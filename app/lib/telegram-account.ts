import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Api, Logger, TelegramClient, utils } from "teleproto";
import { StringSession } from "teleproto/sessions";
import bigInt from "big-integer";
import { getSqlite } from "./sqlite";
import { captionWatchAccountPriority } from "./telegram-caption-watch-cycle";
import { inspectRelayDelivery, isRelayCustomEmojiId, normalizeRelayCaptionEntities, relayCaptionEntitiesMatch, relayCaptionFormattingMatches, relayKeyboard, type RelayCaptionEntity } from "./telegram-relay-content";

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
type SourcePostRow = {
  source_chat_id: number; source_message_id: number; account_generation: string; relay_revision: string;
  selected_at: number; source_date: number; media_id_hash: string; revision_hash: string; checked_at: number;
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
const SOURCE_RECHECK_MS = 30_000;
const SOURCE_RECHECK_BATCH = 20;
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
  const edits = db.prepare(`UPDATE telegram_relay_source_edits SET status='superseded',outcome='source_inactive'
    WHERE status='pending' AND outbox_id IN(SELECT id FROM telegram_relay_outbox WHERE origin='account'${filter})`);
  if (sourceId === undefined) edits.run(); else edits.run(sourceId);
  if (sourceId === undefined) db.prepare("DELETE FROM telegram_personal_source_posts").run();
  else db.prepare("DELETE FROM telegram_personal_source_posts WHERE source_chat_id=?").run(sourceId);
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

function claimAccount(db: DatabaseSync, now: number, options: {
  connected?: boolean; respectBackoff?: boolean; purpose?: "interactive" | "caption" | "background";
} = {}): Claim {
  const claim = transaction(db, () => {
    const current = row(db);
    if (options.connected && (current.stage !== "connected" || !current.session_ciphertext)) throw new TelegramAccountError(REAUTH_ERROR, 409);
    if (current.lease_until > now) throw new TelegramAccountError(BUSY_ERROR, 409);
    if (options.respectBackoff && current.next_attempt_at > now) {
      const seconds = Math.max(1, Math.ceil((current.next_attempt_at - now) / 1000));
      const explanation = /^Telegram 正在限制请求频率/.test(current.last_error)
        ? "Telegram 正在限制请求频率" : "上次操作未完成，系统正在等待重试";
      throw new TelegramAccountError(`${explanation}，请在 ${seconds} 秒后再试。`, 429);
    }
    // Only short-lived background work yields. Owner actions remain available,
    // and caption workers still obey the real lease and Telegram wait above.
    if (options.purpose === "background" && captionWatchAccountPriority(db, now)) return null;
    const leaseId = randomUUID();
    db.prepare("UPDATE telegram_personal_account SET lease_id=?,lease_until=? WHERE id='primary'").run(leaseId, now + LEASE_MS);
    return { row: current, leaseId };
  });
  // Commit the bounded scheduling hint even when this background caller yields.
  if (!claim) throw new TelegramAccountError(BUSY_ERROR, 409);
  return claim;
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
async function closeClient(client: TelegramClient | undefined, timeout = 2000) {
  if (!client) return;
  // destroy also stops update and keepalive loops created by a transient client.
  await Promise.race([client.destroy().catch(() => undefined), new Promise<void>(resolve => {
    const timer = setTimeout(resolve, Math.max(1, timeout)); timer.unref();
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

function captionEntities(entities: Api.TypeMessageEntity[] | undefined, keepLinkUrls = false) {
  type CaptionEntity = RelayCaptionEntity;
  const types: Record<string, string> = {
    MessageEntityUrl: "url", MessageEntityTextUrl: "text_link", MessageEntityMention: "mention",
    MessageEntityMentionName: "text_mention", InputMessageEntityMentionName: "text_mention",
    MessageEntityEmail: "email", MessageEntityPhone: "phone_number", MessageEntityHashtag: "hashtag",
    MessageEntityCashtag: "cashtag", MessageEntityBotCommand: "bot_command", MessageEntityBold: "bold",
    MessageEntityItalic: "italic", MessageEntityUnderline: "underline", MessageEntityStrike: "strikethrough",
    MessageEntitySpoiler: "spoiler", MessageEntityCode: "code", MessageEntityPre: "pre",
    MessageEntityCustomEmoji: "custom_emoji", MessageEntityBlockquote: "blockquote", MessageEntityFormattedDate: "date_time",
  };
  return (entities || []).flatMap((entity): CaptionEntity[] => {
    const type = types[entity.className];
    if (!type || !Number.isSafeInteger(entity.offset) || entity.offset < 0 || !Number.isSafeInteger(entity.length) || entity.length <= 0) return [];
    const converted: CaptionEntity = { type, offset: entity.offset, length: entity.length };
    if (entity.className === "MessageEntityCustomEmoji") {
      // Keep the ID as a decimal string: these 64-bit document identifiers can
      // exceed JavaScript's safe integer range. The caption keeps its original
      // fallback glyph while Telegram renders the corresponding custom emoji.
      let id = "";
      try { id = entity.documentId?.toString() || ""; } catch { return []; }
      if (!isRelayCustomEmojiId(id)) return [];
      converted.custom_emoji_id = id;
    } else if (entity.className === "MessageEntityTextUrl" && keepLinkUrls) {
      if (typeof entity.url !== "string") return [];
      converted.url = entity.url;
    } else if (entity.className === "MessageEntityPre") {
      if (typeof entity.language === "string" && entity.language.length <= 100) converted.language = entity.language;
    } else if (entity.className === "MessageEntityBlockquote") {
      if (entity.collapsed) converted.type = "expandable_blockquote";
    } else if (entity.className === "MessageEntityFormattedDate") {
      if (!Number.isSafeInteger(entity.date) || entity.date < 0) return [];
      converted.unix_time = entity.date;
      converted.date_time_format = entity.relative ? "r" : `${entity.dayOfWeek ? "w" : ""}${entity.longDate ? "D" : entity.shortDate ? "d" : ""}${entity.longTime ? "T" : entity.shortTime ? "t" : ""}`;
    }
    return [converted];
  });
}
function ownButtons(message: Api.Message) {
  if (!(message.replyMarkup instanceof Api.ReplyInlineMarkup)) return false;
  const urls = message.replyMarkup.rows.flatMap(buttonRow => buttonRow.buttons.flatMap(button => button.type instanceof Api.InlineButtonTypeUrl ? [button.type.url.toLowerCase().replace(/\/$/, "")] : []));
  return ["https://365freebonus.com", "https://t.me/join365freebonus", "https://t.me/freebonus365chatbot"].every(url => urls.includes(url));
}
function eligibleMedia(message: Api.Message, protectedChannel: boolean, botId: number, requireCaption = true) {
  if (protectedChannel || message.noforwards || requireCaption && !message.message?.trim() || (message.message || "").length > 16_384 || ownButtons(message)) return null;
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

function sourceMediaHash(mediaId: string) { return createHash("sha256").update(mediaId).digest("hex"); }
function sourcePostHash(message: Api.Message, mediaId: string) {
  // editDate has second precision and Telegram may change entities without
  // changing its value. Compare complete content snapshots instead.
  return createHash("sha256").update(JSON.stringify([message.message || "", captionEntities(message.entities, true),
    (message.entities || []).map(entity => entity.className), mediaId, message.groupedId?.toString() || "",
    (message.media instanceof Api.MessageMediaPhoto || message.media instanceof Api.MessageMediaDocument) && message.media.spoiler === true])).digest("hex");
}
function pruneSourcePosts(db: DatabaseSync, generation: string, revision: string) {
  db.prepare(`DELETE FROM telegram_personal_source_posts WHERE account_generation<>? OR relay_revision<>?
    OR NOT EXISTS(SELECT 1 FROM telegram_personal_sources s WHERE s.chat_id=source_chat_id
      AND s.selected=1 AND s.joined=1 AND s.blocked=0 AND s.selected_at=telegram_personal_source_posts.selected_at)`).run(generation, revision);
  // Confirmed deliveries retain their source watches for as long as the
  // selection is active. Only not-yet-forwarded candidates use bounded history.
  db.exec(`DELETE FROM telegram_personal_source_posts WHERE rowid IN (
    SELECT rowid FROM (SELECT rowid,ROW_NUMBER() OVER(PARTITION BY source_chat_id ORDER BY source_message_id DESC) AS position
      FROM telegram_personal_source_posts w WHERE NOT EXISTS(SELECT 1 FROM telegram_relay_outbox o
        WHERE o.source_chat_id=w.source_chat_id AND o.source_message_id=w.source_message_id AND o.origin='account'
        AND o.status='sent' AND o.account_generation=w.account_generation AND o.revision=w.relay_revision)) WHERE position>512);
    DELETE FROM telegram_personal_source_posts WHERE rowid IN (
      SELECT rowid FROM telegram_personal_source_posts w WHERE NOT EXISTS(SELECT 1 FROM telegram_relay_outbox o
        WHERE o.source_chat_id=w.source_chat_id AND o.source_message_id=w.source_message_id AND o.origin='account'
        AND o.status='sent' AND o.account_generation=w.account_generation AND o.revision=w.relay_revision)
      ORDER BY source_date DESC,source_chat_id,source_message_id DESC LIMIT -1 OFFSET 4096);`);
}
function rememberSourcePost(db: DatabaseSync, source: SourceRow, message: Api.Message, mediaId: string,
  generation: string, revision: string, acceptedHash = "") {
  db.prepare(`INSERT INTO telegram_personal_source_posts(source_chat_id,source_message_id,account_generation,relay_revision,
    selected_at,source_date,media_id_hash,revision_hash,checked_at) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(source_chat_id,source_message_id) DO NOTHING`).run(source.chat_id, message.id, generation, revision,
    source.selected_at, message.date, sourceMediaHash(mediaId), acceptedHash, Date.now());
  pruneSourcePosts(db, generation, revision);
}
function bootstrapSourcePosts(db: DatabaseSync, source: SourceRow, generation: string, revision: string) {
  const previous = db.prepare("SELECT account_generation,relay_revision,selected_at FROM telegram_personal_source_scopes WHERE source_chat_id=?")
    .get(source.chat_id) as { account_generation: string; relay_revision: string; selected_at: number } | undefined;
  if (previous?.account_generation === generation && previous.relay_revision === revision && previous.selected_at === source.selected_at) return;
  // Upgrade only already delivered, positively identified account posts. Never
  // discover arbitrary historical IDs or rearm a removed/protected watch.
  transaction(db, () => {
    db.prepare(`INSERT INTO telegram_personal_source_scopes(source_chat_id,account_generation,relay_revision,selected_at,bootstrapped_at)
      VALUES(?,?,?,?,?) ON CONFLICT(source_chat_id) DO UPDATE SET account_generation=excluded.account_generation,
      relay_revision=excluded.relay_revision,selected_at=excluded.selected_at,bootstrapped_at=excluded.bootstrapped_at`)
      .run(source.chat_id, generation, revision, source.selected_at, Date.now());
    const posts = db.prepare(`SELECT source_message_id,file_unique_id FROM telegram_relay_outbox WHERE source_chat_id=?
      AND origin='account' AND account_generation=? AND revision=? AND queued_at>=? AND status='sent'
      AND typeof(message_id)='integer' AND message_id BETWEEN 1 AND 2147483647
      AND media_kind IN ('photo','video','animation') ORDER BY source_message_id DESC`)
      .all(source.chat_id, generation, revision, source.selected_at) as { source_message_id: number; file_unique_id: string }[];
    const insert = db.prepare(`INSERT OR IGNORE INTO telegram_personal_source_posts(source_chat_id,source_message_id,
      account_generation,relay_revision,selected_at,source_date,media_id_hash,revision_hash,checked_at) VALUES(?,?,?,?,?,0,?,'',0)`);
    for (const post of posts) if (Number.isSafeInteger(post.source_message_id) && post.source_message_id > 0 && /^[a-f0-9]{64}$/.test(post.file_unique_id))
      insert.run(source.chat_id, post.source_message_id, generation, revision, source.selected_at, post.file_unique_id);
    pruneSourcePosts(db, generation, revision);
  });
}

type SourceEmojiSample = {
  state: "ok" | "disconnected" | "busy" | "backoff" | "unavailable";
  sourcesSampled: number; messagesSampled: number; customEmojiEntities: number;
  negativeCustomEmojiEntities: number; unrepresentableCustomEmojiEntities: number;
};

type RelayDeliverySample = {
  state: SourceEmojiSample["state"];
  sampledPosts: number; matchingCaptions: number; customEmojiPosts: number; preservedCustomEmojiPosts: number;
  safeLinkPosts: number; matchingButtonPosts: number; invalidReferences: number;
  personalEditQualification: "qualified" | "not_premium" | "not_channel_admin" | "unknown";
};

function relayDeliveryMessage(message: Api.Message) {
  if (message.entities && (!Array.isArray(message.entities) || message.entities.length > 1024)) return null;
  const entities = captionEntities(message.entities, true);
  if (entities.length !== (message.entities || []).length) return null;
  const markup = message.replyMarkup instanceof Api.ReplyInlineMarkup ? { inline_keyboard: message.replyMarkup.rows.map(buttonRow => buttonRow.buttons.map(button =>
    button.type instanceof Api.InlineButtonTypeUrl ? { text: button.text, url: button.type.url } : { text: button.text, unsupported: true })) } : undefined;
  return { caption: message.message, caption_entities: entities, reply_markup: markup };
}

/** Convert only validated relay entities; unsupported or lossy conversion forbids an edit. */
function editableCaptionEntities(entities: RelayCaptionEntity[]): Api.TypeMessageEntity[] | null {
  const converted: Api.TypeMessageEntity[] = [];
  for (const entity of entities) {
    const span = { offset: entity.offset, length: entity.length };
    switch (entity.type) {
      case "bold": converted.push(new Api.MessageEntityBold(span)); break;
      case "italic": converted.push(new Api.MessageEntityItalic(span)); break;
      case "underline": converted.push(new Api.MessageEntityUnderline(span)); break;
      case "strikethrough": converted.push(new Api.MessageEntityStrike(span)); break;
      case "spoiler": converted.push(new Api.MessageEntitySpoiler(span)); break;
      case "code": converted.push(new Api.MessageEntityCode(span)); break;
      case "pre": converted.push(new Api.MessageEntityPre({ ...span, language: entity.language || "" })); break;
      case "blockquote": case "expandable_blockquote":
        converted.push(new Api.MessageEntityBlockquote({ ...span, collapsed: entity.type === "expandable_blockquote" })); break;
      case "hashtag": converted.push(new Api.MessageEntityHashtag(span)); break;
      case "cashtag": converted.push(new Api.MessageEntityCashtag(span)); break;
      case "bot_command": converted.push(new Api.MessageEntityBotCommand(span)); break;
      case "url": converted.push(new Api.MessageEntityUrl(span)); break;
      case "text_link":
        if (typeof entity.url !== "string") return null;
        converted.push(new Api.MessageEntityTextUrl({ ...span, url: entity.url })); break;
      case "custom_emoji":
        if (!isRelayCustomEmojiId(entity.custom_emoji_id)) return null;
        converted.push(new Api.MessageEntityCustomEmoji({ ...span, documentId: bigInt(entity.custom_emoji_id) })); break;
      case "date_time": {
        if (!Number.isSafeInteger(entity.unix_time) || Number(entity.unix_time) < 0 || Number(entity.unix_time) > 2147483647) return null;
        const format = entity.date_time_format || "";
        if (!/^(?:r|w?[dD]?[tT]?)$/.test(format)) return null;
        converted.push(new Api.MessageEntityFormattedDate({ ...span, date: Number(entity.unix_time), relative: format === "r",
          shortTime: format.includes("t"), longTime: format.includes("T"), shortDate: format.includes("d"), longDate: format.includes("D"), dayOfWeek: format.includes("w") }));
        break;
      }
      default: return null;
    }
  }
  return converted;
}

type AccountCaptionEdit = {
  state: SourceEmojiSample["state"]; attempted: boolean;
  outcome: "preserved" | "changed" | "rejected" | "uncertain" | "invalid" | "unavailable";
  retryAt?: number;
  reason?: RelayCaptionPreflightReason;
};

type RelayCaptionPreflightReason = "input_invalid" | "expected_entities_invalid" | "expected_links_unsafe" | "expected_buttons_invalid"
  | "stored_entities_invalid" | "stored_entities_mismatch" | "message_not_found" | "message_identity_invalid" | "message_not_direct_post"
  | "media_invalid" | "actual_entities_unsupported" | "caption_mismatch" | "actual_links_unsafe" | "buttons_mismatch"
  | "target_unqualified" | "account_unqualified" | "source_inactive" | "ready_to_edit" | "already_preserved" | "watch_readonly"
  | "identity_unverified" | "source_caption_missing" | "source_identity_invalid" | "source_media_changed" | "source_capture_waiting";

type BlockedCaptionReference = {
  id: number; message_id: number | null; caption: string; caption_entities: string; caption_edit_outcome: string;
  origin: string; account_generation: string; queued_at: number; source_chat_id: number;
};
function customEmojiSubset(caption: string, expected: RelayCaptionEntity[], actual: RelayCaptionEntity[]) {
  return relayCaptionEntitiesMatch(caption, expected.filter(entity => entity.type === "custom_emoji"),
    actual.filter(entity => entity.type === "custom_emoji"), { allowMissingCustomEmoji: true });
}
function captionEntityCoverage(expected: RelayCaptionEntity[], actual: RelayCaptionEntity[]) {
  const coverage = (entities: RelayCaptionEntity[]) => {
    let total = 0, end = -1;
    for (const entity of [...entities].sort((left, right) => left.offset - right.offset || left.length - right.length)) {
      const nextEnd = entity.offset + entity.length;
      total += Math.max(0, nextEnd - Math.max(entity.offset, end)); end = Math.max(end, nextEnd);
    }
    return total;
  };
  return [...new Set([...expected, ...actual].map(entity => entity.type))].sort().map(type => {
    const wanted = expected.filter(entity => entity.type === type), received = actual.filter(entity => entity.type === type);
    return { type, expectedCount: wanted.length, actualCount: received.length,
      expectedCoveredUtf16: coverage(wanted), actualCoveredUtf16: coverage(received) };
  });
}
function blockedCaptionSummary(reference: BlockedCaptionReference, sourceActive: boolean, targetChatId: number,
  qualification: RelayDeliverySample["personalEditQualification"], message?: Api.Message) {
  const caption = typeof reference.caption === "string" ? reference.caption : "";
  let raw: unknown, expected: RelayCaptionEntity[] = [], storedEntitiesValid = false, unsupportedExpectedEntityCount = 0;
  try {
    raw = JSON.parse(reference.caption_entities);
    expected = normalizeRelayCaptionEntities(caption, raw);
    storedEntitiesValid = Array.isArray(raw) && raw.length <= 1024 && expected.length === raw.length;
    if (Array.isArray(raw)) unsupportedExpectedEntityCount = raw.slice(0, 1024).filter(value => {
      const normalized = normalizeRelayCaptionEntities(caption, [value]);
      return normalized.length !== 1 || !editableCaptionEntities(normalized);
    }).length + Math.max(0, raw.length - 1024);
  } catch { /* Only fixed flags and counts leave this read-only audit. */ }
  const inputValid = Number.isSafeInteger(reference.message_id) && Number(reference.message_id) > 0
    && Number(reference.message_id) <= 2147483647 && typeof reference.caption === "string" && !!caption.trim() && caption.length <= 1024;
  let peerMatches = false;
  try { peerMatches = !!message?.peerId && Number(utils.getPeerId(message.peerId)) === targetChatId; } catch { /* Invalid peer shape. */ }
  const messageFound = message instanceof Api.Message, idMatches = messageFound && message.id === reference.message_id;
  const isPost = message?.post === true, viaBot = message?.viaBotId != null;
  const viaBusinessBot = (message as (Api.Message & { viaBusinessBotId?: unknown }) | undefined)?.viaBusinessBotId != null;
  const forwarded = message?.fwdFrom != null;
  let mediaValid = false;
  try {
    const media = message?.media instanceof Api.MessageMediaPhoto && message.media.photo instanceof Api.Photo ? message.media.photo
      : message?.media instanceof Api.MessageMediaDocument && message.media.document instanceof Api.Document ? message.media.document : null;
    mediaValid = !!media && isRelayCustomEmojiId(media.id.toString());
  } catch { /* Invalid media references are reported as a boolean. */ }
  const actualText = typeof message?.message === "string" ? message.message : "";
  const actualEntityCount = Array.isArray(message?.entities) ? message.entities.length : 0;
  let actual: ReturnType<typeof relayDeliveryMessage> = null, convertibleEntityCount = 0;
  try {
    if (actualEntityCount <= 1024 && (!message?.entities || Array.isArray(message.entities))) {
      convertibleEntityCount = captionEntities(message?.entities, true).length;
      if (messageFound) actual = relayDeliveryMessage(message);
    }
  } catch { /* Unknown TL data never enters a diagnostic string. */ }
  const unsupportedActualEntityCount = Math.max(0, actualEntityCount - convertibleEntityCount);
  const prepared = inspectRelayDelivery(caption, expected, { caption, caption_entities: expected, reply_markup: { inline_keyboard: relayKeyboard() } });
  const inspected = inspectRelayDelivery(caption, expected, actual);
  const actualEntities = actual?.caption_entities || [];
  const actualCustomSubset = !!actual && customEmojiSubset(caption, expected, actualEntities);
  const semanticFormattingMatches = !!actual && relayCaptionFormattingMatches(caption, expected, actualEntities);
  let reason: RelayCaptionPreflightReason = "ready_to_edit";
  if (!inputValid) reason = "input_invalid";
  else if (!storedEntitiesValid) reason = "stored_entities_invalid";
  else if (unsupportedExpectedEntityCount || !editableCaptionEntities(expected)) reason = "expected_entities_invalid";
  else if (!prepared.linksSafe) reason = "expected_links_unsafe";
  else if (!sourceActive) reason = "source_inactive";
  else if (qualification === "not_channel_admin") reason = "target_unqualified";
  else if (qualification !== "qualified") reason = "account_unqualified";
  else if (!messageFound) reason = "message_not_found";
  else if (!idMatches || !peerMatches) reason = "message_identity_invalid";
  else if (!isPost || viaBot || viaBusinessBot || forwarded) reason = "message_not_direct_post";
  else if (!mediaValid) reason = "media_invalid";
  else if (!actual) reason = "actual_entities_unsupported";
  else if (!inspected.captionMatches) reason = "caption_mismatch";
  else if (!inspected.linksSafe) reason = "actual_links_unsafe";
  else if (!inspected.buttonsMatch) reason = "buttons_mismatch";
  else if (!actualCustomSubset) reason = "stored_entities_mismatch";
  else if (inspected.customEmojiPreserved && semanticFormattingMatches) reason = "already_preserved";
  const outcomes = ["invalid", "changed", "rejected", "preserved", "uncertain", "account_invalid", "account_invalid_final", "account_changed", "account_rejected",
    "account_preserved", "account_uncertain", "account_unavailable_final", "account_unavailable"] as const;
  const snapshotOutcome = outcomes.find(outcome => outcome === reference.caption_edit_outcome) || "other";
  const leading = (value: string) => /^\s*/u.exec(value)?.[0].length || 0;
  const trailing = (value: string) => /\s*$/u.exec(value)?.[0].length || 0;
  const count = (value: string, pattern: RegExp) => [...value.matchAll(pattern)].length;
  let firstDifference = -1;
  for (let index = 0; index < Math.max(caption.length, actualText.length); index++) if (caption[index] !== actualText[index]) { firstDifference = index; break; }
  const differenceKind = (value: string): "none" | "end" | "whitespace" | "control" | "variation" | "ordinary" => {
    if (firstDifference < 0) return "none";
    const point = value.codePointAt(firstDifference);
    if (point === undefined) return "end";
    if (point >= 0xFE00 && point <= 0xFE0F || point >= 0xE0100 && point <= 0xE01EF) return "variation";
    if (point <= 0x1F || point >= 0x7F && point <= 0x9F || /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u.test(String.fromCodePoint(point))) return "control";
    return /\s/u.test(String.fromCodePoint(point)) ? "whitespace" : "ordinary";
  };
  return { reason, snapshotOutcome, inputValid, sourceActive, storedEntitiesValid,
    actualCustomSubset, semanticFormattingMatches,
    exactEntitiesMatch: !!actual && relayCaptionEntitiesMatch(caption, expected, actualEntities),
    entityCoverage: captionEntityCoverage(expected, actualEntities),
    expectedEntityCount: Array.isArray(raw) ? raw.length : 0, unsupportedExpectedEntityCount,
    expectedCustomEmoji: expected.filter(entity => entity.type === "custom_emoji").length,
    messageFound, idMatches, peerMatches, isPost, viaBot, viaBusinessBot, forwarded, mediaValid,
    captionMatches: messageFound && actualText === caption, trimmedCaptionMatches: messageFound && actualText.trim() === caption.trim(),
    lineEndingNormalizedMatches: messageFound && actualText.replace(/\r\n/g, "\n") === caption.replace(/\r\n/g, "\n"),
    expectedUtf16Length: caption.length, actualUtf16Length: actualText.length,
    expectedLeadingWhitespace: leading(caption), expectedTrailingWhitespace: trailing(caption),
    actualLeadingWhitespace: leading(actualText), actualTrailingWhitespace: trailing(actualText),
    expectedCarriageReturns: count(caption, /\r/g), actualCarriageReturns: count(actualText, /\r/g),
    expectedTabs: count(caption, /\t/g), actualTabs: count(actualText, /\t/g), expectedLineFeeds: count(caption, /\n/g), actualLineFeeds: count(actualText, /\n/g),
    expectedVariationSelectors16: count(caption, /\uFE0F/g), actualVariationSelectors16: count(actualText, /\uFE0F/g),
    expectedZeroWidthControls: count(caption, /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g),
    actualZeroWidthControls: count(actualText, /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g),
    expectedOtherControls: count(caption, /[\u0000-\u0009\u000B-\u001F]/g), actualOtherControls: count(actualText, /[\u0000-\u0009\u000B-\u001F]/g),
    firstDifference, firstDifferenceExpectedKind: differenceKind(caption), firstDifferenceActualKind: differenceKind(actualText),
    linksSafe: inspected.linksSafe, buttonsMatch: inspected.buttonsMatch, customEmojiPreserved: inspected.customEmojiPreserved,
    actualEntityCount, convertibleEntityCount, unsupportedActualEntityCount };
}

/** Diagnose a bounded terminal snapshot; never rearm, edit or mutate its queue rows. */
export async function inspectBlockedRelayCaptionPreflights(): Promise<{
  state: SourceEmojiSample["state"]; personalEditQualification: RelayDeliverySample["personalEditQualification"];
  posts: ReturnType<typeof blockedCaptionSummary>[];
}> {
  const empty = { state: "ok" as SourceEmojiSample["state"], personalEditQualification: "unknown" as RelayDeliverySample["personalEditQualification"],
    posts: [] as ReturnType<typeof blockedCaptionSummary>[] };
  const db = getSqlite(), current = row(db), now = Date.now();
  if (current.stage !== "connected" || !current.session_ciphertext) return { ...empty, state: "disconnected" };
  if (current.lease_until > now) return { ...empty, state: "busy" };
  if (current.next_attempt_at > now) return { ...empty, state: "backoff" };
  const configuration = () => db.prepare(`SELECT relay_enabled,relay_chat_id,relay_revision,token_ciphertext
    FROM telegram_promotion_settings WHERE id='primary'`).get() as {
      relay_enabled: number; relay_chat_id: string; relay_revision: string; token_ciphertext: string;
    } | undefined;
  const runtime = () => db.prepare(`SELECT target_chat_id,target_verified_at,ready_until,revision,bot_id
    FROM telegram_relay_state WHERE id='primary'`).get() as {
      target_chat_id: number; target_verified_at: number; ready_until: number; revision: string; bot_id: number;
    } | undefined;
  const settings = configuration(), target = runtime();
  const publicTarget = settings?.relay_chat_id.match(/^(?:@([A-Za-z][A-Za-z0-9_]{3,31})|https:\/\/t\.me\/([A-Za-z][A-Za-z0-9_]{3,31})\/?)$/);
  const username = publicTarget?.[1] || publicTarget?.[2];
  if (!settings || settings.relay_enabled !== 1 || !settings.relay_revision || !settings.token_ciphertext || !username || !target
    || !Number.isSafeInteger(target.target_chat_id) || target.target_chat_id >= 0 || !Number.isSafeInteger(target.bot_id) || target.bot_id <= 0
    || target.target_verified_at <= 0 || target.target_verified_at > now || target.revision !== settings.relay_revision || target.ready_until <= now) return { ...empty, state: "unavailable" };
  const selectReferences = (exact: boolean) => db.prepare(`SELECT id,
    CASE WHEN typeof(message_id)='integer' AND message_id BETWEEN 1 AND 2147483647 THEN message_id ELSE NULL END AS message_id,
    caption,caption_entities,caption_edit_outcome,origin,account_generation,queued_at,source_chat_id
    FROM telegram_relay_outbox WHERE status='sent' AND revision=? AND sent_at>=? AND sent_at<=?
    AND ${exact ? "caption_edit_outcome='account_invalid'" : `caption_edit_outcome IN ('invalid','changed','rejected','preserved','uncertain',
      'account_invalid','account_invalid_final','account_changed','account_rejected','account_preserved','account_uncertain','account_unavailable_final','account_unavailable')
      AND last_error<>'' AND instr(caption_entities,'"custom_emoji"')>0`}
    ORDER BY sent_at DESC,id DESC LIMIT 3`).all(settings.relay_revision, now - 24 * 60 * 60_000, now) as BlockedCaptionReference[];
  const exact = selectReferences(true).length > 0, references = selectReferences(exact);
  if (!references.length) return empty;
  const sourceSnapshot = () => references.map(reference => reference.origin !== "account" ? null : db.prepare(`SELECT selected,joined,blocked,selected_at
    FROM telegram_personal_sources WHERE chat_id=?`).get(reference.source_chat_id) as {
      selected: number; joined: number; blocked: number; selected_at: number;
    } | undefined);
  const sources = sourceSnapshot(), referencesSnapshot = JSON.stringify(references), sourcesSnapshot = JSON.stringify(sources);
  const sourceActive = (reference: BlockedCaptionReference, index: number) => reference.origin !== "account"
    || reference.account_generation === current.generation && sources[index]?.selected === 1 && sources[index]?.joined === 1
      && sources[index]?.blocked === 0 && Number(sources[index]?.selected_at) <= reference.queued_at;
  const ids = [...new Set(references.flatMap(reference => reference.message_id ? [reference.message_id] : []))];
  if (!ids.length) return { ...empty, posts: references.map((reference, index) => blockedCaptionSummary(reference, sourceActive(reference, index), target.target_chat_id, "unknown")) };
  let claim: Claim;
  try { claim = claimAccount(db, Date.now(), { connected: true, respectBackoff: true, purpose: "background" }); }
  catch (error) {
    const state = error instanceof TelegramAccountError && error.status === 429 ? "backoff"
      : error instanceof TelegramAccountError && error.message === BUSY_ERROR ? "busy"
      : error instanceof TelegramAccountError && error.message === REAUTH_ERROR ? "disconnected" : "unavailable";
    return { ...empty, state };
  }
  const deadline = Date.now() + 40_000, remaining = () => Math.max(1, Math.min(REQUEST_MS, deadline - Date.now()));
  const allowed = () => {
    const latest = configuration(), latestTarget = runtime(), account = row(db);
    return Date.now() < deadline && owns(db, claim) && account.stage === "connected"
      && account.config_ciphertext === current.config_ciphertext && account.session_ciphertext === current.session_ciphertext
      && latest?.relay_enabled === 1 && latest.relay_chat_id === settings.relay_chat_id && latest.relay_revision === settings.relay_revision
      && latest.token_ciphertext === settings.token_ciphertext && latestTarget?.target_chat_id === target.target_chat_id
      && latestTarget.bot_id === target.bot_id && latestTarget.revision === settings.relay_revision && latestTarget.ready_until > Date.now()
      && latestTarget.target_verified_at > 0 && latestTarget.target_verified_at <= Date.now()
      && JSON.stringify(selectReferences(exact)) === referencesSnapshot && JSON.stringify(sourceSnapshot()) === sourcesSnapshot;
  };
  let client: TelegramClient | undefined;
  try {
    if (!allowed()) return { ...empty, state: "unavailable" };
    client = makeClient(unseal<Credentials>(claim.row.config_ciphertext), unseal<string>(claim.row.session_ciphertext));
    await bounded(client, client.connect(), remaining());
    if (!allowed()) return { ...empty, state: "unavailable" };
    renew(db, claim);
    const entity = await bounded(client, client.getEntity(`@${username}`), remaining());
    if (!allowed() || !(entity instanceof Api.Channel) || entity.min || Number(utils.getPeerId(entity)) !== target.target_chat_id) return { ...empty, state: "unavailable" };
    renew(db, claim);
    let qualification: RelayDeliverySample["personalEditQualification"] = "not_channel_admin";
    if (entity.broadcast === true && (entity.creator === true || entity.adminRights?.editMessages === true)) {
      const me = await bounded(client, client.getMe(), remaining());
      if (!allowed()) return { ...empty, state: "unavailable" };
      renew(db, claim);
      qualification = me instanceof Api.User && !me.bot && !me.deleted && !me.min ? me.premium === true ? "qualified" : "not_premium" : "unknown";
    }
    const messages = await bounded(client, client.getMessages(entity, { ids, limit: 3 }), remaining());
    if (!allowed()) return { ...empty, state: "unavailable" };
    renew(db, claim);
    const posts = references.map((reference, index) => {
      const matches = messages.filter(message => message instanceof Api.Message && message.id === reference.message_id);
      return blockedCaptionSummary(reference, sourceActive(reference, index), target.target_chat_id, qualification, matches.length === 1 ? matches[0] : undefined);
    });
    return { state: "ok", personalEditQualification: qualification, posts };
  } catch (error) {
    if (allowed() && safeError(error).status === 429 && failureCategory(error) === "telegram-rate-limit") {
      recordFailure(db, claim, error, "relay-blocked-caption-audit");
      return { ...empty, state: "backoff" };
    }
    return { ...empty, state: "unavailable" };
  } finally { release(db, claim); await closeClient(client, Math.max(1, Math.min(2000, deadline - Date.now()))); }
}

type VerifiedCaptionInput = {
  targetChatId: number; relayRevision: string; messageId: number; caption: string; captionEntities: RelayCaptionEntity[];
  sourceEdit?: { id: number; version: number; leaseId: string; expectedCaption: string; expectedCaptionEntities: RelayCaptionEntity[] };
  watch?: { leaseId: string; sourceVersion: number; sourceEditId?: number; allowRepair: boolean };
};
type AccountCaptionRecheck = Omit<AccountCaptionEdit, "outcome" | "attempted"> & {
  attempted: false; outcome: "ready" | "preserved" | "invalid" | "unavailable" | "rejected";
};
type AccountCaptionOperation = Omit<AccountCaptionEdit, "outcome"> & { outcome: AccountCaptionEdit["outcome"] | "ready" };

/** One authorized caption-only edit of one leased relay post, followed by actual readback. */
export function editVerifiedRelayCaptionWithAccount(input: VerifiedCaptionInput): Promise<AccountCaptionEdit> {
  return runVerifiedRelayCaptionWithAccount(input, "account_attempting");
}
/** Recurring checks use their own durable lease, without rearming old edit terminals. */
export function observeVerifiedRelayCaptionWithAccount(input: VerifiedCaptionInput): Promise<AccountCaptionEdit> {
  return runVerifiedRelayCaptionWithAccount(input, "account_watching");
}
/** Read-only revalidation is permitted only for a separately leased rechecking row. */
export function recheckVerifiedRelayCaptionWithAccount(input: VerifiedCaptionInput): Promise<AccountCaptionRecheck> {
  return runVerifiedRelayCaptionWithAccount(input, "account_rechecking");
}
function runVerifiedRelayCaptionWithAccount(input: VerifiedCaptionInput, phase: "account_attempting"): Promise<AccountCaptionEdit>;
function runVerifiedRelayCaptionWithAccount(input: VerifiedCaptionInput, phase: "account_rechecking"): Promise<AccountCaptionRecheck>;
function runVerifiedRelayCaptionWithAccount(input: VerifiedCaptionInput, phase: "account_watching"): Promise<AccountCaptionEdit>;
async function runVerifiedRelayCaptionWithAccount(input: VerifiedCaptionInput,
  phase: "account_attempting" | "account_rechecking" | "account_watching"): Promise<AccountCaptionOperation> {
  let attempted = false;
  let editReturned = false;
  const unavailable = (): AccountCaptionEdit => ({ state: "unavailable", attempted, outcome: attempted ? "uncertain" : "unavailable" });
  const invalid = (reason: RelayCaptionPreflightReason): AccountCaptionEdit => ({ state: "ok", attempted: false, outcome: "invalid", reason });
  if (!Number.isSafeInteger(input.targetChatId) || input.targetChatId >= 0
    || !Number.isSafeInteger(input.messageId) || input.messageId <= 0 || input.messageId > 2147483647
    || typeof input.relayRevision !== "string" || !input.relayRevision
    || typeof input.caption !== "string" || !input.caption.trim() || input.caption.length > 1024
    || !Array.isArray(input.captionEntities) || input.captionEntities.length > 1024) return invalid("input_invalid");
  const expected = normalizeRelayCaptionEntities(input.caption, input.captionEntities);
  const sourceEdit = input.sourceEdit;
  const watch = phase === "account_watching" ? input.watch : undefined;
  if (phase === "account_watching" && (!watch || !watch.leaseId || !Number.isSafeInteger(watch.sourceVersion)
    || watch.sourceVersion < 0 || sourceEdit)) return invalid("input_invalid");
  const baselineCaption = sourceEdit?.expectedCaption ?? input.caption;
  const baselineEntities = sourceEdit?.expectedCaptionEntities ?? expected;
  if (sourceEdit && (!Number.isSafeInteger(sourceEdit.id) || sourceEdit.id <= 0
    || !Number.isSafeInteger(sourceEdit.version) || sourceEdit.version <= 0 || !sourceEdit.leaseId
    || typeof baselineCaption !== "string" || !baselineCaption.trim() || baselineCaption.length > 1024
    || !relayCaptionEntitiesMatch(baselineCaption, baselineEntities, baselineEntities))) return invalid("input_invalid");
  const requiresPremium = watch ? expected.some(entity => entity.type === "custom_emoji")
    : !sourceEdit || [...expected, ...baselineEntities].some(entity => entity.type === "custom_emoji");
  const entities = expected.length === input.captionEntities.length ? editableCaptionEntities(expected) : null;
  const prepared = inspectRelayDelivery(input.caption, expected,
    { caption: input.caption, caption_entities: expected, reply_markup: { inline_keyboard: relayKeyboard() } });
  if (!entities) return invalid("expected_entities_invalid");
  if (!prepared.linksSafe) return invalid("expected_links_unsafe");
  if (!prepared.buttonsMatch) return invalid("expected_buttons_invalid");
  const db = getSqlite(), current = row(db), now = Date.now();
  if (current.stage !== "connected" || !current.session_ciphertext) return { state: "disconnected", attempted: false, outcome: "unavailable" };
  if (current.lease_until > now) return { state: "busy", attempted: false, outcome: "unavailable", retryAt: current.lease_until };
  if (current.next_attempt_at > now) return { state: "backoff", attempted: false, outcome: "unavailable", retryAt: current.next_attempt_at };
  const configuration = () => db.prepare(`SELECT relay_enabled,relay_chat_id,relay_revision,token_ciphertext,relay_caption_watch_enabled
    FROM telegram_promotion_settings WHERE id='primary'`).get() as {
      relay_enabled: number; relay_chat_id: string; relay_revision: string; token_ciphertext: string; relay_caption_watch_enabled: number;
    } | undefined;
  const runtime = () => db.prepare(`SELECT target_chat_id,target_verified_at,ready_until,revision,bot_id,send_lease_id,send_lease_until
    FROM telegram_relay_state WHERE id='primary'`).get() as {
      target_chat_id: number; target_verified_at: number; ready_until: number; revision: string; bot_id: number;
      send_lease_id: string; send_lease_until: number;
    } | undefined;
  type EditReference = { id: number; caption: string; caption_entities: string; lease_id: string; lease_until: number; caption_edit_outcome: string;
    origin: string; account_generation: string; queued_at: number; source_chat_id: number; source_message_id: number; source_version: number; last_error: string; caption_edit_attempted_at: number;
    media_kind: string; caption_watch_outcome: string; caption_watch_source_version: number; caption_watch_edit_attempted_at: number;
    caption_watch_media_id: string; content_hash: string; visual_hash: string; sent_at: number | null };
  const references = () => db.prepare(`SELECT id,caption,caption_entities,lease_id,lease_until,caption_edit_outcome,origin,account_generation,queued_at,source_chat_id,source_message_id,source_version,last_error,caption_edit_attempted_at,
    media_kind,caption_watch_outcome,caption_watch_source_version,caption_watch_edit_attempted_at,caption_watch_media_id,content_hash,visual_hash,sent_at
    FROM telegram_relay_outbox WHERE status='sent' AND revision=? AND message_id=? LIMIT 2`)
    .all(input.relayRevision, input.messageId) as EditReference[];
  const settings = configuration(), target = runtime(), storedReferences = references();
  const reference = storedReferences.length === 1 ? storedReferences[0] : undefined;
  type SourceEditReference = { id: number; outbox_id: number; source_version: number; status: string; outcome: string;
    caption: string; caption_entities: string; baseline_caption: string; baseline_entities: string;
    attempted_at: number; lease_id: string; lease_until: number };
  const sourceReference = () => sourceEdit ? db.prepare(`SELECT id,outbox_id,source_version,status,outcome,caption,caption_entities,
    baseline_caption,baseline_entities,attempted_at,lease_id,lease_until FROM telegram_relay_source_edits WHERE id=?`).get(sourceEdit.id) as SourceEditReference | undefined : undefined;
  const originalSourceEdit = sourceReference();
  const sourceEditMatches = (value: SourceEditReference | undefined) => {
    if (!sourceEdit) return true;
    try { return !!value && !!reference && !!originalSourceEdit
      && value.outbox_id === reference.id && value.source_version === sourceEdit.version && value.status === "attempting"
      && value.outcome === "account_attempting" && value.attempted_at > 0 && value.attempted_at <= Date.now()
      && value.attempted_at === originalSourceEdit.attempted_at && value.caption_entities === originalSourceEdit.caption_entities
      && value.baseline_entities === originalSourceEdit.baseline_entities
      && value.lease_id === sourceEdit.leaseId && value.lease_until > Date.now()
      && value.caption === input.caption && value.baseline_caption === baselineCaption
      && relayCaptionEntitiesMatch(input.caption, expected, JSON.parse(value.caption_entities))
      && relayCaptionEntitiesMatch(baselineCaption, baselineEntities, JSON.parse(value.baseline_entities));
    } catch { return false; }
  };
  const watchMatches = (value: EditReference | undefined) => {
    if (!watch) return true;
    if (!value || value.lease_id !== watch.leaseId || value.lease_until <= Date.now()
      || value.source_version !== watch.sourceVersion || value.caption_watch_source_version !== watch.sourceVersion
      || value.caption_watch_outcome !== "checking") return false;
    const latestEdit = db.prepare(`SELECT id,status,caption,caption_entities FROM telegram_relay_source_edits
      WHERE outbox_id=? AND source_version=? AND outcome<>'applied_before_send' ORDER BY id DESC LIMIT 1`)
      .get(value.id, value.source_version) as { id: number; status: string; caption: string; caption_entities: string } | undefined;
    if (latestEdit && ["pending", "attempting"].includes(latestEdit.status)) return false;
    try { return watch.sourceEditId ? latestEdit?.id === watch.sourceEditId && latestEdit.caption === input.caption
      && relayCaptionEntitiesMatch(input.caption, expected, JSON.parse(latestEdit.caption_entities))
      : !latestEdit && value.caption === input.caption && relayCaptionEntitiesMatch(input.caption, expected, JSON.parse(value.caption_entities)); }
    catch { return false; }
  };
  const activeLeaseId = watch?.leaseId ?? sourceEdit?.leaseId ?? reference?.lease_id;
  const sourceAllowed = (value: EditReference) => value.origin !== "account" || value.account_generation === current.generation
    && Boolean(db.prepare(`SELECT 1 FROM telegram_personal_sources WHERE chat_id=? AND selected=1 AND joined=1
      AND blocked=0 AND selected_at<=?`).get(value.source_chat_id, value.queued_at))
    && (!(sourceEdit || watch) || Boolean(db.prepare(`SELECT 1 FROM telegram_personal_source_posts w,telegram_personal_sources s
      WHERE w.source_chat_id=? AND w.source_message_id=? AND w.account_generation=? AND w.relay_revision=?
      AND s.chat_id=w.source_chat_id AND s.selected_at=w.selected_at`).get(value.source_chat_id, value.source_message_id, current.generation, input.relayRevision)));
  // A known delivery/repair failure can have stripped custom entities. This
  // exception permits only a subset of the exact expected custom IDs; all text,
  // styles, links and buttons must still match the immutable baseline.
  const allowMissingBaselineCustom = !sourceEdit || reference?.last_error === "Telegram 未保留部分原始自定义 Emoji，请检查机器人的自定义 Emoji 使用权限。该消息不会自动重发。"
    || Number(reference?.caption_edit_attempted_at) > 0 && [
      "Telegram 拒绝补正文案或按钮，请检查机器人权限及原消息格式；不会重复发送媒体。",
      "个人账号备用补正当前不可用，请检查本人账号连接和编辑权限；原媒体不会重复发送。",
      "个人账号未能补正原始自定义 Emoji，请检查本人账号权限；不会重新发送媒体。",
      "个人账号备用补正结果未能确认，已停止自动重试；不会重新发送媒体。",
    ].includes(reference?.last_error || "");
  const publicTarget = settings?.relay_chat_id.match(/^(?:@([A-Za-z][A-Za-z0-9_]{3,31})|https:\/\/t\.me\/([A-Za-z][A-Za-z0-9_]{3,31})\/?)$/);
  const username = publicTarget?.[1] || publicTarget?.[2];
  if (!settings || settings.relay_enabled !== 1 || settings.relay_revision !== input.relayRevision || !settings.token_ciphertext || !username
    || !target || target.target_chat_id !== input.targetChatId || target.revision !== input.relayRevision
    || !Number.isSafeInteger(target.bot_id) || target.bot_id <= 0 || target.target_verified_at <= 0 || target.target_verified_at > now
    || target.ready_until <= now || !reference || !watch && reference.caption !== baselineCaption
    || !sourceEdit && !watch && (reference.caption_edit_outcome !== phase || !reference.lease_id || reference.lease_until <= now)
    || sourceEdit && (settings.relay_caption_watch_enabled !== 1 || phase !== "account_attempting" || reference.source_version !== sourceEdit.version || !sourceEditMatches(originalSourceEdit))
    || watch && (settings.relay_caption_watch_enabled !== 1 || !watchMatches(reference))
    || !activeLeaseId || target.send_lease_id !== activeLeaseId || target.send_lease_until <= now
    || !sourceAllowed(reference)) return unavailable();
  let legacyBaselineInvalid = false;
  try {
    const storedEntities: unknown = JSON.parse(reference.caption_entities);
    const normalized = normalizeRelayCaptionEntities(reference.caption, storedEntities);
    if (!Array.isArray(storedEntities) || normalized.length !== storedEntities.length) {
      if (!watch?.sourceEditId) return invalid("stored_entities_invalid");
      legacyBaselineInvalid = true;
    }
    if (!watch && (sourceEdit ? !relayCaptionEntitiesMatch(baselineCaption, baselineEntities, normalized)
      : JSON.stringify(normalized) !== JSON.stringify(expected))) return invalid("stored_entities_mismatch");
  } catch {
    if (!watch?.sourceEditId) return invalid("stored_entities_invalid");
    legacyBaselineInvalid = true;
  }
  let claim: Claim;
  try { claim = claimAccount(db, Date.now(), { connected: true, respectBackoff: true, purpose: "caption" }); }
  catch (error) {
    const state = error instanceof TelegramAccountError && error.status === 429 ? "backoff"
      : error instanceof TelegramAccountError && error.message === BUSY_ERROR ? "busy"
      : error instanceof TelegramAccountError && error.message === REAUTH_ERROR ? "disconnected" : "unavailable";
    const latest = row(db), retryAt = state === "busy" ? latest.lease_until : state === "backoff" ? latest.next_attempt_at : 0;
    return { state, attempted: false, outcome: "unavailable", ...(retryAt > Date.now() ? { retryAt } : {}) };
  }
  const deadline = Date.now() + 40_000;
  const remaining = () => Math.max(1, Math.min(REQUEST_MS, deadline - Date.now()));
  const allowed = () => {
    const latest = configuration(), latestTarget = runtime(), account = row(db), matches = references();
    const latestReference = matches.length === 1 ? matches[0] : undefined;
    return Date.now() < deadline && owns(db, claim) && account.stage === "connected"
      && account.config_ciphertext === current.config_ciphertext && account.session_ciphertext === current.session_ciphertext
      && latest?.relay_enabled === 1 && latest.relay_chat_id === settings.relay_chat_id
      && latest.relay_revision === settings.relay_revision && latest.token_ciphertext === settings.token_ciphertext
      && latestTarget?.target_chat_id === input.targetChatId && latestTarget.bot_id === target.bot_id
      && latestTarget.revision === input.relayRevision && latestTarget.target_verified_at > 0 && latestTarget.target_verified_at <= Date.now()
      && latestTarget.ready_until > Date.now() && latestTarget.send_lease_id === activeLeaseId && latestTarget.send_lease_until > Date.now()
      && latestReference?.id === reference.id && latestReference.caption === reference.caption && latestReference.caption_entities === reference.caption_entities
      && (watch ? latest.relay_caption_watch_enabled === 1 && watchMatches(latestReference) : sourceEdit ? sourceEditMatches(sourceReference())
        && (attempted || latest.relay_caption_watch_enabled === 1)
        && (attempted || latestReference.source_version === sourceEdit.version)
        : latestReference.caption_edit_outcome === phase && latestReference.lease_id === reference.lease_id
          && latestReference.lease_until > Date.now() && latestReference.source_version === reference.source_version)
      && latestReference.origin === reference.origin && latestReference.account_generation === reference.account_generation
      && latestReference.queued_at === reference.queued_at && latestReference.source_chat_id === reference.source_chat_id && sourceAllowed(latestReference);
  };
  const identity = (message: Api.Message) => message.id === input.messageId && message.post === true && !!message.peerId
    && Number(utils.getPeerId(message.peerId)) === input.targetChatId && message.viaBotId == null
    && (message as Api.Message & { viaBusinessBotId?: unknown }).viaBusinessBotId == null && message.fwdFrom == null;
  const mediaIdentity = (message: Api.Message): string | null => {
    const media = message.media instanceof Api.MessageMediaPhoto && message.media.photo instanceof Api.Photo ? message.media.photo
      : message.media instanceof Api.MessageMediaDocument && message.media.document instanceof Api.Document ? message.media.document : null;
    if (!media) return null;
    const id = media.id.toString();
    return isRelayCustomEmojiId(id) ? `${media.className}:${id}` : null;
  };
  let client: TelegramClient | undefined;
  try {
    if (!allowed()) return unavailable();
    client = makeClient(unseal<Credentials>(claim.row.config_ciphertext), unseal<string>(claim.row.session_ciphertext));
    await bounded(client, client.connect(), remaining());
    if (!allowed()) return unavailable();
    renew(db, claim);
    let entity = await bounded(client, client.getEntity(`@${username}`), remaining());
    if (!allowed()) return unavailable();
    if (!(entity instanceof Api.Channel) || entity.min || entity.broadcast !== true || Number(utils.getPeerId(entity)) !== input.targetChatId
      || !(entity.creator === true || entity.adminRights?.editMessages === true)) return { state: "ok", attempted: false, outcome: "rejected", reason: "target_unqualified" };
    renew(db, claim);
    const me = await bounded(client, client.getMe(), remaining());
    if (!allowed()) return unavailable();
    if (!(me instanceof Api.User) || me.bot || me.deleted || me.min || !watch && requiresPremium && me.premium !== true) return { state: "ok", attempted: false, outcome: "rejected", reason: "account_unqualified" };
    renew(db, claim);
    let originalMedia: string | null = null;
    let failure: RelayCaptionPreflightReason = "message_not_found";
    for (let inspection = 0; inspection < 3; inspection++) {
      if (inspection > 0) {
        if (!allowed()) return unavailable();
        await new Promise<void>(resolve => setTimeout(resolve, Math.min(inspection * 1000, remaining())));
        if (!allowed()) return unavailable();
        renew(db, claim);
        // Permissions can change while Telegram is publishing the post. Every
        // repeated read gets fresh target and account evidence before proceeding.
        entity = await bounded(client, client.getEntity(`@${username}`), remaining());
        if (!allowed()) return unavailable();
        if (!(entity instanceof Api.Channel) || entity.min || entity.broadcast !== true || Number(utils.getPeerId(entity)) !== input.targetChatId
          || !(entity.creator === true || entity.adminRights?.editMessages === true)) return { state: "ok", attempted: false, outcome: "rejected", reason: "target_unqualified" };
        renew(db, claim);
        const owner = await bounded(client, client.getMe(), remaining());
        if (!allowed()) return unavailable();
        if (!(owner instanceof Api.User) || owner.bot || owner.deleted || owner.min || !watch && requiresPremium && owner.premium !== true) return { state: "ok", attempted: false, outcome: "rejected", reason: "account_unqualified" };
        renew(db, claim);
      }
      const before = await bounded(client, client.getMessages(entity, { ids: [input.messageId], limit: 1 }), remaining());
      if (!allowed()) return unavailable();
      renew(db, claim);
      if (before.length !== 1 || !(before[0] instanceof Api.Message)) failure = "message_not_found";
      else if (before[0].id !== input.messageId || !before[0].peerId || Number(utils.getPeerId(before[0].peerId)) !== input.targetChatId) failure = "message_identity_invalid";
      else if (!identity(before[0])) failure = "message_not_direct_post";
      else {
        const media = mediaIdentity(before[0]), original = relayDeliveryMessage(before[0]);
        if (!media) failure = "media_invalid";
        else if (watch && reference.caption_watch_media_id && reference.caption_watch_media_id !== media) failure = "media_invalid";
        else if (!original) failure = "actual_entities_unsupported";
        else {
          const actualKind = !watch ? reference.media_kind : before[0].media instanceof Api.MessageMediaPhoto ? "photo"
            : before[0].media instanceof Api.MessageMediaDocument && before[0].media.document instanceof Api.Document
              && before[0].media.document.attributes.some(attribute => attribute instanceof Api.DocumentAttributeAnimated) ? "animation" : "video";
          if (watch && actualKind !== reference.media_kind) return invalid("media_invalid");
          if (watch && !reference.caption_watch_media_id) {
            // Historical deliveries lack a target media receipt. Different text
            // can be repaired only after positively matching the stored upload,
            // never merely because two reads happen to show the same media ID.
            if (legacyBaselineInvalid || before[0].message !== reference.caption && before[0].message !== input.caption) {
              const firstSnapshot = { date: before[0].date, caption: before[0].message, entities: original.caption_entities };
              if (!inspectRelayDelivery(input.caption, expected, original).buttonsMatch
                || reference.last_error === "Telegram 返回的消息目标未能确认，已停止自动补正；该消息不会重复发送。"
                || !Number.isSafeInteger(reference.sent_at) || Number(reference.sent_at) <= 0
                || !Number.isSafeInteger(before[0].date) || before[0].date * 1000 > Number(reference.sent_at) + 5000
                || before[0].date * 1000 < Number(reference.sent_at) - LEASE_MS - 5000
                || !/^[a-f0-9]{64}$/.test(reference.content_hash) && !/^[a-f0-9]{64}$/.test(reference.visual_hash)) return invalid("identity_unverified");
              const max = reference.media_kind === "photo" ? MAX_PHOTO : reference.media_kind === "animation" ? MAX_ANIMATION : MAX_VIDEO;
              let bytes: string | Buffer | undefined;
              try {
                bytes = await bounded(client, client.downloadMedia(before[0], {
                  signal: AbortSignal.timeout(remaining()), requestTimeout: remaining(),
                  progressCallback: (downloaded, total) => {
                    if (Number(downloaded.toString()) > max || Number(total.toString()) > max) throw new OversizeMediaError();
                  },
                }), remaining());
              } catch (error) { if (error instanceof OversizeMediaError) return invalid("identity_unverified"); throw error; }
              if (!allowed()) return unavailable();
              renew(db, claim);
              if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > max) return invalid("identity_unverified");
              let matched = createHash("sha256").update(bytes).digest("hex") === reference.content_hash;
              if (!matched && /^[a-f0-9]{64}$/.test(reference.visual_hash)) {
                const { relayMediaIdentity } = await import("./telegram-relay-media");
                if (!allowed()) return unavailable();
                const hashes = await bounded(client, relayMediaIdentity(bytes, reference.media_kind as "photo" | "animation" | "video"), remaining());
                matched = !!hashes.visualHash && hashes.visualHash === reference.visual_hash;
              }
              if (!matched) return invalid("identity_unverified");
              if (!allowed()) return unavailable();
              renew(db, claim);
              const recheck = await bounded(client, client.getMessages(entity, { ids: [input.messageId], limit: 1 }), remaining());
              if (!allowed()) return unavailable();
              renew(db, claim);
              const second = recheck.length === 1 && recheck[0] instanceof Api.Message ? recheck[0] : null;
              const secondDelivery = second && relayDeliveryMessage(second);
              if (!second || !identity(second) || mediaIdentity(second) !== media || second.date !== firstSnapshot.date
                || second.message !== firstSnapshot.caption || !secondDelivery || !inspectRelayDelivery(input.caption, expected, secondDelivery).buttonsMatch
                || !relayCaptionEntitiesMatch(firstSnapshot.caption, firstSnapshot.entities, secondDelivery.caption_entities)) return invalid("identity_unverified");
            }
            const pinned = db.prepare(`UPDATE telegram_relay_outbox SET caption_watch_media_id=? WHERE id=? AND lease_id=?
              AND caption_watch_media_id='' AND status='sent' AND source_version=? AND caption_watch_source_version=?
              AND caption_watch_outcome='checking' AND lease_until>?`)
              .run(media, reference.id, watch.leaseId, watch.sourceVersion, watch.sourceVersion, Date.now());
            if (!pinned.changes) return unavailable();
            reference.caption_watch_media_id = media;
          }
          if (sourceEdit || watch) {
            const desired = inspectRelayDelivery(input.caption, expected, original);
            if (desired.captionMatches && desired.customEmojiPreserved && desired.linksSafe && desired.buttonsMatch
              && relayCaptionFormattingMatches(input.caption, expected, original.caption_entities)) return { state: "ok", attempted: false, outcome: "preserved" };
            if (watch) {
              if (!watch.allowRepair || reference.caption_watch_edit_attempted_at > 0) return invalid("watch_readonly");
              if (requiresPremium && me.premium !== true) return { state: "ok", attempted: false, outcome: "rejected", reason: "account_unqualified" };
              if (!desired.buttonsMatch) return invalid("buttons_mismatch");
              originalMedia = media;
              break;
            }
          }
          const verified = inspectRelayDelivery(baselineCaption, baselineEntities, original);
          const baselineExpected = sourceEdit && allowMissingBaselineCustom
            ? [...baselineEntities.filter(entity => entity.type !== "custom_emoji"),
              ...original.caption_entities.filter(entity => entity.type === "custom_emoji")]
            : baselineEntities;
          if (!verified.captionMatches) failure = "caption_mismatch";
          else if (!verified.linksSafe) failure = "actual_links_unsafe";
          else if (!verified.buttonsMatch) failure = "buttons_mismatch";
          else if (sourceEdit ? !relayCaptionFormattingMatches(baselineCaption, baselineExpected, original.caption_entities)
            || allowMissingBaselineCustom && !customEmojiSubset(baselineCaption, baselineEntities, original.caption_entities)
            : !customEmojiSubset(baselineCaption, baselineEntities, original.caption_entities)) failure = "stored_entities_mismatch";
          else {
            if (!sourceEdit && verified.customEmojiPreserved && relayCaptionFormattingMatches(input.caption, expected, original.caption_entities))
              return { state: "ok", attempted: false, outcome: "preserved" };
            originalMedia = media;
            break;
          }
        }
      }
    }
    if (!originalMedia) return invalid(failure);
    if (!allowed()) return unavailable();
    if (phase === "account_rechecking") return { state: "ok", attempted: false, outcome: "ready", reason: "ready_to_edit" };
    if (watch) {
      // Commit before the RPC. A timeout/crash leaves a read-only marker instead
      // of submitting an ambiguous edit again after the next tick or restart.
      const marked = db.prepare(`UPDATE telegram_relay_outbox SET caption_watch_edit_attempted_at=?
        WHERE id=? AND status='sent' AND lease_id=? AND lease_until>? AND source_version=?
        AND caption_watch_edit_attempted_at=0`).run(Date.now(), reference.id, watch.leaseId, Date.now(), watch.sourceVersion);
      if (!marked.changes || !allowed()) return unavailable();
    }
    // Deliberately omit replyMarkup/media. The actual readback, not the RPC
    // response, must prove Telegram preserved the original media and keyboard.
    const request = new Api.messages.EditMessage({ peer: entity, id: input.messageId, message: input.caption, entities });
    attempted = true;
    await bounded(client, client.invoke(request, undefined, { maxRetryCount: 0, floodSleepThreshold: 0, timeout: remaining() }), remaining());
    editReturned = true;
    let readOutcome: "changed" | "uncertain" = "uncertain";
    for (let inspection = 0; inspection < 3; inspection++) {
      if (!allowed()) return unavailable();
      if (inspection > 0) {
        await new Promise<void>(resolve => setTimeout(resolve, Math.min(inspection * 1000, remaining())));
        if (!allowed()) return unavailable();
      }
      renew(db, claim);
      try {
        // A timed-out bounded read disconnects the transport. Reconnect only for
        // a subsequent read; the already submitted EditMessage is never retried.
        if (inspection > 0) {
          await bounded(client, client.connect(), remaining());
          if (!allowed()) return unavailable();
          renew(db, claim);
        }
        entity = await bounded(client, client.getEntity(`@${username}`), remaining());
        if (!allowed()) return unavailable();
        if (!(entity instanceof Api.Channel) || entity.min || entity.broadcast !== true || Number(utils.getPeerId(entity)) !== input.targetChatId
          || !(entity.creator === true || entity.adminRights?.editMessages === true)) return { state: "ok", attempted: true, outcome: "uncertain" };
        renew(db, claim);
        const owner = await bounded(client, client.getMe(), remaining());
        if (!allowed()) return unavailable();
        if (!(owner instanceof Api.User) || owner.bot || owner.deleted || owner.min || requiresPremium && owner.premium !== true) return { state: "ok", attempted: true, outcome: "uncertain" };
        renew(db, claim);
        const after = await bounded(client, client.getMessages(entity, { ids: [input.messageId], limit: 1 }), remaining());
        if (!allowed()) return unavailable();
        renew(db, claim);
        if (after.length === 0) { readOutcome = "uncertain"; continue; }
        if (after.length !== 1 || !(after[0] instanceof Api.Message) || !identity(after[0])) return { state: "ok", attempted: true, outcome: "uncertain" };
        if (mediaIdentity(after[0]) !== originalMedia) return { state: "ok", attempted: true, outcome: "changed" };
        const actual = relayDeliveryMessage(after[0]);
        if (actual) {
          const inspected = inspectRelayDelivery(input.caption, expected, actual);
          if (inspected.captionMatches && inspected.customEmojiPreserved && inspected.linksSafe && inspected.buttonsMatch
            && relayCaptionFormattingMatches(input.caption, expected, actual.caption_entities))
            return { state: "ok", attempted: true, outcome: "preserved" };
        }
        readOutcome = "changed";
      } catch (error) {
        const category = failureCategory(error);
        // Unknown RPC and access errors must reach the outer failure boundary;
        // safeError's default 502 alone does not prove a transient network error.
        if (!(category === "network" || category === "timeout"
          || error instanceof TelegramAccountError && error.status === 502 && error.message === TEMP_ERROR)) throw error;
        if (!allowed()) return unavailable();
        readOutcome = "uncertain";
      }
    }
    return readOutcome === "uncertain" ? unavailable() : { state: "ok", attempted: true, outcome: "changed" };
  } catch (error) {
    if (allowed() && safeError(error).status === 429 && failureCategory(error) === "telegram-rate-limit") {
      recordFailure(db, claim, error, phase === "account_rechecking" ? "relay-account-caption-recheck" : "relay-account-caption-edit");
      const retryAt = !attempted || !editReturned ? row(db).next_attempt_at : 0;
      return { state: "backoff", attempted, outcome: attempted ? editReturned ? "uncertain" : "rejected" : "unavailable",
        ...(retryAt > Date.now() ? { retryAt } : {}) };
    }
    const rpc = error as { code?: unknown; errorMessage?: unknown } | null;
    if (attempted && !editReturned && typeof rpc?.code === "number" && rpc.code >= 400 && rpc.code < 500 && typeof rpc.errorMessage === "string") {
      return { state: "ok", attempted: true, outcome: "rejected" };
    }
    return unavailable();
  } finally { release(db, claim); await closeClient(client, Math.max(1, Math.min(2000, deadline - Date.now()))); }
}

/** Read back only recently sent posts in the currently verified relay destination. */
export async function inspectRecentRelayDeliveries(): Promise<RelayDeliverySample> {
  const result: RelayDeliverySample = { state: "ok", sampledPosts: 0, matchingCaptions: 0,
    customEmojiPosts: 0, preservedCustomEmojiPosts: 0, safeLinkPosts: 0, matchingButtonPosts: 0, invalidReferences: 0,
    personalEditQualification: "unknown" };
  const db = getSqlite(), current = row(db), now = Date.now();
  if (current.stage !== "connected" || !current.session_ciphertext) return { ...result, state: "disconnected" };
  if (current.lease_until > now) return { ...result, state: "busy" };
  if (current.next_attempt_at > now) return { ...result, state: "backoff" };
  const configuration = () => db.prepare(`SELECT relay_enabled,relay_chat_id,relay_revision,token_ciphertext
    FROM telegram_promotion_settings WHERE id='primary'`).get() as {
      relay_enabled: number; relay_chat_id: string; relay_revision: string; token_ciphertext: string;
    } | undefined;
  const runtime = () => db.prepare(`SELECT target_chat_id,target_verified_at,ready_until,revision,bot_id
    FROM telegram_relay_state WHERE id='primary'`).get() as {
      target_chat_id: number; target_verified_at: number; ready_until: number; revision: string; bot_id: number;
    } | undefined;
  const settings = configuration(), target = runtime();
  // Do not pass arbitrary IDs, private links, paths or URLs to MTProto resolution.
  const publicTarget = settings?.relay_chat_id.match(/^(?:@([A-Za-z][A-Za-z0-9_]{3,31})|https:\/\/t\.me\/([A-Za-z][A-Za-z0-9_]{3,31})\/?)$/);
  const username = publicTarget?.[1] || publicTarget?.[2];
  if (!settings || settings.relay_enabled !== 1 || !settings.relay_revision || !settings.token_ciphertext || !username
    || !target || !Number.isSafeInteger(target.target_chat_id) || target.target_chat_id >= 0
    || !Number.isSafeInteger(target.bot_id) || target.bot_id <= 0
    || target.target_verified_at <= 0 || target.target_verified_at > now
    || target.revision !== settings.relay_revision || target.ready_until <= now) return { ...result, state: "unavailable" };
  type Reference = { id: number; message_id: number | null; caption: string; caption_entities: string };
  const references = db.prepare(`SELECT id,
    CASE WHEN typeof(message_id)='integer' AND message_id BETWEEN 1 AND 9007199254740991 THEN message_id ELSE NULL END AS message_id,
    caption,caption_entities FROM telegram_relay_outbox WHERE status='sent' AND revision=?
    AND typeof(sent_at)='integer' AND sent_at>=? AND sent_at<=? ORDER BY sent_at DESC,id DESC LIMIT 5`)
    .all(settings.relay_revision, now - 24 * 60 * 60_000, now) as Reference[];
  if (!references.length) return result;
  const expected = new Map<number, { caption: string; entities: RelayCaptionEntity[] }>();
  for (const reference of references) {
    try {
      const parsed: unknown = JSON.parse(reference.caption_entities);
      const entities = normalizeRelayCaptionEntities(reference.caption, parsed);
      if (!Number.isSafeInteger(reference.message_id) || Number(reference.message_id) <= 0 || expected.has(Number(reference.message_id))
        || typeof reference.caption !== "string" || !reference.caption.trim() || reference.caption.length > 1024
        || !Array.isArray(parsed) || entities.length !== parsed.length) { result.invalidReferences++; continue; }
      expected.set(Number(reference.message_id), { caption: reference.caption, entities });
    } catch { result.invalidReferences++; }
  }
  if (!expected.size) return result;
  let claim: Claim;
  try { claim = claimAccount(db, Date.now(), { connected: true, respectBackoff: true, purpose: "background" }); }
  catch (error) {
    const state = error instanceof TelegramAccountError && error.status === 429 ? "backoff"
      : error instanceof TelegramAccountError && error.message === BUSY_ERROR ? "busy"
      : error instanceof TelegramAccountError && error.message === REAUTH_ERROR ? "disconnected" : "unavailable";
    return { ...result, state };
  }
  const deadline = Date.now() + 40_000;
  const remaining = () => Math.max(1, Math.min(REQUEST_MS, deadline - Date.now()));
  const allowed = () => {
    const latest = configuration(), latestTarget = runtime(), account = row(db);
    return Date.now() < deadline && owns(db, claim) && account.stage === "connected"
      && account.config_ciphertext === current.config_ciphertext && account.session_ciphertext === current.session_ciphertext
      && latest?.relay_enabled === 1 && latest.relay_chat_id === settings.relay_chat_id
      && latest.relay_revision === settings.relay_revision && latest.token_ciphertext === settings.token_ciphertext
      && latestTarget?.target_chat_id === target.target_chat_id && latestTarget.bot_id === target.bot_id
      && latestTarget.target_verified_at > 0 && latestTarget.target_verified_at <= Date.now()
      && latestTarget.revision === settings.relay_revision && latestTarget.ready_until > Date.now();
  };
  let client: TelegramClient | undefined;
  try {
    if (!allowed()) return { ...result, state: "unavailable" };
    client = makeClient(unseal<Credentials>(claim.row.config_ciphertext), unseal<string>(claim.row.session_ciphertext));
    await bounded(client, client.connect(), remaining());
    if (!allowed()) return { ...result, state: "unavailable" };
    renew(db, claim);
    const entity = await bounded(client, client.getEntity(`@${username}`), remaining());
    if (!allowed() || !(entity instanceof Api.Channel)
      || entity.min || Number(utils.getPeerId(entity)) !== target.target_chat_id) return { ...result, state: "unavailable" };
    renew(db, claim);
    // Qualification is evidence only; this function never edits a post.
    if (entity instanceof Api.Channel && entity.broadcast) {
      if (entity.creator === true || entity.adminRights?.editMessages === true) {
        const me = await bounded(client, client.getMe(), remaining());
        if (!allowed()) return { ...result, state: "unavailable" };
        renew(db, claim);
        if (me instanceof Api.User && !me.bot && !me.deleted && !me.min) result.personalEditQualification = me.premium === true ? "qualified" : "not_premium";
      } else result.personalEditQualification = "not_channel_admin";
    }
    if (!allowed()) return { ...result, state: "unavailable" };
    const messages = await bounded(client, client.getMessages(entity, { ids: [...expected.keys()], limit: 5 }), remaining());
    if (!allowed()) return { ...result, state: "unavailable" };
    renew(db, claim);
    const received = new Set<number>();
    for (const message of messages) {
      if (!(message instanceof Api.Message) || !Number.isSafeInteger(message.id) || !expected.has(message.id)
        || received.has(message.id)) { result.invalidReferences++; continue; }
      received.add(message.id);
      if (!message.peerId || Number(utils.getPeerId(message.peerId)) !== target.target_chat_id
        || !Number.isSafeInteger(message.date) || message.date * 1000 < now - 24 * 60 * 60_000
        || message.date * 1000 > Date.now() + 1000) { result.invalidReferences++; continue; }
      const reference = expected.get(message.id)!;
      const actualEntities = captionEntities(message.entities, true);
      if (actualEntities.length !== (message.entities || []).length) { result.invalidReferences++; continue; }
      const markup = message.replyMarkup instanceof Api.ReplyInlineMarkup ? { inline_keyboard: message.replyMarkup.rows.map(buttonRow => buttonRow.buttons.map(button =>
        button.type instanceof Api.InlineButtonTypeUrl ? { text: button.text, url: button.type.url } : { text: button.text, unsupported: true })) } : undefined;
      const inspected = inspectRelayDelivery(reference.caption, reference.entities,
        { caption: message.message, caption_entities: actualEntities, reply_markup: markup });
      result.sampledPosts++;
      if (inspected.captionMatches) result.matchingCaptions++;
      if (reference.entities.some(value => value.type === "custom_emoji")) {
        result.customEmojiPosts++;
        if (inspected.customEmojiPreserved) result.preservedCustomEmojiPosts++;
      }
      if (inspected.linksSafe) result.safeLinkPosts++;
      if (inspected.buttonsMatch) result.matchingButtonPosts++;
    }
    result.invalidReferences += [...expected.keys()].filter(id => !received.has(id)).length;
    return allowed() ? result : { ...result, state: "unavailable" };
  } catch (error) {
    // Honor only a genuine Telegram FloodWait. Diagnostics never revoke
    // credentials, save sessions, touch queues or advance source cursors.
    if (allowed() && safeError(error).status === 429 && failureCategory(error) === "telegram-rate-limit") {
      recordFailure(db, claim, error, "relay-delivery-audit");
      return { ...result, state: "backoff" };
    }
    return { ...result, state: "unavailable" };
  } finally { release(db, claim); await closeClient(client); }
}

type ConnectedBotEmojiQualification = {
  state: SourceEmojiSample["state"];
  qualification: "owner_premium" | "fragment_username" | "not_qualified" | "owner_not_verified" | "unknown";
};

/** Read only ownership/qualification needed for this bot; never return profile data. */
export async function inspectConnectedBotEmojiQualification(): Promise<ConnectedBotEmojiQualification> {
  const unknown: ConnectedBotEmojiQualification = { state: "ok", qualification: "unknown" };
  const db = getSqlite();
  const current = row(db);
  if (current.stage !== "connected" || !current.session_ciphertext) return { ...unknown, state: "disconnected" };
  if (current.lease_until > Date.now()) return { ...unknown, state: "busy" };
  if (current.next_attempt_at > Date.now()) return { ...unknown, state: "backoff" };
  const botIdentity = () => (db.prepare("SELECT bot_id FROM telegram_relay_state WHERE id='primary'").get() as { bot_id: number } | undefined)?.bot_id || 0;
  const botId = botIdentity();
  if (!Number.isSafeInteger(botId) || botId <= 0) return unknown;
  let claim: Claim;
  try { claim = claimAccount(db, Date.now(), { connected: true, respectBackoff: true, purpose: "background" }); }
  catch (error) {
    const state = error instanceof TelegramAccountError && error.status === 429 ? "backoff"
      : error instanceof TelegramAccountError && error.message === BUSY_ERROR ? "busy"
      : error instanceof TelegramAccountError && error.message === REAUTH_ERROR ? "disconnected" : "unavailable";
    return { ...unknown, state };
  }
  let client: TelegramClient | undefined;
  const deadline = Date.now() + 40_000;
  const remaining = () => Math.max(1, Math.min(REQUEST_MS, deadline - Date.now()));
  try {
    client = makeClient(unseal<Credentials>(claim.row.config_ciphertext), unseal<string>(claim.row.session_ciphertext));
    await bounded(client, client.connect(), remaining());
    renew(db, claim);
    const me = await bounded(client, client.getMe(), remaining());
    renew(db, claim);
    if (!(me instanceof Api.User) || me.bot || me.deleted || me.min) return unknown;
    if (Date.now() >= deadline) return { ...unknown, state: "unavailable" };
    const bots = await bounded(client, client.invoke(new Api.bots.GetAdminedBots()), remaining());
    renew(db, claim);
    if (!owns(db, claim) || botIdentity() !== botId) return { ...unknown, state: "unavailable" };
    if (!Array.isArray(bots) || bots.some(bot => !(bot instanceof Api.User) || !bot.bot)) return unknown;
    const bot = bots.find(candidate => candidate instanceof Api.User && candidate.id.toString() === String(botId));
    if (!bot) return { state: "ok", qualification: "owner_not_verified" };
    if (!(bot instanceof Api.User) || bot.min || bot.deleted) return unknown;
    if (bot.usernames !== undefined && (!Array.isArray(bot.usernames) || bot.usernames.some(username => !(username instanceof Api.Username)
      || typeof username.username !== "string" || !/^[A-Za-z0-9_]{1,32}$/.test(username.username)))) return unknown;
    if (Array.isArray(bot.usernames) && bot.usernames.some(username => username.editable !== true)) {
      return { state: "ok", qualification: "fragment_username" };
    }
    return { state: "ok", qualification: me.premium === true ? "owner_premium" : "not_qualified" };
  } catch (error) {
    // Keep a genuine Telegram wait, but never alter authorization, source
    // cursors, queued messages or persisted sessions for a diagnostic read.
    if (safeError(error).status === 429) {
      recordFailure(db, claim, error, "emoji-bot-qualification");
      return { ...unknown, state: "backoff" };
    }
    return { ...unknown, state: "unavailable" };
  } finally { release(db, claim); await closeClient(client); }
}

/** Bounded read-only source audit. No message content, identifiers or credentials leave this function. */
export async function sampleSelectedSourceEmoji(): Promise<SourceEmojiSample> {
  const result: SourceEmojiSample = { state: "ok", sourcesSampled: 0, messagesSampled: 0, customEmojiEntities: 0,
    negativeCustomEmojiEntities: 0, unrepresentableCustomEmojiEntities: 0 };
  const db = getSqlite();
  const current = row(db);
  if (current.stage !== "connected" || !current.session_ciphertext) return { ...result, state: "disconnected" };
  if (current.lease_until > Date.now()) return { ...result, state: "busy" };
  if (current.next_attempt_at > Date.now()) return { ...result, state: "backoff" };
  const target = (db.prepare("SELECT target_chat_id FROM telegram_relay_state WHERE id='primary'").get() as { target_chat_id: number } | undefined)?.target_chat_id || 0;
  const sources = db.prepare(`SELECT * FROM telegram_personal_sources WHERE selected=1 AND joined=1 AND blocked=0
    AND chat_id<>? ORDER BY chat_id LIMIT 3`).all(target) as SourceRow[];
  if (!sources.length) return result;
  let claim: Claim;
  try { claim = claimAccount(db, Date.now(), { connected: true, respectBackoff: true, purpose: "background" }); }
  catch (error) {
    const state = error instanceof TelegramAccountError && error.status === 429 ? "backoff"
      : error instanceof TelegramAccountError && error.message === BUSY_ERROR ? "busy"
      : error instanceof TelegramAccountError && error.message === REAUTH_ERROR ? "disconnected" : "unavailable";
    return { ...result, state };
  }
  let client: TelegramClient | undefined;
  const deadline = Date.now() + 40_000;
  const remaining = () => Math.max(1, Math.min(REQUEST_MS, deadline - Date.now()));
  try {
    client = makeClient(unseal<Credentials>(claim.row.config_ciphertext), unseal<string>(claim.row.session_ciphertext));
    await bounded(client, client.connect(), remaining());
    for (const source of sources) {
      if (Date.now() >= deadline) return { ...result, state: "unavailable" };
      renew(db, claim);
      const peer = inputPeer(source);
      if (peer.protected) continue;
      const iterator = client.iterMessages(peer.input, { limit: 5 })[Symbol.asyncIterator]();
      let sourceCounted = false;
      for (let index = 0; index < 5; index++) {
        if (Date.now() >= deadline) return { ...result, state: "unavailable" };
        renew(db, claim);
        const next = await bounded(client, iterator.next(), remaining());
        renew(db, claim);
        if (!sourceCounted) { result.sourcesSampled++; sourceCounted = true; }
        if (next.done) break;
        const message = next.value;
        if (!(message instanceof Api.Message)) continue;
        result.messagesSampled++;
        for (const entity of message.entities || []) {
          if (entity.className !== "MessageEntityCustomEmoji") continue;
          result.customEmojiEntities++;
          let id = "";
          try { id = entity.documentId?.toString() || ""; } catch { /* Only the invalid count is retained. */ }
          if (!isRelayCustomEmojiId(id)) result.unrepresentableCustomEmojiEntities++;
          else if (id.startsWith("-")) result.negativeCustomEmojiEntities++;
        }
      }
    }
    return result;
  } catch (error) {
    // A diagnostic read must not edit source cursors, queue rows or account
    // authorization. Persist only Telegram's rate-limit delay when requested.
    if (safeError(error).status === 429) {
      recordFailure(db, claim, error, "emoji-source-audit");
      return { ...result, state: "backoff" };
    }
    return { ...result, state: "unavailable" };
  } finally { release(db, claim); await closeClient(client); }
}

export type RelayCaptionSourceRefresh = {
  state: "ok" | "waiting" | "busy" | "backoff" | "unavailable" | "disconnected";
  sourceVersion?: number; verifiedAt?: number; retryAt?: number;
  reason?: "input_invalid" | "source_inactive" | "source_identity_invalid" | "source_media_changed"
    | "source_caption_missing" | "source_capture_waiting" | "source_busy" | "source_backoff" | "source_unavailable";
};

/** Refresh exactly one known delivered source; never discover/replay media or advance a cursor. */
export async function refreshRelayCaptionSourceWithAccount(input: {
  outboxId: number; relayRevision: string; targetChatId: number;
}): Promise<RelayCaptionSourceRefresh> {
  const waiting = (reason: RelayCaptionSourceRefresh["reason"]): RelayCaptionSourceRefresh => ({ state: "waiting", reason });
  if (!Number.isSafeInteger(input.outboxId) || input.outboxId <= 0 || typeof input.relayRevision !== "string" || !input.relayRevision
    || !Number.isSafeInteger(input.targetChatId) || input.targetChatId >= 0) return waiting("input_invalid");
  const db = getSqlite(), current = row(db), now = Date.now();
  type Reference = { id: number; status: string; message_id: number | null; revision: string; origin: string;
    source_chat_id: number; source_message_id: number; account_generation: string; queued_at: number;
    file_unique_id: string; media_kind: "photo" | "animation" | "video"; source_version: number; source_content_hash: string };
  const reference = () => db.prepare(`SELECT id,status,message_id,revision,origin,source_chat_id,source_message_id,
    account_generation,queued_at,file_unique_id,media_kind,source_version,source_content_hash FROM telegram_relay_outbox WHERE id=?`).get(input.outboxId) as Reference | undefined;
  const configuration = () => db.prepare(`SELECT relay_enabled,relay_revision,relay_started_at,relay_caption_watch_enabled,token_ciphertext
    FROM telegram_promotion_settings WHERE id='primary'`).get() as {
      relay_enabled: number; relay_revision: string; relay_started_at: number; relay_caption_watch_enabled: number; token_ciphertext: string;
    } | undefined;
  const runtime = () => db.prepare("SELECT target_chat_id,revision,bot_id FROM telegram_relay_state WHERE id='primary'").get() as {
    target_chat_id: number; revision: string; bot_id: number;
  } | undefined;
  const job = reference(), settings = configuration(), target = runtime();
  const source = job && db.prepare("SELECT * FROM telegram_personal_sources WHERE chat_id=?").get(job.source_chat_id) as SourceRow | undefined;
  const post = job && db.prepare(`SELECT * FROM telegram_personal_source_posts WHERE source_chat_id=? AND source_message_id=?`)
    .get(job.source_chat_id, job.source_message_id) as SourcePostRow | undefined;
  if (!job || job.status !== "sent" || !Number.isSafeInteger(job.message_id) || Number(job.message_id) <= 0
    || job.origin !== "account" || job.revision !== input.relayRevision || job.account_generation !== current.generation
    || !Number.isSafeInteger(job.source_message_id) || job.source_message_id <= 0 || job.source_chat_id === input.targetChatId
    || !settings || settings.relay_enabled !== 1 || settings.relay_caption_watch_enabled !== 1 || settings.relay_revision !== input.relayRevision
    || !target || target.target_chat_id !== input.targetChatId || target.revision !== input.relayRevision || !Number.isSafeInteger(target.bot_id) || target.bot_id <= 0
    || !source || source.selected !== 1 || source.joined !== 1 || source.blocked !== 0 || source.selected_at > job.queued_at
    || !post || post.account_generation !== current.generation || post.relay_revision !== input.relayRevision
    || post.selected_at !== source.selected_at || !/^[a-f0-9]{64}$/.test(job.file_unique_id) || post.media_id_hash !== job.file_unique_id) return waiting("source_inactive");
  if (current.stage !== "connected" || !current.session_ciphertext) return { state: "disconnected", reason: "source_inactive", retryAt: now + RETRY_MS };
  if (current.lease_until > now) return { state: "busy", reason: "source_busy", retryAt: current.lease_until };
  if (current.next_attempt_at > now) return { state: "backoff", reason: "source_backoff", retryAt: current.next_attempt_at };
  let claim: Claim;
  try { claim = claimAccount(db, now, { connected: true, respectBackoff: true, purpose: "caption" }); }
  catch {
    const latest = row(db), retryAt = Math.max(latest.lease_until, latest.next_attempt_at, Date.now() + 5000);
    return { state: latest.lease_until > Date.now() ? "busy" : latest.next_attempt_at > Date.now() ? "backoff" : "unavailable", reason: "source_unavailable", retryAt };
  }
  const deadline = Date.now() + 40_000;
  const remaining = () => Math.max(1, Math.min(REQUEST_MS, deadline - Date.now()));
  const active = () => {
    const latest = reference(), config = configuration(), state = runtime(), account = row(db);
    const peer = db.prepare("SELECT selected,joined,blocked,selected_at FROM telegram_personal_sources WHERE chat_id=?").get(source.chat_id) as SourceRow | undefined;
    const watched = db.prepare(`SELECT account_generation,relay_revision,selected_at,media_id_hash FROM telegram_personal_source_posts
      WHERE source_chat_id=? AND source_message_id=?`).get(source.chat_id, job.source_message_id) as SourcePostRow | undefined;
    return Date.now() < deadline && owns(db, claim) && account.stage === "connected" && account.generation === current.generation
      && account.config_ciphertext === current.config_ciphertext && account.session_ciphertext === current.session_ciphertext
      && config?.relay_enabled === 1 && config.relay_caption_watch_enabled === 1 && config.relay_revision === settings.relay_revision
      && config.relay_started_at === settings.relay_started_at && config.token_ciphertext === settings.token_ciphertext
      && state?.target_chat_id === target.target_chat_id && state.revision === target.revision && state.bot_id === target.bot_id
      && latest?.status === "sent" && latest.message_id === job.message_id && latest.revision === job.revision
      && latest.origin === job.origin && latest.account_generation === job.account_generation && latest.queued_at === job.queued_at
      && latest.source_chat_id === job.source_chat_id && latest.source_message_id === job.source_message_id
      && latest.file_unique_id === job.file_unique_id && latest.media_kind === job.media_kind
      && peer?.selected === 1 && peer.joined === 1 && peer.blocked === 0 && peer.selected_at === source.selected_at
      && watched?.account_generation === post.account_generation && watched.relay_revision === post.relay_revision
      && watched.selected_at === post.selected_at && watched.media_id_hash === post.media_id_hash;
  };
  let client: TelegramClient | undefined;
  try {
    if (!active()) return waiting("source_inactive");
    client = makeClient(unseal<Credentials>(claim.row.config_ciphertext), unseal<string>(claim.row.session_ciphertext));
    await bounded(client, client.connect(), remaining());
    if (!active()) return waiting("source_inactive");
    renew(db, claim);
    const peer = inputPeer(source), entity = await bounded(client, client.getEntity(peer.input), remaining());
    if (!active()) return waiting("source_inactive");
    renew(db, claim);
    if (!(entity instanceof Api.Channel) || entity.broadcast !== true || entity.left || entity.noforwards || peer.protected
      || Number(utils.getPeerId(entity)) !== job.source_chat_id) return waiting("source_identity_invalid");
    const messages = await bounded(client, client.getMessages(peer.input, { ids: [job.source_message_id], limit: 1 }), remaining());
    if (!active()) return waiting("source_inactive");
    renew(db, claim);
    const message = messages.length === 1 && messages[0] instanceof Api.Message ? messages[0] : null;
    if (!message || message.id !== job.source_message_id || !message.peerId || Number(utils.getPeerId(message.peerId)) !== job.source_chat_id
      || !Number.isSafeInteger(message.date) || message.date * 1000 > Date.now() + 1000
      || message.date * 1000 < Math.floor(Math.max(source.selected_at, settings.relay_started_at) / 1000) * 1000
      || post.source_date > 0 && post.source_date !== message.date) return waiting("source_identity_invalid");
    const media = eligibleMedia(message, false, target.bot_id, false);
    if (!media || media.mediaKind !== job.media_kind || sourceMediaHash(media.mediaId) !== post.media_id_hash) return waiting("source_media_changed");
    if (!message.message?.trim()) return waiting("source_caption_missing");
    const { observeRelaySourceCaption } = await import("./telegram-relay");
    if (!active()) return waiting("source_inactive");
    const accepted = observeRelaySourceCaption({ sourceChatId: job.source_chat_id, sourceMessageId: job.source_message_id,
      sourceDate: message.date, mediaKind: media.mediaKind, sourceMediaId: media.mediaId, caption: message.message,
      captionEntities: captionEntities(message.entities), expectedCustomEmojiCount: (message.entities || []).filter(entity => entity.className === "MessageEntityCustomEmoji").length,
      origin: "account", accountGeneration: current.generation, relayRevision: input.relayRevision });
    if (!active()) return waiting("source_inactive");
    const latest = reference();
    if (!accepted || !latest || latest.source_content_hash.startsWith("invalid:")) return waiting("source_capture_waiting");
    const verifiedAt = Date.now();
    db.prepare(`UPDATE telegram_personal_source_posts SET revision_hash=?,checked_at=?,source_date=?
      WHERE source_chat_id=? AND source_message_id=? AND account_generation=? AND relay_revision=? AND selected_at=? AND media_id_hash=?`)
      .run(sourcePostHash(message, media.mediaId), verifiedAt, message.date, job.source_chat_id, job.source_message_id,
        current.generation, input.relayRevision, source.selected_at, post.media_id_hash);
    return { state: "ok", sourceVersion: latest.source_version, verifiedAt };
  } catch (error) {
    const safe = safeError(error);
    // Observation persists only a bounded cooldown. Even a revoked-session
    // reply must not reset selections, cursors, credentials or media queues.
    if (owns(db, claim)) db.prepare(`UPDATE telegram_personal_account SET last_error=?,next_attempt_at=MAX(next_attempt_at,?)
      WHERE id='primary' AND lease_id=?`).run(safe.message, Math.min(Number.MAX_SAFE_INTEGER, Date.now() + safe.delay), claim.leaseId);
    console.warn("Telegram personal account operation failed.", JSON.stringify({ operation: "relay-caption-source-refresh", category: failureCategory(error) }));
    const latest = row(db), backoff = safe.status === 429;
    return { state: safe.revoked || latest.stage !== "connected" ? "disconnected" : backoff ? "backoff" : "unavailable",
      reason: backoff ? "source_backoff" : "source_unavailable", retryAt: Math.max(Date.now() + 5000, latest.next_attempt_at) };
  } finally { release(db, claim); await closeClient(client, Math.max(1, Math.min(2000, deadline - Date.now()))); }
}

/** Catch up from per-channel durable cursors; new selections start at the latest message. */
export async function pollTelegramAccountOnce() {
  const db = getSqlite();
  const current = row(db);
  if (current.stage !== "connected" || !current.session_ciphertext || current.next_attempt_at > Date.now() || current.lease_until > Date.now()) return;
  const relay = db.prepare("SELECT relay_enabled,relay_revision,relay_started_at,relay_caption_watch_enabled,relay_caption_watch_interval_seconds,relay_caption_serial_enabled FROM telegram_promotion_settings WHERE id='primary'").get() as { relay_enabled: number; relay_revision: string; relay_started_at: number; relay_caption_watch_enabled: number; relay_caption_watch_interval_seconds: number; relay_caption_serial_enabled: number } | undefined;
  const target = db.prepare("SELECT target_chat_id,ready_until,bot_id,revision FROM telegram_relay_state WHERE id='primary'").get() as { target_chat_id: number; ready_until: number; bot_id: number; revision: string } | undefined;
  const ready = relay?.relay_enabled === 1 && target && target.ready_until > Date.now() && target.revision === relay.relay_revision && target.target_chat_id < 0;
  const repairNow = Date.now();
  const serialWatch = relay?.relay_caption_serial_enabled === 1 && relay.relay_caption_watch_enabled === 1;
  const focus = serialWatch ? (await import("./telegram-caption-watch-cycle")).captionWatchFocus(db, repairNow) : null;
  // Reserve the next lease window after a source-caption preflight has already
  // waited. Otherwise receive can reacquire the account just before its retry
  // and repeatedly exhaust a healthy version's bounded busy waits.
  if (ready && relay.relay_caption_watch_enabled === 1 && (!serialWatch || focus && focus.retryAt <= repairNow) && db.prepare(`SELECT 1 FROM telegram_relay_source_edits e JOIN telegram_relay_outbox o ON o.id=e.outbox_id
    WHERE e.status='pending' AND (e.next_attempt_at<=? OR (e.preflight_waits>0 AND e.next_attempt_at<=?))
    AND e.source_version=o.source_version AND o.status='sent' AND o.message_id>0 AND o.revision=?${serialWatch ? " AND e.outbox_id=?" : ""} LIMIT 1`)
    .get(repairNow, repairNow + LEASE_MS, relay.relay_revision, ...(serialWatch ? [focus!.outboxId] : []))) return;
  // Initial Emoji repairs share the same lease reservation as source updates.
  // Match the actual worker's eligibility so obsolete work cannot block receive.
  if (ready && !serialWatch && db.prepare(`SELECT 1 FROM telegram_relay_outbox WHERE status='sent' AND revision=? AND message_id>0
    AND sent_at>=? AND sent_at<=? AND caption_edit_attempted_at>0
    AND (next_attempt_at<=? OR (caption_edit_outcome IN ('account_waiting_1','account_waiting_2','account_waiting_3',
      'account_recheck_waiting_1','account_recheck_waiting_2','account_recheck_waiting_3') AND next_attempt_at<=?))
    AND source_content_hash NOT LIKE 'invalid:%'
    AND NOT EXISTS(SELECT 1 FROM telegram_relay_source_edits e WHERE e.outbox_id=telegram_relay_outbox.id AND e.outcome<>'applied_before_send')
    AND ((caption_edit_outcome IN ('changed','account_waiting_1','account_waiting_2','account_waiting_3','account_revalidated') AND last_error=?)
      OR (caption_edit_outcome='account_unavailable' AND last_error=?)
      OR (caption_edit_outcome='rejected' AND last_error=? AND instr(caption_entities,'"custom_emoji"')>0)
      OR (((caption_edit_outcome='account_invalid' AND caption_edit_recheck_count=0)
        OR (caption_edit_outcome='account_invalid_final' AND caption_edit_recheck_count=1 AND caption_metadata_recovery_count=0)
        OR (caption_edit_outcome IN ('account_recheck_waiting_1','account_recheck_waiting_2','account_recheck_waiting_3') AND caption_edit_recheck_count=1))
        AND instr(caption_entities,'"custom_emoji"')>0)) LIMIT 1`)
    .get(relay.relay_revision, repairNow - 24 * 60 * 60_000, repairNow, repairNow, repairNow + LEASE_MS,
      "Telegram 未保留部分原始自定义 Emoji，请检查机器人的自定义 Emoji 使用权限。该消息不会自动重发。",
      "个人账号备用补正当前不可用，请检查本人账号连接和编辑权限；原媒体不会重复发送。",
      "Telegram 拒绝补正文案或按钮，请检查机器人权限及原消息格式；不会重复发送媒体。")) return;
  const refreshDue = current.synced_at < Date.now() - REFRESH_MS;
  const source = ready ? db.prepare(`SELECT * FROM telegram_personal_sources WHERE selected=1 AND joined=1
    AND chat_id<>? ORDER BY CASE WHEN chat_id>? THEN 0 ELSE 1 END,chat_id LIMIT 1`).get(target.target_chat_id, current.poll_source_id) as SourceRow | undefined : undefined;
  if (!refreshDue && !source) return;
  const claim = claimAccount(db, Date.now(), { connected: true, respectBackoff: true, purpose: "background" });
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
      if (entity.noforwards || peer.protected) {
        cancelSourceQueue(db, selected.chat_id);
        db.prepare("DELETE FROM telegram_personal_source_posts WHERE source_chat_id=?").run(selected.chat_id);
      }
      pruneSourcePosts(db, claim.row.generation, relay.relay_revision);
      if (!entity.noforwards && !peer.protected) bootstrapSourcePosts(db, selected, claim.row.generation, relay.relay_revision);
    });
    const pollDeadline = Date.now() + 40_000;
    const remaining = () => Math.max(1, Math.min(REQUEST_MS, pollDeadline - Date.now()));
    const sourceActive = () => Date.now() < pollDeadline && owns(db, claim)
      && Boolean(db.prepare(`SELECT 1 FROM telegram_personal_sources s,telegram_promotion_settings p
        WHERE s.chat_id=? AND s.selected=1 AND s.joined=1 AND s.blocked=0 AND s.selected_at=?
        AND p.id='primary' AND p.relay_enabled=1 AND p.relay_revision=?`).get(selected.chat_id, selected.selected_at, relay.relay_revision));
    let recheckDownloads = 0;
    const consume = async (message: Api.Message, media: NonNullable<ReturnType<typeof eligibleMedia>>, rechecking = false) => {
      if (!sourceActive()) return false;
      const { enqueuePersonalRelayMedia, observeRelaySourceCaption } = await import("./telegram-relay");
      const known = db.prepare("SELECT 1 FROM telegram_relay_outbox WHERE source_chat_id=? AND source_message_id=?")
        .get(selected.chat_id, message.id);
      if (known) return observeRelaySourceCaption({ sourceChatId: selected.chat_id, sourceMessageId: message.id,
        sourceDate: message.date, mediaKind: media.mediaKind, sourceMediaId: media.mediaId,
        caption: message.message, captionEntities: captionEntities(message.entities),
        expectedCustomEmojiCount: (message.entities || []).filter(entity => entity.className === "MessageEntityCustomEmoji").length,
        origin: "account", accountGeneration: claim.row.generation, relayRevision: relay.relay_revision });
      if (!message.message?.trim()) return true;
      if (rechecking && recheckDownloads++ >= 1) return false;
      renew(db, claim);
      let bytes: string | Buffer | undefined;
      try {
        bytes = await bounded(client!, client!.downloadMedia(message, {
          signal: AbortSignal.timeout(remaining()), requestTimeout: remaining(),
          progressCallback: (downloaded, total) => {
            if (Number(downloaded.toString()) > media.max || Number(total.toString()) > media.max) throw new OversizeMediaError();
          },
        }), remaining());
      } catch (error) { if (error instanceof OversizeMediaError) return true; throw error; }
      renew(db, claim);
      if (Buffer.isBuffer(bytes) && bytes.length > media.max) return true;
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new TelegramAccountError(TEMP_ERROR, 502);
      if (!sourceActive()) return false;
      const consumed = await enqueuePersonalRelayMedia({ sourceChatId: selected.chat_id, sourceMessageId: message.id,
        sourceDate: message.date, relayRevision: relay.relay_revision,
        mediaGroupId: message.groupedId?.toString() || "", caption: message.message, captionEntities: captionEntities(message.entities),
        expectedCustomEmojiCount: (message.entities || []).filter(entity => entity.className === "MessageEntityCustomEmoji").length,
        mediaKind: media.mediaKind, bytes, hasSpoiler: (message.media instanceof Api.MessageMediaPhoto || message.media instanceof Api.MessageMediaDocument) && message.media.spoiler === true,
        sourceMediaId: media.mediaId, accountGeneration: claim.row.generation,
        ...(media.mediaKind === "video" ? { mimeType: media.mimeType } : {}) });
      renew(db, claim);
      return consumed;
    };
    const acceptSnapshot = (message: Api.Message, mediaId: string) => db.prepare(`UPDATE telegram_personal_source_posts
      SET revision_hash=?,checked_at=? WHERE source_chat_id=? AND source_message_id=? AND account_generation=? AND relay_revision=? AND selected_at=?`)
      .run(sourcePostHash(message, mediaId), Date.now(), selected.chat_id, message.id, claim.row.generation, relay.relay_revision, selected.selected_at);
    // Re-read only posts already observed after this source was selected. A
    // bounded oldest-checked rotation also finds late captions and same-second
    // caption/entity edits, without scanning channel history or replaying media.
    if (sourceActive() && relay.relay_caption_watch_enabled === 1) {
      const recheckMs = [30, 60, 180, 300].includes(relay.relay_caption_watch_interval_seconds)
        ? relay.relay_caption_watch_interval_seconds * 1000 : SOURCE_RECHECK_MS;
      const watched = db.prepare(`SELECT * FROM telegram_personal_source_posts WHERE source_chat_id=?
        AND account_generation=? AND relay_revision=? AND selected_at=? AND checked_at<=?
        ORDER BY checked_at,source_message_id LIMIT ?`).all(selected.chat_id, claim.row.generation, relay.relay_revision,
        selected.selected_at, Date.now() - recheckMs, SOURCE_RECHECK_BATCH) as SourcePostRow[];
      if (watched.length) {
        renew(db, claim);
        const snapshots = await bounded(client, client.getMessages(peer.input, { ids: watched.map(post => post.source_message_id), limit: SOURCE_RECHECK_BATCH }), remaining());
        renew(db, claim);
        for (const post of watched) {
          if (!sourceActive()) break;
          db.prepare("UPDATE telegram_personal_source_posts SET checked_at=? WHERE source_chat_id=? AND source_message_id=?")
            .run(Date.now(), post.source_chat_id, post.source_message_id);
          const matches = snapshots.filter(message => message instanceof Api.Message && message.id === post.source_message_id);
          const message = matches.length === 1 ? matches[0] : undefined;
          const media = message && eligibleMedia(message, entity.noforwards === true || peer.protected, target.bot_id, false);
          if (!message || !message.peerId || Number(utils.getPeerId(message.peerId)) !== selected.chat_id
            || !Number.isSafeInteger(message.date) || message.date * 1000 > Date.now() + 1000
            || message.date * 1000 < Math.floor(Math.max(selected.selected_at, relay.relay_started_at) / 1000) * 1000
            || post.source_date !== 0 && message.date !== post.source_date || !media || sourceMediaHash(media.mediaId) !== post.media_id_hash) {
            transaction(db, () => {
              db.prepare(`UPDATE telegram_relay_source_edits SET status='superseded',outcome='source_inactive'
                WHERE status='pending' AND outbox_id IN(SELECT id FROM telegram_relay_outbox WHERE origin='account'
                  AND source_chat_id=? AND source_message_id=?)`).run(post.source_chat_id, post.source_message_id);
              db.prepare(`UPDATE telegram_relay_outbox SET status='cancelled',media_bytes=NULL,last_error=''
                WHERE origin='account' AND status='pending' AND source_chat_id=? AND source_message_id=?`)
                .run(post.source_chat_id, post.source_message_id);
              db.prepare("DELETE FROM telegram_personal_source_posts WHERE source_chat_id=? AND source_message_id=?")
                .run(post.source_chat_id, post.source_message_id);
            });
            continue;
          }
          if (post.source_date === 0) db.prepare(`UPDATE telegram_personal_source_posts SET source_date=?
            WHERE source_chat_id=? AND source_message_id=? AND source_date=0`).run(message.date, post.source_chat_id, post.source_message_id);
          if (sourcePostHash(message, media.mediaId) === post.revision_hash) continue;
          if (await consume(message, media, true)) acceptSnapshot(message, media.mediaId);
        }
      }
    }
    const iterator = client.iterMessages(peer.input, { minId: selected.last_message_id, reverse: true, limit: 20 })[Symbol.asyncIterator]();
    let last = selected.last_message_id;
    for (;;) {
      if (Date.now() >= pollDeadline) break;
      renew(db, claim);
      const next = await bounded(client, iterator.next(), remaining());
      if (next.done) break;
      const message = next.value;
      if (!Number.isSafeInteger(message.id) || message.id <= last) continue;
      if (!(message instanceof Api.Message) || message.date * 1000 < Math.floor(Math.max(selected.selected_at, relay.relay_started_at) / 1000) * 1000) {
        last = message.id;
      } else {
        const media = eligibleMedia(message, entity.noforwards === true || peer.protected, target.bot_id, false);
        if (!media) last = message.id;
        else {
          rememberSourcePost(db, selected, message, media.mediaId, claim.row.generation, relay.relay_revision);
          if (!await consume(message, media)) break;
          acceptSnapshot(message, media.mediaId);
          last = message.id;
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

/** Server-only application credentials, never the owner's personal login session. */
export function hotVideoBotApplication(db = getSqlite()) {
  const current = row(db);
  if (!current.config_ciphertext) return null;
  const credentials = unseal<Credentials>(current.config_ciphertext);
  return { ...credentials, revision: createHash("sha256").update(current.config_ciphertext).digest("hex") };
}

export type HotVideoSourcePageInput = {
  chatId: number; revision: string; beforeId: number; afterId: number; backfillDone: boolean; limit?: number;
};
export type HotVideoSourceHistory = {
  state: "ok" | "busy" | "backoff" | "disconnected" | "protected" | "unavailable" | "changed";
  accountGeneration: string; sourceTitle: string; sourceUsername: string; lastMessageId: number;
  backfillBeforeId: number; backfillDone: boolean; retryAfterMs: number;
  videos: { sourceMessageId: number; documentId: string; bytes: number; createdAt: number }[];
  inspection: { messages: number; documents: number; regularVideos: number; eligibleVideos: number; absentTtlNull: number; ephemeralVideos: number; unsupportedVideos: number; invalidMetadata: number; dateObjects: number };
};

/** Metadata-only history reader sharing the existing account lease. No media, captions, access hashes or sessions leave this helper. */
export async function readHotVideoSourcePages(db: DatabaseSync, input: HotVideoSourcePageInput): Promise<HotVideoSourceHistory> {
  const current = row(db), limit = Math.max(1, Math.min(50, Math.floor(input.limit || 50)));
  const result: HotVideoSourceHistory = { state: "unavailable", accountGeneration: current.generation, sourceTitle: "", sourceUsername: "",
    lastMessageId: input.afterId, backfillBeforeId: input.beforeId, backfillDone: input.backfillDone, retryAfterMs: RETRY_MS, videos: [],
    inspection: { messages: 0, documents: 0, regularVideos: 0, eligibleVideos: 0, absentTtlNull: 0, ephemeralVideos: 0, unsupportedVideos: 0, invalidMetadata: 0, dateObjects: 0 } };
  if (!Number.isSafeInteger(input.chatId) || input.chatId >= 0 || !input.revision || ![input.beforeId, input.afterId].every(value => Number.isSafeInteger(value) && value >= 0)) return result;
  if (current.stage !== "connected" || !current.session_ciphertext) return { ...result, state: "disconnected" };
  if (current.next_attempt_at > Date.now()) return { ...result, state: "backoff", retryAfterMs: Math.max(1000, current.next_attempt_at - Date.now()) };
  if (current.lease_until > Date.now()) return { ...result, state: "busy", retryAfterMs: 15_000 };
  const selected = db.prepare("SELECT * FROM telegram_personal_sources WHERE chat_id=? AND joined=1").get(input.chatId) as SourceRow | undefined;
  const selectedHot = () => Boolean(db.prepare("SELECT 1 FROM telegram_hot_video_sources WHERE chat_id=? AND selected=1 AND revision=?").get(input.chatId, input.revision));
  if (!selected || !selectedHot()) return { ...result, state: "changed" };
  if (selected.blocked) return { ...result, state: "protected" };
  let claim: Claim;
  try { claim = claimAccount(db, Date.now(), { connected: true, respectBackoff: true, purpose: "background" }); }
  catch { return { ...result, state: "busy", retryAfterMs: 15_000 }; }
  let client: TelegramClient | undefined;
  const deadline = Date.now() + 40_000;
  const remaining = () => Math.max(1, Math.min(REQUEST_MS, deadline - Date.now()));
  const active = () => Date.now() < deadline && owns(db, claim) && selectedHot()
    && Boolean(db.prepare("SELECT 1 FROM telegram_personal_sources WHERE chat_id=? AND joined=1 AND peer_ciphertext=?").get(selected.chat_id, selected.peer_ciphertext));
  const assertActive = () => {
    if (!active()) throw new TelegramAccountError("来源或账号设置已改变，本次读取已停止。", 409);
    renew(db, claim);
  };
  try {
    client = makeClient(unseal<Credentials>(claim.row.config_ciphertext), unseal<string>(claim.row.session_ciphertext));
    assertActive(); await bounded(client, client.connect(), remaining()); assertActive();
    const peer = inputPeer(selected);
    if (peer.protected) return { ...result, state: "protected" };
    const entity = await bounded(client, client.getEntity(peer.input), remaining()); assertActive();
    if (!(entity instanceof Api.Channel) || Number(utils.getPeerId(entity)) !== input.chatId || !entity.broadcast || entity.left) return result;
    if (entity.noforwards) return { ...result, state: "protected" };
    result.sourceTitle = String(entity.title || selected.title).slice(0, 300);
    result.sourceUsername = String(entity.username || "").slice(0, 64);
    const readPage = async (mode: "new" | "backfill" | "initial", boundary: number) => {
      assertActive();
      const iterator = client!.iterMessages(peer.input, { limit, ...(mode === "new" ? { minId: boundary, reverse: true } : boundary > 0 ? { maxId: boundary } : {}) })[Symbol.asyncIterator]();
      let fetched = 0, last = mode === "new" ? boundary : Infinity, minimum = Infinity, maximum = 0;
      try {
        for (; fetched < limit; fetched++) {
          assertActive(); const next = await bounded(client!, iterator.next(), remaining()); assertActive();
          if (next.done) break;
          const message = next.value, id = Number(message.id);
          if (!Number.isSafeInteger(id) || id <= 0 || (mode === "new" ? id <= last : id >= last) || boundary > 0 && (mode === "new" ? id <= boundary : id >= boundary))
            throw new TelegramAccountError("Telegram 来源列表暂时未能完整读取，请稍后再试。", 502);
          last = id; minimum = Math.min(minimum, id); maximum = Math.max(maximum, id); result.inspection.messages++;
          if (!(message instanceof Api.Message)) continue;
          if (!message.peerId || Number(utils.getPeerId(message.peerId)) !== input.chatId) throw new TelegramAccountError("Telegram 来源身份不一致，本次读取已停止。", 409);
          if (message.noforwards || !(message.media instanceof Api.MessageMediaDocument) || !(message.media.document instanceof Api.Document)) continue;
          result.inspection.documents++;
          // The pinned SDK decodes an absent optional TL integer as null, while
          // constructor-created objects use undefined. Explicit zero has no TTL.
          if (message.media.ttlSeconds === null) result.inspection.absentTtlNull++;
          if (message.media.ttlSeconds != null && message.media.ttlSeconds !== 0) { result.inspection.ephemeralVideos++; continue; }
          const document = message.media.document;
          if (document.mimeType !== "video/mp4" || !document.attributes?.some(attribute => attribute instanceof Api.DocumentAttributeVideo && !attribute.roundMessage)
            || document.attributes.some(attribute => attribute instanceof Api.DocumentAttributeAnimated)) { result.inspection.unsupportedVideos++; continue; }
          result.inspection.regularVideos++;
          let documentId = ""; try { documentId = document.id.toString(); } catch { /* malformed metadata is skipped */ }
          const sourceDate: unknown = message.date, bytes = Number(document.size?.toString());
          if (sourceDate instanceof Date) result.inspection.dateObjects++;
          const createdAt = sourceDate instanceof Date ? sourceDate.getTime() : typeof sourceDate === "number" ? sourceDate * 1000 : NaN;
          if (!/^-?[1-9]\d{0,19}$/.test(documentId) || !Number.isSafeInteger(bytes) || bytes <= 0 || !Number.isSafeInteger(createdAt) || createdAt <= 0 || createdAt > Date.now() + 1000) { result.inspection.invalidMetadata++; continue; }
          result.videos.push({ sourceMessageId: id, documentId, bytes, createdAt }); result.inspection.eligibleVideos++;
        }
      } finally { if (iterator.return) await bounded(client!, iterator.return(undefined), Math.max(1, Math.min(1000, remaining()))).catch(() => undefined); }
      return { fetched, minimum: Number.isFinite(minimum) ? minimum : 0, maximum };
    };
    if (!input.beforeId && !input.afterId && !input.backfillDone) {
      const page = await readPage("initial", 0);
      result.lastMessageId = page.maximum;
      result.backfillBeforeId = page.minimum;
      result.backfillDone = page.fetched < limit || page.minimum <= 1;
    } else {
      const fresh = await readPage("new", input.afterId);
      result.lastMessageId = Math.max(input.afterId, fresh.maximum);
      if (!input.backfillDone) {
        const older = await readPage("backfill", input.beforeId);
        result.backfillBeforeId = older.minimum || input.beforeId;
        result.backfillDone = older.fetched < limit || older.minimum <= 1;
      }
    }
    assertActive();
    // Persist only this transport's renewed encrypted session. Relay source cursors and selections are never edited.
    saveSession(db, claim, client);
    return { ...result, state: "ok", retryAfterMs: 30_000 };
  } catch (error) {
    if (!active()) return { ...result, state: "changed", videos: [] };
    const raw = error as { errorMessage?: string };
    if (/CHANNEL_PRIVATE|CHANNEL_INVALID|USER_BANNED_IN_CHANNEL|CHAT_FORBIDDEN/.test(raw?.errorMessage || "")) return { ...result, state: "unavailable", videos: [] };
    const safe = safeError(error);
    if (safe.status === 429 || safe.revoked) recordFailure(db, claim, error, "hot-video-source-history");
    return { ...result, state: safe.status === 429 ? "backoff" : safe.revoked ? "disconnected" : "unavailable", retryAfterMs: Math.max(15_000, safe.delay), videos: [] };
  } finally { release(db, claim); await closeClient(client); }
}
