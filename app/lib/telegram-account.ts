import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Api, Logger, TelegramClient, utils } from "teleproto";
import { StringSession } from "teleproto/sessions";
import bigInt from "big-integer";
import { getSqlite } from "./sqlite";

type Stage = "disconnected" | "code" | "password" | "connected";
type AccountRow = {
  generation: string; config_ciphertext: string; session_ciphertext: string; pending_ciphertext: string;
  pending_until: number; stage: Stage; lease_id: string; lease_until: number; next_attempt_at: number;
  last_error: string; last_polled_at: number; synced_at: number; poll_source_id: number; next_code_at: number;
};
type SourceRow = {
  chat_id: number; title: string; username: string; peer_ciphertext: string; selected: number;
  joined: number; selected_at: number; last_message_id: number; blocked: number;
};
type Credentials = { apiId: number; apiHash: string };
type PendingLogin = Credentials & { phone: string; phoneCodeHash: string; session: string };
type Claim = { row: AccountRow; leaseId: string };
export type TelegramAccountAction =
  | { action: "sendCode"; apiId: number; apiHash: string; phone: string }
  | { action: "code"; code: string }
  | { action: "password"; password: string }
  | { action: "refresh" }
  | { action: "select"; channelIds: string[] }
  | { action: "disconnect" };

const KEY_CONTEXT = "365freebonus:telegram-personal-account:v1";
const LEASE_MS = 60_000;
const REQUEST_MS = 25_000;
const LOGIN_MS = 10 * 60_000;
const REFRESH_MS = 5 * 60_000;
const POLL_MS = 10_000;
const RETRY_MS = 60_000;
const MAX_PHOTO = 10 * 1024 * 1024;
const MAX_ANIMATION = 20 * 1024 * 1024;
const MAX_VIDEO = 50 * 1024 * 1024;
const TEMP_ERROR = "暂时无法连接 Telegram 个人账号，请稍后再试。";
const REAUTH_ERROR = "Telegram 个人账号连接已失效，请在后台重新连接。";
const BUSY_ERROR = "正在处理 Telegram 账号连接，请稍后再试。";
const PENDING_ERROR = "登录步骤已过期，请重新获取验证码。";
const initialized = new WeakSet<DatabaseSync>();

export class TelegramAccountError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "TelegramAccountError"; }
}
class OversizeMediaError extends Error {}

/** This additive schema uses a savepoint so it is also safe inside a caller's transaction. */
export function ensureTelegramAccountTables(db = getSqlite()) {
  if (initialized.has(db)) return;
  db.exec("SAVEPOINT telegram_personal_schema");
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS telegram_personal_account (
      id TEXT PRIMARY KEY CHECK(id='primary'), generation TEXT NOT NULL DEFAULT '',
      config_ciphertext TEXT NOT NULL DEFAULT '', session_ciphertext TEXT NOT NULL DEFAULT '',
      pending_ciphertext TEXT NOT NULL DEFAULT '', pending_until INTEGER NOT NULL DEFAULT 0,
      stage TEXT NOT NULL DEFAULT 'disconnected' CHECK(stage IN ('disconnected','code','password','connected')),
      lease_id TEXT NOT NULL DEFAULT '', lease_until INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0, next_code_at INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '',
      last_polled_at INTEGER NOT NULL DEFAULT 0, synced_at INTEGER NOT NULL DEFAULT 0,
      poll_source_id INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO telegram_personal_account(id) VALUES('primary');
    CREATE TABLE IF NOT EXISTS telegram_personal_sources (
      chat_id INTEGER PRIMARY KEY CHECK(chat_id<0), title TEXT NOT NULL, username TEXT NOT NULL DEFAULT '',
      peer_ciphertext TEXT NOT NULL, selected INTEGER NOT NULL DEFAULT 0 CHECK(selected IN (0,1)),
      joined INTEGER NOT NULL DEFAULT 1 CHECK(joined IN (0,1)), selected_at INTEGER NOT NULL DEFAULT 0,
      last_message_id INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1))
    );`);
    if (!(db.prepare("PRAGMA table_info(telegram_personal_sources)").all() as { name: string }[]).some(column => column.name === "blocked")) db.exec("ALTER TABLE telegram_personal_sources ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1))");
    if (!(db.prepare("PRAGMA table_info(telegram_personal_account)").all() as { name: string }[]).some(column => column.name === "next_code_at")) db.exec("ALTER TABLE telegram_personal_account ADD COLUMN next_code_at INTEGER NOT NULL DEFAULT 0");
    db.exec("RELEASE telegram_personal_schema");
    initialized.add(db);
  } catch (error) {
    db.exec("ROLLBACK TO telegram_personal_schema; RELEASE telegram_personal_schema");
    throw error;
  }
}

function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("SAVEPOINT telegram_personal_write");
  try { const value = work(); db.exec("RELEASE telegram_personal_write"); return value; }
  catch (error) { db.exec("ROLLBACK TO telegram_personal_write; RELEASE telegram_personal_write"); throw error; }
}
function row(db: DatabaseSync): AccountRow {
  ensureTelegramAccountTables(db);
  return db.prepare("SELECT * FROM telegram_personal_account WHERE id='primary'").get() as AccountRow;
}
function key() {
  const secret = process.env.SESSION_SECRET || "";
  if (secret.length < 32) throw new TelegramAccountError("服务器尚未配置账号加密，请联系网站管理员。", 503);
  return createHmac("sha256", secret).update(KEY_CONTEXT).digest();
}
function seal(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(KEY_CONTEXT));
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${bytes.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
}
function unseal<T>(value: string): T {
  try {
    const [version, iv, ciphertext, tag] = value.split(".");
    if (version !== "v1" || !iv || !ciphertext || !tag) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(KEY_CONTEXT));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8")) as T;
  } catch { throw new TelegramAccountError(REAUTH_ERROR, 409); }
}
function hasQueue(db: DatabaseSync) {
  return (db.prepare("PRAGMA table_info(telegram_relay_outbox)").all() as { name: string }[]).some(column => column.name === "origin");
}
function cancelSourceQueue(db: DatabaseSync, sourceId?: number) {
  if (!hasQueue(db)) return;
  const filter = sourceId === undefined ? "" : " AND source_chat_id=?";
  const statement = db.prepare(`UPDATE telegram_relay_outbox SET status='cancelled',lease_id='',lease_until=0,
    last_error='',media_bytes=NULL WHERE origin='account' AND status='pending'${filter}`);
  if (sourceId === undefined) statement.run(); else statement.run(sourceId);
}

export function accountStatus() {
  const db = getSqlite();
  const current = row(db);
  const expired = (current.stage === "code" || current.stage === "password") && current.pending_until <= Date.now();
  const retryAt = Math.max(current.next_attempt_at, current.stage === "disconnected" || expired ? current.next_code_at : 0);
  return {
    connected: current.stage === "connected" && Boolean(current.session_ciphertext),
    stage: expired ? "disconnected" as const : current.stage,
    hasApiCredentials: Boolean(current.config_ciphertext),
    lastError: expired ? PENDING_ERROR : current.last_error,
    lastPolledAt: current.last_polled_at || null,
    syncedAt: current.synced_at || null,
    retryAt: retryAt > Date.now() ? retryAt : null,
    retrySource: retryAt > Date.now() ? (/^Telegram 正在限制请求频率/.test(current.last_error) ? "telegram" as const : "connection" as const) : null,
    channels: (db.prepare("SELECT chat_id,title,username,selected,joined FROM telegram_personal_sources WHERE joined=1 OR selected=1 ORDER BY title COLLATE NOCASE,chat_id").all() as SourceRow[])
      .map(source => ({ id: String(source.chat_id), title: source.title, username: source.username, selected: source.selected === 1, joined: source.joined === 1 })),
  };
}

function claimAccount(db: DatabaseSync, now: number, options: { connected?: boolean; respectBackoff?: boolean } = {}): Claim {
  return transaction(db, () => {
    const current = row(db);
    if (options.connected && (current.stage !== "connected" || !current.session_ciphertext)) throw new TelegramAccountError(REAUTH_ERROR, 409);
    if (current.lease_until > now) throw new TelegramAccountError(BUSY_ERROR, 409);
    if (options.respectBackoff && current.next_attempt_at > now) {
      const seconds = Math.max(1, Math.ceil((current.next_attempt_at - now) / 1000));
      const explanation = /^Telegram 正在限制请求频率/.test(current.last_error)
        ? "Telegram 正在限制请求频率" : "上次操作未完成，系统正在等待重试";
      throw new TelegramAccountError(`${explanation}，请在 ${seconds} 秒后再试。`, 429);
    }
    const leaseId = randomUUID();
    db.prepare("UPDATE telegram_personal_account SET lease_id=?,lease_until=? WHERE id='primary'").run(leaseId, now + LEASE_MS);
    return { row: current, leaseId };
  });
}
function owns(db: DatabaseSync, claim: Claim) {
  return Boolean(db.prepare("SELECT 1 FROM telegram_personal_account WHERE id='primary' AND generation=? AND lease_id=? AND lease_until>?")
    .get(claim.row.generation, claim.leaseId, Date.now()));
}
function renew(db: DatabaseSync, claim: Claim) {
  if (!owns(db, claim)) throw new TelegramAccountError("账号设置已改变，请刷新后再试。", 409);
  db.prepare("UPDATE telegram_personal_account SET lease_until=? WHERE id='primary' AND lease_id=?").run(Date.now() + LEASE_MS, claim.leaseId);
}
function release(db: DatabaseSync, claim: Claim) {
  db.prepare("UPDATE telegram_personal_account SET lease_id='',lease_until=0 WHERE id='primary' AND lease_id=?").run(claim.leaseId);
}
function safeError(error: unknown): { message: string; status: number; delay: number; revoked: boolean } {
  const raw = error as { errorMessage?: string; message?: string; seconds?: number } | null;
  const code = raw?.errorMessage || raw?.message || "";
  if (/API_ID_INVALID|API_ID_PUBLISHED_FLOOD/.test(code)) return { message: "请检查你自己的 Telegram API ID 和 API Hash。", status: 400, delay: RETRY_MS, revoked: false };
  if (/FLOOD|SLOWMODE|PHONE_NUMBER_FLOOD|PHONE_PASSWORD_FLOOD/.test(code)) {
    const delay = Number.isSafeInteger(raw?.seconds) && Number(raw?.seconds) > 0 ? Math.min(Number.MAX_SAFE_INTEGER, Number(raw?.seconds) * 1000) : RETRY_MS;
    return { message: "Telegram 正在限制请求频率，请稍后再试。", status: 429, delay, revoked: false };
  }
  if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|AUTH_KEY_DUPLICATED|USER_DEACTIVATED/.test(code)) return { message: REAUTH_ERROR, status: 409, delay: RETRY_MS, revoked: true };
  if (/PHONE_CODE_INVALID|PHONE_CODE_EMPTY/.test(code)) return { message: "验证码不正确，请重新输入。", status: 400, delay: 5000, revoked: false };
  if (/PHONE_CODE_EXPIRED|PHONE_CODE_HASH_EMPTY/.test(code)) return { message: PENDING_ERROR, status: 400, delay: 5000, revoked: false };
  if (/PASSWORD_HASH_INVALID/.test(code)) return { message: "两步验证密码不正确，请重新输入。", status: 400, delay: 5000, revoked: false };
  if (/PHONE_NUMBER_INVALID|PHONE_NUMBER_BANNED|PHONE_NUMBER_UNOCCUPIED|AUTH_SIGNUP_REQUIRED/.test(code)) return { message: "请使用有效且已注册的 Telegram 手机号码。", status: 400, delay: RETRY_MS, revoked: false };
  if (/PHONE_MIGRATE|NETWORK_MIGRATE|USER_MIGRATE/.test(code)) return { message: "Telegram 数据中心切换暂未完成，请稍后重试。", status: 502, delay: RETRY_MS, revoked: false };
  if (/RECAPTCHA_CHECK|CAPTCHA_CHECK/.test(code)) return { message: "Telegram 要求额外验证码验证，当前连接流程暂不支持。", status: 409, delay: RETRY_MS, revoked: false };
  if (/FROZEN|USER_RESTRICTED/.test(code)) return { message: "Telegram 已限制此账号的部分操作，请先在官方应用检查账号状态。", status: 409, delay: RETRY_MS, revoked: false };
  if (error instanceof TelegramAccountError) return { message: error.message, status: error.status, delay: error.status === 429 ? RETRY_MS : 5000, revoked: false };
  return { message: TEMP_ERROR, status: 502, delay: RETRY_MS, revoked: false };
}
function failureCategory(error: unknown) {
  const raw = error as { errorMessage?: string; message?: string; name?: string; code?: string } | null;
  const value = raw?.errorMessage || raw?.code || raw?.message || "";
  if (/PHONE_MIGRATE|NETWORK_MIGRATE|USER_MIGRATE/.test(value)) return "data-center-migration";
  if (/API_ID_INVALID|API_ID_PUBLISHED_FLOOD/.test(value)) return "api-credentials";
  if (/FLOOD|SLOWMODE/.test(value)) return "telegram-rate-limit";
  if (/TIMEOUT|ETIMEDOUT|timed out/i.test(value) || raw?.name === "TimeoutError") return "timeout";
  if (/ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN/.test(value)) return "network";
  if (error instanceof TelegramAccountError) return "handled-operation";
  return raw?.errorMessage ? "telegram-rpc" : "unexpected";
}
function recordFailure(db: DatabaseSync, claim: Claim, error: unknown, operation = "poll") {
  const safe = safeError(error);
  // Log only fixed categories. RPC messages can include private account data.
  console.warn("Telegram personal account operation failed.", JSON.stringify({ operation, category: failureCategory(error) }));
  if (owns(db, claim)) transaction(db, () => {
    db.prepare("UPDATE telegram_personal_account SET last_error=?,next_attempt_at=MAX(next_attempt_at,?) WHERE id='primary' AND lease_id=?")
      .run(safe.message, Math.min(Number.MAX_SAFE_INTEGER, Date.now() + safe.delay), claim.leaseId);
    if (safe.revoked) {
      db.prepare("UPDATE telegram_personal_account SET stage='disconnected',session_ciphertext='',pending_ciphertext='',pending_until=0,generation=? WHERE id='primary' AND lease_id=?")
        .run(randomUUID(), claim.leaseId);
      db.prepare("UPDATE telegram_personal_sources SET selected=0,joined=0").run();
      cancelSourceQueue(db);
    }
  });
  return new TelegramAccountError(safe.message, safe.status);
}

function makeClient(credentials: Credentials, session: string) {
  const logger = new Logger();
  logger.handler = () => undefined;
  const client = new TelegramClient(new StringSession(session), credentials.apiId, credentials.apiHash, {
    // One attempt prevents the SDK from applying PHONE_MIGRATE recovery.
    // Allow a bounded migration/retry while surfacing every FloodWait immediately.
    baseLogger: logger, timeout: 10, connectionRetries: 1, reconnectRetries: 0, requestRetries: 3,
    autoReconnect: false, catchUp: false, floodSleepThreshold: 0,
    deviceModel: "365 Free Bonus relay", appVersion: "1.0", systemVersion: "Linux",
    downloadPool: { sessions: 1, maxSessions: 1, requestRetries: 1, requestDeadlineMs: REQUEST_MS },
  });
  client.setLogLevel("none" as Parameters<TelegramClient["setLogLevel"]>[0]);
  return client;
}
async function bounded<T>(client: TelegramClient, work: Promise<T>, timeout = REQUEST_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void client.disconnect().catch(() => undefined);
        reject(new TelegramAccountError(TEMP_ERROR, 502));
      }, timeout);
      timer.unref();
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
async function closeClient(client: TelegramClient | undefined) {
  if (!client) return;
  // destroy also stops update and keepalive loops created by a transient client.
  await Promise.race([client.destroy().catch(() => undefined), new Promise<void>(resolve => {
    const timer = setTimeout(resolve, 2000); timer.unref();
  })]);
}
function saveSession(db: DatabaseSync, claim: Claim, client: TelegramClient) {
  if (!owns(db, claim)) throw new TelegramAccountError("账号设置已改变，请刷新后再试。", 409);
  const session = client.session.save();
  if (typeof session !== "string" || !session) throw new TelegramAccountError(REAUTH_ERROR, 409);
  db.prepare("UPDATE telegram_personal_account SET session_ciphertext=?,last_error='',next_attempt_at=0 WHERE id='primary' AND lease_id=?")
    .run(seal(session), claim.leaseId);
}
function pendingLogin(current: AccountRow): PendingLogin {
  if (!current.pending_ciphertext || current.pending_until <= Date.now() || !["code", "password"].includes(current.stage)) throw new TelegramAccountError(PENDING_ERROR, 400);
  return unseal<PendingLogin>(current.pending_ciphertext);
}
async function completeLogin(db: DatabaseSync, claim: Claim, client: TelegramClient) {
  const me = await bounded(client, client.getMe());
  if (!(me instanceof Api.User) || me.bot || me.deleted) throw new TelegramAccountError("请连接你自己的普通 Telegram 账号。", 400);
  transaction(db, () => {
    saveSession(db, claim, client);
    db.prepare("UPDATE telegram_personal_account SET stage='connected',pending_ciphertext='',pending_until=0,synced_at=0 WHERE id='primary' AND lease_id=?").run(claim.leaseId);
  });
  await refreshChannels(db, claim, client);
}

type DiscoveredChannel = { id: number; title: string; username: string; peer: string; latest: number; blocked: boolean };
async function refreshChannels(db: DatabaseSync, claim: Claim, client: TelegramClient) {
  renew(db, claim);
  const channels = await bounded(client, (async () => {
    const found: DiscoveredChannel[] = [];
    for await (const dialog of client.iterDialogs({})) {
      const entity = dialog.entity;
      if (!(entity instanceof Api.Channel) || !entity.broadcast || entity.left || !entity.accessHash) continue;
      const id = Number(utils.getPeerId(entity));
      if (!Number.isSafeInteger(id) || id >= 0) continue;
      found.push({ id, title: entity.title.slice(0, 300), username: (entity.username || "").slice(0, 64),
        peer: seal({ id: entity.id.toString(), accessHash: entity.accessHash.toString(), protected: entity.noforwards === true }),
        latest: dialog.dialog.topMessage || dialog.message?.id || 0, blocked: entity.noforwards === true });
    }
    return found;
  })());
  renew(db, claim);
  transaction(db, () => {
    const previous = db.prepare("SELECT chat_id,selected FROM telegram_personal_sources WHERE joined=1").all() as { chat_id: number; selected: number }[];
    db.prepare("UPDATE telegram_personal_sources SET joined=0").run();
    const insert = db.prepare(`INSERT INTO telegram_personal_sources(chat_id,title,username,peer_ciphertext,last_message_id,blocked)
      VALUES(?,?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title,username=excluded.username,
      peer_ciphertext=excluded.peer_ciphertext,joined=1,blocked=excluded.blocked`);
    for (const channel of channels) {
      insert.run(channel.id, channel.title, channel.username, channel.peer, channel.latest, Number(channel.blocked));
      if (channel.blocked) cancelSourceQueue(db, channel.id);
    }
    const found = new Set(channels.map(channel => channel.id));
    for (const source of previous) if (!found.has(source.chat_id)) {
      db.prepare("UPDATE telegram_personal_sources SET selected=0 WHERE chat_id=?").run(source.chat_id);
      cancelSourceQueue(db, source.chat_id);
    }
    saveSession(db, claim, client);
    db.prepare("UPDATE telegram_personal_account SET synced_at=? WHERE id='primary' AND lease_id=?").run(Date.now(), claim.leaseId);
  });
  return new Map(channels.map(channel => [channel.id, channel.latest]));
}

function inputPeer(source: SourceRow) {
  const peer = unseal<{ id: string; accessHash: string; protected: boolean }>(source.peer_ciphertext);
  // Rehydrate only the encrypted channel peer; no access hash leaves the server.
  const input = new Api.InputPeerChannel({ channelId: bigInt(peer.id), accessHash: bigInt(peer.accessHash) });
  return { input, protected: peer.protected };
}

async function selectChannels(db: DatabaseSync, claim: Claim, client: TelegramClient, values: string[]) {
  const ids = [...new Set(values.map(Number))];
  if (ids.length > 500 || ids.some(id => !Number.isSafeInteger(id) || !String(id).startsWith("-100"))) throw new TelegramAccountError("请检查所选择的来源频道。", 400);
  // One paginated dialog sync seeds every newly selected channel at its current
  // top message, avoiding hundreds of separate history requests for a bulk edit.
  const latest = await refreshChannels(db, claim, client);
  const sources = db.prepare("SELECT * FROM telegram_personal_sources WHERE joined=1").all() as SourceRow[];
  const byId = new Map(sources.map(source => [source.chat_id, source]));
  if (ids.some(id => !byId.has(id))) throw new TelegramAccountError("频道列表已改变，请刷新频道列表后重新选择。", 409);
  renew(db, claim);
  transaction(db, () => {
    const wanted = new Set(ids);
    for (const source of sources) {
      if (!wanted.has(source.chat_id)) {
        db.prepare("UPDATE telegram_personal_sources SET selected=0 WHERE chat_id=?").run(source.chat_id);
        cancelSourceQueue(db, source.chat_id);
      } else if (!source.selected) {
        db.prepare("UPDATE telegram_personal_sources SET selected=1,selected_at=?,last_message_id=? WHERE chat_id=?")
          .run(Math.max(Date.now(), source.selected_at + 1), latest.get(source.chat_id) || 0, source.chat_id);
      }
    }
    saveSession(db, claim, client);
  });
}

export async function handleAccountAction(input: TelegramAccountAction) {
  const db = getSqlite();
  ensureTelegramAccountTables(db);
  if (input.action === "disconnect") {
    const previous = row(db);
    transaction(db, () => {
      db.prepare(`UPDATE telegram_personal_account SET generation=?,stage='disconnected',session_ciphertext='',
        config_ciphertext='',pending_ciphertext='',pending_until=0,lease_id='',lease_until=0,
        last_error='',last_polled_at=0,synced_at=0,poll_source_id=0 WHERE id='primary'`).run(randomUUID());
      db.prepare("DELETE FROM telegram_personal_sources").run();
      cancelSourceQueue(db);
    });
    let client: TelegramClient | undefined;
    try {
      if (previous.next_attempt_at > Date.now()) throw new TelegramAccountError("Telegram 正在限制请求频率。", 429);
      if (previous.config_ciphertext && previous.session_ciphertext) {
        client = makeClient(unseal<Credentials>(previous.config_ciphertext), unseal<string>(previous.session_ciphertext));
        await bounded(client, client.connect());
        await bounded(client, client.invoke(new Api.auth.LogOut()));
      }
    } catch {
      // Local receive access is already revoked. Report remote-session cleanup without exposing details.
      db.prepare("UPDATE telegram_personal_account SET last_error=? WHERE id='primary' AND stage='disconnected'")
        .run("本网站已断开连接；请在 Telegram 的设备管理中检查并移除对应会话。");
    } finally { await closeClient(client); }
    return accountStatus();
  }
  const claim = claimAccount(db, Date.now(), { connected: input.action === "refresh" || input.action === "select", respectBackoff: true });
  let client: TelegramClient | undefined;
  try {
    if (input.action === "sendCode") {
      if (claim.row.stage === "connected") throw new TelegramAccountError("请先断开当前账号，再连接其他账号。", 409);
      if (claim.row.next_code_at > Date.now()) throw new TelegramAccountError(`验证码刚刚请求过，请在 ${Math.max(1, Math.ceil((claim.row.next_code_at - Date.now()) / 1000))} 秒后再试。`, 429);
      if (!Number.isSafeInteger(input.apiId) || input.apiId <= 0 || !/^[a-f0-9]{32}$/i.test(input.apiHash) || !/^\+[1-9]\d{6,14}$/.test(input.phone)) throw new TelegramAccountError("请检查 API ID、API Hash 和国际格式手机号码。", 400);
      const credentials = { apiId: input.apiId, apiHash: input.apiHash };
      client = makeClient(credentials, "");
      await bounded(client, client.connect());
      // Persist throttle before contacting Telegram, including failures/interrupted responses.
      renew(db, claim);
      db.prepare("UPDATE telegram_personal_account SET next_code_at=? WHERE id='primary' AND lease_id=?").run(Date.now() + RETRY_MS, claim.leaseId);
      const sent = await bounded(client, client.sendCode(credentials, input.phone));
      if (sent.emailRequired || sent.emailCodeSent || !sent.phoneCodeHash) throw new TelegramAccountError("此账号需要额外的 Telegram 邮箱验证，请先在官方应用完成验证后再连接。", 400);
      renew(db, claim);
      const pending: PendingLogin = { ...credentials, phone: input.phone, phoneCodeHash: sent.phoneCodeHash, session: String(client.session.save()) };
      transaction(db, () => {
        db.prepare(`UPDATE telegram_personal_account SET config_ciphertext=?,pending_ciphertext=?,pending_until=?,
          session_ciphertext='',stage='code',last_error='',next_attempt_at=0,generation=? WHERE id='primary' AND lease_id=?`)
          .run(seal(credentials), seal(pending), Date.now() + LOGIN_MS, randomUUID(), claim.leaseId);
      });
    } else if (input.action === "code" || input.action === "password") {
      const pending = pendingLogin(claim.row);
      if (claim.row.stage !== input.action) throw new TelegramAccountError("登录步骤已改变，请刷新后继续。", 409);
      client = makeClient(pending, pending.session);
      await bounded(client, client.connect());
      renew(db, claim);
      if (input.action === "code") {
        if (!/^\d{3,12}$/.test(input.code)) throw new TelegramAccountError("请检查验证码。", 400);
        try {
          const authorization = await bounded(client, client.invoke(new Api.auth.SignIn({ phoneNumber: pending.phone, phoneCodeHash: pending.phoneCodeHash, phoneCode: input.code })));
          if (!(authorization instanceof Api.auth.Authorization)) throw new TelegramAccountError("请使用已经注册的 Telegram 账号。", 400);
        } catch (error) {
          const raw = error as { errorMessage?: string };
          if (raw.errorMessage !== "SESSION_PASSWORD_NEEDED") throw error;
          renew(db, claim);
          pending.session = String(client.session.save());
          db.prepare("UPDATE telegram_personal_account SET pending_ciphertext=?,stage='password',last_error='',next_attempt_at=0 WHERE id='primary' AND lease_id=?")
            .run(seal(pending), claim.leaseId);
          return accountStatus();
        }
      } else {
        if (!input.password || input.password.length > 256) throw new TelegramAccountError("请检查两步验证密码。", 400);
        await bounded(client, client.signInWithPassword(pending, { password: async () => input.password, onError: error => { throw error; } }));
      }
      renew(db, claim);
      await completeLogin(db, claim, client);
    } else {
      client = makeClient(unseal<Credentials>(claim.row.config_ciphertext), unseal<string>(claim.row.session_ciphertext));
      await bounded(client, client.connect());
      if (input.action === "refresh") await refreshChannels(db, claim, client);
      else await selectChannels(db, claim, client, input.channelIds);
    }
    return accountStatus();
  } catch (error) { throw recordFailure(db, claim, error, input.action); }
  finally { release(db, claim); await closeClient(client); }
}

function captionEntities(entities: Api.TypeMessageEntity[] | undefined) {
  const types: Record<string, string> = { MessageEntityUrl: "url", MessageEntityTextUrl: "text_link", MessageEntityMention: "mention", MessageEntityMentionName: "text_mention", MessageEntityEmail: "email", MessageEntityPhone: "phone_number" };
  return (entities || []).flatMap(entity => types[entity.className] ? [{ type: types[entity.className], offset: entity.offset, length: entity.length }] : []);
}
function ownButtons(message: Api.Message) {
  if (!(message.replyMarkup instanceof Api.ReplyInlineMarkup)) return false;
  const urls = message.replyMarkup.rows.flatMap(buttonRow => buttonRow.buttons.flatMap(button => button.type instanceof Api.InlineButtonTypeUrl ? [button.type.url.toLowerCase().replace(/\/$/, "")] : []));
  return ["https://365freebonus.com", "https://t.me/join365freebonus", "https://t.me/freebonus365chatbot"].every(url => urls.includes(url));
}
function eligibleMedia(message: Api.Message, protectedChannel: boolean, botId: number) {
  if (protectedChannel || message.noforwards || !message.message?.trim() || message.message.length > 16_384 || ownButtons(message)) return null;
  if (message.viaBotId?.toString() === String(botId) || message.senderId?.toString() === String(botId)) return null;
  // Getter message.photo/document also exposes web-page preview media. Only
  // actual attached photo/video/GIF posts qualify for this relay.
  const photo = message.media instanceof Api.MessageMediaPhoto ? message.media.photo : undefined;
  if (photo instanceof Api.Photo) return { mediaKind: "photo" as const, mediaId: `photo-${photo.id}`, max: MAX_PHOTO };
  const document = message.media instanceof Api.MessageMediaDocument ? message.media.document : undefined;
  if (document instanceof Api.Document && (document.mimeType === "image/gif" || document.attributes.some(attribute => attribute instanceof Api.DocumentAttributeAnimated))) {
    if (Number(document.size.toString()) > MAX_ANIMATION) return null;
    return { mediaKind: "animation" as const, mediaId: `animation-${document.id}`, max: MAX_ANIMATION };
  }
  if (document instanceof Api.Document && document.mimeType.length <= 100 && /^video\/[a-z0-9.+-]+$/i.test(document.mimeType)
    && document.attributes.some(attribute => attribute instanceof Api.DocumentAttributeVideo && !attribute.roundMessage)) {
    if (Number(document.size.toString()) > MAX_VIDEO) return null;
    return { mediaKind: "video" as const, mediaId: `video-${document.id}`, max: MAX_VIDEO, mimeType: document.mimeType.toLowerCase() };
  }
  return null;
}

/** Catch up from per-channel durable cursors; new selections start at the latest message. */
export async function pollTelegramAccountOnce() {
  const db = getSqlite();
  const current = row(db);
  if (current.stage !== "connected" || !current.session_ciphertext || current.next_attempt_at > Date.now() || current.lease_until > Date.now()) return;
  const relay = db.prepare("SELECT relay_enabled,relay_revision,relay_started_at FROM telegram_promotion_settings WHERE id='primary'").get() as { relay_enabled: number; relay_revision: string; relay_started_at: number } | undefined;
  const target = db.prepare("SELECT target_chat_id,ready_until,bot_id,revision FROM telegram_relay_state WHERE id='primary'").get() as { target_chat_id: number; ready_until: number; bot_id: number; revision: string } | undefined;
  const ready = relay?.relay_enabled === 1 && target && target.ready_until > Date.now() && target.revision === relay.relay_revision && target.target_chat_id < 0;
  const refreshDue = current.synced_at < Date.now() - REFRESH_MS;
  const source = ready ? db.prepare(`SELECT * FROM telegram_personal_sources WHERE selected=1 AND joined=1
    AND chat_id<>? ORDER BY CASE WHEN chat_id>? THEN 0 ELSE 1 END,chat_id LIMIT 1`).get(target.target_chat_id, current.poll_source_id) as SourceRow | undefined : undefined;
  if (!refreshDue && !source) return;
  const claim = claimAccount(db, Date.now(), { connected: true, respectBackoff: true });
  let client: TelegramClient | undefined;
  try {
    client = makeClient(unseal<Credentials>(claim.row.config_ciphertext), unseal<string>(claim.row.session_ciphertext));
    await bounded(client, client.connect());
    if (refreshDue) await refreshChannels(db, claim, client);
    if (!source || !ready || !relay || !target) return;
    const selected = db.prepare("SELECT * FROM telegram_personal_sources WHERE chat_id=? AND selected=1 AND joined=1").get(source.chat_id) as SourceRow | undefined;
    if (!selected) return;
    const peer = inputPeer(selected);
    const entity = await bounded(client, client.getEntity(peer.input));
    renew(db, claim);
    if (!(entity instanceof Api.Channel) || !entity.broadcast || entity.left) throw Object.assign(new Error(), { errorMessage: "CHANNEL_PRIVATE" });
    transaction(db, () => {
      db.prepare("UPDATE telegram_personal_sources SET blocked=? WHERE chat_id=?").run(Number(entity.noforwards === true), selected.chat_id);
      if (entity.noforwards) cancelSourceQueue(db, selected.chat_id);
    });
    const iterator = client.iterMessages(peer.input, { minId: selected.last_message_id, reverse: true, limit: 20 })[Symbol.asyncIterator]();
    const pollDeadline = Date.now() + 40_000;
    let last = selected.last_message_id;
    for (;;) {
      if (Date.now() >= pollDeadline) break;
      renew(db, claim);
      const next = await bounded(client, iterator.next());
      if (next.done) break;
      const message = next.value;
      if (!Number.isSafeInteger(message.id) || message.id <= last) continue;
      if (!(message instanceof Api.Message) || message.date * 1000 < Math.floor(Math.max(selected.selected_at, relay.relay_started_at) / 1000) * 1000) {
        last = message.id;
      } else {
        const media = eligibleMedia(message, entity.noforwards === true || peer.protected, target.bot_id);
        if (!media) last = message.id;
        else {
          renew(db, claim);
          let bytes: string | Buffer | undefined;
          let oversized = false;
          try {
            bytes = await bounded(client, client.downloadMedia(message, {
              signal: AbortSignal.timeout(REQUEST_MS), requestTimeout: REQUEST_MS,
              progressCallback: (downloaded, total) => {
                if (Number(downloaded.toString()) > media.max || Number(total.toString()) > media.max) throw new OversizeMediaError();
              },
            }));
          } catch (error) { if (!(error instanceof OversizeMediaError)) throw error; oversized = true; }
          renew(db, claim);
          if (oversized || (Buffer.isBuffer(bytes) && bytes.length > media.max)) {
            last = message.id;
          } else {
            if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new TelegramAccountError(TEMP_ERROR, 502);
            const { enqueuePersonalRelayMedia } = await import("./telegram-relay");
            const consumed = await enqueuePersonalRelayMedia({ sourceChatId: selected.chat_id, sourceMessageId: message.id,
              sourceDate: message.date, relayRevision: relay.relay_revision,
              mediaGroupId: message.groupedId?.toString() || "", caption: message.message, captionEntities: captionEntities(message.entities),
              mediaKind: media.mediaKind, bytes, hasSpoiler: (message.media instanceof Api.MessageMediaPhoto || message.media instanceof Api.MessageMediaDocument) && message.media.spoiler === true,
              sourceMediaId: media.mediaId, accountGeneration: claim.row.generation,
              ...(media.mediaKind === "video" ? { mimeType: media.mimeType } : {}) });
            renew(db, claim);
            if (!consumed) break;
            last = message.id;
          }
        }
      }
      if (last > selected.last_message_id) db.prepare(`UPDATE telegram_personal_sources SET last_message_id=MAX(last_message_id,?)
        WHERE chat_id=? AND selected=1 AND joined=1 AND EXISTS(SELECT 1 FROM telegram_personal_account WHERE id='primary' AND generation=? AND lease_id=?)`)
        .run(last, selected.chat_id, claim.row.generation, claim.leaseId);
    }
    renew(db, claim);
    saveSession(db, claim, client);
    db.prepare("UPDATE telegram_personal_account SET last_polled_at=?,poll_source_id=? WHERE id='primary' AND lease_id=?").run(Date.now(), selected.chat_id, claim.leaseId);
  } catch (error) {
    const raw = error as { errorMessage?: string };
    if (source && /CHANNEL_PRIVATE|CHANNEL_INVALID|USER_BANNED_IN_CHANNEL|CHAT_FORBIDDEN/.test(raw.errorMessage || "") && owns(db, claim)) {
      transaction(db, () => {
        db.prepare("UPDATE telegram_personal_sources SET selected=0,joined=0 WHERE chat_id=?").run(source.chat_id);
        cancelSourceQueue(db, source.chat_id);
        db.prepare("UPDATE telegram_personal_account SET last_error=?,poll_source_id=? WHERE id='primary' AND lease_id=?")
          .run("一个来源频道已无法访问，已停止转发该频道，请刷新列表。", source.chat_id, claim.leaseId);
      });
    } else {
      recordFailure(db, claim, error);
      if (source && owns(db, claim)) db.prepare("UPDATE telegram_personal_account SET poll_source_id=? WHERE id='primary' AND lease_id=?").run(source.chat_id, claim.leaseId);
    }
  } finally { release(db, claim); await closeClient(client); }
}

const workers = globalThis as typeof globalThis & { telegramAccountWorkerStarted?: boolean };
export function startTelegramAccountWorker() {
  if (workers.telegramAccountWorkerStarted) return;
  workers.telegramAccountWorkerStarted = true;
  let running = false;
  const poll = async () => {
    if (running) return;
    running = true;
    try { await pollTelegramAccountOnce(); }
    catch { /* All Telegram/credential details stay private; next interval retries. */ }
    finally { running = false; }
  };
  void poll();
  setInterval(() => void poll(), POLL_MS).unref();
}

export { makeClient as createTelegramAccountClient };
