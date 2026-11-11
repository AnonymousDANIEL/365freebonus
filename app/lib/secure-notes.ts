import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { verifyCredentials, sessionIdHash, type SessionPayload } from "./auth-core";
import { getAdminAuthConfig } from "./admin-credentials";
import { sessionIsActive } from "./session-store";
import { getSqlite } from "./sqlite";

const scrypt = promisify(scryptCallback);
export const NOTES_COOKIE = "directory_notes_unlock";
export const NOTES_UNLOCK_MS = 15 * 60 * 1000;
const PIN_WINDOW_MS = 15 * 60 * 1000;
const PIN_ATTEMPTS = 8;
const PAGE_SIZE = 20;
export class SecureNotesError extends Error {
  constructor(public status: number, message: string, public retryAfter?: number) { super(message); this.name = "SecureNotesError"; }
}
type VaultRow = { pin_hash: string; revision: string };
type UnlockRow = { expires_at: number };
type NoteRow = { id: number; title_ciphertext: string; body_ciphertext: string; revision: string; created_at: number; updated_at: number };
export type SecureNote = { id: number; title: string; body: string; revision: string; createdAt: number; updatedAt: number };
export type VaultStatus = { configured: boolean; unlocked: boolean; expiresAt: number | null };

function secretKey(purpose: string): Buffer {
  const secret = process.env.SESSION_SECRET || "";
  if (secret.length < 32) throw new SecureNotesError(503, "安全笔记尚未配置完成，请联系网站拥有者。");
  return createHmac("sha256", secret).update(`secure-notes:v1:${purpose}`).digest();
}
function activeAdmin(session: SessionPayload) {
  const config = getAdminAuthConfig();
  if (!config || config.username !== session.sub || !sessionIsActive(session)) throw new SecureNotesError(401, "登入已失效，请重新登入。");
  return config;
}
function writeTransaction<T>(operation: () => T): T {
  const db = getSqlite();
  db.exec("BEGIN IMMEDIATE");
  try { const result = operation(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
function vault(): VaultRow | undefined {
  return getSqlite().prepare("SELECT pin_hash, revision FROM notes_vault_settings WHERE id='primary'").get() as VaultRow | undefined;
}
function checkedObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SecureNotesError(400, "提交的格式不正确。");
  return value as Record<string, unknown>;
}
function pinValue(value: unknown): string {
  if (typeof value !== "string" || !/^\d{6,12}$/.test(value)) throw new SecureNotesError(400, "PIN 需要 6–12 位数字。");
  return value;
}
function newPin(pin: unknown, confirmation: unknown): string {
  const value = pinValue(pin);
  if (value !== confirmation) throw new SecureNotesError(400, "两次输入的 PIN 不一致。");
  return value;
}
function pinMaterial(pin: string): Buffer { return createHmac("sha256", secretKey("pin-pepper")).update(pin).digest(); }
async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(32);
  const key = await scrypt(pinMaterial(pin), salt, 64) as Buffer;
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}
async function correctPin(pin: string, hash: string): Promise<boolean> {
  if (!/^scrypt\$[a-f0-9]{64}\$[a-f0-9]{128}$/.test(hash)) throw new SecureNotesError(503, "安全笔记暂时无法解锁，请联系网站拥有者。");
  const [, salt, expected] = hash.split("$");
  const actual = await scrypt(pinMaterial(pin), Buffer.from(salt, "hex"), 64) as Buffer;
  return timingSafeEqual(actual, Buffer.from(expected, "hex"));
}
// Reserve an attempt before asynchronous credential verification. The single
// global row prevents rotating IPs, admin sessions or parallel requests bypassing it.
function reserveAttempt(now: number) {
  writeTransaction(() => {
    const db = getSqlite();
    const row = db.prepare("SELECT attempts, expires_at FROM notes_vault_attempts WHERE id='primary'").get() as { attempts: number; expires_at: number } | undefined;
    if (row && row.expires_at > now && row.attempts >= PIN_ATTEMPTS) {
      throw new SecureNotesError(429, "PIN 尝试次数过多，请稍后再试。", Math.max(1, Math.ceil((row.expires_at - now) / 1000)));
    }
    if (!row || row.expires_at <= now) db.prepare("INSERT INTO notes_vault_attempts(id, attempts, expires_at) VALUES ('primary', 1, ?) ON CONFLICT(id) DO UPDATE SET attempts=1, expires_at=excluded.expires_at").run(now + PIN_WINDOW_MS);
    else db.prepare("UPDATE notes_vault_attempts SET attempts=attempts+1 WHERE id='primary'").run();
  });
}
function clearAttempts() { getSqlite().exec("DELETE FROM notes_vault_attempts"); }
function tokenHash(token: string): string { return createHash("sha256").update(token).digest("hex"); }
function lockGeneration(session: SessionPayload): string {
  return (getSqlite().prepare("SELECT generation FROM notes_vault_sessions WHERE session_hash=?").get(sessionIdHash(session.jti)) as { generation: string } | undefined)?.generation || "";
}
function unlockRow(session: SessionPayload, token: string | undefined, current: VaultRow, now: number): UnlockRow | undefined {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
  return getSqlite().prepare("SELECT expires_at FROM notes_vault_unlocks WHERE token_hash=? AND session_hash=? AND vault_revision=? AND expires_at>?").get(tokenHash(token), sessionIdHash(session.jti), current.revision, now) as UnlockRow | undefined;
}
function grantUnlock(session: SessionPayload, current: VaultRow, now: number) {
  const db = getSqlite();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = Math.min(now + NOTES_UNLOCK_MS, session.exp * 1000);
  db.prepare("DELETE FROM notes_vault_unlocks WHERE expires_at<=? OR session_hash=?").run(now, sessionIdHash(session.jti));
  db.prepare("INSERT INTO notes_vault_unlocks(token_hash,session_hash,vault_revision,expires_at) VALUES (?,?,?,?)").run(tokenHash(token), sessionIdHash(session.jti), current.revision, expiresAt);
  return { token, status: { configured: true, unlocked: true, expiresAt } satisfies VaultStatus };
}
function requireUnlock(session: SessionPayload, token: string | undefined, now: number): number {
  activeAdmin(session);
  const current = vault();
  if (!current) throw new SecureNotesError(423, "请先设置安全笔记 PIN。");
  const row = unlockRow(session, token, current, now);
  if (!row) throw new SecureNotesError(423, "安全笔记已锁定，请输入 PIN 解锁。");
  return row.expires_at;
}
export function getVaultStatus(session: SessionPayload, token?: string, now = Date.now()): VaultStatus {
  activeAdmin(session);
  const current = vault();
  const row = current && unlockRow(session, token, current, now);
  return { configured: Boolean(current), unlocked: Boolean(row), expiresAt: row?.expires_at ?? null };
}
export async function setupNotesVault(value: unknown, session: SessionPayload, now = Date.now()) {
  const input = checkedObject(value);
  const pin = newPin(input.pin, input.confirmPin);
  if (typeof input.currentPassword !== "string" || !input.currentPassword || input.currentPassword.length > 1024) throw new SecureNotesError(400, "请输入当前后台登录密码。");
  const expected = activeAdmin(session);
  const generation = lockGeneration(session);
  if (vault()) throw new SecureNotesError(409, "安全笔记已设置 PIN，请使用现有 PIN 解锁。");
  reserveAttempt(now);
  if (!await verifyCredentials(session.sub, input.currentPassword, expected)) throw new SecureNotesError(400, "当前后台密码不正确。");
  const hash = await hashPin(pin);
  return writeTransaction(() => {
    const config = activeAdmin(session);
    if (config.passwordHash !== expected.passwordHash || config.secret !== expected.secret) throw new SecureNotesError(401, "登入已失效，请重新登入。");
    if (lockGeneration(session) !== generation) throw new SecureNotesError(423, "安全笔记已锁定，请重新解锁。");
    if (vault()) throw new SecureNotesError(409, "安全笔记已设置 PIN，请刷新后解锁。");
    const current = { pin_hash: hash, revision: randomUUID() };
    getSqlite().prepare("INSERT INTO notes_vault_settings(id,pin_hash,revision,created_at,updated_at) VALUES ('primary',?,?,?,?)").run(hash, current.revision, now, now);
    clearAttempts();
    return grantUnlock(session, current, now);
  });
}
export async function unlockNotesVault(value: unknown, session: SessionPayload, now = Date.now()) {
  const input = checkedObject(value);
  const pin = pinValue(input.pin);
  activeAdmin(session);
  const generation = lockGeneration(session);
  const expected = vault();
  if (!expected) throw new SecureNotesError(409, "请先设置安全笔记 PIN。");
  reserveAttempt(now);
  if (!await correctPin(pin, expected.pin_hash)) throw new SecureNotesError(400, "PIN 不正确。");
  return writeTransaction(() => {
    activeAdmin(session);
    if (lockGeneration(session) !== generation) throw new SecureNotesError(423, "安全笔记已锁定，请重新解锁。");
    const current = vault();
    if (!current || current.revision !== expected.revision) throw new SecureNotesError(409, "PIN 已更改，请重新输入。");
    clearAttempts();
    return grantUnlock(session, current, now);
  });
}
export function lockNotesVault(session: SessionPayload, token?: string): VaultStatus {
  return writeTransaction(() => {
    activeAdmin(session);
    // Advance a session-bound lock generation so even an earlier asynchronous
    // unlock verification cannot mint a new token after this lock commits.
    const db = getSqlite();
    db.prepare("INSERT INTO notes_vault_sessions(session_hash,generation) VALUES (?,?) ON CONFLICT(session_hash) DO UPDATE SET generation=excluded.generation").run(sessionIdHash(session.jti), randomUUID());
    db.prepare("DELETE FROM notes_vault_unlocks WHERE session_hash=?").run(sessionIdHash(session.jti));
    return { configured: Boolean(vault()), unlocked: false, expiresAt: null };
  });
}
export async function changeNotesPin(value: unknown, session: SessionPayload, token?: string, now = Date.now()): Promise<VaultStatus> {
  const input = checkedObject(value);
  const currentPin = pinValue(input.currentPin);
  const replacement = newPin(input.newPin, input.confirmPin);
  if (currentPin === replacement) throw new SecureNotesError(400, "新 PIN 不能与当前 PIN 相同。");
  requireUnlock(session, token, now);
  const expected = vault()!;
  reserveAttempt(now);
  if (!await correctPin(currentPin, expected.pin_hash)) throw new SecureNotesError(400, "当前 PIN 不正确。");
  const hash = await hashPin(replacement);
  return writeTransaction(() => {
    requireUnlock(session, token, Date.now());
    const current = vault();
    if (!current || current.revision !== expected.revision) throw new SecureNotesError(409, "PIN 已更改，请重新解锁。");
    getSqlite().prepare("UPDATE notes_vault_settings SET pin_hash=?,revision=?,updated_at=? WHERE id='primary'").run(hash, randomUUID(), now);
    getSqlite().exec("DELETE FROM notes_vault_unlocks");
    clearAttempts();
    return { configured: true, unlocked: false, expiresAt: null };
  });
}
function encrypt(value: string, id: number, field: "title" | "body"): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey("content-encryption"), iv);
  cipher.setAAD(Buffer.from(`secure-notes:v1:${id}:${field}`));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}
function decrypt(value: string, id: number, field: "title" | "body"): string {
  try {
    const [version, iv, tag, encrypted, extra] = value.split(".");
    if (version !== "v1" || extra !== undefined || !iv || !tag || encrypted === undefined) throw Error();
    const decipher = createDecipheriv("aes-256-gcm", secretKey("content-encryption"), Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(`secure-notes:v1:${id}:${field}`));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
  } catch { throw new SecureNotesError(503, "安全笔记暂时无法读取，资料已保留，请联系网站拥有者。"); }
}
function note(row: NoteRow): SecureNote {
  return { id: row.id, title: decrypt(row.title_ciphertext, row.id, "title"), body: decrypt(row.body_ciphertext, row.id, "body"), revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at };
}
function content(value: unknown) {
  const input = checkedObject(value);
  if (typeof input.title !== "string" || !input.title.trim() || input.title.trim().length > 100) throw new SecureNotesError(400, "标题需要 1–100 个字符。");
  if (typeof input.body !== "string" || input.body.length > 8000) throw new SecureNotesError(400, "笔记内容最多 8000 个字符。");
  return { title: input.title.trim(), body: input.body, expectedRevision: input.expectedRevision };
}
function expectedRevision(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value)) throw new SecureNotesError(400, "缺少有效的记录版本，请刷新后再试。");
  return value;
}
export function notesId(value: string): number {
  if (!/^[1-9]\d{0,14}$/.test(value) || !Number.isSafeInteger(Number(value))) throw new SecureNotesError(404, "找不到这条笔记。");
  return Number(value);
}
export function listSecureNotes(session: SessionPayload, token?: string, requestedPage = 1, now = Date.now()) {
  const expiresAt = requireUnlock(session, token, now);
  const db = getSqlite();
  const total = (db.prepare("SELECT COUNT(*) AS count FROM secure_notes").get() as { count: number }).count;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, lastPage) : 1;
  const rows = db.prepare("SELECT * FROM secure_notes ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?").all(PAGE_SIZE, (page - 1) * PAGE_SIZE) as NoteRow[];
  return { notes: rows.map(note), total, page, pageSize: PAGE_SIZE, expiresAt };
}
export function saveSecureNote(value: unknown, session: SessionPayload, token?: string, id?: number, now = Date.now()): SecureNote {
  const input = content(value);
  const expected = id === undefined ? undefined : expectedRevision(input.expectedRevision);
  return writeTransaction(() => {
    requireUnlock(session, token, now);
    const db = getSqlite();
    const revision = randomUUID();
    if (id === undefined) {
      const created = db.prepare("INSERT INTO secure_notes(title_ciphertext,body_ciphertext,revision,created_at,updated_at) VALUES ('','',?,?,?)").run(revision, now, now);
      id = Number(created.lastInsertRowid);
      db.prepare("UPDATE secure_notes SET title_ciphertext=?,body_ciphertext=? WHERE id=?").run(encrypt(input.title, id, "title"), encrypt(input.body, id, "body"), id);
    } else {
      const previous = db.prepare("SELECT revision FROM secure_notes WHERE id=?").get(id) as { revision: string } | undefined;
      if (!previous) throw new SecureNotesError(404, "找不到这条笔记。");
      if (previous.revision !== expected) throw new SecureNotesError(409, "这条笔记已被修改，请刷新后再编辑，避免覆盖新内容。");
      db.prepare("UPDATE secure_notes SET title_ciphertext=?,body_ciphertext=?,revision=?,updated_at=? WHERE id=? AND revision=?").run(encrypt(input.title, id, "title"), encrypt(input.body, id, "body"), revision, now, id, expected!);
    }
    return note(db.prepare("SELECT * FROM secure_notes WHERE id=?").get(id) as NoteRow);
  });
}
export function deleteSecureNote(value: unknown, session: SessionPayload, token: string | undefined, id: number, now = Date.now()) {
  const expected = expectedRevision(checkedObject(value).expectedRevision);
  return writeTransaction(() => {
    requireUnlock(session, token, now);
    const db = getSqlite();
    const previous = db.prepare("SELECT revision FROM secure_notes WHERE id=?").get(id) as { revision: string } | undefined;
    if (!previous) throw new SecureNotesError(404, "找不到这条笔记。");
    if (previous.revision !== expected) throw new SecureNotesError(409, "这条笔记已被修改，请刷新后再删除。");
    db.prepare("DELETE FROM secure_notes WHERE id=? AND revision=?").run(id, expected);
  });
}
