import { createHash, randomInt, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getSqlite } from "./sqlite";
import { telegramRequest } from "./telegram-bot";
import { readScheduledMessageMedia, sendScheduledMessageMedia } from "./telegram-scheduled-media";
import { ensureGameTipsAssets, gameTipsPlatformRetired, gameTipsProviderBackgroundId, gameTipsProviderKey, gameTipsProviderLogo,
  gameTipsProviders, listGameTipAssets, releaseDeletedGameTipsAssets, releaseRetiredGameTipsArtwork, renderGameTips } from "./telegram-game-tips";
import { DEFAULT_GAME_TIPS_CAPTION_PRESET_ID, GAME_TIPS_CAPTION_BODIES, gameTipsCaption, isGameTipsCaptionPresetId } from "./telegram-game-tips-captions";
import { GAME_TIPS_PROVIDER_LIMIT, type GameTipsProvider, type GameTipsSelection } from "./telegram-game-tips-types";
import { isGeneratedGameTipsCaption, RELAY_DEFAULT_TARGET } from "./telegram-relay-content";
import type { ScheduledMessageStatus, ScheduledMessagePlan, ScheduledMessagePlanInput, ScheduledMessageTargetInput, ScheduledMessageTargetKey } from "./telegram-scheduled-messages-types";

type Decrypt = (ciphertext: string) => string;
type Plan = { id: string; revision: string; name: string; text: string; times_json: string; calendar_date: string; target_keys_json: string; media_id: string; game_tips_provider: string; game_tips_caption_preset_id: string; enabled: number; next_run_at: number; last_run_at: number; created_at: number; updated_at: number; deleted_at: number };
type Target = { target_key: ScheduledMessageTargetKey; chat_id: number; title: string; ready: number; last_error: string; verified_at: number };
type Channel = { target_key: ScheduledMessageTargetKey; title: string; address: string; revision: string; deleted_at: number };
type ChannelDefinition = { key: ScheduledMessageTargetKey; title: string; address: string; revision: string; editable: boolean };
type Runtime = { token_hash: string; bot_id: number; hot_chat_id: number; next_verify_at: number; owner_id: string; lease_id: string; lease_until: number; heartbeat_at: number; last_tick_at: number; last_completed_at: number; last_error: string };
type Delivery = { id: string; plan_id: string; plan_revision: string; plan_name: string; text: string; media_id: string; game_tips_provider: string; run_at: number; target_key: ScheduledMessageTargetKey; target_chat_id: number; target_title: string; token_hash: string; bot_id: number; status: string; attempts: number; next_attempt_at: number; lease_id: string; lease_until: number; dispatch_started_at: number; last_error: string; sent_at: number; message_id: number };
const DAY = 86_400_000, OFFSET = 8 * 3_600_000, TICK_MS = 5_000, LEASE_MS = 90_000, GRACE_MS = 15 * 60_000, MAX_ATTEMPTS = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const TOKEN_ERROR = "请先保存 @FreeBonus365ChatBot 的 Token。";
const TARGET_ERROR = "请检查所选频道的机器人发布权限，并重新验证频道。";
const CHANGED_ERROR = "机器人或频道设置已改变，请重新验证频道后继续发布。";
const UNKNOWN_ERROR = "Telegram 未确认发送结果，已停止自动重试以避免重复。";
const GAME_TIPS_EMPTY = "这个游戏平台至少需要 3 张已启用、游戏名称不同的图片。";
const GAME_TIPS_RENDER_ERROR = "无法生成 Game Tips 图片，请检查图库后重新排期。";
const GAME_TIPS_BUTTONS = { inline_keyboard: [[
  { text: "Visit website", url: "https://365freebonus.com/" },
  { text: "NEED HELP?", url: "https://t.me/FreeBonus365ChatBot" },
]] };
const TARGETS: Omit<ChannelDefinition, "revision" | "editable">[] = [
  { key: "official", title: "365 Free Bonus Official", address: "@join365freebonus" },
  { key: "group", title: "365 Free Bonus Group", address: "@join365freebonusgroup" },
  { key: "hot", title: "🔞365 Free Bonus Hot", address: "" },
];
const DEFAULT_TARGET_KEYS = TARGETS.map(target => target.key);
export class ScheduledMessageError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const validChat = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value < 0;
const validId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const validCustomKey = (key: unknown): key is `custom:${string}` => typeof key === "string" && key.startsWith("custom:") && UUID.test(key.slice(7));
const validTargetKey = (key: unknown): key is ScheduledMessageTargetKey => key === "official" || key === "group" || key === "hot" || validCustomKey(key);
function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const result = work(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; }
}
function cipher(db: DatabaseSync): string { return (db.prepare("SELECT chat_bot_token_ciphertext FROM telegram_promotion_settings WHERE id='primary'").get() as { chat_bot_token_ciphertext: string } | undefined)?.chat_bot_token_ciphertext || ""; }
function hotChatId(db: DatabaseSync): number {
  // The separate Hot video or join-gate setting supplies only the initial scheduled destination.
  if (channelRow(db, "hot")) return 0;
  const video = (db.prepare("SELECT target_chat_id FROM telegram_hot_video_settings WHERE id='primary'").get() as { target_chat_id: number } | undefined)?.target_chat_id;
  if (validChat(video)) return video;
  const gate = (db.prepare("SELECT target_chat_id FROM telegram_join_gate_settings WHERE id='primary'").get() as { target_chat_id: number } | undefined)?.target_chat_id;
  return validChat(gate) ? gate : 0;
}
function runtime(db: DatabaseSync): Runtime { return db.prepare("SELECT * FROM telegram_scheduled_message_runtime WHERE id='primary'").get() as Runtime; }
function targets(db: DatabaseSync): Target[] { return db.prepare("SELECT * FROM telegram_scheduled_message_targets").all() as Target[]; }
function channelDefinitions(db: DatabaseSync, hot: number): ChannelDefinition[] {
  const stored = db.prepare("SELECT * FROM telegram_scheduled_message_channels ORDER BY target_key").all() as Channel[];
  const overrides = new Map(stored.map(channel => [channel.target_key, channel]));
  const view = ({ target_key: key, title, address, revision }: Channel): ChannelDefinition => ({ key, title, address, revision, editable: true });
  const defaults = TARGETS.flatMap(target => {
    const override = overrides.get(target.key);
    if (override) return override.deleted_at === 0 ? [view(override)] : [];
    const address = target.key === "hot" && hot ? String(hot) : target.address;
    // Unmodified defaults need a stable version, including changes to the linked Hot address.
    const version = hash(`${target.key}:${address}`);
    const revision = `${version.slice(0, 8)}-${version.slice(8, 12)}-4${version.slice(13, 16)}-8${version.slice(17, 20)}-${version.slice(20, 32)}`;
    return [{ ...target, address, revision, editable: true }];
  });
  return [...defaults, ...stored.filter(channel => channel.deleted_at === 0 && validCustomKey(channel.target_key)).map(view)];
}
function plan(db: DatabaseSync, id: string): Plan | undefined { return db.prepare("SELECT * FROM telegram_scheduled_message_plans WHERE id=? AND deleted_at=0").get(id) as Plan | undefined; }
function parseTimes(value: string): string[] { try { const times: unknown = JSON.parse(value); return Array.isArray(times) && times.every(t => typeof t === "string" && TIME.test(t)) ? times : []; } catch { return []; } }
function parseTargetKeys(value: string): ScheduledMessageTargetKey[] {
  if (!value) return [...DEFAULT_TARGET_KEYS];
  try { const keys: unknown = JSON.parse(value); return Array.isArray(keys) && keys.every(validTargetKey) ? keys : []; }
  catch { return []; }
}
function dayStart(now: number): number { return Math.floor((now + OFFSET) / DAY) * DAY - OFFSET; }
function calendarDay(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
  const day = Date.parse(`${date}T00:00:00+08:00`);
  return Number.isFinite(day) && new Date(day + OFFSET).toISOString().slice(0, 10) === date ? day : NaN;
}
function slot(day: number, time: string): number { const [hours, minutes] = time.split(":").map(Number); return day + hours * 3_600_000 + minutes * 60_000; }
/** Fixed UTC+8 wall times avoid host timezone, DST and interval drift. */
export function nextScheduledMessageTime(times: string[], now: number, inclusive = false, date = ""): number {
  const start = dayStart(now);
  const days = date ? [calendarDay(date)] : [start, start + DAY];
  for (const day of days) for (const time of [...times].sort()) { const at = slot(day, time); if (inclusive ? at >= now : at > now) return at; }
  return 0;
}
function providerCount(providers: GameTipsProvider[], provider: string) {
  const key = gameTipsProviderKey(provider);
  return providers.find(entry => gameTipsProviderKey(entry.name) === key)?.count ?? 0;
}
function captionPresetOrDefault(value: string | undefined) {
  return isGameTipsCaptionPresetId(value) ? value : DEFAULT_GAME_TIPS_CAPTION_PRESET_ID;
}
function viewPlan(db: DatabaseSync, row: Plan, providers: GameTipsProvider[]): ScheduledMessagePlan {
  return { id: row.id, revision: row.revision, name: row.name, text: row.text, times: parseTimes(row.times_json), enabled: row.enabled === 1,
    calendarDate: row.calendar_date, targetKeys: parseTargetKeys(row.target_keys_json), media: row.media_id ? readScheduledMessageMedia(db, row.media_id) : null,
    ...(row.game_tips_provider ? { gameTipsProvider: row.game_tips_provider, gameTipsCaptionPresetId: captionPresetOrDefault(row.game_tips_caption_preset_id),
      ...(providerCount(providers, row.game_tips_provider) < 3 ? { gameTipsIssue: GAME_TIPS_EMPTY } : {}) } : {}),
    nextRunAt: row.next_run_at || null, lastRunAt: row.last_run_at || null, createdAt: row.created_at, updatedAt: row.updated_at };
}
function identityCurrent(db: DatabaseSync): boolean {
  const state = runtime(db), stored = cipher(db);
  return Boolean(stored && state.token_hash === hash(stored) && state.bot_id > 0 && state.hot_chat_id === hotChatId(db));
}
function targetsReady(entries: Target[], keys: ScheduledMessageTargetKey[]): boolean {
  const selected = keys.map(key => entries.find(entry => entry.target_key === key && entry.ready === 1 && validChat(entry.chat_id)));
  return selected.length > 0 && selected.every(entry => entry !== undefined) && new Set(selected.map(entry => entry?.chat_id)).size === selected.length;
}
function configured(db: DatabaseSync, keys: ScheduledMessageTargetKey[]): boolean {
  return identityCurrent(db) && targetsReady(targets(db), keys);
}
function hasBlockedPlan(db: DatabaseSync): boolean {
  const entries = targets(db), current = identityCurrent(db);
  const plans = db.prepare("SELECT target_keys_json FROM telegram_scheduled_message_plans WHERE enabled=1 AND deleted_at=0 AND next_run_at>0").all() as { target_keys_json: string }[];
  return plans.some(p => !current || !targetsReady(entries, parseTargetKeys(p.target_keys_json)));
}
export function scheduledMessageStatus(db: DatabaseSync, clock = Date.now): ScheduledMessageStatus {
  const now = clock(), state = runtime(db), stored = cipher(db), rows = targets(db), current = identityCurrent(db);
  const providers = gameTipsProviders(db);
  const plans = (db.prepare("SELECT * FROM telegram_scheduled_message_plans WHERE deleted_at=0 ORDER BY created_at,id").all() as Plan[]).map(row => viewPlan(db, row, providers));
  const deliveries = (db.prepare(`
    SELECT * FROM (SELECT * FROM telegram_scheduled_message_deliveries WHERE game_tips_provider=''
      ORDER BY run_at DESC,target_key,id LIMIT 150)
    UNION ALL
    SELECT * FROM (SELECT * FROM telegram_scheduled_message_deliveries WHERE game_tips_provider<>''
      ORDER BY run_at DESC,target_key,id LIMIT 150)
    ORDER BY run_at DESC,target_key,id
  `).all() as Delivery[]).map(row => ({
    id: row.id, planId: row.plan_id, planName: row.plan_name, runAt: row.run_at, targetKey: row.target_key, targetTitle: row.target_title,
    status: row.status, attempts: row.attempts, lastError: row.last_error, sentAt: row.sent_at || null, messageId: row.message_id || null,
    ...(row.game_tips_provider ? { gameTipsProvider: row.game_tips_provider } : {}),
  }));
  const counts: Record<string, number> = { pending: 0, sending: 0, sent: 0, failed: 0, unknown: 0, cancelled: 0, skipped: 0 };
  const messageCounts = { ...counts }, gameTipsCounts = { ...counts };
  for (const row of db.prepare(`SELECT status,game_tips_provider<>'' AS game_tips,COUNT(*) AS count
    FROM telegram_scheduled_message_deliveries GROUP BY status,game_tips`).all() as { status: string; game_tips: number; count: number }[]) {
    counts[row.status] = (counts[row.status] ?? 0) + row.count;
    (row.game_tips ? gameTipsCounts : messageCounts)[row.status] = row.count;
  }
  function summary(gameTips: boolean, counts: Record<string, number>) {
    const active = plans.filter(p => Boolean(p.gameTipsProvider) === gameTips && p.enabled && p.nextRunAt);
    const blocked = active.some(p => !current || !targetsReady(rows, p.targetKeys));
    const sharedError = state.last_error === CHANGED_ERROR ? "" : state.last_error;
    return { counts, nextRunAt: active.length ? Math.min(...active.map(p => p.nextRunAt!)) : null,
      lastError: sharedError || (blocked ? CHANGED_ERROR : active.find(p => p.gameTipsIssue)?.gameTipsIssue || "") };
  }
  const messageSummary = summary(false, messageCounts), gameTipsSummary = summary(true, gameTipsCounts);
  const next = [messageSummary.nextRunAt, gameTipsSummary.nextRunAt].filter((value): value is number => value !== null);
  const gameTipsIssue = plans.find(p => p.enabled && p.nextRunAt && p.gameTipsIssue)?.gameTipsIssue;
  return { now, timezone: "Asia/Kuala_Lumpur", hasToken: Boolean(stored), plans, deliveries, counts, gameTipsProviders: providers, gameTipsSummary, messageSummary,
    targets: channelDefinitions(db, hotChatId(db)).map(target => {
      const row = rows.find(r => r.target_key === target.key);
      return { ...target, chatId: row?.chat_id ? String(row.chat_id) : /^-\d+$/.test(target.address) ? target.address : "",
        ready: current && row?.ready === 1, lastError: row?.last_error || (stored && !current ? CHANGED_ERROR : !stored ? TOKEN_ERROR : !row ? TARGET_ERROR : "") };
    }),
    scheduler: { workerHealthy: state.heartbeat_at > 0 && now - state.heartbeat_at < 30_000, heartbeatAt: state.heartbeat_at || null, lastTickAt: state.last_tick_at || null, lastCompletedAt: state.last_completed_at || null, nextRunAt: next.length ? Math.min(...next) : null, lastError: state.last_error || (hasBlockedPlan(db) ? CHANGED_ERROR : gameTipsIssue || "") } };
}

/** Read-only routing evidence for the site's public group. Keep user content and private chat IDs out of logs. */
export async function inspectGameTipsGroupRoutes(db: DatabaseSync, decrypt: Decrypt, now = Date.now()) {
  const stored = cipher(db);
  if (!stored) return null;
  const group = await telegramRequest(decrypt(stored), "getChat", { chat_id: RELAY_DEFAULT_TARGET }).catch(() => null);
  const live = group?.ok && validChat(group.result.id) && ["group", "supergroup", "channel"].includes(String(group.result.type))
    && String(group.result.username).toLowerCase() === RELAY_DEFAULT_TARGET.slice(1) ? group.result : null;
  const targetRows = targets(db);
  const savedKey = channelDefinitions(db, hotChatId(db)).find(target => target.address === RELAY_DEFAULT_TARGET)?.key;
  const savedChatId = identityCurrent(db) ? targetRows.find(target => target.target_key === savedKey && target.ready === 1)?.chat_id : undefined;
  const relayTarget = db.prepare(`SELECT r.target_chat_id FROM telegram_relay_state r
    JOIN telegram_promotion_settings p ON p.id='primary' AND p.relay_revision=r.revision
    WHERE r.id='primary' AND p.relay_chat_id=? AND r.target_verified_at>0`).get(RELAY_DEFAULT_TARGET) as { target_chat_id: number } | undefined;
  const groupId = live?.id ?? savedChatId ?? relayTarget?.target_chat_id;
  if (!validChat(groupId)) return { group: "unverified" as const };
  // A broadcast channel's linked chat is its own discussion group, not a source of incoming copies.
  const linkedId = live?.type === "supergroup" && validChat(live.linked_chat_id) ? live.linked_chat_id : 0;
  const since = now - DAY;
  const history = db.prepare(`SELECT COUNT(*) AS sent, MAX(sent_at) AS latestAt FROM telegram_scheduled_message_deliveries
    WHERE game_tips_provider<>'' AND target_chat_id=? AND status='sent' AND sent_at>=?`);
  const direct = history.get(groupId, since) as { sent: number; latestAt: number | null };
  const throughLinkedChannel = linkedId ? history.get(linkedId, since) as typeof direct : null;
  const channelIds = new Map(targetRows.map(target => [target.target_key, target.chat_id]));
  const plans = db.prepare(`SELECT target_keys_json FROM telegram_scheduled_message_plans
    WHERE game_tips_provider<>'' AND enabled=1 AND deleted_at=0 AND next_run_at>0`).all() as Pick<Plan, "target_keys_json">[];
  const destinations = plans.map(plan => parseTargetKeys(plan.target_keys_json).map(key => channelIds.get(key)));
  const activePlansSelectingGroup = destinations.filter(ids => ids.includes(groupId)).length;
  const newPostsToLinkedWithoutGroup = linkedId ? destinations.filter(ids => ids.includes(linkedId) && !ids.includes(groupId)).length : 0;

  // The relay's target identity is pinned for the lifetime of a settings revision.
  const relayCopies = db.prepare(`SELECT o.caption, o.sent_at AS sentAt FROM telegram_relay_outbox o
    JOIN telegram_relay_state r ON r.id='primary' AND r.revision=o.revision
    WHERE r.target_chat_id=? AND o.status='sent' AND o.sent_at>=?
      AND o.media_kind='photo' AND instr(o.caption, '365FreeBonus X ')>0
    ORDER BY o.sent_at DESC LIMIT 100`).all(groupId, since) as { caption: string; sentAt: number }[];
  const gameTipsCopies = relayCopies.filter(row => isGeneratedGameTipsCaption(row.caption));
  return { group: live ? String(live.type) : "cached", since, direct, throughLinkedChannel, activePlansSelectingGroup, newPostsToLinkedWithoutGroup,
    relay: { sampledCopies: gameTipsCopies.length, latestAt: gameTipsCopies[0]?.sentAt ?? null } };
}

/** Permission checks only; this method never publishes a message. */
export async function verifyScheduledMessageTargets(db: DatabaseSync, decrypt: Decrypt, clock = Date.now): Promise<ScheduledMessageStatus> {
  const stored = cipher(db), hot = hotChatId(db), token = stored ? decrypt(stored) : "", now = clock();
  const definitions = channelDefinitions(db, hot), signature = JSON.stringify(definitions);
  let botId = 0, globalError = "";
  if (!token) globalError = TOKEN_ERROR;
  else {
    const me = await telegramRequest(token, "getMe").catch(() => null);
    if (me?.ok && me.result.is_bot === true && validId(me.result.id) && typeof me.result.username === "string" && me.result.username.toLowerCase() === "freebonus365chatbot") botId = me.result.id;
    else globalError = "无法验证 @FreeBonus365ChatBot，请检查已保存的 Token。";
  }
  const verified = await Promise.all(definitions.map(async target => {
    const fail = (error: string): Target => ({ target_key: target.key, chat_id: 0, title: target.title, ready: 0, last_error: error, verified_at: now });
    if (globalError) return fail(globalError);
    if (!target.address) return fail("请先在 Hot 频道设置保存目标频道。");
    const username = target.address.startsWith("@") ? target.address.slice(1) : "";
    const chat = await telegramRequest(token, "getChat", { chat_id: username ? target.address : Number(target.address) }).catch(() => null);
    if (!chat?.ok || !validChat(chat.result.id) || !["channel", "supergroup", "group"].includes(String(chat.result.type))
      || (username ? typeof chat.result.username !== "string" || chat.result.username.toLowerCase() !== username
        : chat.result.id !== Number(target.address))) return fail(`无法识别 ${target.title}，请检查频道和机器人权限。`);
    const member = await telegramRequest(token, "getChatMember", { chat_id: chat.result.id, user_id: botId }).catch(() => null);
    const allowed = member?.ok && (member.result.status === "creator" || member.result.status === "administrator" && (chat.result.type !== "channel" || member.result.can_post_messages === true));
    if (!allowed) return { ...fail(`请将 @FreeBonus365ChatBot 设为 ${target.title} 管理员并允许发布消息。`), chat_id: chat.result.id };
    return { target_key: target.key, chat_id: chat.result.id, title: target.title, ready: 1, last_error: "", verified_at: now } as Target;
  }));
  const fixed = verified.filter(target => !validCustomKey(target.target_key));
  const fixedIds = fixed.filter(target => target.ready).map(target => target.chat_id);
  if (new Set(fixedIds).size !== fixedIds.length) for (const row of fixed) {
    row.ready = 0;
    row.last_error = "发送目标必须使用不同的频道，请检查频道地址。";
  }
  const knownChats = new Set(fixed.filter(target => validChat(target.chat_id)).map(target => target.chat_id));
  for (const row of verified.filter(target => validCustomKey(target.target_key) && target.ready)) {
    if (knownChats.has(row.chat_id)) {
      row.ready = 0;
      row.last_error = "此频道已在发送目标中。请使用已有频道或填写不同的频道。";
    } else knownChats.add(row.chat_id);
  }
  transaction(db, () => {
    if (cipher(db) !== stored || hotChatId(db) !== hot || JSON.stringify(channelDefinitions(db, hot)) !== signature) throw new ScheduledMessageError(CHANGED_ERROR, 409);
    for (const row of verified) db.prepare(`INSERT INTO telegram_scheduled_message_targets(target_key,chat_id,title,ready,last_error,verified_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(target_key) DO UPDATE SET chat_id=excluded.chat_id,title=excluded.title,ready=excluded.ready,last_error=excluded.last_error,verified_at=excluded.verified_at`)
      .run(row.target_key, row.chat_id, row.title, row.ready, row.last_error, row.verified_at);
    db.prepare("UPDATE telegram_scheduled_message_runtime SET token_hash=?,bot_id=?,hot_chat_id=?,next_verify_at=?,last_error=? WHERE id='primary'")
      .run(stored ? hash(stored) : "", botId, hot, now + (verified.every(t => t.ready) ? 60 * 60_000 : 60_000), globalError);
  });
  return scheduledMessageStatus(db, clock);
}

function channelAddress(value: string): string {
  const address = value.trim().toLowerCase();
  const handle = /^(?:@|https?:\/\/t\.me\/)([a-z][a-z0-9_]{4,31})\/?$/.exec(address);
  if (handle) return `@${handle[1]}`;
  if (/^-[1-9]\d{0,15}$/.test(address) && validChat(Number(address))) return address;
  throw new ScheduledMessageError("请输入频道的 @用户名、t.me 公开链接或负数频道 ID。");
}
function channelRow(db: DatabaseSync, key: ScheduledMessageTargetKey): Channel | undefined {
  return db.prepare("SELECT * FROM telegram_scheduled_message_channels WHERE target_key=?").get(key) as Channel | undefined;
}
function clearChannelJobs(db: DatabaseSync, key: ScheduledMessageTargetKey) {
  db.prepare("DELETE FROM telegram_scheduled_message_targets WHERE target_key=?").run(key);
  db.prepare(`UPDATE telegram_scheduled_message_deliveries SET text='',media_id='',status='cancelled',last_error=?,lease_id='',lease_until=0
    WHERE target_key=? AND status IN ('pending','sending') AND dispatch_started_at=0`).run(CHANGED_ERROR, key);
  db.prepare("UPDATE telegram_scheduled_message_runtime SET next_verify_at=0 WHERE id='primary'").run();
}
function requireInactiveChannel(db: DatabaseSync, key: ScheduledMessageTargetKey) {
  const active = db.prepare(`SELECT target_keys_json FROM telegram_scheduled_message_plans p
    WHERE enabled=1 AND deleted_at=0 AND (next_run_at>0 OR EXISTS (
      SELECT 1 FROM telegram_scheduled_message_deliveries d WHERE d.plan_id=p.id AND d.plan_revision=p.revision AND d.status IN ('pending','sending')
    ))`).all() as { target_keys_json: string }[];
  if (active.some(p => parseTargetKeys(p.target_keys_json).includes(key))) {
    throw new ScheduledMessageError("此频道仍有启用的发送计划，请先修改目标或暂停相关计划。");
  }
}
export async function saveScheduledMessageTarget(db: DatabaseSync, input: ScheduledMessageTargetInput, decrypt: Decrypt, clock = Date.now): Promise<ScheduledMessageStatus> {
  if (typeof input.title !== "string" || !input.title.trim() || input.title.trim().length > 100 || typeof input.address !== "string"
    || input.key !== undefined && (!validTargetKey(input.key) || typeof input.revision !== "string" || !UUID.test(input.revision) || input.requestId !== undefined)
    || input.key === undefined && (typeof input.requestId !== "string" || !UUID.test(input.requestId) || input.revision !== undefined)) {
    throw new ScheduledMessageError("请检查频道名称、地址和版本。");
  }
  const title = input.title.trim(), address = channelAddress(input.address);
  const key = input.key ?? `custom:${input.requestId!}`;
  const changed = transaction(db, () => {
    const definitions = channelDefinitions(db, hotChatId(db));
    const current = definitions.find(target => target.key === key);
    if (input.key ? !current || current.revision !== input.revision
      : channelRow(db, key) && (!current || current.title !== title || current.address !== address)) {
      throw new ScheduledMessageError("频道已被修改或请求已处理，请刷新后再保存。", 409);
    }
    if (current?.title === title && current.address === address) return false;
    if (definitions.some(target => target.key !== key && target.address === address)
      || !address.startsWith("@") && targets(db).some(target => target.target_key !== key && String(target.chat_id) === address)) {
      throw new ScheduledMessageError("此频道已在发送目标中，请选择已有频道。");
    }
    if (!current && definitions.filter(target => validCustomKey(target.key)).length >= 20) throw new ScheduledMessageError("最多可添加 20 个自定义频道。");
    if (current && current.address !== address) requireInactiveChannel(db, key);
    db.prepare(`INSERT INTO telegram_scheduled_message_channels(target_key,title,address,revision) VALUES(?,?,?,?)
      ON CONFLICT(target_key) DO UPDATE SET title=excluded.title,address=excluded.address,revision=excluded.revision`)
      .run(key, title, address, randomUUID());
    if (current?.address !== address) clearChannelJobs(db, key);
    return true;
  });
  if (!changed || !cipher(db)) return scheduledMessageStatus(db, clock);
  try { return await verifyScheduledMessageTargets(db, decrypt, clock); }
  catch (error) {
    if (error instanceof ScheduledMessageError && error.status === 409) return scheduledMessageStatus(db, clock);
    throw error;
  }
}
export function deleteScheduledMessageTarget(db: DatabaseSync, input: { key: ScheduledMessageTargetKey; revision: string }, clock = Date.now): ScheduledMessageStatus {
  if (!validTargetKey(input.key) || !UUID.test(input.revision)) throw new ScheduledMessageError("频道标识无效。");
  transaction(db, () => {
    const current = channelDefinitions(db, hotChatId(db)).find(target => target.key === input.key);
    if (!current || current.revision !== input.revision) throw new ScheduledMessageError("频道已被修改，请刷新后重试。", 409);
    requireInactiveChannel(db, input.key);
    db.prepare(`INSERT INTO telegram_scheduled_message_channels(target_key,revision,title,address,deleted_at) VALUES(?,?,?,?,?)
      ON CONFLICT(target_key) DO UPDATE SET deleted_at=excluded.deleted_at,revision=excluded.revision`)
      .run(input.key, randomUUID(), current.title, current.address, clock());
    clearChannelJobs(db, input.key);
  });
  return scheduledMessageStatus(db, clock);
}
function validateInput(input: ScheduledMessagePlanInput) {
  if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 100 || typeof input.text !== "string" || input.text.length > 4096
    || !Array.isArray(input.times) || input.times.length < 1 || input.times.length > 24 || input.times.some(t => typeof t !== "string" || !TIME.test(t)) || new Set(input.times).size !== input.times.length
    || typeof input.enabled !== "boolean" || input.id !== undefined && !UUID.test(input.id) || input.revision !== undefined && !UUID.test(input.revision)
    || input.id && (!input.revision || input.requestId !== undefined) || !input.id && (typeof input.requestId !== "string" || !UUID.test(input.requestId) || input.revision !== undefined)) throw new ScheduledMessageError("请检查文案、每日发送时间和计划版本。" );
  if (input.calendarDate != null && (typeof input.calendarDate !== "string" || input.calendarDate && !Number.isFinite(calendarDay(input.calendarDate)))) {
    throw new ScheduledMessageError("请输入有效的马来西亚日期。");
  }
  if (!input.id && input.targetKeys === undefined || input.targetKeys !== undefined &&
    (!Array.isArray(input.targetKeys) || !input.targetKeys.length || input.targetKeys.length > 23
      || !input.targetKeys.every(validTargetKey) || new Set(input.targetKeys).size !== input.targetKeys.length)) {
    throw new ScheduledMessageError("请选择至少一个有效且不同的发送频道。");
  }
  if (input.mediaId != null && (typeof input.mediaId !== "string" || !UUID.test(input.mediaId))) throw new ScheduledMessageError("附件标识无效，请重新上传。");
  if (input.gameTipsProvider != null && (typeof input.gameTipsProvider !== "string" || !input.gameTipsProvider.trim()
    || Array.from(input.gameTipsProvider.trim()).length > GAME_TIPS_PROVIDER_LIMIT || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input.gameTipsProvider))) {
    throw new ScheduledMessageError("请选择有效的 Game Tips 游戏平台。");
  }
  if (input.gameTipsCaptionPresetId != null && !isGameTipsCaptionPresetId(input.gameTipsCaptionPresetId)) {
    throw new ScheduledMessageError("请选择有效的 Game Tips 文案。");
  }
}
export async function saveScheduledMessagePlan(db: DatabaseSync, input: ScheduledMessagePlanInput, decrypt: Decrypt, clock = Date.now): Promise<ScheduledMessageStatus> {
  validateInput(input);
  const existingRequest = () => !input.id ? db.prepare("SELECT * FROM telegram_scheduled_message_plans WHERE id=?").get(input.requestId!) as Plan | undefined : undefined;
  const before = input.id ? plan(db, input.id) : undefined;
  if (input.id && (!before || before.revision !== input.revision)) throw new ScheduledMessageError("计划已被修改，请刷新后再保存。", 409);
  const times = [...input.times].sort(), timesJson = JSON.stringify(times), name = input.name.trim(), enabled = Number(input.enabled);
  const calendarDate = input.calendarDate === undefined ? before?.calendar_date || "" : input.calendarDate || "";
  const mediaId = input.mediaId === undefined ? before?.media_id || "" : input.mediaId || "";
  const requestedProvider = input.gameTipsProvider === undefined ? before?.game_tips_provider || "" : input.gameTipsProvider?.trim() || "";
  const sameProvider = Boolean(before && gameTipsProviderKey(before.game_tips_provider) === gameTipsProviderKey(requestedProvider));
  const provider = before && sameProvider ? before.game_tips_provider : requestedProvider;
  const presetId = provider ? captionPresetOrDefault(input.gameTipsCaptionPresetId === undefined
    ? before?.game_tips_caption_preset_id : input.gameTipsCaptionPresetId ?? undefined) : "";
  const text = provider ? "" : input.text;
  const keys = [...(input.targetKeys ?? (before ? parseTargetKeys(before.target_keys_json) : []))].sort();
  const keysJson = JSON.stringify(keys);
  if (!provider && !text.trim()) throw new ScheduledMessageError("请输入发送文案。");
  if (!provider && input.gameTipsCaptionPresetId != null) throw new ScheduledMessageError("只有 Game Tips 计划可选择 Game Tips 文案。");
  if (provider && input.text.trim()) throw new ScheduledMessageError("Game Tips 会自动生成文案，请清除手动文案。");
  if (provider && mediaId) throw new ScheduledMessageError("Game Tips 自动生成图片，请移除额外附件。");
  if (mediaId && text.length > 1024) throw new ScheduledMessageError("附照片、视频或 GIF 的文案最多 1,024 个字符。");
  const samePayload = (row: Plan) => !row.deleted_at && row.name === name && row.text === text
    && row.times_json === timesJson && row.calendar_date === calendarDate
    && JSON.stringify(parseTargetKeys(row.target_keys_json).sort()) === keysJson
    && row.media_id === mediaId && row.game_tips_provider === provider && row.enabled === enabled
    && (!provider || captionPresetOrDefault(row.game_tips_caption_preset_id) === presetId);
  const existing = existingRequest();
  if (existing) {
    if (!samePayload(existing)) throw new ScheduledMessageError("此新增请求已处理或内容已改变，请刷新后重试。", 409);
    return scheduledMessageStatus(db, clock);
  }
  const enablingGameTips = enabled && provider && (!before?.enabled
    || gameTipsProviderKey(before.game_tips_provider) !== gameTipsProviderKey(provider));
  if (enablingGameTips && providerCount(gameTipsProviders(db), provider) < 3) throw new ScheduledMessageError(GAME_TIPS_EMPTY);
  if (input.enabled && !(before && samePayload(before))) {
    await verifyScheduledMessageTargets(db, decrypt, clock);
    if (!configured(db, keys)) throw new ScheduledMessageError(TARGET_ERROR);
  }
  transaction(db, () => {
    const replay = existingRequest();
    if (replay) {
      if (!samePayload(replay)) throw new ScheduledMessageError("此新增请求已处理或内容已改变，请刷新后重试。", 409);
      return;
    }
    const current = input.id ? plan(db, input.id) : undefined;
    if (input.id && (!current || current.revision !== input.revision || current.game_tips_provider !== before?.game_tips_provider)) {
      throw new ScheduledMessageError("计划已被修改，请刷新后再保存。", 409);
    }
    if (current && samePayload(current)) return;
    if (provider && (enabled || !sameProvider) && gameTipsPlatformRetired(db, provider)) {
      throw new ScheduledMessageError("平台已改名或删除，请刷新后重新选择。", 409);
    }
    const now = clock(), today = new Date(now + OFFSET).toISOString().slice(0, 10);
    const sameSchedule = current?.enabled === 1 && current.times_json === timesJson && current.calendar_date === calendarDate;
    const next = enabled ? sameSchedule ? current.next_run_at : nextScheduledMessageTime(times, now, true, calendarDate) : 0;
    if (enabled && calendarDate && !sameSchedule && !next) throw new ScheduledMessageError("这一天的发送时间已过，请选未来的日期或时间。");
    if (enabled && !configured(db, keys)) throw new ScheduledMessageError(CHANGED_ERROR, 409);
    if (enablingGameTips && providerCount(gameTipsProviders(db), provider) < 3) throw new ScheduledMessageError(GAME_TIPS_EMPTY);
    const definitions = channelDefinitions(db, hotChatId(db));
    if (!keys.length || keys.some(key => !definitions.some(channel => channel.key === key))) {
      throw new ScheduledMessageError("所选频道已不存在，请重新选择。");
    }
    if (mediaId && !readScheduledMessageMedia(db, mediaId)) throw new ScheduledMessageError("附件已失效，请重新上传。");
    if ((!current || current.calendar_date && current.calendar_date < today) && (!calendarDate || calendarDate >= today)) {
      const count = db.prepare("SELECT COUNT(*) AS count FROM telegram_scheduled_message_plans WHERE deleted_at=0 AND (calendar_date='' OR calendar_date>=?)").get(today) as { count: number };
      if (count.count >= 100) throw new ScheduledMessageError("最多安排 100 个重复、今天和未来的文案计划。");
    }
    const id = current?.id || input.requestId!, revision = randomUUID();
    db.prepare(`INSERT INTO telegram_scheduled_message_plans(id,revision,name,text,times_json,calendar_date,target_keys_json,media_id,game_tips_provider,game_tips_caption_preset_id,enabled,next_run_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,name=excluded.name,text=excluded.text,
      times_json=excluded.times_json,calendar_date=excluded.calendar_date,target_keys_json=excluded.target_keys_json,media_id=excluded.media_id,
      game_tips_provider=excluded.game_tips_provider,game_tips_caption_preset_id=excluded.game_tips_caption_preset_id,
      enabled=excluded.enabled,next_run_at=excluded.next_run_at,updated_at=excluded.updated_at`)
      .run(id, revision, name, text, timesJson, calendarDate, keysJson, mediaId, provider, presetId, enabled, next, now, now);
    db.prepare(`UPDATE telegram_scheduled_message_deliveries SET text='',media_id='',status='cancelled',last_error='计划已修改或停用。',lease_id='',lease_until=0
      WHERE plan_id=? AND status IN ('pending','sending') AND dispatch_started_at=0`).run(id);
  });
  return scheduledMessageStatus(db, clock);
}
export function deleteScheduledMessagePlan(db: DatabaseSync, input: { id: string; revision: string }, clock = Date.now): ScheduledMessageStatus {
  if (!UUID.test(input.id) || !UUID.test(input.revision)) throw new ScheduledMessageError("计划标识无效。" );
  transaction(db, () => {
    const current = plan(db, input.id);
    if (!current || current.revision !== input.revision) throw new ScheduledMessageError("计划已被修改，请刷新后重试。", 409);
    db.prepare("UPDATE telegram_scheduled_message_plans SET enabled=0,next_run_at=0,media_id='',deleted_at=?,updated_at=?,revision=? WHERE id=?").run(clock(), clock(), randomUUID(), input.id);
    db.prepare(`UPDATE telegram_scheduled_message_deliveries SET text='',media_id='',status='cancelled',last_error='计划已删除。',lease_id='',lease_until=0
      WHERE plan_id=? AND status IN ('pending','sending') AND dispatch_started_at=0`).run(input.id);
  });
  return scheduledMessageStatus(db, clock);
}

type GameTipsSnapshot = GameTipsSelection & {
  captionPresetId?: string; caption?: string; captionBodyId?: string; captionCycle?: string[];
};
function parseGameTipsSelection(value: string): GameTipsSnapshot | null {
  try {
    const selection = JSON.parse(value) as GameTipsSnapshot;
    if (typeof selection.provider !== "string" || !selection.provider || !Array.isArray(selection.games) || selection.games.length !== 3
      || selection.logoId !== undefined && (typeof selection.logoId !== "string" || !UUID.test(selection.logoId))
      || selection.backgroundId !== undefined && (typeof selection.backgroundId !== "string" || !UUID.test(selection.backgroundId))
      || selection.caption !== undefined && (typeof selection.caption !== "string" || !selection.caption || selection.caption.length > 1024)
      || selection.captionPresetId !== undefined && (typeof selection.captionPresetId !== "string" || !/^[a-z0-9-]{1,64}$/.test(selection.captionPresetId))
      || selection.games.some(game => !game || typeof game.id !== "string" || !UUID.test(game.id) || typeof game.game !== "string" || !game.game)) return null;
    return selection;
  } catch { return null; }
}

// Keep the rotation in the occurrence snapshot so it advances with the queue
// transaction, including when multiple plans for a platform become due together.
function pickGameTipsCaptionBody(db: DatabaseSync, providerKey: string) {
  const previous = db.prepare(`SELECT selection_json FROM telegram_game_tip_slots
    WHERE provider_key=? AND CASE WHEN json_valid(selection_json)
      THEN json_type(selection_json, '$.captionCycle')='array' ELSE 0 END
    ORDER BY rowid DESC LIMIT 1`).get(providerKey) as { selection_json: string } | undefined;
  const used = previous ? parseGameTipsSelection(previous.selection_json)?.captionCycle : undefined;
  const pool = GAME_TIPS_CAPTION_BODIES;
  const cycle = Array.isArray(used)
    ? [...new Set(used.filter(id => pool.some(body => body.id === id)))] : [];
  const remaining = pool.filter(body => !cycle.includes(body.id));
  const choices = remaining.length ? remaining : pool.filter(body => body.id !== cycle.at(-1));
  const body = choices[randomInt(choices.length)];
  return { body, cycle: [...(remaining.length ? cycle : []), body.id] };
}

function pickGameTips(db: DatabaseSync, row: Plan, at: number): GameTipsSnapshot | null {
  const key = gameTipsProviderKey(row.game_tips_provider), today = dayStart(at);
  const candidates = [...new Map(listGameTipAssets(db, row.game_tips_provider)
    .map(asset => [gameTipsProviderKey(asset.game), asset])).values()];
  if (candidates.length < 3) return null;
  const usedToday = new Map<string, number>(), usedYesterday = new Map<string, number>();
  const recent = db.prepare(`SELECT s.run_at,s.selection_json FROM telegram_game_tip_slots s
    WHERE provider_key=? AND run_at>=? AND run_at<?
    AND EXISTS(SELECT 1 FROM telegram_scheduled_message_deliveries d
      WHERE d.plan_id=s.plan_id AND d.run_at=s.run_at AND d.plan_revision=s.plan_revision
      AND d.status IN ('pending','sending','sent','unknown'))`)
    .all(key, today - DAY, today + DAY) as { run_at: number; selection_json: string }[];
  for (const entry of recent) {
    const counts = entry.run_at < today ? usedYesterday : usedToday;
    for (const { game } of parseGameTipsSelection(entry.selection_json)?.games ?? []) {
      const name = gameTipsProviderKey(game);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  // Shuffle before the stable sort so games with equally recent usage are
  // randomly selected. Prefer unused games today, then less-used yesterday.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  function compare(a: string, b: string, counts: Map<string, number>) {
    return (counts.get(a) ?? 0) - (counts.get(b) ?? 0);
  }
  candidates.sort((a, b) => {
    const left = gameTipsProviderKey(a.game), right = gameTipsProviderKey(b.game);
    return compare(left, right, usedToday) || compare(left, right, usedYesterday);
  });
  const logo = gameTipsProviderLogo(db, row.game_tips_provider);
  const backgroundId = gameTipsProviderBackgroundId(db, row.game_tips_provider);
  const provider = logo?.name ?? candidates[0].provider;
  const captionPresetId = captionPresetOrDefault(row.game_tips_caption_preset_id);
  const { body, cycle } = pickGameTipsCaptionBody(db, key);
  const selection: GameTipsSnapshot = {
    provider,
    ...(logo ? { logoId: logo.logoId } : {}),
    ...(backgroundId ? { backgroundId } : {}),
    games: candidates.slice(0, 3).map(({ id, game }) => ({ id, game })),
    captionPresetId,
    captionBodyId: body.id,
    captionCycle: cycle,
    caption: gameTipsCaption(provider, captionPresetId, body),
  };
  db.prepare("INSERT INTO telegram_game_tip_slots(plan_id,plan_revision,run_at,provider_key,selection_json) VALUES(?,?,?,?,?)")
    .run(row.id, row.revision, at, key, JSON.stringify(selection));
  return selection;
}

function materialize(db: DatabaseSync, now: number) {
  const state = runtime(db), channelRows = targets(db), currentIdentity = identityCurrent(db), today = dayStart(now);
  const definitions = channelDefinitions(db, hotChatId(db));
  const insert = (row: Plan, keys: ScheduledMessageTargetKey[], at: number, status: "pending" | "skipped",
    error = "", provider = row.game_tips_provider) => {
    for (const key of keys) {
      const channel = channelRows.find(target => target.target_key === key);
      db.prepare(`INSERT OR IGNORE INTO telegram_scheduled_message_deliveries
        (id,plan_id,plan_revision,plan_name,text,media_id,game_tips_provider,run_at,target_key,target_chat_id,target_title,token_hash,bot_id,status,next_attempt_at,last_error)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          randomUUID(), row.id, row.revision, row.name, status === "pending" ? row.text : "", status === "pending" ? row.media_id : "",
          provider, at, key, channel?.chat_id || 0, definitions.find(target => target.key === key)?.title || key, state.token_hash, state.bot_id, status, at, error);
    }
  };
  for (const row of db.prepare("SELECT * FROM telegram_scheduled_message_plans WHERE enabled=1 AND deleted_at=0 AND next_run_at>0 AND next_run_at<=?").all(now) as Plan[]) {
    const times = parseTimes(row.times_json), keys = parseTargetKeys(row.target_keys_json), date = row.calendar_date ? calendarDay(row.calendar_date) : null;
    if (!times.length || !keys.length || date !== null && !Number.isFinite(date)) {
      db.prepare("UPDATE telegram_scheduled_message_plans SET enabled=0,next_run_at=0 WHERE id=?").run(row.id);
      continue;
    }
    const expiredDate = date !== null && date < today;
    if (!expiredDate && (!currentIdentity || !targetsReady(channelRows, keys))) continue;
    if (date === null && row.next_run_at < now - GRACE_MS) insert(row, keys, row.next_run_at, "skipped", "错过发送时段超过 15 分钟，已跳过停机期间的旧时段。");
    // Only recent wall-clock occurrences may catch up; long downtime never bursts an old backlog.
    let latest = row.last_run_at;
    for (const day of date === null ? [today - DAY, today] : [date]) for (const time of times) {
      const at = slot(day, time);
      if (at < row.next_run_at || at > now) continue;
      const expired = expiredDate || Boolean(row.game_tips_provider && at < today);
      if (expired || date !== null && at < now - GRACE_MS) {
        insert(row, keys, at, "skipped", expired ? "该发送日期已结束，未补发旧消息。" : "错过发送时段超过 15 分钟，已跳过旧消息。");
      } else if (at >= now - GRACE_MS) {
        const selection = row.game_tips_provider ? pickGameTips(db, row, at) : null;
        if (row.game_tips_provider && !selection) {
          insert(row, keys, at, "skipped", GAME_TIPS_EMPTY);
          continue;
        }
        insert(row, keys, at, "pending", "", selection?.provider);
        latest = Math.max(latest, at);
      }
    }
    db.prepare("UPDATE telegram_scheduled_message_plans SET next_run_at=?,last_run_at=? WHERE id=? AND revision=?")
      .run(nextScheduledMessageTime(times, now, false, row.calendar_date), latest, row.id, row.revision);
  }
}
function releaseTerminalPayloads(db: DatabaseSync) {
  // Keep the unique occurrence metadata forever for deduplication. Only the
  // redundant payload snapshot is released after a definitive terminal outcome.
  db.prepare("UPDATE telegram_scheduled_message_deliveries SET text='',media_id='' WHERE (text<>'' OR media_id<>'') AND status IN ('sent','failed','cancelled','skipped')").run();
}
function recover(db: DatabaseSync, now: number) {
  releaseTerminalPayloads(db);
  db.prepare(`UPDATE telegram_scheduled_message_deliveries SET status='unknown',last_error=?,lease_id='',lease_until=0
    WHERE status='sending' AND dispatch_started_at>0 AND lease_until<=?`).run(UNKNOWN_ERROR, now);
  db.prepare(`UPDATE telegram_scheduled_message_deliveries SET status='pending',lease_id='',lease_until=0
    WHERE status='sending' AND dispatch_started_at=0 AND lease_until<=?`).run(now);
  db.prepare(`UPDATE telegram_scheduled_message_deliveries SET text='',media_id='',status='cancelled',last_error='计划已修改或停用。',lease_id='',lease_until=0
    WHERE status='pending' AND NOT EXISTS(SELECT 1 FROM telegram_scheduled_message_plans p
      WHERE p.id=plan_id AND p.revision=plan_revision AND p.enabled=1 AND p.deleted_at=0)`).run();
  db.prepare(`UPDATE telegram_scheduled_message_deliveries SET text='',media_id='',status='skipped',last_error='发送时段已过期，未补发旧消息。',lease_id='',lease_until=0
    WHERE status='pending' AND (run_at<? OR (run_at<? AND EXISTS (
      SELECT 1 FROM telegram_scheduled_message_plans p WHERE p.id=plan_id AND (p.calendar_date<>'' OR p.game_tips_provider<>'')
    )))`).run(now - GRACE_MS, dayStart(now));
}
function owns(db: DatabaseSync, lease: string, now: number): boolean { const state = runtime(db); return state.lease_id === lease && state.lease_until > now; }
function claimGroup(db: DatabaseSync, lease: string, now: number): Delivery[] {
  return transaction(db, () => {
    if (!owns(db, lease, now) || !identityCurrent(db)) return [];
    recover(db, now);
    const due = db.prepare("SELECT plan_id,run_at FROM telegram_scheduled_message_deliveries d WHERE status='pending' AND run_at<=? AND next_attempt_at<=? AND EXISTS(SELECT 1 FROM telegram_scheduled_message_targets t WHERE t.target_key=d.target_key AND t.ready=1) ORDER BY run_at,id LIMIT 1").get(now, now) as { plan_id: string; run_at: number } | undefined;
    if (!due) return [];
    const jobs = db.prepare("SELECT * FROM telegram_scheduled_message_deliveries d WHERE plan_id=? AND run_at=? AND status='pending' AND next_attempt_at<=? AND EXISTS(SELECT 1 FROM telegram_scheduled_message_targets t WHERE t.target_key=d.target_key AND t.ready=1) ORDER BY target_key LIMIT 4").all(due.plan_id, due.run_at, now) as Delivery[];
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
    if (!owns(db, lease, now) || !identityCurrent(db) || !current?.enabled || current.revision !== job.plan_revision
      || !parseTargetKeys(current.target_keys_json).includes(job.target_key) || !target?.ready
      || target.chat_id !== job.target_chat_id || state.token_hash !== job.token_hash || state.bot_id !== job.bot_id || row.status !== "sending" || row.lease_id !== job.lease_id) {
      db.prepare("UPDATE telegram_scheduled_message_deliveries SET text='',media_id='',status='cancelled',lease_id='',lease_until=0,last_error=? WHERE id=? AND lease_id=? AND status='sending' AND dispatch_started_at=0")
        .run(CHANGED_ERROR, job.id, job.lease_id);
      return false;
    }
    if ((current.calendar_date || current.game_tips_provider) && row.run_at < dayStart(now)) {
      db.prepare("UPDATE telegram_scheduled_message_deliveries SET text='',media_id='',status='skipped',lease_id='',lease_until=0,last_error='该发送日期已结束，未补发旧消息。' WHERE id=? AND lease_id=? AND status='sending' AND dispatch_started_at=0")
        .run(job.id, job.lease_id);
      return false;
    }
    return Boolean(db.prepare("UPDATE telegram_scheduled_message_deliveries SET dispatch_started_at=?,attempts=attempts+1,lease_until=? WHERE id=? AND lease_id=? AND status='sending' AND dispatch_started_at=0").run(now, now + LEASE_MS, job.id, job.lease_id).changes);
  });
}
type GameTipsDelivery = { kind: "standard" } | { kind: "photo"; bytes: Buffer; caption: string } | { kind: "error" };
async function prepareGameTipsPhoto(db: DatabaseSync, job: Delivery): Promise<GameTipsDelivery> {
  const slot = db.prepare("SELECT selection_json FROM telegram_game_tip_slots WHERE plan_id=? AND plan_revision=? AND run_at=?")
    .get(job.plan_id, job.plan_revision, job.run_at) as { selection_json: string } | undefined;
  if (!slot) {
    const current = plan(db, job.plan_id);
    return job.game_tips_provider || current?.revision === job.plan_revision && current.game_tips_provider
      ? { kind: "error" } : { kind: "standard" };
  }
  const selection = parseGameTipsSelection(slot.selection_json);
  if (!selection) return { kind: "error" };
  try {
    const captionPresetId = captionPresetOrDefault(selection.captionPresetId);
    const caption = selection.caption ?? gameTipsCaption(selection.provider, captionPresetId);
    if (!selection.caption) {
      db.prepare(`UPDATE telegram_game_tip_slots SET selection_json=?
        WHERE plan_id=? AND plan_revision=? AND run_at=? AND selection_json=?`).run(
        JSON.stringify({ ...selection, captionPresetId, caption }), job.plan_id, job.plan_revision, job.run_at, slot.selection_json);
    }
    const bytes = await renderGameTips(db, selection);
    if (bytes.length > 0 && bytes.length <= 10 * 1024 * 1024 && caption.length > 0 && caption.length <= 1024) {
      return { kind: "photo", bytes, caption };
    }
  } catch { /* The render failed before any network send. */ }
  return { kind: "error" };
}
async function dispatch(db: DatabaseSync, lease: string, job: Delivery, decrypt: Decrypt, clock: () => number, gameTips: GameTipsDelivery) {
  const stored = cipher(db), token = decrypt(stored);
  if (!token || hash(stored) !== job.token_hash) {
    transaction(db, () => {
      db.prepare("UPDATE telegram_scheduled_message_deliveries SET text='',media_id='',status='cancelled',last_error=?,lease_id='',lease_until=0 WHERE id=? AND lease_id=? AND status='sending' AND dispatch_started_at=0").run(TOKEN_ERROR, job.id, job.lease_id);
      db.prepare("UPDATE telegram_scheduled_message_targets SET ready=0,last_error=?").run(TOKEN_ERROR);
      db.prepare("UPDATE telegram_scheduled_message_runtime SET next_verify_at=?,last_error=? WHERE id='primary'").run(clock() + 60_000, TOKEN_ERROR);
    });
    return;
  }
  if (gameTips.kind === "error") {
    transaction(db, () => {
      if (!owns(db, lease, clock())) return;
      db.prepare(`UPDATE telegram_scheduled_message_deliveries SET status='failed',text='',last_error=?,lease_id='',lease_until=0
        WHERE id=? AND lease_id=? AND status='sending' AND dispatch_started_at=0`).run(GAME_TIPS_RENDER_ERROR, job.id, job.lease_id);
    });
    return;
  }
  if (!prepareDispatch(db, lease, job, clock())) return;
  const response = await (gameTips.kind === "photo"
    ? telegramRequest(token, "sendPhoto", { chat_id: job.target_chat_id, caption: gameTips.caption, reply_markup: GAME_TIPS_BUTTONS },
      { field: "photo", bytes: gameTips.bytes, mime: "image/jpeg", fileName: "game-tips.jpg" })
    : job.media_id ? sendScheduledMessageMedia(db, token, job.target_chat_id, job.text, job.media_id)
      : telegramRequest(token, "sendMessage", { chat_id: job.target_chat_id, text: job.text, link_preview_options: { is_disabled: true } })).catch(() => null);
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
    const definitive = [400, 401, 403, 429].includes(code), error = code === 401 ? TOKEN_ERROR
      : code === 400 && gameTips.kind === "photo" ? "Telegram 拒绝了生成的 Game Tips 图片，请检查后重新安排。"
      : code === 400 && job.media_id ? "Telegram 拒绝附件或附件已失效，请检查文件后重新安排。"
      : code === 400 || code === 403 ? TARGET_ERROR : code === 429 ? "Telegram 连续限流，已停止本次发送。" : UNKNOWN_ERROR;
    db.prepare("UPDATE telegram_scheduled_message_deliveries SET status=?,last_error=?,lease_id='',lease_until=0 WHERE id=? AND lease_id=?").run(definitive ? "failed" : "unknown", error, job.id, job.lease_id);
    if ((code === 401 || code === 403) && runtime(db).token_hash === job.token_hash) {
      if (code === 401) db.prepare("UPDATE telegram_scheduled_message_targets SET ready=0,last_error=?").run(error);
      else if (!db.prepare("UPDATE telegram_scheduled_message_targets SET ready=0,last_error=? WHERE target_key=? AND chat_id=?")
        .run(error, job.target_key, job.target_chat_id).changes) return;
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
    const active = Boolean(db.prepare(`SELECT 1 FROM telegram_scheduled_message_plans p WHERE enabled=1 AND deleted_at=0
      AND (next_run_at>0 OR EXISTS (SELECT 1 FROM telegram_scheduled_message_deliveries d WHERE d.plan_id=p.id AND d.status IN ('pending','sending'))) LIMIT 1`).get());
    const stored = cipher(db), state = runtime(db);
    // One read-only startup verification makes the destinations visible;
    // failures back off rather than hammering Telegram every five seconds.
    const identityDirty = stored && (hash(stored) !== state.token_hash || hotChatId(db) !== state.hot_chat_id);
    const keys = channelDefinitions(db, hotChatId(db)).map(target => target.key);
    if (stored && (identityDirty || clock() >= state.next_verify_at) && (active || !state.next_verify_at || keys.length > 0 && !configured(db, keys))) {
      await verifyScheduledMessageTargets(db, decrypt, clock);
    }
    if (active) {
      ensureGameTipsAssets(db);
      transaction(db, () => { if (owns(db, lease, clock())) materialize(db, clock()); });
      // A permission problem on one destination must not block a definitive
      // 429 retry that belongs to another already-materialized destination.
      if (identityCurrent(db)) {
        for (let i = 0; i < 10; i++) {
          const jobs = claimGroup(db, lease, clock());
          if (!jobs.length) break;
          const payload = await prepareGameTipsPhoto(db, jobs[0]);
          const results = await Promise.allSettled(jobs.map(job => dispatch(db, lease, job, decrypt, clock, payload)));
          if (results.some(result => result.status === "rejected")) throw new ScheduledMessageError("无法保存文案发送状态，将在下一次检查恢复。", 503);
        }
      }
    }
    releaseTerminalPayloads(db);
    releaseDeletedGameTipsAssets(db);
    releaseRetiredGameTipsArtwork(db);
    db.prepare("UPDATE telegram_scheduled_message_runtime SET last_completed_at=?,heartbeat_at=?,last_error=? WHERE id='primary' AND lease_id=?")
      .run(clock(), clock(), active && hasBlockedPlan(db) ? runtime(db).last_error || CHANGED_ERROR : "", lease);
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
        const db = getSqlite(), status = scheduledMessageStatus(db);
        console.info("Telegram scheduled text worker status.", JSON.stringify({ planCount: status.plans.length, enabledPlanCount: status.plans.filter(p => p.enabled).length, targetReadyCount: status.targets.filter(t => t.ready).length, workerHealthy: status.scheduler.workerHealthy, nextRunAt: status.scheduler.nextRunAt, pending: status.counts.pending, sending: status.counts.sending, failed: status.counts.failed, unknown: status.counts.unknown }));
        if (!lastReport) void inspectGameTipsGroupRoutes(db, decrypt).then(audit => {
          if (audit) console.info("Game Tips Group routing audit.", JSON.stringify(audit));
        }).catch(() => console.info("Game Tips Group routing audit unavailable."));
        lastReport = Date.now();
      }
    } catch { if (!reported) console.error("Telegram scheduled text worker could not process its queue."); reported = true; }
    finally { running = false; }
  };
  console.info("Telegram scheduled text worker started.");
  void tick(); setInterval(() => void tick(), TICK_MS).unref();
}
