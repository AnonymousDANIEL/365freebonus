import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getSqlite } from "./sqlite";
import { telegramRequest } from "./telegram-bot";
import type { ScheduledMessageStatus, ScheduledMessagePlan, ScheduledMessagePlanInput, ScheduledMessageTargetKey } from "./telegram-scheduled-messages-types";

type Decrypt = (ciphertext: string) => string;
type Plan = { id: string; revision: string; name: string; text: string; times_json: string; enabled: number; next_run_at: number; last_run_at: number; created_at: number; updated_at: number; deleted_at: number };
type Target = { target_key: ScheduledMessageTargetKey; chat_id: number; title: string; ready: number; last_error: string; verified_at: number };
type Runtime = { token_hash: string; bot_id: number; hot_chat_id: number; next_verify_at: number; owner_id: string; lease_id: string; lease_until: number; heartbeat_at: number; last_tick_at: number; last_completed_at: number; last_error: string };
type Delivery = { id: string; plan_id: string; plan_revision: string; plan_name: string; text: string; run_at: number; target_key: ScheduledMessageTargetKey; target_chat_id: number; target_title: string; token_hash: string; bot_id: number; status: string; attempts: number; next_attempt_at: number; lease_id: string; lease_until: number; dispatch_started_at: number; last_error: string; sent_at: number; message_id: number };
const DAY = 86_400_000, OFFSET = 8 * 3_600_000, TICK_MS = 5_000, LEASE_MS = 90_000, GRACE_MS = 15 * 60_000, MAX_ATTEMPTS = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const TOKEN_ERROR = "请先保存 @FreeBonus365ChatBot 的 Token。";
const TARGET_ERROR = "请检查三个频道的机器人发布权限，并重新验证频道。";
const CHANGED_ERROR = "机器人或 Hot 目标已改变，请重新验证频道后继续发布。";
const UNKNOWN_ERROR = "Telegram 未确认发送结果，已停止自动重试以避免重复。";
const TARGETS: { key: ScheduledMessageTargetKey; title: string; username?: string }[] = [
  { key: "official", title: "365 Free Bonus Official", username: "join365freebonus" },
  { key: "group", title: "365 Free Bonus Group", username: "join365freebonusgroup" },
  { key: "hot", title: "🔞365 Free Bonus Hot" },
];
export class ScheduledMessageError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const validChat = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value < 0;
const validId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const result = work(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; }
}
function cipher(db: DatabaseSync): string { return (db.prepare("SELECT chat_bot_token_ciphertext FROM telegram_promotion_settings WHERE id='primary'").get() as { chat_bot_token_ciphertext: string } | undefined)?.chat_bot_token_ciphertext || ""; }
function hotChatId(db: DatabaseSync): number {
  const video = (db.prepare("SELECT target_chat_id FROM telegram_hot_video_settings WHERE id='primary'").get() as { target_chat_id: number } | undefined)?.target_chat_id;
  if (validChat(video)) return video;
  const gate = (db.prepare("SELECT target_chat_id FROM telegram_join_gate_settings WHERE id='primary'").get() as { target_chat_id: number } | undefined)?.target_chat_id;
  return validChat(gate) ? gate : 0;
}
function runtime(db: DatabaseSync): Runtime { return db.prepare("SELECT * FROM telegram_scheduled_message_runtime WHERE id='primary'").get() as Runtime; }
function targets(db: DatabaseSync): Target[] { return db.prepare("SELECT * FROM telegram_scheduled_message_targets").all() as Target[]; }
function plan(db: DatabaseSync, id: string): Plan | undefined { return db.prepare("SELECT * FROM telegram_scheduled_message_plans WHERE id=? AND deleted_at=0").get(id) as Plan | undefined; }
function parseTimes(value: string): string[] { try { const times: unknown = JSON.parse(value); return Array.isArray(times) && times.every(t => typeof t === "string" && TIME.test(t)) ? times : []; } catch { return []; } }
function dayStart(now: number): number { return Math.floor((now + OFFSET) / DAY) * DAY - OFFSET; }
function slot(day: number, time: string): number { const [hours, minutes] = time.split(":").map(Number); return day + hours * 3_600_000 + minutes * 60_000; }
/** Fixed UTC+8 wall times avoid host timezone, DST and interval drift. */
export function nextScheduledMessageTime(times: string[], now: number, inclusive = false): number {
  const start = dayStart(now);
  for (const day of [start, start + DAY]) for (const time of [...times].sort()) { const at = slot(day, time); if (inclusive ? at >= now : at > now) return at; }
  return 0;
}
function viewPlan(row: Plan): ScheduledMessagePlan { return { id: row.id, revision: row.revision, name: row.name, text: row.text, times: parseTimes(row.times_json), enabled: row.enabled === 1, nextRunAt: row.next_run_at || null, lastRunAt: row.last_run_at || null, createdAt: row.created_at, updatedAt: row.updated_at }; }
function identityCurrent(db: DatabaseSync): boolean {
  const state = runtime(db), stored = cipher(db);
  return Boolean(stored && state.token_hash === hash(stored) && state.bot_id > 0 && state.hot_chat_id === hotChatId(db));
}
function configured(db: DatabaseSync): boolean {
  const entries = targets(db);
  return identityCurrent(db) && TARGETS.every(t => entries.some(e => e.target_key === t.key && e.ready === 1 && validChat(e.chat_id)));
}
export function scheduledMessageStatus(db: DatabaseSync, clock = Date.now): ScheduledMessageStatus {
  const now = clock(), state = runtime(db), stored = cipher(db), rows = targets(db), current = identityCurrent(db);
  const plans = (db.prepare("SELECT * FROM telegram_scheduled_message_plans WHERE deleted_at=0 ORDER BY created_at,id").all() as Plan[]).map(viewPlan);
  const deliveries = (db.prepare("SELECT * FROM telegram_scheduled_message_deliveries ORDER BY run_at DESC,target_key,id LIMIT 150").all() as Delivery[]).map(row => ({ id: row.id, planId: row.plan_id, planName: row.plan_name, runAt: row.run_at, targetKey: row.target_key, targetTitle: row.target_title, status: row.status, attempts: row.attempts, lastError: row.last_error, sentAt: row.sent_at || null, messageId: row.message_id || null }));
  const counts: Record<string, number> = { pending: 0, sending: 0, sent: 0, failed: 0, unknown: 0, cancelled: 0, skipped: 0 };
  for (const row of db.prepare("SELECT status,COUNT(*) AS count FROM telegram_scheduled_message_deliveries GROUP BY status").all() as { status: string; count: number }[]) counts[row.status] = row.count;
  const next = plans.flatMap(p => p.enabled && p.nextRunAt ? [p.nextRunAt] : []);
  return { now, timezone: "Asia/Kuala_Lumpur", hasToken: Boolean(stored), plans, deliveries, counts,
    targets: TARGETS.map(target => { const row = rows.find(r => r.target_key === target.key); return { key: target.key, title: target.title, chatId: row?.chat_id ? String(row.chat_id) : target.key === "hot" && hotChatId(db) ? String(hotChatId(db)) : "", ready: current && row?.ready === 1, lastError: row?.last_error || (stored && !current ? CHANGED_ERROR : !stored ? TOKEN_ERROR : !row ? TARGET_ERROR : "") }; }),
    scheduler: { workerHealthy: state.heartbeat_at > 0 && now - state.heartbeat_at < 30_000, heartbeatAt: state.heartbeat_at || null, lastTickAt: state.last_tick_at || null, lastCompletedAt: state.last_completed_at || null, nextRunAt: next.length ? Math.min(...next) : null, lastError: state.last_error || (plans.some(p => p.enabled) && !configured(db) ? CHANGED_ERROR : "") } };
}

/** Permission checks only; this method never publishes a message. */
export async function verifyScheduledMessageTargets(db: DatabaseSync, decrypt: Decrypt, clock = Date.now): Promise<ScheduledMessageStatus> {
  const stored = cipher(db), hot = hotChatId(db), token = stored ? decrypt(stored) : "", now = clock();
  let botId = 0, globalError = "";
  if (!token) globalError = TOKEN_ERROR;
  else {
    const me = await telegramRequest(token, "getMe").catch(() => null);
    if (me?.ok && me.result.is_bot === true && validId(me.result.id) && typeof me.result.username === "string" && me.result.username.toLowerCase() === "freebonus365chatbot") botId = me.result.id;
    else globalError = "无法验证 @FreeBonus365ChatBot，请检查已保存的 Token。";
  }
  const verified = await Promise.all(TARGETS.map(async target => {
    const fail = (error: string): Target => ({ target_key: target.key, chat_id: 0, title: target.title, ready: 0, last_error: error, verified_at: now });
    if (globalError) return fail(globalError);
    if (target.key === "hot" && !hot) return fail("请先在 Hot 频道设置保存目标频道。" );
    const chat = await telegramRequest(token, "getChat", { chat_id: target.username ? `@${target.username}` : hot }).catch(() => null);
    if (!chat?.ok || !validChat(chat.result.id) || !["channel", "supergroup", "group"].includes(String(chat.result.type))
      || target.username && (typeof chat.result.username !== "string" || chat.result.username.toLowerCase() !== target.username)
      || target.key === "hot" && chat.result.id !== hot) return fail(`无法识别 ${target.title}，请检查频道和机器人权限。`);
    const member = await telegramRequest(token, "getChatMember", { chat_id: chat.result.id, user_id: botId }).catch(() => null);
    const allowed = member?.ok && (member.result.status === "creator" || member.result.status === "administrator" && (chat.result.type !== "channel" || member.result.can_post_messages === true));
    if (!allowed) return { ...fail(`请将 @FreeBonus365ChatBot 设为 ${target.title} 管理员并允许发布消息。`), chat_id: chat.result.id };
    return { target_key: target.key, chat_id: chat.result.id, title: target.title, ready: 1, last_error: "", verified_at: now } as Target;
  }));
  const ids = verified.filter(t => t.ready).map(t => t.chat_id);
  if (new Set(ids).size !== ids.length) for (const row of verified) { row.ready = 0; row.last_error = "三个目标必须是不同的频道，请检查 Hot 频道设置。"; }
  transaction(db, () => {
    if (cipher(db) !== stored || hotChatId(db) !== hot) throw new ScheduledMessageError(CHANGED_ERROR, 409);
    for (const row of verified) db.prepare(`INSERT INTO telegram_scheduled_message_targets(target_key,chat_id,title,ready,last_error,verified_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(target_key) DO UPDATE SET chat_id=excluded.chat_id,title=excluded.title,ready=excluded.ready,last_error=excluded.last_error,verified_at=excluded.verified_at`)
      .run(row.target_key, row.chat_id, row.title, row.ready, row.last_error, row.verified_at);
    db.prepare("UPDATE telegram_scheduled_message_runtime SET token_hash=?,bot_id=?,hot_chat_id=?,next_verify_at=?,last_error=? WHERE id='primary'")
      .run(stored ? hash(stored) : "", botId, hot, now + (verified.every(t => t.ready) ? 60 * 60_000 : 60_000), verified.find(t => !t.ready)?.last_error || "");
  });
  return scheduledMessageStatus(db, clock);
}
function validateInput(input: ScheduledMessagePlanInput) {
  if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 100 || typeof input.text !== "string" || !input.text.trim() || input.text.length > 4096
    || !Array.isArray(input.times) || input.times.length < 1 || input.times.length > 24 || input.times.some(t => typeof t !== "string" || !TIME.test(t)) || new Set(input.times).size !== input.times.length
    || typeof input.enabled !== "boolean" || input.id !== undefined && !UUID.test(input.id) || input.revision !== undefined && !UUID.test(input.revision)
    || input.id && (!input.revision || input.requestId !== undefined) || !input.id && (typeof input.requestId !== "string" || !UUID.test(input.requestId) || input.revision !== undefined)) throw new ScheduledMessageError("请检查文案、每日发送时间和计划版本。" );
}
export async function saveScheduledMessagePlan(db: DatabaseSync, input: ScheduledMessagePlanInput, decrypt: Decrypt, clock = Date.now): Promise<ScheduledMessageStatus> {
  validateInput(input);
  const samePayload = (row: Plan) => !row.deleted_at && row.name === input.name.trim() && row.text === input.text
    && row.times_json === JSON.stringify([...input.times].sort()) && row.enabled === Number(input.enabled);
  const existingRequest = () => !input.id ? db.prepare("SELECT * FROM telegram_scheduled_message_plans WHERE id=?").get(input.requestId!) as Plan | undefined : undefined;
  const existing = existingRequest();
  if (existing) {
    if (!samePayload(existing)) throw new ScheduledMessageError("此新增请求已处理或内容已改变，请刷新后重试。", 409);
    return scheduledMessageStatus(db, clock);
  }
  const before = input.id ? plan(db, input.id) : undefined;
  if (input.id && (!before || before.revision !== input.revision)) throw new ScheduledMessageError("计划已被修改，请刷新后再保存。", 409);
  if (input.enabled) { await verifyScheduledMessageTargets(db, decrypt, clock); if (!configured(db)) throw new ScheduledMessageError(TARGET_ERROR); }
  transaction(db, () => {
    const replay = existingRequest();
    if (replay) {
      if (!samePayload(replay)) throw new ScheduledMessageError("此新增请求已处理或内容已改变，请刷新后重试。", 409);
      return;
    }
    const current = input.id ? plan(db, input.id) : undefined;
    if (input.enabled && !configured(db)) throw new ScheduledMessageError(CHANGED_ERROR, 409);
    if (input.id && (!current || current.revision !== input.revision)) throw new ScheduledMessageError("计划已被修改，请刷新后再保存。", 409);
    if (!current && (db.prepare("SELECT COUNT(*) AS count FROM telegram_scheduled_message_plans WHERE deleted_at=0").get() as { count: number }).count >= 100) throw new ScheduledMessageError("最多保留 100 个文案计划。" );
    const times = [...input.times].sort(), timesJson = JSON.stringify(times), name = input.name.trim(), enabled = Number(input.enabled), now = clock();
    if (current && current.name === name && current.text === input.text && current.times_json === timesJson && current.enabled === enabled) return;
    const next = enabled ? current?.enabled === 1 && current.times_json === timesJson ? current.next_run_at : nextScheduledMessageTime(times, now, true) : 0;
    const id = current?.id || input.requestId!, revision = randomUUID();
    db.prepare(`INSERT INTO telegram_scheduled_message_plans(id,revision,name,text,times_json,enabled,next_run_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,name=excluded.name,text=excluded.text,
      times_json=excluded.times_json,enabled=excluded.enabled,next_run_at=excluded.next_run_at,updated_at=excluded.updated_at`)
      .run(id, revision, name, input.text, timesJson, enabled, next, now, now);
    db.prepare(`UPDATE telegram_scheduled_message_deliveries SET text='',status='cancelled',last_error='计划已修改或停用。',lease_id='',lease_until=0
      WHERE plan_id=? AND status IN ('pending','sending') AND dispatch_started_at=0`).run(id);
  });
  return scheduledMessageStatus(db, clock);
}
export function deleteScheduledMessagePlan(db: DatabaseSync, input: { id: string; revision: string }, clock = Date.now): ScheduledMessageStatus {
  if (!UUID.test(input.id) || !UUID.test(input.revision)) throw new ScheduledMessageError("计划标识无效。" );
  transaction(db, () => {
    const current = plan(db, input.id);
    if (!current || current.revision !== input.revision) throw new ScheduledMessageError("计划已被修改，请刷新后重试。", 409);
    db.prepare("UPDATE telegram_scheduled_message_plans SET enabled=0,next_run_at=0,deleted_at=?,updated_at=?,revision=? WHERE id=?").run(clock(), clock(), randomUUID(), input.id);
    db.prepare(`UPDATE telegram_scheduled_message_deliveries SET text='',status='cancelled',last_error='计划已删除。',lease_id='',lease_until=0
      WHERE plan_id=? AND status IN ('pending','sending') AND dispatch_started_at=0`).run(input.id);
  });
  return scheduledMessageStatus(db, clock);
}

function materialize(db: DatabaseSync, now: number) {
  const state = runtime(db), channelRows = targets(db);
  const insert = (row: Plan, at: number, status: "pending" | "skipped", error = "") => {
    for (const target of TARGETS) {
      const channel = channelRows.find(t => t.target_key === target.key);
      db.prepare(`INSERT OR IGNORE INTO telegram_scheduled_message_deliveries
        (id,plan_id,plan_revision,plan_name,text,run_at,target_key,target_chat_id,target_title,token_hash,bot_id,status,next_attempt_at,last_error)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), row.id, row.revision, row.name, status === "pending" ? row.text : "", at, target.key, channel?.chat_id || 0, target.title, state.token_hash, state.bot_id, status, at, error);
    }
  };
  for (const row of db.prepare("SELECT * FROM telegram_scheduled_message_plans WHERE enabled=1 AND deleted_at=0 AND next_run_at>0 AND next_run_at<=?").all(now) as Plan[]) {
    const times = parseTimes(row.times_json);
    if (!times.length) { db.prepare("UPDATE telegram_scheduled_message_plans SET enabled=0,next_run_at=0 WHERE id=?").run(row.id); continue; }
    if (row.next_run_at < now - GRACE_MS) insert(row, row.next_run_at, "skipped", "错过发送时段超过 15 分钟，已跳过停机期间的旧时段。" );
    // Only recent wall-clock occurrences may catch up; long downtime never bursts an old backlog.
    let latest = row.last_run_at;
    for (const day of [dayStart(now) - DAY, dayStart(now)]) for (const time of times) {
      const at = slot(day, time);
      if (at >= row.next_run_at && at >= now - GRACE_MS && at <= now) { insert(row, at, "pending"); latest = Math.max(latest, at); }
    }
    db.prepare("UPDATE telegram_scheduled_message_plans SET next_run_at=?,last_run_at=? WHERE id=? AND revision=?")
      .run(nextScheduledMessageTime(times, now), latest, row.id, row.revision);
  }
}
function releaseTerminalPayloads(db: DatabaseSync) {
  // Keep the unique occurrence metadata forever for deduplication. Only the
  // redundant text snapshot is released after a definitive terminal outcome.
  db.prepare("UPDATE telegram_scheduled_message_deliveries SET text='' WHERE text<>'' AND status IN ('sent','failed','cancelled','skipped')").run();
}
function recover(db: DatabaseSync, now: number) {
  releaseTerminalPayloads(db);
  db.prepare(`UPDATE telegram_scheduled_message_deliveries SET status='unknown',last_error=?,lease_id='',lease_until=0
    WHERE status='sending' AND dispatch_started_at>0 AND lease_until<=?`).run(UNKNOWN_ERROR, now);
  db.prepare(`UPDATE telegram_scheduled_message_deliveries SET status='pending',lease_id='',lease_until=0
    WHERE status='sending' AND dispatch_started_at=0 AND lease_until<=?`).run(now);
  db.prepare(`UPDATE telegram_scheduled_message_deliveries SET text='',status='cancelled',last_error='计划已修改或停用。',lease_id='',lease_until=0
    WHERE status='pending' AND NOT EXISTS(SELECT 1 FROM telegram_scheduled_message_plans p
      WHERE p.id=plan_id AND p.revision=plan_revision AND p.enabled=1 AND p.deleted_at=0)`).run();
  db.prepare(`UPDATE telegram_scheduled_message_deliveries SET text='',status='skipped',last_error='发送时段已过期，未补发旧消息。',lease_id='',lease_until=0
    WHERE status='pending' AND run_at<?`).run(now - GRACE_MS);
}
function owns(db: DatabaseSync, lease: string, now: number): boolean { const state = runtime(db); return state.lease_id === lease && state.lease_until > now; }
function claimGroup(db: DatabaseSync, lease: string, now: number): Delivery[] {
  return transaction(db, () => {
    if (!owns(db, lease, now) || !identityCurrent(db)) return [];
    recover(db, now);
    const due = db.prepare("SELECT plan_id,run_at FROM telegram_scheduled_message_deliveries d WHERE status='pending' AND run_at<=? AND next_attempt_at<=? AND EXISTS(SELECT 1 FROM telegram_scheduled_message_targets t WHERE t.target_key=d.target_key AND t.ready=1) ORDER BY run_at,id LIMIT 1").get(now, now) as { plan_id: string; run_at: number } | undefined;
    if (!due) return [];
    const jobs = db.prepare("SELECT * FROM telegram_scheduled_message_deliveries d WHERE plan_id=? AND run_at=? AND status='pending' AND next_attempt_at<=? AND EXISTS(SELECT 1 FROM telegram_scheduled_message_targets t WHERE t.target_key=d.target_key AND t.ready=1) ORDER BY target_key").all(due.plan_id, due.run_at, now) as Delivery[];
    const claimed: Delivery[] = [];
    for (const job of jobs) {
      const claim = randomUUID();
      if (db.prepare("UPDATE telegram_scheduled_message_deliveries SET status='sending',lease_id=?,lease_until=? WHERE id=? AND status='pending'").run(claim, now + LEASE_MS, job.id).changes) claimed.push({ ...job, status: "sending", lease_id: claim });
    }
    db.prepare("UPDATE telegram_scheduled_message_runtime SET lease_until=?,heartbeat_at=? WHERE id='primary' AND lease_id=?").run(now + LEASE_MS, now, lease);
    return claimed;
  });
}
function prepareDispatch(db: DatabaseSync, lease: string, job: Delivery, now: number): boolean {
  return transaction(db, () => {
    const row = db.prepare("SELECT * FROM telegram_scheduled_message_deliveries WHERE id=?").get(job.id) as Delivery;
    const current = plan(db, job.plan_id), state = runtime(db), target = targets(db).find(t => t.target_key === job.target_key);
    if (!owns(db, lease, now) || !identityCurrent(db) || !current?.enabled || current.revision !== job.plan_revision || !target?.ready
      || target.chat_id !== job.target_chat_id || state.token_hash !== job.token_hash || state.bot_id !== job.bot_id || row.status !== "sending" || row.lease_id !== job.lease_id) {
      db.prepare("UPDATE telegram_scheduled_message_deliveries SET text='',status='cancelled',lease_id='',lease_until=0,last_error=? WHERE id=? AND status='sending' AND dispatch_started_at=0").run(CHANGED_ERROR, job.id);
      return false;
    }
    return Boolean(db.prepare("UPDATE telegram_scheduled_message_deliveries SET dispatch_started_at=?,attempts=attempts+1,lease_until=? WHERE id=? AND lease_id=? AND status='sending' AND dispatch_started_at=0").run(now, now + LEASE_MS, job.id, job.lease_id).changes);
  });
}
async function dispatch(db: DatabaseSync, lease: string, job: Delivery, decrypt: Decrypt, clock: () => number) {
  const stored = cipher(db), token = decrypt(stored);
  if (!token || hash(stored) !== job.token_hash) {
    transaction(db, () => {
      db.prepare("UPDATE telegram_scheduled_message_deliveries SET text='',status='cancelled',last_error=?,lease_id='',lease_until=0 WHERE id=? AND status='sending' AND dispatch_started_at=0").run(TOKEN_ERROR, job.id);
      db.prepare("UPDATE telegram_scheduled_message_targets SET ready=0,last_error=?").run(TOKEN_ERROR);
      db.prepare("UPDATE telegram_scheduled_message_runtime SET next_verify_at=?,last_error=? WHERE id='primary'").run(clock() + 60_000, TOKEN_ERROR);
    });
    return;
  }
  if (!prepareDispatch(db, lease, job, clock())) return;
  const response = await telegramRequest(token, "sendMessage", { chat_id: job.target_chat_id, text: job.text, link_preview_options: { is_disabled: true } }).catch(() => null);
  transaction(db, () => {
    const row = db.prepare("SELECT * FROM telegram_scheduled_message_deliveries WHERE id=?").get(job.id) as Delivery;
    if (row.status !== "sending" || row.lease_id !== job.lease_id) return;
    const result = response?.ok ? response.result : null;
    const chat = result?.chat && typeof result.chat === "object" ? result.chat as { id?: unknown } : null;
    if (result && validId(result.message_id) && chat?.id === job.target_chat_id) {
      db.prepare("UPDATE telegram_scheduled_message_deliveries SET status='sent',sent_at=?,message_id=?,lease_id='',lease_until=0,last_error='' WHERE id=? AND lease_id=?").run(clock(), result.message_id, job.id, job.lease_id); return;
    }
    const code = response && !response.ok ? response.code : 0;
    if (code === 429 && row.attempts < MAX_ATTEMPTS && clock() < job.run_at + GRACE_MS) {
      const delay = response && !response.ok && response.retryAfter > 0 ? response.retryAfter * 1000 : 60_000;
      db.prepare("UPDATE telegram_scheduled_message_deliveries SET status='pending',next_attempt_at=?,dispatch_started_at=0,lease_id='',lease_until=0,last_error='Telegram 限流，稍后自动重试。' WHERE id=? AND lease_id=?")
        .run(clock() + Math.max(1_000, delay), job.id, job.lease_id); return;
    }
    const definitive = [400, 401, 403, 429].includes(code), error = code === 401 ? TOKEN_ERROR : code === 400 || code === 403 ? TARGET_ERROR : code === 429 ? "Telegram 连续限流，已停止本次发送。" : UNKNOWN_ERROR;
    db.prepare("UPDATE telegram_scheduled_message_deliveries SET status=?,last_error=?,lease_id='',lease_until=0 WHERE id=? AND lease_id=?").run(definitive ? "failed" : "unknown", error, job.id, job.lease_id);
    if (code === 401 || code === 403) {
      if (code === 401) db.prepare("UPDATE telegram_scheduled_message_targets SET ready=0,last_error=?").run(error);
      else db.prepare("UPDATE telegram_scheduled_message_targets SET ready=0,last_error=? WHERE target_key=?").run(error, job.target_key);
      db.prepare("UPDATE telegram_scheduled_message_runtime SET next_verify_at=?,last_error=? WHERE id='primary'").run(clock() + 60_000, error);
    }
  });
}

/** One bounded server tick, independently leased across processes. */
export async function deliverScheduledMessagesOnce(decrypt: Decrypt, clock = Date.now, ownerId = randomUUID()) {
  const db = getSqlite(), lease = randomUUID(), now = clock();
  const claimed = transaction(db, () => {
    const state = runtime(db);
    if (state.lease_until > now) return false;
    db.prepare("UPDATE telegram_scheduled_message_runtime SET owner_id=?,lease_id=?,lease_until=?,heartbeat_at=?,last_tick_at=? WHERE id='primary'").run(ownerId, lease, now + LEASE_MS, now, now);
    recover(db, now); return true;
  });
  if (!claimed) return;
  try {
    const active = Boolean(db.prepare("SELECT 1 FROM telegram_scheduled_message_plans WHERE enabled=1 AND deleted_at=0 LIMIT 1").get());
    const stored = cipher(db), state = runtime(db);
    // One read-only startup verification makes all three destinations visible;
    // failures back off rather than hammering Telegram every five seconds.
    const identityDirty = stored && (hash(stored) !== state.token_hash || hotChatId(db) !== state.hot_chat_id);
    if (stored && (identityDirty || clock() >= state.next_verify_at) && (active || !targets(db).length || !configured(db))) await verifyScheduledMessageTargets(db, decrypt, clock);
    if (active) {
      if (configured(db)) {
        transaction(db, () => { if (owns(db, lease, clock())) materialize(db, clock()); });
      }
      // A permission problem on one destination must not block a definitive
      // 429 retry that belongs to another already-materialized destination.
      if (identityCurrent(db)) {
        for (let i = 0; i < 10; i++) {
          const jobs = claimGroup(db, lease, clock());
          if (!jobs.length) break;
          const results = await Promise.allSettled(jobs.map(job => dispatch(db, lease, job, decrypt, clock)));
          if (results.some(result => result.status === "rejected")) throw new ScheduledMessageError("无法保存文案发送状态，将在下一次检查恢复。", 503);
        }
      }
    }
    releaseTerminalPayloads(db);
    db.prepare("UPDATE telegram_scheduled_message_runtime SET last_completed_at=?,heartbeat_at=?,last_error=? WHERE id='primary' AND lease_id=?")
      .run(clock(), clock(), active && !configured(db) ? runtime(db).last_error || CHANGED_ERROR : "", lease);
  } catch (error) {
    db.prepare("UPDATE telegram_scheduled_message_runtime SET last_error='文案定时服务暂时无法完成检查，将自动重试。' WHERE id='primary' AND lease_id=?").run(lease);
    throw error;
  } finally {
    db.prepare("UPDATE telegram_scheduled_message_runtime SET lease_id='',lease_until=0 WHERE id='primary' AND lease_id=?").run(lease);
  }
}
const workers = globalThis as typeof globalThis & { telegramScheduledMessageWorkerStarted?: boolean };
export function startTelegramScheduledMessageWorker(decrypt: Decrypt) {
  if (workers.telegramScheduledMessageWorkerStarted) return;
  workers.telegramScheduledMessageWorkerStarted = true;
  const owner = randomUUID(); let running = false, reported = false, lastReport = 0;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await deliverScheduledMessagesOnce(decrypt, Date.now, owner); reported = false;
      if (Date.now() - lastReport >= 60_000) {
        const status = scheduledMessageStatus(getSqlite());
        console.info("Telegram scheduled text worker status.", JSON.stringify({ planCount: status.plans.length, enabledPlanCount: status.plans.filter(p => p.enabled).length, targetReadyCount: status.targets.filter(t => t.ready).length, workerHealthy: status.scheduler.workerHealthy, nextRunAt: status.scheduler.nextRunAt, pending: status.counts.pending, sending: status.counts.sending, failed: status.counts.failed, unknown: status.counts.unknown }));
        lastReport = Date.now();
      }
    } catch { if (!reported) console.error("Telegram scheduled text worker could not process its queue."); reported = true; }
    finally { running = false; }
  };
  console.info("Telegram scheduled text worker started.");
  void tick(); setInterval(() => void tick(), TICK_MS).unref();
}
