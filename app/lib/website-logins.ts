import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { getSqlite } from "./sqlite";
import { validateWebsiteUrl } from "./website-login-client";

export class WebsiteSettingsError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const fields = z.object({
  name: z.string().trim().min(1).max(120),
  loginUrl: z.string().trim().min(1).max(2048),
  verifyUrl: z.string().trim().min(1).max(2048),
  successText: z.string().trim().min(2).max(200),
  username: z.string().min(1).max(256),
  password: z.string().max(1024).optional().default(""),
  usernameField: z.string().trim().max(100).optional().default(""),
  passwordField: z.string().trim().max(100).optional().default(""),
  enabled: z.boolean(),
  intervalMinutes: z.number().int().min(15).max(1440),
}).strict();
export type WebsiteRow = {
  id: number; name: string; login_url: string; verify_url: string; success_text: string;
  username: string; password_ciphertext: string; session_ciphertext: string; username_field: string; password_field: string;
  enabled: number; interval_minutes: number; status: string; message: string;
  last_attempt_at: number | null; last_success_at: number | null; next_attempt_at: number;
  requested: number; revision: string; lease_id: string; lease_until: number;
};
function encryptionKey() {
  const secret = process.env.SESSION_SECRET || "";
  if (secret.length < 32) throw new WebsiteSettingsError(503, "网站凭据加密尚未配置，请联系管理员。");
  return createHmac("sha256", secret).update("website-login-credentials:v1").digest();
}
function scope(origin: string, username: string, purpose: string) { return Buffer.from(`${purpose}\n${origin}\n${username}`); }
function encryptSecret(value: string, origin: string, username: string, purpose: string) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(scope(origin, username, purpose));
  const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), bytes.toString("base64url")].join(".");
}
function decryptSecret(row: WebsiteRow, value: string, purpose: string): string {
  const [version, iv, tag, encrypted, extra] = value.split(".");
  if (version !== "v1" || !iv || !tag || !encrypted || extra) throw new WebsiteSettingsError(503, "已保存的登录凭据无法读取，请重新填写密码。");
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
    decipher.setAAD(scope(new URL(row.login_url).origin, row.username, purpose));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
  } catch { throw new WebsiteSettingsError(503, "已保存的登录凭据无法读取，请重新填写密码。"); }
}
export function readWebsitePassword(row: WebsiteRow) { return decryptSecret(row, row.password_ciphertext, "password"); }
export function readWebsiteSession(row: WebsiteRow) { return row.session_ciphertext ? decryptSecret(row, row.session_ciphertext, "session") : undefined; }
export function encryptWebsiteSession(row: WebsiteRow, value: string) { return encryptSecret(value, new URL(row.login_url).origin, row.username, "session"); }
function transaction<T>(work: () => T): T {
  const db = getSqlite();
  db.exec("BEGIN IMMEDIATE");
  try { const value = work(); db.exec("COMMIT"); return value; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
export function publicWebsite(row: WebsiteRow) {
  return {
    id: row.id, name: row.name, loginUrl: row.login_url, verifyUrl: row.verify_url, successText: row.success_text,
    username: row.username, usernameField: row.username_field, passwordField: row.password_field,
    enabled: Boolean(row.enabled), intervalMinutes: row.interval_minutes, status: row.status, message: row.message,
    lastAttemptAt: row.last_attempt_at, lastSuccessAt: row.last_success_at, hasPassword: Boolean(row.password_ciphertext),
  };
}
export function getWebsite(id: number): WebsiteRow | undefined {
  return getSqlite().prepare("SELECT * FROM website_logins WHERE id=?").get(id) as WebsiteRow | undefined;
}
export function listWebsites(pageInput: number) {
  const db = getSqlite(), pageSize = 20;
  const total = (db.prepare("SELECT COUNT(*) AS total FROM website_logins").get() as { total: number }).total;
  const page = Math.max(1, Math.min(Number.isSafeInteger(pageInput) ? pageInput : 1, Math.max(1, Math.ceil(total / pageSize))));
  const rows = db.prepare("SELECT * FROM website_logins ORDER BY id DESC LIMIT ? OFFSET ?").all(pageSize, (page - 1) * pageSize) as WebsiteRow[];
  return { websites: rows.map(publicWebsite), total, page, pageSize };
}
export function saveWebsite(input: unknown, id?: number) {
  const result = fields.safeParse(input);
  if (!result.success) throw new WebsiteSettingsError(400, "请检查网站名称、网址、账号、成功识别文字及 15–1440 分钟的间隔。");
  const data = result.data;
  const login = validateWebsiteUrl(data.loginUrl), verify = validateWebsiteUrl(data.verifyUrl);
  if (login.origin !== verify.origin) throw new WebsiteSettingsError(400, "登录网址与检查网址必须属于同一个 HTTPS 网站。");
  return transaction(() => {
  const db = getSqlite();
  const previous = id === undefined ? undefined : getWebsite(id);
  if (id !== undefined && !previous) throw new WebsiteSettingsError(404, "找不到这个网站。");
  if (previous && previous.lease_until > Date.now()) throw new WebsiteSettingsError(409, "网站正在登录，请完成后再修改。");
  if (!data.password && (!previous || previous.username !== data.username || new URL(previous.login_url).origin !== login.origin)) {
    throw new WebsiteSettingsError(400, "新增网站或更换账号、域名时，请填写该网站的密码。");
  }
  const cipher = data.password ? encryptSecret(data.password, login.origin, data.username, "password") : previous!.password_ciphertext;
  const args = [data.name, login.href, verify.href, data.successText, data.username, cipher, data.usernameField, data.passwordField,
    Number(data.enabled), data.intervalMinutes, data.enabled ? Date.now() : 0, randomUUID()];
  if (previous) {
    db.prepare("UPDATE website_logins SET name=?,login_url=?,verify_url=?,success_text=?,username=?,password_ciphertext=?,username_field=?,password_field=?,enabled=?,interval_minutes=?,next_attempt_at=?,revision=?,status='idle',message='',requested=0,lease_id='',lease_until=0,session_ciphertext='',last_success_at=NULL WHERE id=?").run(...args, previous.id);
    return publicWebsite(getWebsite(previous.id)!);
  }
  const added = db.prepare("INSERT INTO website_logins(name,login_url,verify_url,success_text,username,password_ciphertext,username_field,password_field,enabled,interval_minutes,next_attempt_at,revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(...args);
  return publicWebsite(getWebsite(Number(added.lastInsertRowid))!);
  });
}
export function deleteWebsite(id: number) {
  return transaction(() => {
  const row = getWebsite(id);
  if (!row) throw new WebsiteSettingsError(404, "找不到这个网站。");
  if (row.lease_until > Date.now()) throw new WebsiteSettingsError(409, "网站正在登录，请完成后再删除配置。");
  getSqlite().prepare("DELETE FROM website_logins WHERE id=?").run(id);
  });
}
export function queueWebsiteLogin(id: number) {
  return transaction(() => {
  const row = getWebsite(id), now = Date.now();
  if (!row) throw new WebsiteSettingsError(404, "找不到这个网站。");
  if (row.lease_until > now) throw new WebsiteSettingsError(409, "网站正在登录，请稍后查看结果。");
  if (row.last_attempt_at && now - row.last_attempt_at < 60_000) throw new WebsiteSettingsError(429, "请间隔至少一分钟再发起登录。");
  getSqlite().prepare("UPDATE website_logins SET requested=1,next_attempt_at=?,status='idle',message='等待登录' WHERE id=?").run(now, id);
  return publicWebsite(getWebsite(id)!);
  });
}
