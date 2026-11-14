import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getSqlite } from "./sqlite";
import { answerTelegramCallback, telegramBooleanRequest, telegramRequest } from "./telegram-bot";

type DecryptToken = (ciphertext: string) => string;
export type JoinGateRequirement = { chatId: string; label: string; url: string };
export type JoinGateInput = { enabled: boolean; targetChatId: string; requiredChats: JoinGateRequirement[]; revision?: string };
type Gate = { enabled: number; target_chat_id: number; target_title: string; requirements: string; revision: string;
  token_hash: string; bot_id: number; invite_link: string; started_at: number; last_checked_at: number; last_error: string;
  lease_id: string; lease_until: number; next_run_at: number };
type Job = { user_id: number; revision: string; request_pending: number; notify_pending: number; notification_attempted: number;
  callback_id: string; sequence: number; status: string; attempts: number; next_attempt_at: number; lease_id: string; lease_until: number };
type Member = { state: string; blocked_by_gate: number; ban_until: number; checked_at: number };
type Discovery = { chat_id: number; requested_by: number; token_hash: string; queued_at: number; attempts: number };
type RecordValue = Record<string, unknown>;
const LEASE_MS = 120_000, TICK_MS = 10_000, RECHECK_MS = 5 * 60_000;
const TOKEN_ERROR = "请先保存并启用 @FreeBonus365ChatBot 的 1 对 1 私聊。";
const TEMP_ERROR = "暂时无法核实 Telegram 成员资格，稍后自动复查；不会据此移除成员。";
const PERMISSION_ERROR = "机器人管理员权限不足，请检查三个地方的权限后重新保存门禁设置。";
const defaults: JoinGateRequirement[] = [
  { chatId: "@join365freebonus", label: "🎁 BONUS OFFICIAL", url: "https://t.me/join365freebonus" },
  { chatId: "@join365freebonusgroup", label: "🎁 BONUS GROUP", url: "https://t.me/join365freebonusgroup" },
];
export class JoinGateError extends Error { constructor(message: string, readonly status = 400, readonly retryAfter = 0) { super(message); } }
const asRecord = (v: unknown): RecordValue | null => v && typeof v === "object" && !Array.isArray(v) ? v as RecordValue : null;
const positive = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const chatNumber = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v < 0;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function transaction<T>(db: DatabaseSync, work: () => T): T { db.exec("BEGIN IMMEDIATE"); try { const r = work(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } }
function gate(db: DatabaseSync): Gate {
  db.prepare("INSERT OR IGNORE INTO telegram_join_gate_settings(id) VALUES('primary')").run();
  return db.prepare("SELECT * FROM telegram_join_gate_settings WHERE id='primary'").get() as Gate;
}
function chatSettings(db: DatabaseSync) {
  return db.prepare("SELECT chat_bot_token_ciphertext,private_enabled FROM telegram_promotion_settings WHERE id='primary'").get() as
    { chat_bot_token_ciphertext: string; private_enabled: number } | undefined;
}
function requirements(value: Gate): JoinGateRequirement[] {
  try { const r: unknown = JSON.parse(value.requirements); return Array.isArray(r) ? r as JoinGateRequirement[] : []; } catch { return []; }
}
function memberState(value: RecordValue): "yes" | "no" | "unknown" {
  if (["member", "administrator", "creator"].includes(String(value.status))) return "yes";
  if (value.status === "restricted") return typeof value.is_member === "boolean" ? value.is_member ? "yes" : "no" : "unknown";
  return ["left", "kicked"].includes(String(value.status)) ? "no" : "unknown";
}
const administrator = (value: RecordValue) => value.status === "administrator" || value.status === "creator";
function parseChatId(value: string): string | number {
  const normalized = value.trim();
  if (/^-[1-9]\d{0,15}$/.test(normalized) && Number.isSafeInteger(Number(normalized))) return Number(normalized);
  const match = /^(?:@([A-Za-z][A-Za-z0-9_]{3,31})|https:\/\/t\.me\/([A-Za-z][A-Za-z0-9_]{3,31})\/?)$/.exec(normalized);
  if (match) return `@${match[1] || match[2]}`;
  throw new JoinGateError("请输入频道数字 ID、@用户名或公开 t.me 链接；私密邀请链接不能作为频道 ID。");
}
function cleanInput(input: JoinGateInput): JoinGateInput {
  if (!input || typeof input.enabled !== "boolean" || typeof input.targetChatId !== "string"
    || !Array.isArray(input.requiredChats) || input.enabled && input.requiredChats.length < 1 || input.requiredChats.length > 8)
    throw new JoinGateError("请设置 1 至 8 个必须加入的频道或群组。");
  const list = input.requiredChats.map(item => {
    if (!item || typeof item.chatId !== "string" || typeof item.label !== "string" || typeof item.url !== "string"
      || !item.label.trim() || item.label.trim().length > 80 || !/^https:\/\/t\.me\/[A-Za-z][A-Za-z0-9_]{3,31}\/?$/.test(item.url.trim()))
      throw new JoinGateError("请检查加入条件名称与公开 Telegram 链接。");
    parseChatId(item.chatId);
    return { chatId: item.chatId.trim(), label: item.label.trim(), url: item.url.trim().replace(/\/$/, "") };
  });
  if (input.enabled || input.targetChatId.trim()) parseChatId(input.targetChatId);
  return { ...input, targetChatId: input.targetChatId.trim(), requiredChats: list };
}
export function joinGateMenuEnabled(db: DatabaseSync): boolean {
  const value = gate(db), chat = chatSettings(db);
  return value.enabled === 1 && Boolean(value.invite_link) && chat?.private_enabled === 1
    && value.token_hash === hash(chat.chat_bot_token_ciphertext);
}
export function joinGateStatus(db: DatabaseSync) {
  const value = gate(db), chat = chatSettings(db), tokenHash = hash(chat?.chat_bot_token_ciphertext || "");
  const counts = { pending: 0, approved: 0, blocked: 0, failed: 0, unknown: 0 };
  for (const row of db.prepare("SELECT state,COUNT(*) AS count FROM telegram_join_gate_members WHERE revision=? AND state IN ('approved','blocked') GROUP BY state").all(value.revision) as { state: string; count: number }[])
    if (row.state in counts) counts[row.state as keyof typeof counts] += row.count;
  for (const row of db.prepare("SELECT status,COUNT(*) AS count FROM telegram_join_gate_jobs WHERE revision=? AND status IN ('pending','working','failed','unknown') GROUP BY status").all(value.revision) as { status: string; count: number }[]) {
    const key = row.status === "working" ? "pending" : row.status;
    if (key in counts) counts[key as keyof typeof counts] += row.count;
  }
  const unresolved = db.prepare(`SELECT last_error FROM telegram_join_gate_jobs WHERE revision=? AND status IN ('failed','unknown')
    AND last_error<>'' ORDER BY next_attempt_at DESC,user_id DESC LIMIT 1`).get(value.revision) as { last_error: string } | undefined;
  return { enabled: value.enabled === 1, targetChatId: value.target_chat_id ? String(value.target_chat_id) : "", targetTitle: value.target_title,
    requiredChats: requirements(value).length ? requirements(value) : defaults.map(r => ({ ...r })), revision: value.revision,
    inviteLink: value.invite_link, ready: joinGateMenuEnabled(db) && value.last_error === "" && value.last_checked_at > Date.now() - 120_000,
    lastError: value.enabled && (value.token_hash !== tokenHash || chat?.private_enabled !== 1) ? TOKEN_ERROR : value.last_error || unresolved?.last_error || "", lastCheckedAt: value.last_checked_at || null, counts,
    candidates: (db.prepare("SELECT chat_id,title FROM telegram_join_gate_candidates WHERE token_hash=? ORDER BY verified_at DESC LIMIT 30").all(tokenHash) as { chat_id: number; title: string }[])
      .map(row => ({ chatId: String(row.chat_id), title: row.title })),
  };
}
async function objectRequest(token: string, method: Parameters<typeof telegramRequest>[1], parameters: RecordValue, valid: () => boolean): Promise<RecordValue> {
  if (!valid()) throw new JoinGateError("门禁设置已改变，请刷新后重试。", 409);
  const result = await telegramRequest(token, method, parameters);
  if (!valid()) throw new JoinGateError("门禁设置已改变，请刷新后重试。", 409);
  if (!result?.ok) {
    if (result && result.code === 429) throw new JoinGateError("Telegram 正在限制请求频率，稍后自动复查。", 429, Math.max(10, result.retryAfter));
    throw new JoinGateError(result && [400, 401, 403].includes(result.code) ? PERMISSION_ERROR : TEMP_ERROR, 503);
  }
  return result.result;
}
async function verifyConfiguration(db: DatabaseSync, token: string, value: Gate, valid: () => boolean) {
  const me = await objectRequest(token, "getMe", {}, valid);
  if (!positive(me.id) || me.is_bot !== true || String(me.username).toLowerCase() !== "freebonus365chatbot") throw new JoinGateError(TOKEN_ERROR);
  const target = await objectRequest(token, "getChat", { chat_id: value.target_chat_id }, valid);
  if (target.id !== value.target_chat_id || target.type !== "channel" || target.username
    || Array.isArray(target.active_usernames) && target.active_usernames.length) throw new JoinGateError("Hot 必须是没有公开用户名的私密频道。");
  const own = await objectRequest(token, "getChatMember", { chat_id: target.id, user_id: me.id }, valid);
  if (!administrator(own) || own.status !== "creator" && (own.can_invite_users !== true || own.can_restrict_members !== true)) throw new JoinGateError(PERMISSION_ERROR);
  const ids = new Set<number>([value.target_chat_id]);
  const resolvedRequirements = requirements(value);
  for (const item of resolvedRequirements) {
    const id = parseChatId(item.chatId), chat = await objectRequest(token, "getChat", { chat_id: id }, valid);
    if (!chatNumber(chat.id) || typeof id === "number" && chat.id !== id || !["channel", "supergroup", "group"].includes(String(chat.type)) || ids.has(chat.id)) throw new JoinGateError("Hot 和必须加入的目标不能相同，加入条件也不能重复。");
    const username = typeof chat.username === "string" ? chat.username : "";
    if (!username || item.url.toLowerCase() !== `https://t.me/${username}`.toLowerCase()) throw new JoinGateError("加入链接与 Telegram 实际频道不一致，请使用该频道的公开用户名链接。");
    const role = await objectRequest(token, "getChatMember", { chat_id: chat.id, user_id: me.id }, valid);
    if (!administrator(role)) throw new JoinGateError(PERMISSION_ERROR);
    ids.add(chat.id);
    item.chatId = String(chat.id);
  }
  return { target, requirements: resolvedRequirements, botId: Number(me.id) };
}
export async function saveJoinGateSettings(db: DatabaseSync, raw: JoinGateInput, decryptToken: DecryptToken, clock = Date.now) {
  const input = cleanInput(raw), previous = gate(db), snapshot = chatSettings(db), now = clock();
  if (input.revision !== undefined && input.revision !== previous.revision) throw new JoinGateError("门禁设置已被其他页面更新，请刷新后再保存。", 409);
  if (!input.enabled) {
    const draftTarget = input.targetChatId ? parseChatId(input.targetChatId) : 0;
    if (typeof draftTarget !== "number") throw new JoinGateError("私密 Hot 请使用数字 ID，或从识别列表选择频道。");
    transaction(db, () => {
      const same = previous.target_chat_id === draftTarget;
      const revision = randomUUID();
      db.prepare(`UPDATE telegram_join_gate_settings SET enabled=0,target_chat_id=?,target_title=?,invite_link=?,requirements=?,revision=?,
        last_error='',lease_id='',lease_until=0,next_run_at=0 WHERE id='primary'`)
        .run(draftTarget, same ? previous.target_title : "", same ? previous.invite_link : "", JSON.stringify(input.requiredChats), revision);
      if (same) db.prepare("UPDATE telegram_join_gate_members SET revision=? WHERE target_chat_id=? AND revision=?")
        .run(revision, draftTarget, previous.revision);
      db.prepare("UPDATE telegram_join_gate_jobs SET status='cancelled',lease_id='',lease_until=0 WHERE status IN ('pending','working')").run();
    });
    return joinGateStatus(db);
  }
  if (!snapshot?.chat_bot_token_ciphertext || snapshot.private_enabled !== 1) throw new JoinGateError(TOKEN_ERROR);
  let token = ""; try { token = decryptToken(snapshot.chat_bot_token_ciphertext); } catch { /* never expose stored credentials */ }
  if (!token) throw new JoinGateError(TOKEN_ERROR);
  const leaseId = randomUUID();
  transaction(db, () => {
    const current = gate(db);
    if (current.revision !== previous.revision || current.lease_until > now) throw new JoinGateError("门禁正在处理上一项操作，请稍后再保存。", 409);
    db.prepare("UPDATE telegram_join_gate_settings SET lease_id=?,lease_until=? WHERE id='primary'").run(leaseId, now + LEASE_MS);
  });
  const valid = () => {
    const current = gate(db), chat = chatSettings(db);
    return clock() < now + LEASE_MS && current.revision === previous.revision && current.lease_id === leaseId
      && current.lease_until > clock() && chat?.private_enabled === 1 && chat.chat_bot_token_ciphertext === snapshot.chat_bot_token_ciphertext;
  };
  try {
    const identity = await objectRequest(token, "getChat", { chat_id: parseChatId(input.targetChatId) }, valid);
    if (!chatNumber(identity.id)) throw new JoinGateError("无法识别 Hot 频道，请从候选列表选择正确频道。");
    const candidate = { ...previous, target_chat_id: identity.id, requirements: JSON.stringify(input.requiredChats) };
    const verified = await verifyConfiguration(db, token, candidate, valid);
    const webhook = await objectRequest(token, "getWebhookInfo", {}, valid);
    if (webhook.url) throw new JoinGateError("ChatBot 正由其他 Webhook 接收，请先处理接收冲突。");
    const invite = await objectRequest(token, "createChatInviteLink", { chat_id: identity.id, name: "Hot 入群审批", creates_join_request: true }, valid);
    if (invite.creates_join_request !== true || typeof invite.invite_link !== "string" || !/^https:\/\/t\.me\/(?:\+|joinchat\/)[A-Za-z0-9_-]+$/.test(invite.invite_link))
      throw new JoinGateError("Telegram 没有确认创建审批邀请链接，门禁未启用。", 503);
    transaction(db, () => {
      if (!valid()) throw new JoinGateError("门禁设置已改变，请刷新后重试。", 409);
      const revision = randomUUID();
      db.prepare(`UPDATE telegram_join_gate_settings SET enabled=1,target_chat_id=?,target_title=?,requirements=?,revision=?,token_hash=?,bot_id=?,invite_link=?,
        started_at=?,last_checked_at=?,last_error='',lease_id='',lease_until=0,next_run_at=0 WHERE id='primary'`)
        .run(Number(identity.id), String(verified.target.title || "Hot").slice(0, 200), JSON.stringify(verified.requirements), revision,
          hash(snapshot.chat_bot_token_ciphertext), verified.botId, String(invite.invite_link), now, clock());
      if (previous.target_chat_id === identity.id && previous.bot_id === verified.botId)
        db.prepare("UPDATE telegram_join_gate_members SET revision=?,checked_at=0 WHERE target_chat_id=? AND revision=?")
          .run(revision, Number(identity.id), previous.revision);
      db.prepare("UPDATE telegram_join_gate_jobs SET status='cancelled',lease_id='',lease_until=0 WHERE status IN ('pending','working')").run();
    });
    return joinGateStatus(db);
  } finally { db.prepare("UPDATE telegram_join_gate_settings SET lease_id='',lease_until=0 WHERE id='primary' AND lease_id=?").run(leaseId); }
}

function enqueue(db: DatabaseSync, value: Gate, userId: number, now: number, request = false, notify = false, callback = "") {
  db.prepare(`INSERT INTO telegram_join_gate_jobs(user_id,revision,request_pending,notify_pending,callback_id,next_attempt_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,
    request_pending=CASE WHEN revision=excluded.revision THEN MAX(request_pending,excluded.request_pending) ELSE excluded.request_pending END,
    notify_pending=MAX(notify_pending,excluded.notify_pending),notification_attempted=CASE WHEN excluded.notify_pending=1 THEN 0 ELSE notification_attempted END,
    callback_id=CASE WHEN excluded.callback_id<>'' THEN excluded.callback_id ELSE callback_id END,
    sequence=sequence+1,status='pending',attempts=0,next_attempt_at=excluded.next_attempt_at,lease_id='',lease_until=0,last_error=''`)
    .run(userId, value.revision, Number(request), Number(notify), callback, now);
}
function discover(db: DatabaseSync, chat: RecordValue | null, requester: number, tokenHash: string, now: number) {
  if (!chat || !chatNumber(chat.id) || chat.type !== "channel") return;
  const count = db.prepare("SELECT COUNT(*) AS count FROM telegram_join_gate_discovery").get() as { count: number };
  if (count.count >= 30) return;
  db.prepare(`INSERT INTO telegram_join_gate_discovery(chat_id,requested_by,token_hash,queued_at,next_attempt_at) VALUES(?,?,?,?,?)
    ON CONFLICT(chat_id) DO UPDATE SET requested_by=excluded.requested_by,token_hash=excluded.token_hash,queued_at=excluded.queued_at,next_attempt_at=excluded.next_attempt_at,attempts=0`)
    .run(chat.id, requester, tokenHash, now, now);
}
/** Called in the existing poller's cursor transaction. No network or extra update receiver. */
export function observeJoinGateUpdate(db: DatabaseSync, update: RecordValue, updateId: number, now: number): boolean {
  const settings = chatSettings(db);
  if (!settings?.chat_bot_token_ciphertext) return false;
  const tokenHash = hash(settings.chat_bot_token_ciphertext), value = gate(db);
  const self = asRecord(update.my_chat_member), post = asRecord(update.channel_post), message = asRecord(update.message);
  if (self) discover(db, asRecord(self.chat), 0, tokenHash, now);
  if (post) discover(db, asRecord(post.chat), 0, tokenHash, now);
  const sender = asRecord(message?.from), privateChat = asRecord(message?.chat), origin = asRecord(message?.forward_origin);
  const privateMessage = message && positive(message.message_id) && privateChat?.type === "private" && sender?.is_bot === false
    && positive(sender.id) && privateChat.id === sender.id;
  const forwarded = privateMessage && origin?.type === "channel" && asRecord(origin.chat);
  if (forwarded) discover(db, forwarded, sender!.id as number, tokenHash, now);
  const enabled = value.enabled === 1 && settings.private_enabled === 1 && value.token_hash === tokenHash;
  if (!enabled) return Boolean(forwarded);
  const callback = asRecord(update.callback_query), callbackMessage = asRecord(callback?.message), callbackSender = asRecord(callback?.from), callbackChat = asRecord(callbackMessage?.chat);
  const callbackValid = callback?.data === "hot:check" && typeof callback.id === "string" && callback.id.length > 0 && callback.id.length <= 128
    && positive(callbackMessage?.message_id)
    && callbackSender?.is_bot === false && positive(callbackSender.id) && callbackChat?.type === "private" && callbackChat.id === callbackSender.id;
  const text = privateMessage && typeof message.text === "string" && message.via_bot == null && message.forward_origin == null ? message.text.trim() : "";
  const privateCommand = Boolean(text && positive(message?.date) && message.date >= Math.floor(value.started_at / 1000)
    && (/^\/hot(?:@FreeBonus365ChatBot)?\s*$/i.test(text) || /^\/start(?:@FreeBonus365ChatBot)?\s+hot\s*$/i.test(text) || text === "🔒 Hot 频道"));
  const request = asRecord(update.chat_join_request), requestChat = asRecord(request?.chat), requestUser = asRecord(request?.from);
  const event = asRecord(update.chat_member), eventChat = asRecord(event?.chat), changed = asRecord(event?.new_chat_member), eventUser = asRecord(changed?.user);
  const requestValid = requestChat?.id === value.target_chat_id && requestUser?.is_bot === false && positive(requestUser.id)
    && positive(request?.date) && request.date >= Math.floor(value.started_at / 1000);
  const eventValid = chatNumber(eventChat?.id) && eventUser?.is_bot === false && positive(eventUser.id)
    && positive(event?.date) && event.date >= Math.floor(value.started_at / 1000);
  if (!callbackValid && !privateCommand && !requestValid && !eventValid) return Boolean(forwarded);
  const inserted = db.prepare("INSERT OR IGNORE INTO telegram_join_gate_events(token_hash,update_id,created_at) VALUES(?,?,?)").run(tokenHash, updateId, now);
  if (!inserted.changes) return callbackValid || privateCommand;
  db.prepare("DELETE FROM telegram_join_gate_events WHERE created_at<?").run(now - 2 * 86400_000);
  if (privateCommand || callbackValid) enqueue(db, value, privateCommand ? sender!.id as number : callbackSender!.id as number, now, false, true, callbackValid ? callback!.id as string : "");
  if (requestValid) {
    db.prepare(`INSERT INTO telegram_join_gate_members(target_chat_id,user_id,revision) VALUES(?,?,?)
      ON CONFLICT(target_chat_id,user_id) DO UPDATE SET revision=excluded.revision,
      blocked_by_gate=CASE WHEN revision=excluded.revision THEN blocked_by_gate ELSE 0 END,
      ban_until=CASE WHEN revision=excluded.revision THEN ban_until ELSE 0 END`).run(value.target_chat_id, Number(requestUser!.id), value.revision);
    enqueue(db, value, requestUser!.id as number, now, true);
  }
  if (eventValid) {
    const id = eventUser!.id as number;
    const actor = asRecord(event!.from);
    if (eventChat!.id === value.target_chat_id && ["kicked", "left"].includes(String(changed?.status)) && actor?.id !== value.bot_id) {
      db.prepare("UPDATE telegram_join_gate_members SET blocked_by_gate=0,ban_until=0,state='blocked' WHERE target_chat_id=? AND user_id=?")
        .run(value.target_chat_id, id);
      // Invalidate a simultaneous gate action: a human moderation change must
      // never be overwritten by the result of an older request in flight.
      db.prepare(`UPDATE telegram_join_gate_jobs SET sequence=sequence+1,status='cancelled',lease_id='',lease_until=0
        WHERE user_id=? AND revision=?`).run(id, value.revision);
    }
    if (eventChat!.id === value.target_chat_id && changed && memberState(changed) === "yes") {
      db.prepare(`INSERT INTO telegram_join_gate_members(target_chat_id,user_id,revision) VALUES(?,?,?)
        ON CONFLICT(target_chat_id,user_id) DO UPDATE SET revision=excluded.revision,
        blocked_by_gate=CASE WHEN revision=excluded.revision THEN blocked_by_gate ELSE 0 END,
        ban_until=CASE WHEN revision=excluded.revision THEN ban_until ELSE 0 END`).run(value.target_chat_id, id, value.revision);
      enqueue(db, value, id, now);
    } else if (requirements(value).some(item => Number(item.chatId) === eventChat!.id)
      && db.prepare("SELECT 1 FROM telegram_join_gate_members WHERE target_chat_id=? AND user_id=? AND revision=?").get(value.target_chat_id, id, value.revision)) enqueue(db, value, id, now);
  }
  return callbackValid || privateCommand || Boolean(forwarded);
}

type Claim = { value: Gate; leaseId: string; ciphertext: string; token: string; deadline: number; job?: Job; discovery?: Discovery };
function claimAllowed(db: DatabaseSync, claim: Claim, now: number, enabled = true): boolean {
  const current = gate(db), chat = chatSettings(db);
  return now < claim.deadline && current.revision === claim.value.revision && current.lease_id === claim.leaseId && current.lease_until > now
    && chat?.chat_bot_token_ciphertext === claim.ciphertext && chat.private_enabled === 1
    && (!enabled || current.enabled === 1 && current.token_hash === hash(claim.ciphertext))
    && (!claim.job || Boolean(db.prepare(`SELECT 1 FROM telegram_join_gate_jobs WHERE user_id=? AND revision=? AND sequence=?
      AND lease_id=? AND lease_until>? AND status='working'`).get(claim.job.user_id, claim.value.revision, claim.job.sequence, claim.leaseId, now)));
}
async function booleanRequest(token: string, method: Parameters<typeof telegramBooleanRequest>[1], parameters: RecordValue, valid: () => boolean) {
  if (!valid()) throw new JoinGateError("门禁设置已改变，请刷新后重试。", 409);
  const result = await telegramBooleanRequest(token, method, parameters);
  if (!valid()) throw new JoinGateError("门禁设置已改变，请刷新后重试。", 409);
  if (result?.ok) return;
  if (result && result.code === 429) throw new JoinGateError("Telegram 正在限制请求频率，稍后自动复查。", 429, Math.max(10, result.retryAfter));
  throw new JoinGateError(result && [400, 401, 403].includes(result.code) ? PERMISSION_ERROR : TEMP_ERROR, 503);
}
function markMember(db: DatabaseSync, value: Gate, userId: number, state: string, at: number, blocked?: boolean, banUntil?: number) {
  db.prepare(`INSERT INTO telegram_join_gate_members(target_chat_id,user_id,revision,state,blocked_by_gate,ban_until,checked_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(target_chat_id,user_id) DO UPDATE SET revision=excluded.revision,state=excluded.state,
    blocked_by_gate=CASE WHEN ? IS NULL THEN blocked_by_gate ELSE excluded.blocked_by_gate END,
    ban_until=CASE WHEN ? IS NOT NULL THEN excluded.ban_until WHEN ?=0 THEN 0 ELSE ban_until END,checked_at=excluded.checked_at`)
    .run(value.target_chat_id, userId, value.revision, state, Number(blocked === true), banUntil || 0, at,
      blocked === undefined ? null : Number(blocked), banUntil ?? null, blocked === undefined ? null : Number(blocked));
}
function finishJob(db: DatabaseSync, claim: Claim, status: string, now: number, error = "") {
  if (!claim.job) return;
  db.prepare(`UPDATE telegram_join_gate_jobs SET status=?,last_error=?,request_pending=0,notify_pending=0,callback_id='',lease_id='',lease_until=0
    WHERE user_id=? AND revision=? AND sequence=? AND lease_id=?`).run(status, error, claim.job.user_id, claim.value.revision, claim.job.sequence, claim.leaseId);
  if (claimAllowedWithoutJob(db, claim, now)) db.prepare("UPDATE telegram_join_gate_settings SET last_checked_at=?,last_error=? WHERE id='primary' AND lease_id=?")
    .run(now, error, claim.leaseId);
}
function claimAllowedWithoutJob(db: DatabaseSync, claim: Claim, now: number) {
  return claimAllowed(db, { ...claim, job: undefined }, now);
}
async function notifyCustomer(db: DatabaseSync, claim: Claim, missing: JoinGateRequirement[], admitted: boolean, clock: () => number) {
  const job = claim.job!;
  if (!job.notify_pending || job.notification_attempted) return;
  const valid = () => claimAllowed(db, claim, clock());
  if (!valid()) return;
  const parameters = missing.length
    ? { text: `请先加入以下所有地方，再点击验证：\n${missing.map(item => item.label).join("\n")}`,
      reply_markup: { inline_keyboard: [...missing.map(item => [{ text: item.label, url: item.url }]), [{ text: "✅ 我已加入，重新验证", callback_data: "hot:check" }]] } }
    : { text: admitted ? "加入条件已通过，你已在 Hot 频道。" : "所有加入条件已验证通过，请点击下方按钮申请进入 Hot。",
      reply_markup: { inline_keyboard: [[{ text: "🔥 申请进入 Hot", url: claim.value.invite_link }], [{ text: "✅ 重新验证", callback_data: "hot:check" }]] } };
  // Persist before the only send. A timeout never automatically duplicates a DM.
  const changed = db.prepare(`UPDATE telegram_join_gate_jobs SET notification_attempted=1 WHERE user_id=? AND revision=?
    AND sequence=? AND lease_id=? AND notification_attempted=0`).run(job.user_id, claim.value.revision, job.sequence, claim.leaseId);
  if (!changed.changes || !valid()) return;
  const reply = await telegramRequest(claim.token, "sendMessage", { chat_id: job.user_id, ...parameters, link_preview_options: { is_disabled: true } });
  if (!valid()) return;
  if (reply?.ok && positive(reply.result.message_id)) {
    const { recordPrivateFollowupOutbound } = await import("./telegram-followups");
    if (!valid()) return;
    const date = reply.result.date;
    recordPrivateFollowupOutbound(db, job.user_id, reply.result.message_id, positive(date) ? date * 1000 : clock());
  } else if (reply && !reply.ok && reply.code === 429) {
    db.prepare(`UPDATE telegram_join_gate_jobs SET notification_attempted=0 WHERE user_id=? AND revision=? AND sequence=? AND lease_id=?`)
      .run(job.user_id, claim.value.revision, job.sequence, claim.leaseId);
    throw new JoinGateError("Telegram 正在限制请求频率，稍后自动复查。", 429, Math.max(10, reply.retryAfter));
  } else {
    finishJob(db, claim, "unknown", clock(), "Telegram 未确认门禁提示的发送结果；该提示不会自动重发。");
  }
}
async function processDiscovery(db: DatabaseSync, claim: Claim, clock: () => number) {
  const entry = claim.discovery!, valid = () => claimAllowed(db, claim, clock(), false);
  const me = await objectRequest(claim.token, "getMe", {}, valid);
  if (!positive(me.id) || me.is_bot !== true || String(me.username).toLowerCase() !== "freebonus365chatbot") throw new JoinGateError(TOKEN_ERROR);
  const chat = await objectRequest(claim.token, "getChat", { chat_id: entry.chat_id }, valid);
  if (chat.id !== entry.chat_id || chat.type !== "channel") throw new JoinGateError("候选目标不是频道。");
  const own = await objectRequest(claim.token, "getChatMember", { chat_id: entry.chat_id, user_id: me.id }, valid);
  if (!administrator(own)) throw new JoinGateError(PERMISSION_ERROR);
  if (entry.requested_by) {
    const sender = await objectRequest(claim.token, "getChatMember", { chat_id: entry.chat_id, user_id: entry.requested_by }, valid);
    if (!administrator(sender)) throw new JoinGateError("只有该频道管理员转发的消息可用于识别目标。");
  }
  if (!valid()) return;
  db.prepare(`INSERT INTO telegram_join_gate_candidates(chat_id,title,token_hash,verified_at) VALUES(?,?,?,?)
    ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title,token_hash=excluded.token_hash,verified_at=excluded.verified_at`)
    .run(entry.chat_id, String(chat.title || "Telegram 频道").slice(0, 200), entry.token_hash, clock());
  db.prepare("DELETE FROM telegram_join_gate_discovery WHERE chat_id=? AND token_hash=? AND queued_at=?").run(entry.chat_id, entry.token_hash, entry.queued_at);
}
async function processJob(db: DatabaseSync, claim: Claim, clock: () => number) {
  const value = claim.value, job = claim.job!, valid = () => claimAllowed(db, claim, clock());
  const verified = await verifyConfiguration(db, claim.token, value, valid);
  if (job.callback_id) {
    if (!valid()) return;
    await answerTelegramCallback(claim.token, job.callback_id).catch(() => false);
    if (!valid()) return;
  }
  const missing: JoinGateRequirement[] = [];
  for (const item of verified.requirements) {
    const member = await objectRequest(claim.token, "getChatMember", { chat_id: Number(item.chatId), user_id: job.user_id }, valid);
    const state = memberState(member);
    if (state === "unknown") throw new JoinGateError(TEMP_ERROR, 503);
    if (state === "no") missing.push(item);
  }
  const hot = await objectRequest(claim.token, "getChatMember", { chat_id: value.target_chat_id, user_id: job.user_id }, valid);
  const existing = db.prepare("SELECT state,blocked_by_gate,ban_until,checked_at FROM telegram_join_gate_members WHERE target_chat_id=? AND user_id=? AND revision=?")
    .get(value.target_chat_id, job.user_id, value.revision) as Member | undefined;
  const ownedBan = hot.status === "kicked" && existing && existing.ban_until > Math.floor(clock() / 1000) && hot.until_date === existing.ban_until;
  if (hot.status === "kicked" && existing) {
    // A fresh, exact Telegram expiry proves the pending gate ban took effect;
    // an unrelated manual ban must never inherit the gate's unban authority.
    existing.blocked_by_gate = Number(Boolean(ownedBan));
    markMember(db, value, job.user_id, "blocked", clock(), Boolean(ownedBan), ownedBan ? existing.ban_until : 0);
  }
  let admitted = memberState(hot) === "yes";
  if (memberState(hot) === "unknown") throw new JoinGateError(TEMP_ERROR, 503);
  if (admitted && job.request_pending) {
    // A human or an earlier ambiguous approval already resolved this request.
    // Do not decline a nonexistent request after enforcing the current rules.
    db.prepare("UPDATE telegram_join_gate_jobs SET request_pending=0 WHERE user_id=? AND sequence=? AND lease_id=?")
      .run(job.user_id, job.sequence, claim.leaseId);
    job.request_pending = 0;
  }
  if (administrator(hot)) {
    markMember(db, value, job.user_id, "approved", clock(), false);
  } else if (missing.length) {
    if (admitted && existing) {
      const until = Math.floor(clock() / 1000) + 365 * 86400;
      markMember(db, value, job.user_id, "pending", clock(), false, until);
      await booleanRequest(claim.token, "banChatMember", { chat_id: value.target_chat_id, user_id: job.user_id, until_date: until }, valid);
      if (!valid()) return;
      markMember(db, value, job.user_id, "blocked", clock(), true, until);
      admitted = false;
    } else if (existing) markMember(db, value, job.user_id, existing.blocked_by_gate ? "blocked" : "pending", clock());
    if (job.request_pending) {
      await booleanRequest(claim.token, "declineChatJoinRequest", { chat_id: value.target_chat_id, user_id: job.user_id }, valid);
      if (!valid()) return;
      db.prepare("UPDATE telegram_join_gate_jobs SET request_pending=0 WHERE user_id=? AND sequence=? AND lease_id=?")
        .run(job.user_id, job.sequence, claim.leaseId);
    }
  } else {
    if (hot.status === "kicked" && existing?.blocked_by_gate) {
      await booleanRequest(claim.token, "unbanChatMember", { chat_id: value.target_chat_id, user_id: job.user_id, only_if_banned: true }, valid);
      if (!valid()) return;
      markMember(db, value, job.user_id, "pending", clock(), false);
    } else if (hot.status === "kicked") {
      finishJob(db, claim, "failed", clock(), "该成员被其他管理员限制，系统不会自动解除人工封禁。"); return;
    }
    if (!admitted && job.request_pending) {
      await booleanRequest(claim.token, "approveChatJoinRequest", { chat_id: value.target_chat_id, user_id: job.user_id }, valid);
      const after = await objectRequest(claim.token, "getChatMember", { chat_id: value.target_chat_id, user_id: job.user_id }, valid);
      if (memberState(after) !== "yes") throw new JoinGateError("Telegram 尚未确认加入结果，将只读复查后再处理。", 503);
      admitted = true;
    }
    if (existing || admitted) markMember(db, value, job.user_id, admitted ? "approved" : "pending", clock(), false);
  }
  await notifyCustomer(db, claim, missing, admitted, clock);
  if (!valid()) return;
  finishJob(db, claim, "done", clock());
}

/** One bounded, leased gate operation; never opens another getUpdates stream. */
export async function runJoinGateOnce(decryptToken: DecryptToken, clock = Date.now): Promise<void> {
  const db = getSqlite(), now = clock(), settings = chatSettings(db);
  if (!settings?.chat_bot_token_ciphertext || settings.private_enabled !== 1) return;
  let token = ""; try { token = decryptToken(settings.chat_bot_token_ciphertext); } catch { /* private fixed error only */ }
  if (!token) return;
  const claim = transaction(db, () => {
    const value = gate(db), current = chatSettings(db), tokenHash = hash(settings.chat_bot_token_ciphertext);
    if (current?.chat_bot_token_ciphertext !== settings.chat_bot_token_ciphertext || value.lease_until > now || value.next_run_at > now) return null;
    db.prepare("DELETE FROM telegram_join_gate_discovery WHERE token_hash<>? OR queued_at<?").run(tokenHash, now - 24 * 60 * 60_000);
    const active = value.enabled === 1 && value.token_hash === tokenHash;
    let job: Job | undefined;
    if (active) {
      // In-flight approval/ban may already have succeeded. Resume by reading
      // membership first, never by blindly replaying the previous operation.
      db.prepare("UPDATE telegram_join_gate_jobs SET status='pending',lease_id='',lease_until=0 WHERE status='working' AND lease_until<=?").run(now);
      job = db.prepare("SELECT * FROM telegram_join_gate_jobs WHERE revision=? AND status='pending' AND next_attempt_at<=? ORDER BY next_attempt_at,user_id LIMIT 1")
        .get(value.revision, now) as Job | undefined;
      if (!job) {
        const member = db.prepare(`SELECT user_id FROM telegram_join_gate_members WHERE revision=? AND state IN ('approved','blocked')
          AND checked_at<=? ORDER BY checked_at,user_id LIMIT 1`).get(value.revision, now - RECHECK_MS) as { user_id: number } | undefined;
        if (member) {
          db.prepare("UPDATE telegram_join_gate_members SET checked_at=? WHERE target_chat_id=? AND user_id=? AND revision=?")
            .run(now, value.target_chat_id, member.user_id, value.revision);
          enqueue(db, value, member.user_id, now); job = db.prepare("SELECT * FROM telegram_join_gate_jobs WHERE user_id=?").get(member.user_id) as Job;
        }
      }
    }
    const discovery = !job ? db.prepare("SELECT * FROM telegram_join_gate_discovery WHERE token_hash=? AND next_attempt_at<=? ORDER BY requested_by=0 DESC,queued_at LIMIT 1")
      .get(tokenHash, now) as Discovery | undefined : undefined;
    if (!job && !discovery && (!active || value.last_checked_at > now - 60_000)) return null;
    const leaseId = randomUUID();
    db.prepare("UPDATE telegram_join_gate_settings SET lease_id=?,lease_until=?,next_run_at=? WHERE id='primary'").run(leaseId, now + LEASE_MS, now + TICK_MS);
    if (job) {
      db.prepare("UPDATE telegram_join_gate_jobs SET status='working',attempts=attempts+1,lease_id=?,lease_until=? WHERE user_id=? AND revision=? AND sequence=?")
        .run(leaseId, now + LEASE_MS, job.user_id, value.revision, job.sequence);
      job = { ...job, status: "working", attempts: job.attempts + 1, lease_id: leaseId, lease_until: now + LEASE_MS };
    }
    return { value, leaseId, ciphertext: settings.chat_bot_token_ciphertext, token, deadline: now + LEASE_MS, job, discovery } as Claim;
  });
  if (!claim) return;
  try {
    if (claim.discovery) await processDiscovery(db, claim, clock);
    else if (claim.job) await processJob(db, claim, clock);
    else {
      await verifyConfiguration(db, claim.token, claim.value, () => claimAllowed(db, claim, clock()));
      if (claimAllowed(db, claim, clock())) db.prepare("UPDATE telegram_join_gate_settings SET last_checked_at=?,last_error='' WHERE id='primary' AND lease_id=?").run(clock(), claim.leaseId);
    }
  } catch (error) {
    const enabled = !claim.discovery;
    if (claimAllowed(db, claim, clock(), enabled)) {
      const safe = error instanceof JoinGateError ? error : new JoinGateError(TEMP_ERROR, 503);
      const delay = safe.status === 429 ? Math.max(TICK_MS, safe.retryAfter * 1000) : Math.min(300_000, 10_000 * 2 ** Math.min(5, claim.job?.attempts || claim.discovery?.attempts || 0));
      db.prepare("UPDATE telegram_join_gate_settings SET last_error=?,next_run_at=? WHERE id='primary' AND lease_id=?").run(safe.message, clock() + delay, claim.leaseId);
      if (claim.job) db.prepare(`UPDATE telegram_join_gate_jobs SET status=?,next_attempt_at=?,last_error=?,lease_id='',lease_until=0
        WHERE user_id=? AND revision=? AND sequence=? AND lease_id=?`).run(claim.job.attempts >= 5 ? "failed" : "pending", clock() + delay, safe.message,
          claim.job.user_id, claim.value.revision, claim.job.sequence, claim.leaseId);
      if (claim.discovery) {
        if (claim.discovery.attempts >= 2 || safe.status !== 429 && safe.message !== TEMP_ERROR) db.prepare("DELETE FROM telegram_join_gate_discovery WHERE chat_id=? AND token_hash=? AND queued_at=?")
          .run(claim.discovery.chat_id, claim.discovery.token_hash, claim.discovery.queued_at);
        else db.prepare("UPDATE telegram_join_gate_discovery SET attempts=attempts+1,next_attempt_at=? WHERE chat_id=? AND token_hash=? AND queued_at=?")
          .run(clock() + delay, claim.discovery.chat_id, claim.discovery.token_hash, claim.discovery.queued_at);
      }
    }
  } finally {
    db.prepare("UPDATE telegram_join_gate_settings SET lease_id='',lease_until=0 WHERE id='primary' AND lease_id=?").run(claim.leaseId);
  }
}
const workers = globalThis as typeof globalThis & { telegramJoinGateWorkerStarted?: boolean };
export function startJoinGateWorker(decryptToken: DecryptToken) {
  if (workers.telegramJoinGateWorkerStarted) return;
  workers.telegramJoinGateWorkerStarted = true;
  let running = false;
  const tick = async () => { if (running) return; running = true; try { await runJoinGateOnce(decryptToken); }
    catch { console.warn("Telegram join gate could not process its queue."); } finally { running = false; } };
  void tick(); setInterval(() => void tick(), TICK_MS).unref();
}
