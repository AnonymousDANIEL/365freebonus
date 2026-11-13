import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getSqlite } from "./sqlite";
import { telegramRelayUpdates, telegramRequest } from "./telegram-bot";
import { inspectRelayDelivery, normalizeRelayCaptionEntities, prepareRelayMessage, relayKeyboard, type RelayCaptionEntity } from "./telegram-relay-content";
import { downloadBotRelayMedia, relayMediaIdentity, relayMediaMaxBytes } from "./telegram-relay-media";

type DecryptToken = (ciphertext: string) => string;
type RelaySettings = { relay_enabled: number; relay_chat_id: string; relay_started_at: number; relay_revision: string; token_ciphertext: string };
type RelayState = {
  revision: string; bot_id: number; next_offset: number; last_polled_at: number; next_poll_at: number;
  poll_lease_id: string; poll_lease_until: number; send_lease_id: string; send_lease_until: number; next_send_at: number;
  target_chat_id: number; target_verified_at: number; ready_until: number; skipped_count: number; last_error: string;
};
type PollClaim = { settings: RelaySettings; botId: number; leaseId: string; offset: number; state: RelayState };
type RelayJob = {
  id: number; source_chat_id: number; source_message_id: number; media_group_id: string; fingerprint: string;
  revision: string; media_kind: "photo" | "animation" | "video"; file_id: string; file_unique_id: string; caption: string;
  has_spoiler: number; attempts: number; lease_id: string; lease_until: number;
  origin: string; account_generation: string; queued_at: number; media_bytes: Uint8Array | null;
  content_hash: string; visual_hash: string; media_prepared: number; mime_type: string; caption_entities: string;
  message_id: number | null; sent_at: number | null; last_error: string;
  caption_edit_attempted_at: number; caption_edit_outcome: string;
};
type SendClaim = { settings: RelaySettings; targetChatId: number; job: RelayJob };
type CaptionEditClaim = SendClaim;
const LEASE_MS = 60_000;
const VERIFY_MS = 60_000;
const POLL_MS = 1_000;
const SEND_MS = 3_000;
const MAX_ATTEMPTS = 5;
const QUEUE_MAX_BYTES = 64 * 1024 * 1024;
const UNCERTAIN = "Telegram 未确认图片转发的发送结果，已停止自动重试以避免重复。";
const TOKEN_ERROR = "无法使用品牌机器人凭据，请重新填写 @FreeBonus365Bot 的 Token。";
const TARGET_ERROR = "请将 @FreeBonus365Bot 加入目标群或频道，并允许它发送照片、视频和 GIF；目标频道需要发布消息权限。";
const TARGET_CHANGED_ERROR = "目标群或频道身份已改变，请在后台核对目标并重新关闭／开启转发。";
const WEBHOOK_ERROR = "品牌机器人已连接其他 Webhook，请先解除该接收连接后再启用图片转发。";
const CONFLICT_ERROR = "品牌机器人正由另一项轮询或 Webhook 使用，请检查其他接收程序。";
const TEMP_ERROR = "暂时无法验证图片转发连接，稍后自动检查。";
const CAPTION_LIMIT_ERROR = "原文超过当前媒体文案长度限制，已停止发送，避免截断文案或 Emoji。";
const CAPTION_DATA_ERROR = "转发文案格式资料异常，已停止发送，避免改变文案或 Emoji。";
const LEGACY_CAPTION_ERROR = "旧转发记录未保存原始 Emoji 和格式，已停止发送以避免表情变样。之后的新消息会保留原始格式资料。";
const CUSTOM_EMOJI_ERROR = "Telegram 拒绝发送含自定义 Emoji 的消息。请检查机器人的自定义 Emoji 使用权限及原消息格式；不会改成普通 Emoji 重发。";
const CUSTOM_EMOJI_CHANGED_ERROR = "Telegram 未保留部分原始自定义 Emoji，请检查机器人的自定义 Emoji 使用权限。该消息不会自动重发。";
const CAPTION_CHANGED_ERROR = "Telegram 返回的文案与提交原文不一致，请检查原消息格式。该消息不会自动重发。";
const CUSTOM_EMOJI_DROPPED_ERROR = "原始自定义 Emoji 资料未能完整保留，已停止发送，避免表情变样。";
const CAPTION_LINKS_CHANGED_ERROR = "Telegram 返回的文案链接与本站入口不一致，将尝试补正原消息；不会重复发送媒体。";
const CAPTION_BUTTONS_CHANGED_ERROR = "Telegram 返回的按钮与固定入口不一致，将尝试补正原消息；不会重复发送媒体。";
const CAPTION_REPLY_TARGET_ERROR = "Telegram 返回的消息目标未能确认，已停止自动补正；该消息不会重复发送。";
const CAPTION_EDIT_REJECTED_ERROR = "Telegram 拒绝补正文案或按钮，请检查机器人权限及原消息格式；不会重复发送媒体。";
const CAPTION_EDIT_UNCERTAIN_ERROR = "Telegram 未确认文案补正结果，已停止自动重试；不会重复发送媒体。";
const CAPTION_EDIT_INVALID_ERROR = "原消息身份、设置或来源已改变，已停止自动补正文案；不会重复发送媒体。";
const CAPTION_UNSAFE_LINKS_ERROR = "保存的转发文案仍含未替换链接，已停止发送或编辑，避免保留外部入口。";
const ACCOUNT_CAPTION_UNAVAILABLE_ERROR = "个人账号备用补正当前不可用，请检查本人账号连接和编辑权限；原媒体不会重复发送。";
const ACCOUNT_CAPTION_REJECTED_ERROR = "个人账号未能补正原始自定义 Emoji，请检查本人账号权限；不会重新发送媒体。";
const ACCOUNT_CAPTION_UNCERTAIN_ERROR = "个人账号备用补正结果未能确认，已停止自动重试；不会重新发送媒体。";
const REPAIRABLE_CAPTION_ERRORS = [CAPTION_CHANGED_ERROR, CUSTOM_EMOJI_CHANGED_ERROR, CAPTION_LINKS_CHANGED_ERROR, CAPTION_BUTTONS_CHANGED_ERROR];
const CAPTION_EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const result = work(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
function settings(db: DatabaseSync): RelaySettings | undefined {
  return db.prepare(`SELECT relay_enabled, relay_chat_id, relay_started_at, relay_revision, token_ciphertext
    FROM telegram_promotion_settings WHERE id='primary'`).get() as RelaySettings | undefined;
}
function enabled(value: RelaySettings | undefined): value is RelaySettings {
  return value?.relay_enabled === 1 && Boolean(value.relay_chat_id) && value.relay_started_at > 0
    && Boolean(value.relay_revision) && Boolean(value.token_ciphertext);
}
function botId(token: string): number {
  const id = Number(token.split(":", 1)[0]);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}
function state(db: DatabaseSync): RelayState {
  db.prepare("INSERT OR IGNORE INTO telegram_relay_state(id) VALUES('primary')").run();
  return db.prepare("SELECT * FROM telegram_relay_state WHERE id='primary'").get() as RelayState;
}
/** Invalidates queued work but keeps a global in-flight send lease until it settles. */
export function cancelRelayPending(db: DatabaseSync) {
  db.prepare(`UPDATE telegram_relay_outbox SET status='cancelled',lease_id='',lease_until=0,media_bytes=NULL
    WHERE status='pending'`).run();
  // A request already handed to Telegram may still succeed after settings
  // change. Retain its media identity instead of making it eligible again.
  db.prepare(`UPDATE telegram_relay_outbox SET status='unknown',last_error=?,lease_id='',lease_until=0,media_bytes=NULL
    WHERE status='sending'`).run(UNCERTAIN);
}

/** Persistent media identities are independent of caption, source, target and settings generations. */
function mediaOwner(db: DatabaseSync, keys: string[], exceptId = 0): number {
  for (const key of keys) {
    const existing = db.prepare(`SELECT k.outbox_id,o.status FROM telegram_relay_media_keys k
      JOIN telegram_relay_outbox o ON o.id=k.outbox_id WHERE k.media_key=?`).get(key) as { outbox_id: number; status: string } | undefined;
    if (!existing) continue;
    if (["failed", "cancelled"].includes(existing.status)) {
      db.prepare("DELETE FROM telegram_relay_media_keys WHERE media_key=?").run(key);
    } else if (existing.outbox_id !== exceptId) return existing.outbox_id;
  }
  return 0;
}
function registerMedia(db: DatabaseSync, id: number, keys: string[]): boolean {
  const duplicate = mediaOwner(db, keys, id);
  const owner = duplicate || id;
  for (const key of keys) db.prepare("INSERT OR IGNORE INTO telegram_relay_media_keys(media_key,outbox_id) VALUES(?,?)").run(key, owner);
  if (!duplicate) return true;
  db.prepare("UPDATE telegram_relay_outbox SET status='cancelled',media_bytes=NULL,lease_id='',lease_until=0,last_error='' WHERE id=?").run(id);
  db.prepare("UPDATE telegram_relay_state SET skipped_count=skipped_count+1 WHERE id='primary'").run();
  return false;
}
function identityKeys(kind: string, contentHash: string, visualHash: string) {
  return [contentHash ? `content:${kind}:${contentHash}` : "", visualHash ? `visual:${kind}:${visualHash}` : ""].filter(Boolean);
}
function accountAllowed(db: DatabaseSync, sourceChatId: number, generation: string, queuedAt = Number.MAX_SAFE_INTEGER): boolean {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='telegram_personal_account'").get()) return false;
  return Boolean(db.prepare(`SELECT 1 FROM telegram_personal_account a JOIN telegram_personal_sources s
    WHERE a.id='primary' AND a.stage='connected' AND a.generation=? AND s.chat_id=? AND s.selected=1 AND s.joined=1 AND s.blocked=0 AND s.selected_at<=?`)
    .get(generation, sourceChatId, queuedAt));
}

/** User-account media is uploaded as bytes, never as a Bot API file_id. */
export async function enqueuePersonalRelayMedia(input: {
  sourceChatId: number; sourceMessageId: number; sourceDate: number; mediaGroupId: string; caption: string; captionEntities: unknown;
  mediaKind: "photo" | "animation" | "video"; bytes: Buffer; hasSpoiler: boolean; sourceMediaId: string; mimeType?: string; expectedCustomEmojiCount?: number;
  accountGeneration: string; relayRevision: string;
}): Promise<boolean> {
  const db = getSqlite();
  const current = settings(db);
  if (!enabled(current) || current.relay_revision !== input.relayRevision || !accountAllowed(db, input.sourceChatId, input.accountGeneration)) return false;
  const runtime = state(db);
  if (runtime.ready_until <= Date.now() || runtime.revision !== current.relay_revision || runtime.target_chat_id >= 0) return false;
  const selected = db.prepare("SELECT selected_at FROM telegram_personal_sources WHERE chat_id=?").get(input.sourceChatId) as { selected_at: number };
  if (input.sourceDate * 1000 < Math.floor(selected.selected_at / 1000) * 1000) return true;
  if (!Buffer.isBuffer(input.bytes) || !input.bytes.length || input.bytes.length > relayMediaMaxBytes(input.mediaKind)) return true;
  const sourceId = createHash("sha256").update(input.sourceMediaId).digest("hex");
  const content = prepareRelayMessage({ chat: { id: input.sourceChatId, type: "channel" },
    message_id: input.sourceMessageId, date: input.sourceDate, media_group_id: input.mediaGroupId || undefined,
    caption: input.caption, caption_entities: input.captionEntities, has_media_spoiler: input.hasSpoiler,
    [input.mediaKind]: input.mediaKind === "photo"
      ? [{ file_id: sourceId, file_unique_id: sourceId, width: 1, height: 1 }]
      : { file_id: sourceId, file_unique_id: sourceId },
  }, { botId: runtime.bot_id, targetChatId: runtime.target_chat_id, startedAt: current.relay_started_at });
  if (!content) return true;
  const expectedCustom = Number.isSafeInteger(input.expectedCustomEmojiCount) && Number(input.expectedCustomEmojiCount) >= 0 ? Number(input.expectedCustomEmojiCount) : 0;
  const droppedCustom = content.customEmojiLost || expectedCustom > content.captionEntities.filter(entity => entity.type === "custom_emoji").length;
  const contentError = content.captionTruncated ? CAPTION_LIMIT_ERROR : droppedCustom ? CUSTOM_EMOJI_DROPPED_ERROR : "";
  const mimeType = input.mediaKind === "video" && input.mimeType && /^video\/[a-z0-9.+-]{1,80}$/i.test(input.mimeType)
    ? input.mimeType.toLowerCase() : input.mediaKind === "video" ? "video/mp4" : "";
  const hashes = await relayMediaIdentity(input.bytes, input.mediaKind);
  return transaction(db, () => {
    const latest = settings(db);
    const target = state(db);
    if (!enabled(latest) || latest.relay_revision !== input.relayRevision || target.ready_until <= Date.now()
      || target.target_chat_id !== runtime.target_chat_id || !accountAllowed(db, input.sourceChatId, input.accountGeneration)) return false;
    const latestSelection = db.prepare("SELECT selected_at FROM telegram_personal_sources WHERE chat_id=?").get(input.sourceChatId) as { selected_at: number };
    if (latestSelection.selected_at !== selected.selected_at) return false;
    const keys = [`account:${input.mediaKind}:${sourceId}`, ...identityKeys(input.mediaKind, hashes.contentHash, hashes.visualHash)];
    const duplicate = mediaOwner(db, keys);
    const exists = db.prepare(`SELECT 1 FROM telegram_relay_outbox WHERE source_chat_id=? AND (source_message_id=?
      OR (?<>'' AND media_group_id=?))`).get(input.sourceChatId, input.sourceMessageId, input.mediaGroupId, input.mediaGroupId);
    if (duplicate || exists) { db.prepare("UPDATE telegram_relay_state SET skipped_count=skipped_count+1 WHERE id='primary'").run(); return true; }
    const queue = db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(length(media_bytes)),0) AS bytes FROM telegram_relay_outbox WHERE status IN ('pending','sending')").get() as { count: number; bytes: number };
    if (queue.count >= 128 || queue.bytes + input.bytes.length > QUEUE_MAX_BYTES) return false;
    const now = Date.now();
    const inserted = db.prepare(`INSERT OR IGNORE INTO telegram_relay_outbox
      (source_chat_id,source_message_id,media_group_id,fingerprint,queued_at,revision,media_kind,file_id,file_unique_id,caption,has_spoiler,
       next_attempt_at,origin,account_generation,media_bytes,content_hash,visual_hash,media_prepared,mime_type,caption_entities,status,last_error)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)`)
      .run(content.sourceChatId, content.sourceMessageId, content.mediaGroupId, content.fingerprint, now, current.relay_revision,
        content.mediaKind, "", sourceId, content.caption, Number(content.hasSpoiler), now, "account", input.accountGeneration,
        contentError ? null : input.bytes, hashes.contentHash, hashes.visualHash, mimeType,
        JSON.stringify(content.captionEntities), contentError ? "failed" : "pending", contentError);
    if (inserted.changes) registerMedia(db, Number(inserted.lastInsertRowid), keys);
    return true;
  });
}
function synchronize(db: DatabaseSync, current: RelaySettings, identity: number): RelayState {
  const previous = state(db);
  if (previous.revision !== current.relay_revision || previous.bot_id !== identity) {
    cancelRelayPending(db);
    db.prepare(`UPDATE telegram_relay_state SET revision=?,bot_id=?,
      next_offset=CASE WHEN bot_id=? THEN next_offset ELSE 0 END,
      last_polled_at=CASE WHEN bot_id=? THEN last_polled_at ELSE 0 END,
      next_poll_at=0,target_chat_id=CASE WHEN revision=? THEN target_chat_id ELSE 0 END,
      target_verified_at=0,ready_until=0,last_error=''
      WHERE id='primary'`).run(current.relay_revision, identity, identity, identity, current.relay_revision);
  }
  return state(db);
}
export function relayStatus(db: DatabaseSync) {
  const counts = { pending: 0, sending: 0, sent: 0, failed: 0, unknown: 0, cancelled: 0, skipped: 0 };
  for (const row of db.prepare("SELECT status,COUNT(*) AS count FROM telegram_relay_outbox GROUP BY status").all() as { status: keyof typeof counts; count: number }[]) {
    if (row.status in counts) counts[row.status] += row.count;
  }
  const current = settings(db);
  const runtime = state(db);
  const latest = db.prepare("SELECT last_error FROM telegram_relay_outbox WHERE status IN ('failed','unknown','sent') ORDER BY id DESC LIMIT 1").get() as { last_error: string } | undefined;
  const custom = db.prepare(`SELECT last_error FROM telegram_relay_outbox WHERE status IN ('failed','unknown','sent')
    AND (instr(caption_entities,'"custom_emoji"')>0 OR last_error=?) ORDER BY id DESC LIMIT 1`).get(CUSTOM_EMOJI_DROPPED_ERROR) as { last_error: string } | undefined;
  counts.skipped += runtime.skipped_count;
  return { ready: enabled(current) && runtime.revision === current.relay_revision && runtime.ready_until > Date.now() && runtime.target_chat_id < 0,
    counts, lastError: current?.relay_enabled === 1 ? (!current.token_ciphertext ? TOKEN_ERROR : runtime.last_error || custom?.last_error || latest?.last_error || "") : "",
    lastPolledAt: runtime.last_polled_at || null };
}
function currentClaim(db: DatabaseSync, claim: PollClaim, now: number): boolean {
  const current = settings(db);
  if (!enabled(current) || current.relay_revision !== claim.settings.relay_revision
    || current.relay_chat_id !== claim.settings.relay_chat_id || current.token_ciphertext !== claim.settings.token_ciphertext) return false;
  return Boolean(db.prepare(`SELECT 1 FROM telegram_relay_state WHERE id='primary' AND revision=?
    AND poll_lease_id=? AND poll_lease_until>?`).get(current.relay_revision, claim.leaseId, now));
}
function finishPoll(db: DatabaseSync, claim: PollClaim) {
  db.prepare("UPDATE telegram_relay_state SET poll_lease_id='',poll_lease_until=0 WHERE id='primary' AND poll_lease_id=?").run(claim.leaseId);
}
function report(error: string) {
  if (error === TARGET_ERROR) console.warn("Telegram photo relay is waiting for target access.");
  else if (error === TARGET_CHANGED_ERROR) console.warn("Telegram photo relay is waiting for target identity confirmation.");
  else if (error === WEBHOOK_ERROR) console.warn("Telegram photo relay is blocked by an existing webhook.");
  else if (error === TOKEN_ERROR) console.warn("Telegram photo relay is waiting for valid bot credentials.");
  else if (error === CONFLICT_ERROR) console.warn("Telegram photo relay is waiting for an update receiver conflict to clear.");
  else console.warn("Telegram photo relay connection could not be verified.");
}
function failPoll(db: DatabaseSync, claim: PollClaim, now: number, error: string, delay = VERIFY_MS) {
  if (currentClaim(db, claim, now)) {
    const previous = state(db);
    db.prepare(`UPDATE telegram_relay_state SET ready_until=0,next_poll_at=?,last_error=? WHERE id='primary' AND poll_lease_id=?`)
      .run(Math.min(Number.MAX_SAFE_INTEGER, now + delay), error, claim.leaseId);
    if (previous.last_error !== error) report(error);
  }
  finishPoll(db, claim);
}
function allowedMember(chat: Record<string, unknown>, member: Record<string, unknown>): boolean {
  if (member.status === "creator") return true;
  if (member.status === "administrator") return chat.type !== "channel" || member.can_post_messages === true;
  if (chat.type === "channel") return false;
  const permissions = typeof chat.permissions === "object" && chat.permissions !== null ? chat.permissions as Record<string, unknown> : {};
  if (member.status === "member") return permissions.can_send_messages !== false && permissions.can_send_photos !== false;
  return member.status === "restricted" && member.is_member === true && member.can_send_messages === true
    && member.can_send_photos === true;
}
async function verifyTarget(token: string, claim: PollClaim): Promise<{ targetId: number } | { error: string }> {
  const target = /^-[1-9]\d*$/.test(claim.settings.relay_chat_id) ? Number(claim.settings.relay_chat_id) : claim.settings.relay_chat_id;
  const [me, webhook, chat] = await Promise.all([
    telegramRequest(token, "getMe"), telegramRequest(token, "getWebhookInfo"), telegramRequest(token, "getChat", { chat_id: target }),
  ]).catch(() => [null, null, null]);
  if (me && !me.ok && me.code === 401) return { error: TOKEN_ERROR };
  if (!me?.ok || me.result.is_bot !== true || me.result.id !== claim.botId
    || typeof me.result.username !== "string" || me.result.username.toLowerCase() !== "freebonus365bot") return { error: me?.ok ? TOKEN_ERROR : TEMP_ERROR };
  if (!webhook?.ok || typeof webhook.result.url !== "string") return { error: TEMP_ERROR };
  if (webhook.result.url) return { error: WEBHOOK_ERROR };
  if (!chat?.ok || typeof chat.result.id !== "number" || !Number.isSafeInteger(chat.result.id) || chat.result.id >= 0
    || !["group", "supergroup", "channel"].includes(String(chat.result.type))) return { error: TARGET_ERROR };
  const member = await telegramRequest(token, "getChatMember", { chat_id: chat.result.id, user_id: claim.botId }).catch(() => null);
  if (!member?.ok || !allowedMember(chat.result, member.result)) return { error: TARGET_ERROR };
  return { targetId: chat.result.id };
}

/** Owns only @FreeBonus365Bot's update cursor, separate from the ChatBot poller. */
export async function pollTelegramRelayOnce(decryptToken: DecryptToken, clock = Date.now) {
  const db = getSqlite();
  const snapshot = settings(db);
  if (!enabled(snapshot)) { transaction(db, () => cancelRelayPending(db)); return; }
  let token = "";
  try { token = decryptToken(snapshot.token_ciphertext); } catch { /* Never expose stored credentials. */ }
  const identity = botId(token);
  if (!token || !identity) {
    const previous = state(db);
    db.prepare("UPDATE telegram_relay_state SET ready_until=0,last_error=? WHERE id='primary'").run(TOKEN_ERROR);
    if (previous.last_error !== TOKEN_ERROR) report(TOKEN_ERROR);
    return;
  }
  const claim = transaction(db, () => {
    const current = settings(db);
    if (!enabled(current) || current.token_ciphertext !== snapshot.token_ciphertext) return null;
    const runtime = synchronize(db, current, identity);
    const now = clock();
    if (runtime.poll_lease_until > now || runtime.next_poll_at > now) return null;
    const leaseId = randomUUID();
    db.prepare("UPDATE telegram_relay_state SET poll_lease_id=?,poll_lease_until=? WHERE id='primary'").run(leaseId, now + LEASE_MS);
    return { settings: current, botId: identity, leaseId, offset: runtime.next_offset, state: runtime };
  });
  if (!claim) return;
  if (claim.state.ready_until <= clock() || claim.state.target_chat_id >= 0) {
    const verified = await verifyTarget(token, claim).catch(() => ({ error: TEMP_ERROR }));
    if (!currentClaim(db, claim, clock())) { finishPoll(db, claim); return; }
    if ("error" in verified) { failPoll(db, claim, clock(), verified.error); return; }
    const previous = state(db);
    // A public username may be reassigned. Keep the first verified numeric
    // destination bound to this settings generation until the owner explicitly
    // confirms a new target by changing/re-enabling the relay configuration.
    if (previous.target_chat_id < 0 && previous.target_chat_id !== verified.targetId) {
      failPoll(db, claim, clock(), TARGET_CHANGED_ERROR);
      return;
    }
    db.prepare(`UPDATE telegram_relay_state SET target_chat_id=?,target_verified_at=?,ready_until=?,last_error=''
      WHERE id='primary' AND poll_lease_id=?`).run(verified.targetId, clock(), clock() + VERIFY_MS, claim.leaseId);
    if (previous.target_chat_id !== verified.targetId || previous.target_verified_at === 0 || previous.last_error) console.info("Telegram photo relay is ready.");
  }
  const updates = await telegramRelayUpdates(token, claim.offset).catch(() => null);
  if (!currentClaim(db, claim, clock())) { finishPoll(db, claim); return; }
  if (!updates?.ok) {
    const code = updates && !updates.ok ? updates.code : 0;
    const delay = code === 429 && updates && !updates.ok ? Math.max(VERIFY_MS, updates.retryAfter * 1_000) : VERIFY_MS;
    failPoll(db, claim, clock(), code === 401 ? TOKEN_ERROR : code === 409 ? CONFLICT_ERROR : TEMP_ERROR, delay);
    return;
  }
  transaction(db, () => {
    const now = clock();
    if (!currentClaim(db, claim, now)) return;
    const runtime = state(db);
    let offset = claim.offset;
    let skipped = 0;
    const sorted = updates.result.filter(update => typeof update.update_id === "number" && Number.isSafeInteger(update.update_id)
      && update.update_id > 0 && update.update_id < Number.MAX_SAFE_INTEGER).sort((a, b) => Number(a.update_id) - Number(b.update_id));
    const insert = db.prepare(`INSERT OR IGNORE INTO telegram_relay_outbox
      (source_chat_id,source_message_id,media_group_id,fingerprint,queued_at,revision,media_kind,file_id,file_unique_id,caption,has_spoiler,next_attempt_at,caption_entities,status,last_error)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const update of sorted) {
      const id = Number(update.update_id);
      if (id < offset) continue;
      offset = id + 1;
      const membership = update.my_chat_member;
      if (typeof membership === "object" && membership !== null && !Array.isArray(membership)) {
        const change = membership as Record<string, unknown>;
        const chat = change.chat as Record<string, unknown> | undefined;
        const member = change.new_chat_member as Record<string, unknown> | undefined;
        const user = member?.user as Record<string, unknown> | undefined;
        if (chat && ["group", "supergroup", "channel"].includes(String(chat.type))
          && typeof chat.id === "number" && Number.isSafeInteger(chat.id) && chat.id < 0 && chat.id !== runtime.target_chat_id
          && user?.id === identity && ["left", "kicked"].includes(String(member?.status))
          && typeof change.date === "number" && Number.isSafeInteger(change.date)
          && change.date * 1_000 >= Math.floor(claim.settings.relay_started_at / 1_000) * 1_000) {
          // Source removal revokes queued forwarding for that group. An HTTP
          // request already in flight cannot be recalled, so only queued work
          // is cancelled; other sources retain their independent pending jobs.
          db.prepare(`UPDATE telegram_relay_outbox SET status='cancelled',last_error='',lease_id='',lease_until=0,media_bytes=NULL
            WHERE source_chat_id=? AND origin='bot' AND status='pending'`).run(chat.id);
        }
      }
      const message = update.message ?? update.channel_post;
      if (typeof message !== "object" || message === null || Array.isArray(message)) continue;
      let content;
      try { content = prepareRelayMessage(message as Record<string, unknown>, { botId: identity, targetChatId: runtime.target_chat_id, startedAt: claim.settings.relay_started_at }); }
      catch { content = null; }
      if (!content) { skipped++; continue; }
      const contentError = content.captionTruncated ? CAPTION_LIMIT_ERROR : content.customEmojiLost ? CUSTOM_EMOJI_DROPPED_ERROR : "";
      const mediaKey = `file:${content.mediaKind}:${content.fileUniqueId}`;
      const duplicate = mediaOwner(db, [mediaKey]);
      if (duplicate) { skipped++; continue; }
      const queued = db.prepare("SELECT COUNT(*) AS count FROM telegram_relay_outbox WHERE status IN ('pending','sending')").get() as { count: number };
      if (queued.count >= 128) { offset = id; break; }
      const result = insert.run(content.sourceChatId, content.sourceMessageId, content.mediaGroupId, content.fingerprint, now,
        claim.settings.relay_revision, content.mediaKind, content.fileId, content.fileUniqueId, content.caption, Number(content.hasSpoiler), now,
        JSON.stringify(content.captionEntities), contentError ? "failed" : "pending", contentError);
      if (!result.changes) skipped++;
      else registerMedia(db, Number(result.lastInsertRowid), [mediaKey]);
    }
    db.prepare(`UPDATE telegram_relay_state SET next_offset=?,last_polled_at=?,next_poll_at=MAX(next_poll_at,?),
      skipped_count=skipped_count+?,last_error=CASE WHEN ready_until>? THEN '' ELSE last_error END
      WHERE id='primary' AND poll_lease_id=?`).run(updates.result.length === 0 ? 0 : offset, now, now + POLL_MS, skipped, now, claim.leaseId);
  });
  finishPoll(db, claim);
}

function ownsSend(db: DatabaseSync, claim: SendClaim, now: number): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM telegram_relay_outbox WHERE id=? AND status='sending' AND lease_id=? AND lease_until>?
    AND EXISTS(SELECT 1 FROM telegram_relay_state WHERE id='primary' AND send_lease_id=? AND send_lease_until>?)`)
    .get(claim.job.id, claim.job.lease_id, now, claim.job.lease_id, now));
}
function sendAllowed(db: DatabaseSync, claim: SendClaim, now: number): boolean {
  const current = settings(db);
  const runtime = state(db);
  return enabled(current) && current.relay_revision === claim.settings.relay_revision
    && current.relay_chat_id === claim.settings.relay_chat_id && current.token_ciphertext === claim.settings.token_ciphertext
    && runtime.revision === current.relay_revision && runtime.ready_until > now && runtime.target_chat_id === claim.targetChatId
    && claim.job.source_chat_id !== runtime.target_chat_id && ownsSend(db, claim, now)
    && (claim.job.origin !== "account" || accountAllowed(db, claim.job.source_chat_id, claim.job.account_generation, claim.job.queued_at));
}
function storedCaptionEntities(job: RelayJob): RelayCaptionEntity[] | null {
  try {
    const parsed: unknown = JSON.parse(job.caption_entities);
    if (!Array.isArray(parsed)) return null;
    const entities = normalizeRelayCaptionEntities(job.caption, parsed);
    return entities.length === parsed.length ? entities : null;
  } catch { return null; }
}
function deliveryWarning(caption: string, entities: RelayCaptionEntity[], actual: unknown): string {
  const inspected = inspectRelayDelivery(caption, entities, actual);
  return !inspected.captionMatches ? CAPTION_CHANGED_ERROR
    : !inspected.customEmojiPreserved ? CUSTOM_EMOJI_CHANGED_ERROR
    : !inspected.linksSafe ? CAPTION_LINKS_CHANGED_ERROR
    : !inspected.buttonsMatch ? CAPTION_BUTTONS_CHANGED_ERROR : "";
}
function messageIdentityMatches(actual: Record<string, unknown>, targetChatId: number, messageId?: number | null): boolean {
  const chat = actual.chat;
  return typeof actual.message_id === "number" && Number.isSafeInteger(actual.message_id) && actual.message_id > 0
    && (messageId === undefined || actual.message_id === messageId)
    && chat !== null && typeof chat === "object" && !Array.isArray(chat) && (chat as Record<string, unknown>).id === targetChatId;
}
function ownsCaptionEdit(db: DatabaseSync, claim: CaptionEditClaim, now: number, phase: "attempting" | "account_attempting" = "attempting"): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM telegram_relay_outbox WHERE id=? AND status='sent' AND message_id=?
    AND caption_edit_attempted_at>0 AND caption_edit_outcome=? AND lease_id=? AND lease_until>?
    AND EXISTS(SELECT 1 FROM telegram_relay_state WHERE id='primary' AND send_lease_id=? AND send_lease_until>?)`)
    .get(claim.job.id, claim.job.message_id, phase, claim.job.lease_id, now, claim.job.lease_id, now));
}
function captionEditAllowed(db: DatabaseSync, claim: CaptionEditClaim, now: number, phase: "attempting" | "account_attempting" = "attempting"): boolean {
  const current = settings(db), runtime = state(db);
  return enabled(current) && current.relay_revision === claim.settings.relay_revision
    && current.relay_chat_id === claim.settings.relay_chat_id && current.token_ciphertext === claim.settings.token_ciphertext
    && runtime.revision === current.relay_revision && runtime.ready_until > now && runtime.target_chat_id === claim.targetChatId
    && claim.job.revision === current.relay_revision && claim.job.source_chat_id !== claim.targetChatId
    && ownsCaptionEdit(db, claim, now, phase)
    && (claim.job.origin !== "account" || accountAllowed(db, claim.job.source_chat_id, claim.job.account_generation, claim.job.queued_at));
}
function auditCaptionEdit(outcome: "preserved" | "changed" | "rejected" | "uncertain" | "invalid", expected: RelayCaptionEntity[], actual?: unknown, caption = "") {
  const inspected = actual ? inspectRelayDelivery(caption, expected, actual) : null;
  console.info("Telegram relay caption edit check.", JSON.stringify({ outcome,
    expectedCustomEmoji: expected.filter(entity => entity.type === "custom_emoji").length,
    returnedCustomEmoji: actual && typeof actual === "object" && Array.isArray((actual as Record<string, unknown>).caption_entities)
      ? ((actual as Record<string, unknown>).caption_entities as Record<string, unknown>[]).filter(entity => entity?.type === "custom_emoji").length : 0,
    captionMatches: inspected?.captionMatches ?? false, customEmojiPreserved: inspected?.customEmojiPreserved ?? false,
    linksSafe: inspected?.linksSafe ?? false, buttonsMatch: inspected?.buttonsMatch ?? false,
  }));
}
/** One Bot edit may be followed by one qualified personal-account edit; media is never sent again. */
async function repairTelegramRelayCaptionOnce(token: string, identity: number, snapshot: RelaySettings, clock: () => number): Promise<boolean> {
  const db = getSqlite();
  const claim = transaction(db, () => {
    const current = settings(db);
    if (!enabled(current) || current.token_ciphertext !== snapshot.token_ciphertext) return null;
    const runtime = synchronize(db, current, identity), now = clock();
    db.prepare(`UPDATE telegram_relay_outbox SET caption_edit_outcome='uncertain',last_error=?,lease_id='',lease_until=0
      WHERE status='sent' AND caption_edit_outcome='attempting' AND lease_until<=?`).run(CAPTION_EDIT_UNCERTAIN_ERROR, now);
    if (runtime.ready_until <= now || runtime.target_chat_id >= 0 || runtime.send_lease_until > now || runtime.next_send_at > now) return null;
    const placeholders = REPAIRABLE_CAPTION_ERRORS.map(() => "?").join(",");
    const job = db.prepare(`SELECT * FROM telegram_relay_outbox WHERE status='sent' AND revision=?
      AND message_id>0 AND sent_at>=? AND sent_at<=? AND caption_edit_attempted_at=0 AND last_error IN (${placeholders})
      ORDER BY sent_at DESC,id DESC LIMIT 1`).get(current.relay_revision, now - CAPTION_EDIT_WINDOW_MS, now, ...REPAIRABLE_CAPTION_ERRORS) as RelayJob | undefined;
    if (!job) return null;
    const entities = storedCaptionEntities(job);
    const preparedSafe = entities && inspectRelayDelivery(job.caption, entities,
      { caption: job.caption, caption_entities: entities, reply_markup: { inline_keyboard: relayKeyboard() } }).linksSafe;
    if (!Number.isSafeInteger(job.message_id) || Number(job.message_id) <= 0
      || job.source_chat_id === runtime.target_chat_id || !entities || job.caption.length > 1024
      || !preparedSafe
      || (job.origin === "account" && !accountAllowed(db, job.source_chat_id, job.account_generation, job.queued_at))) {
      db.prepare(`UPDATE telegram_relay_outbox SET caption_edit_attempted_at=?,caption_edit_outcome='invalid',last_error=? WHERE id=? AND caption_edit_attempted_at=0`)
        .run(now, !entities ? !job.caption_entities ? LEGACY_CAPTION_ERROR : CAPTION_DATA_ERROR
          : !preparedSafe ? CAPTION_UNSAFE_LINKS_ERROR : CAPTION_EDIT_INVALID_ERROR, job.id);
      return { invalid: true as const, entities: entities || [] };
    }
    const leaseId = randomUUID();
    db.prepare("UPDATE telegram_relay_state SET send_lease_id=?,send_lease_until=?,next_send_at=? WHERE id='primary'")
      .run(leaseId, now + LEASE_MS, now + SEND_MS);
    db.prepare(`UPDATE telegram_relay_outbox SET caption_edit_attempted_at=?,caption_edit_outcome='attempting',lease_id=?,lease_until=?
      WHERE id=? AND status='sent' AND caption_edit_attempted_at=0`).run(now, leaseId, now + LEASE_MS, job.id);
    return { settings: current, targetChatId: runtime.target_chat_id, entities,
      job: { ...job, caption_edit_attempted_at: now, caption_edit_outcome: "attempting", lease_id: leaseId, lease_until: now + LEASE_MS } };
  });
  if (!claim) return false;
  if ("invalid" in claim) { auditCaptionEdit("invalid", claim.entities); return true; }
  if (!captionEditAllowed(db, claim, clock())) {
    transaction(db, () => {
      if (ownsCaptionEdit(db, claim, clock())) db.prepare(`UPDATE telegram_relay_outbox SET caption_edit_outcome='invalid',last_error=?,lease_id='',lease_until=0
        WHERE id=? AND lease_id=?`).run(CAPTION_EDIT_INVALID_ERROR, claim.job.id, claim.job.lease_id);
      db.prepare("UPDATE telegram_relay_state SET send_lease_id='',send_lease_until=0 WHERE id='primary' AND send_lease_id=?").run(claim.job.lease_id);
    });
    auditCaptionEdit("invalid", claim.entities); return true;
  }
  const reply = await telegramRequest(token, "editMessageCaption", { chat_id: claim.targetChatId, message_id: claim.job.message_id,
    caption: claim.job.caption, caption_entities: claim.entities, reply_markup: { inline_keyboard: relayKeyboard() } }).catch(() => null);
  let outcome: "preserved" | "changed" | "rejected" | "uncertain" | "invalid" = "uncertain";
  transaction(db, () => {
    const now = clock();
    if (!ownsCaptionEdit(db, claim, now)) return;
    let error = CAPTION_EDIT_UNCERTAIN_ERROR, nextSend = now + SEND_MS;
    if (!captionEditAllowed(db, claim, now)) { outcome = "uncertain"; error = CAPTION_EDIT_INVALID_ERROR; }
    else if (reply?.ok) {
      if (!messageIdentityMatches(reply.result, claim.targetChatId, claim.job.message_id)) { outcome = "invalid"; error = CAPTION_EDIT_INVALID_ERROR; }
      else { error = deliveryWarning(claim.job.caption, claim.entities, reply.result); outcome = error ? "changed" : "preserved"; }
    } else if (reply && !reply.ok && reply.code >= 400 && reply.code < 500) {
      outcome = "rejected"; error = CAPTION_EDIT_REJECTED_ERROR;
      if (reply.code === 429) nextSend = Math.min(Number.MAX_SAFE_INTEGER, now + Math.max(SEND_MS, reply.retryAfter * 1000));
      if (reply.code === 401 || reply.code === 403) {
        const accessError = reply.code === 401 ? TOKEN_ERROR : TARGET_ERROR;
        nextSend = now + VERIFY_MS;
        db.prepare(`UPDATE telegram_relay_state SET ready_until=0,next_poll_at=MAX(next_poll_at,?),last_error=?
          WHERE id='primary' AND send_lease_id=?`).run(nextSend, accessError, claim.job.lease_id);
      }
    }
    db.prepare(`UPDATE telegram_relay_outbox SET caption_edit_outcome=?,last_error=?,lease_id='',lease_until=0 WHERE id=? AND lease_id=?`)
      .run(outcome, error, claim.job.id, claim.job.lease_id);
    db.prepare("UPDATE telegram_relay_state SET send_lease_id='',send_lease_until=0,next_send_at=MAX(next_send_at,?) WHERE id='primary' AND send_lease_id=?")
      .run(nextSend, claim.job.lease_id);
  });
  auditCaptionEdit(outcome, claim.entities, reply?.ok ? reply.result : undefined, claim.job.caption);
  return true;
}

function auditAccountCaptionEdit(outcome: string, entities: RelayCaptionEntity[], attempted: boolean, waitingCount: number) {
  console.info("Telegram relay account caption edit check.", JSON.stringify({ outcome, attempted, waitingCount,
    expectedCustomEmoji: entities.filter(entity => entity.type === "custom_emoji").length,
    verified: outcome === "account_preserved",
  }));
}
/** Only a Bot edit known to have lost custom emoji can reach this qualified fallback. */
async function repairTelegramRelayCaptionWithAccountOnce(identity: number, snapshot: RelaySettings, clock: () => number): Promise<boolean> {
  const db = getSqlite();
  const claim = transaction(db, () => {
    const current = settings(db);
    if (!enabled(current) || current.token_ciphertext !== snapshot.token_ciphertext) return null;
    const runtime = synchronize(db, current, identity), now = clock();
    db.prepare(`UPDATE telegram_relay_outbox SET caption_edit_outcome='account_uncertain',last_error=?,lease_id='',lease_until=0
      WHERE status='sent' AND caption_edit_outcome='account_attempting' AND lease_until<=?`).run(ACCOUNT_CAPTION_UNCERTAIN_ERROR, now);
    if (runtime.ready_until <= now || runtime.target_chat_id >= 0 || runtime.send_lease_until > now || runtime.next_send_at > now) return null;
    const job = db.prepare(`SELECT * FROM telegram_relay_outbox WHERE status='sent' AND revision=? AND message_id>0
      AND sent_at>=? AND sent_at<=? AND last_error=? AND caption_edit_attempted_at>0
      AND caption_edit_outcome IN ('changed','account_waiting_1','account_waiting_2','account_waiting_3')
      ORDER BY sent_at DESC,id DESC LIMIT 1`).get(current.relay_revision, now - CAPTION_EDIT_WINDOW_MS, now, CUSTOM_EMOJI_CHANGED_ERROR) as RelayJob | undefined;
    if (!job) return null;
    const entities = storedCaptionEntities(job);
    const preparedSafe = entities && inspectRelayDelivery(job.caption, entities,
      { caption: job.caption, caption_entities: entities, reply_markup: { inline_keyboard: relayKeyboard() } }).linksSafe;
    const waitingCount = Number(/^account_waiting_([1-3])$/.exec(job.caption_edit_outcome)?.[1] || 0);
    if (!Number.isSafeInteger(job.message_id) || Number(job.message_id) <= 0 || !entities
      || !entities.some(entity => entity.type === "custom_emoji") || job.caption.length > 1024 || !preparedSafe
      || job.source_chat_id === runtime.target_chat_id
      || (job.origin === "account" && !accountAllowed(db, job.source_chat_id, job.account_generation, job.queued_at))) {
      db.prepare("UPDATE telegram_relay_outbox SET caption_edit_outcome='account_invalid',caption_edit_attempted_at=?,last_error=? WHERE id=?")
        .run(now, !preparedSafe ? CAPTION_UNSAFE_LINKS_ERROR : CAPTION_EDIT_INVALID_ERROR, job.id);
      return { invalid: true as const, entities: entities || [], waitingCount };
    }
    const leaseId = randomUUID();
    db.prepare("UPDATE telegram_relay_state SET send_lease_id=?,send_lease_until=?,next_send_at=? WHERE id='primary'")
      .run(leaseId, now + LEASE_MS, now + SEND_MS);
    db.prepare(`UPDATE telegram_relay_outbox SET caption_edit_outcome='account_attempting',caption_edit_attempted_at=?,lease_id=?,lease_until=?
      WHERE id=? AND status='sent'`).run(now, leaseId, now + LEASE_MS, job.id);
    return { settings: current, targetChatId: runtime.target_chat_id, entities, waitingCount,
      job: { ...job, caption_edit_outcome: "account_attempting", caption_edit_attempted_at: now, lease_id: leaseId, lease_until: now + LEASE_MS } };
  });
  if (!claim) return false;
  if ("invalid" in claim) { auditAccountCaptionEdit("account_invalid", claim.entities, false, claim.waitingCount); return true; }
  if (!captionEditAllowed(db, claim, clock(), "account_attempting")) {
    transaction(db, () => {
      if (ownsCaptionEdit(db, claim, clock(), "account_attempting")) db.prepare(`UPDATE telegram_relay_outbox
        SET caption_edit_outcome='account_invalid',last_error=?,lease_id='',lease_until=0 WHERE id=? AND lease_id=?`)
        .run(CAPTION_EDIT_INVALID_ERROR, claim.job.id, claim.job.lease_id);
      db.prepare("UPDATE telegram_relay_state SET send_lease_id='',send_lease_until=0 WHERE id='primary' AND send_lease_id=?").run(claim.job.lease_id);
    });
    auditAccountCaptionEdit("account_invalid", claim.entities, false, claim.waitingCount); return true;
  }
  let result: { state: string; attempted: boolean; outcome: "preserved" | "changed" | "rejected" | "uncertain" | "invalid" | "unavailable" };
  try {
    const { editVerifiedRelayCaptionWithAccount } = await import("./telegram-account");
    // The account helper separately revalidates membership, Premium/admin
    // qualification, source generation and the actual post's safe links/buttons.
    result = captionEditAllowed(db, claim, clock(), "account_attempting")
      ? await editVerifiedRelayCaptionWithAccount({ targetChatId: claim.targetChatId, relayRevision: claim.settings.relay_revision,
        messageId: claim.job.message_id!, caption: claim.job.caption, captionEntities: claim.entities })
      : { state: "unavailable", attempted: false, outcome: "invalid" };
  } catch { result = { state: "unavailable", attempted: true, outcome: "uncertain" }; }
  let outcome = "account_uncertain", waited = claim.waitingCount;
  transaction(db, () => {
    const now = clock();
    if (!ownsCaptionEdit(db, claim, now, "account_attempting")) return;
    let error = ACCOUNT_CAPTION_UNCERTAIN_ERROR, nextSend = now + SEND_MS;
    if (!captionEditAllowed(db, claim, now, "account_attempting")) {
      outcome = result.attempted ? "account_uncertain" : "account_invalid";
      error = CAPTION_EDIT_INVALID_ERROR;
    } else if (!result.attempted && (result.state === "busy" || result.state === "backoff")) {
      if (claim.waitingCount < 3) {
        waited = claim.waitingCount + 1; outcome = `account_waiting_${waited}`; error = CUSTOM_EMOJI_CHANGED_ERROR; nextSend = now + 5000;
      } else { outcome = "account_unavailable"; error = ACCOUNT_CAPTION_UNAVAILABLE_ERROR; }
    } else {
      const resolved = result.attempted && result.outcome === "unavailable" ? "uncertain" : result.outcome;
      outcome = `account_${resolved}`;
      error = resolved === "preserved" ? "" : resolved === "changed" ? CUSTOM_EMOJI_CHANGED_ERROR
        : resolved === "rejected" ? ACCOUNT_CAPTION_REJECTED_ERROR : resolved === "invalid" ? CAPTION_EDIT_INVALID_ERROR
        : resolved === "unavailable" ? ACCOUNT_CAPTION_UNAVAILABLE_ERROR : ACCOUNT_CAPTION_UNCERTAIN_ERROR;
    }
    db.prepare("UPDATE telegram_relay_outbox SET caption_edit_outcome=?,last_error=?,lease_id='',lease_until=0 WHERE id=? AND lease_id=?")
      .run(outcome, error, claim.job.id, claim.job.lease_id);
    db.prepare("UPDATE telegram_relay_state SET send_lease_id='',send_lease_until=0,next_send_at=MAX(next_send_at,?) WHERE id='primary' AND send_lease_id=?")
      .run(nextSend, claim.job.lease_id);
  });
  auditAccountCaptionEdit(outcome, claim.entities, result.attempted, waited);
  return true;
}
let successfulEmojiAuditBudget = 5;
function auditEmojiDelivery(expected: RelayCaptionEntity[], actual: unknown, outcome: "preserved" | "changed" | "rejected" | "uncertain") {
  const custom = expected.filter(entity => entity.type === "custom_emoji");
  if (!custom.length) return;
  if (outcome === "preserved") {
    if (successfulEmojiAuditBudget <= 0) return;
    successfulEmojiAuditBudget--;
  }
  const returned = Array.isArray(actual) ? actual.filter(entity => entity && typeof entity === "object" && entity.type === "custom_emoji") : [];
  console.info("Telegram relay emoji delivery check.", JSON.stringify({
    outcome, expectedCustomEmoji: custom.length, expectedNegativeCustomEmoji: custom.filter(entity => entity.custom_emoji_id?.startsWith("-")).length,
    returnedCustomEmoji: returned.length, returnedNegativeCustomEmoji: returned.filter(entity => typeof entity.custom_emoji_id === "string" && entity.custom_emoji_id.startsWith("-")).length,
  }));
}
export async function deliverTelegramRelayOnce(decryptToken: DecryptToken, clock = Date.now) {
  const db = getSqlite();
  const snapshot = settings(db);
  if (!enabled(snapshot)) { transaction(db, () => cancelRelayPending(db)); return; }
  let token = "";
  try { token = decryptToken(snapshot.token_ciphertext); } catch { /* Keep credentials private. */ }
  const identity = botId(token);
  if (!token || !identity) return;
  if (await repairTelegramRelayCaptionWithAccountOnce(identity, snapshot, clock)) return;
  if (await repairTelegramRelayCaptionOnce(token, identity, snapshot, clock)) return;
  const claim = transaction(db, () => {
    const current = settings(db);
    if (!enabled(current) || current.token_ciphertext !== snapshot.token_ciphertext) return null;
    const runtime = synchronize(db, current, identity);
    const now = clock();
    db.prepare(`UPDATE telegram_relay_outbox SET status='unknown',last_error=?,lease_id='',lease_until=0,media_bytes=NULL
      WHERE status='sending' AND lease_until<=?`).run(UNCERTAIN, now);
    db.prepare(`UPDATE telegram_relay_outbox SET status='cancelled',lease_id='',lease_until=0,media_bytes=NULL
      WHERE status='pending' AND (revision<>? OR source_chat_id=?)`).run(current.relay_revision, runtime.target_chat_id);
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='telegram_personal_account'").get()) {
      db.prepare(`UPDATE telegram_relay_outbox SET status='cancelled',media_bytes=NULL WHERE status='pending' AND origin='account'
        AND NOT EXISTS(SELECT 1 FROM telegram_personal_account a JOIN telegram_personal_sources s
          WHERE a.id='primary' AND a.stage='connected' AND a.generation=account_generation
            AND s.chat_id=source_chat_id AND s.selected=1 AND s.joined=1 AND s.blocked=0 AND s.selected_at<=queued_at)`).run();
    }
    if (runtime.ready_until <= now || runtime.target_chat_id >= 0 || runtime.send_lease_until > now || runtime.next_send_at > now) return null;
    const job = db.prepare(`SELECT * FROM telegram_relay_outbox WHERE status='pending' AND revision=? AND next_attempt_at<=?
      ORDER BY next_attempt_at,id LIMIT 1`).get(current.relay_revision, now) as RelayJob | undefined;
    if (!job) return null;
    const leaseId = randomUUID();
    db.prepare("UPDATE telegram_relay_state SET send_lease_id=?,send_lease_until=?,next_send_at=? WHERE id='primary'")
      .run(leaseId, now + LEASE_MS, now + SEND_MS);
    db.prepare("UPDATE telegram_relay_outbox SET status='sending',attempts=attempts+1,lease_id=?,lease_until=? WHERE id=? AND status='pending'")
      .run(leaseId, now + LEASE_MS, job.id);
    return { settings: current, targetChatId: runtime.target_chat_id,
      job: { ...job, attempts: job.attempts + 1, lease_id: leaseId, lease_until: now + LEASE_MS } };
  });
  if (!claim) return;
  const captionEntities = storedCaptionEntities(claim.job);
  const preparedSafe = captionEntities && inspectRelayDelivery(claim.job.caption, captionEntities,
    { caption: claim.job.caption, caption_entities: captionEntities, reply_markup: { inline_keyboard: relayKeyboard() } }).linksSafe;
  if (!captionEntities || claim.job.caption.length > 1024 || !preparedSafe) {
    transaction(db, () => {
      const error = claim.job.caption.length > 1024 ? CAPTION_LIMIT_ERROR : !claim.job.caption_entities ? LEGACY_CAPTION_ERROR
        : !captionEntities ? CAPTION_DATA_ERROR : CAPTION_UNSAFE_LINKS_ERROR;
      if (ownsSend(db, claim, clock())) db.prepare("UPDATE telegram_relay_outbox SET status='failed',last_error=?,media_bytes=NULL,lease_id='',lease_until=0 WHERE id=? AND lease_id=?")
        .run(error, claim.job.id, claim.job.lease_id);
      db.prepare("UPDATE telegram_relay_state SET send_lease_id='',send_lease_until=0 WHERE id='primary' AND send_lease_id=?").run(claim.job.lease_id);
    });
    return;
  }
  if (!sendAllowed(db, claim, clock())) {
    transaction(db, () => {
      if (ownsSend(db, claim, clock())) db.prepare("UPDATE telegram_relay_outbox SET status='pending',attempts=MAX(0,attempts-1),lease_id='',lease_until=0 WHERE id=? AND lease_id=?")
        .run(claim.job.id, claim.job.lease_id);
      db.prepare("UPDATE telegram_relay_state SET send_lease_id='',send_lease_until=0 WHERE id='primary' AND send_lease_id=?").run(claim.job.lease_id);
    });
    return;
  }
  // Read and hash before sending. Bot downloads are only for cross-source
  // duplicate checks; Bot API still sends its own file_id. Account files must
  // be uploaded because the two Telegram transports have different media IDs.
  let uploadBytes = claim.job.media_bytes ? Buffer.from(claim.job.media_bytes) : null;
  if (!claim.job.media_prepared && claim.job.media_kind !== "video") {
    const bytes = await downloadBotRelayMedia(token, claim.job.file_id, claim.job.media_kind).catch(() => null);
    if (!bytes) {
      transaction(db, () => {
        if (ownsSend(db, claim, clock())) db.prepare(`UPDATE telegram_relay_outbox SET status=?,next_attempt_at=?,last_error=?,lease_id='',lease_until=0
          WHERE id=? AND lease_id=?`).run(claim.job.attempts < MAX_ATTEMPTS ? "pending" : "failed", clock() + VERIFY_MS,
          "暂时无法读取转发图片，稍后重试；未发送消息。", claim.job.id, claim.job.lease_id);
        db.prepare("UPDATE telegram_relay_state SET send_lease_id='',send_lease_until=0,next_send_at=? WHERE id='primary' AND send_lease_id=?")
          .run(clock() + SEND_MS, claim.job.lease_id);
      });
      return;
    }
    const hashes = await relayMediaIdentity(bytes, claim.job.media_kind);
    const accepted = transaction(db, () => {
      if (!sendAllowed(db, claim, clock())) return false;
      if (!registerMedia(db, claim.job.id, identityKeys(claim.job.media_kind, hashes.contentHash, hashes.visualHash))) return false;
      db.prepare("UPDATE telegram_relay_outbox SET content_hash=?,visual_hash=?,media_prepared=1 WHERE id=? AND lease_id=?")
        .run(hashes.contentHash, hashes.visualHash, claim.job.id, claim.job.lease_id);
      return true;
    });
    if (!accepted) {
      transaction(db, () => {
        db.prepare("UPDATE telegram_relay_outbox SET status='cancelled',media_bytes=NULL,lease_id='',lease_until=0 WHERE id=? AND status='sending' AND lease_id=?")
          .run(claim.job.id, claim.job.lease_id);
        db.prepare("UPDATE telegram_relay_state SET send_lease_id='',send_lease_until=0 WHERE id='primary' AND send_lease_id=?").run(claim.job.lease_id);
      });
      return;
    }
  }
  if (!sendAllowed(db, claim, clock()) || (claim.job.origin === "account" && !uploadBytes?.length)) {
    transaction(db, () => {
      db.prepare("UPDATE telegram_relay_outbox SET status='cancelled',media_bytes=NULL,lease_id='',lease_until=0 WHERE id=? AND status='sending' AND lease_id=?")
        .run(claim.job.id, claim.job.lease_id);
      db.prepare("UPDATE telegram_relay_state SET send_lease_id='',send_lease_until=0 WHERE id='primary' AND send_lease_id=?").run(claim.job.lease_id);
    });
    return;
  }
  const videoMime = claim.job.mime_type && /^video\/[a-z0-9.+-]{1,80}$/i.test(claim.job.mime_type) ? claim.job.mime_type.toLowerCase() : "video/mp4";
  const videoAsFile = claim.job.origin === "account" && claim.job.media_kind === "video" && videoMime !== "video/mp4";
  const method = videoAsFile ? "sendDocument" : claim.job.media_kind === "photo" ? "sendPhoto" : claim.job.media_kind === "video" ? "sendVideo" : "sendAnimation";
  const parameters = { chat_id: claim.targetChatId, ...(claim.job.origin !== "account" ? { [claim.job.media_kind]: claim.job.file_id } : {}), caption: claim.job.caption, caption_entities: captionEntities,
    reply_markup: { inline_keyboard: relayKeyboard() }, ...(claim.job.has_spoiler && !videoAsFile ? { has_spoiler: true } : {}),
    ...(method === "sendVideo" ? { supports_streaming: true } : {}) };
  const isGif = uploadBytes && /^GIF8[79]a$/.test(uploadBytes.subarray(0, 6).toString("ascii"));
  const extension = ({ "video/webm": "webm", "video/quicktime": "mov", "video/x-matroska": "mkv" } as Record<string,string>)[videoMime] || "bin";
  const upload = claim.job.origin === "account" && uploadBytes ? { field: videoAsFile ? "document" as const : claim.job.media_kind,
    fileName: claim.job.media_kind === "photo" ? "photo.jpg" : claim.job.media_kind === "video" ? videoAsFile ? `video.${extension}` : "video.mp4" : isGif ? "animation.gif" : "animation.mp4",
    mime: claim.job.media_kind === "photo" ? "image/jpeg" : claim.job.media_kind === "video" ? videoMime : isGif ? "image/gif" : "video/mp4", bytes: uploadBytes } : undefined;
  const reply = await telegramRequest(token, method, parameters, upload).catch(() => null);
  uploadBytes = null;
  transaction(db, () => {
    const now = clock();
    let nextSend = now + SEND_MS;
    const owned = ownsSend(db, claim, now);
    if (owned) {
      if (reply?.ok && typeof reply.result.message_id === "number" && Number.isSafeInteger(reply.result.message_id) && reply.result.message_id > 0) {
        const warning = messageIdentityMatches(reply.result, claim.targetChatId)
          ? deliveryWarning(claim.job.caption, captionEntities, reply.result) : CAPTION_REPLY_TARGET_ERROR;
        auditEmojiDelivery(captionEntities, reply.result.caption_entities, warning ? "changed" : "preserved");
        db.prepare("UPDATE telegram_relay_outbox SET status='sent',sent_at=?,message_id=?,last_error=?,lease_id='',lease_until=0 WHERE id=? AND lease_id=?")
          .run(now, reply.result.message_id, warning, claim.job.id, claim.job.lease_id);
      } else {
        const code = reply && !reply.ok ? reply.code : 0;
        auditEmojiDelivery(captionEntities, undefined, code === 400 || code === 401 || code === 403 ? "rejected" : "uncertain");
        const retry = (code === 429 || code === 403) && claim.job.attempts < MAX_ATTEMPTS;
        if (code === 429 || code === 403) {
          const seconds = reply && !reply.ok ? reply.retryAfter : 0;
          nextSend = Math.min(Number.MAX_SAFE_INTEGER, now + Math.max(code === 403 ? VERIFY_MS : SEND_MS, seconds * 1_000, SEND_MS * 2 ** (claim.job.attempts - 1)));
          const error = code === 403 ? TARGET_ERROR : "Telegram 正在限制图片转发频率，稍后重试。";
          db.prepare("UPDATE telegram_relay_outbox SET status=?,next_attempt_at=?,last_error=?,lease_id='',lease_until=0 WHERE id=? AND lease_id=?")
            .run(retry ? "pending" : "failed", nextSend, error, claim.job.id, claim.job.lease_id);
          if (code === 403) db.prepare("UPDATE telegram_relay_state SET ready_until=0,next_poll_at=MAX(next_poll_at,?),last_error=? WHERE id='primary'")
            .run(nextSend, TARGET_ERROR);
        } else {
          const status = code === 400 || code === 401 ? "failed" : "unknown";
          const error = code === 401 ? TOKEN_ERROR : code === 400
            ? captionEntities.some(entity => entity.type === "custom_emoji") ? CUSTOM_EMOJI_ERROR : "Telegram 拒绝图片转发，请检查目标群或频道权限和图片状态。" : UNCERTAIN;
          db.prepare("UPDATE telegram_relay_outbox SET status=?,last_error=?,lease_id='',lease_until=0 WHERE id=? AND lease_id=?")
            .run(status, error, claim.job.id, claim.job.lease_id);
          if (code === 401 || code === 400) db.prepare("UPDATE telegram_relay_state SET ready_until=0,next_poll_at=MAX(next_poll_at,?),last_error=? WHERE id='primary'")
            .run(now + (code === 401 ? VERIFY_MS : SEND_MS), error);
        }
      }
    }
    db.prepare("UPDATE telegram_relay_outbox SET media_bytes=NULL WHERE id=? AND status NOT IN ('pending','sending')").run(claim.job.id);
    db.prepare(`UPDATE telegram_relay_state SET send_lease_id='',send_lease_until=0,next_send_at=MAX(next_send_at,?)
      WHERE id='primary' AND send_lease_id=?`).run(nextSend, claim.job.lease_id);
  });
}

const workers = globalThis as typeof globalThis & { telegramRelayWorkerStarted?: boolean };
export function startTelegramRelayWorker(decryptToken: DecryptToken) {
  if (workers.telegramRelayWorkerStarted) return;
  workers.telegramRelayWorkerStarted = true;
  void (async () => {
    try {
      const { relayFormattingDiagnostics } = await import("./telegram-relay-diagnostics");
      console.info("Telegram relay formatting audit.", JSON.stringify(relayFormattingDiagnostics(getSqlite(), Date.now(), Date.parse("2026-11-13T11:48:35Z"))));
      if (settings(getSqlite())?.relay_enabled !== 1) return;
      const { sampleSelectedSourceEmoji, inspectConnectedBotEmojiQualification, inspectRecentRelayDeliveries } = await import("./telegram-account");
      for (let attempt = 0; attempt < 6; attempt++) {
        const sample = await sampleSelectedSourceEmoji();
        if (sample.state !== "busy" || attempt === 5) {
          console.info("Telegram relay source emoji audit.", JSON.stringify(sample));
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 5_000));
      }
      let targetKind = "unknown";
      const snapshot = settings(getSqlite());
      const runtime = state(getSqlite());
      if (snapshot && runtime.target_chat_id < 0) {
        let token = "";
        try { token = decryptToken(snapshot.token_ciphertext); } catch { /* No credentials enter diagnostics. */ }
        if (token && botId(token) === runtime.bot_id) {
          const chat = await telegramRequest(token, "getChat", { chat_id: runtime.target_chat_id }).catch(() => null);
          if (chat?.ok && chat.result.id === runtime.target_chat_id && ["group", "supergroup", "channel"].includes(String(chat.result.type))) targetKind = String(chat.result.type);
        }
      }
      for (let attempt = 0; attempt < 6; attempt++) {
        const qualification = await inspectConnectedBotEmojiQualification();
        if (qualification.state !== "busy" || attempt === 5) {
          console.info("Telegram relay emoji qualification audit.", JSON.stringify({ ...qualification, targetKind }));
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 5_000));
      }
      await new Promise(resolve => setTimeout(resolve, 20_000));
      for (let attempt = 0; attempt < 6; attempt++) {
        const readback = await inspectRecentRelayDeliveries();
        if (readback.state !== "busy" || attempt === 5) {
          console.info("Telegram relay delivery readback audit.", JSON.stringify({ state: readback.state,
            sampledPosts: readback.sampledPosts, matchingCaptions: readback.matchingCaptions,
            customEmojiPosts: readback.customEmojiPosts, preservedCustomEmojiPosts: readback.preservedCustomEmojiPosts, safeLinkPosts: readback.safeLinkPosts,
            matchingButtonPosts: readback.matchingButtonPosts, invalidReferences: readback.invalidReferences,
            personalEditQualification: readback.personalEditQualification,
          }));
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 5_000));
      }
    } catch { console.warn("Telegram relay formatting audit is unavailable."); }
  })();
  let polling = false;
  let sending = false;
  let pollError = false;
  let sendError = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try { await pollTelegramRelayOnce(decryptToken); pollError = false; }
    catch { if (!pollError) console.error("Telegram photo relay could not read source updates."); pollError = true; }
    finally { polling = false; }
  };
  const send = async () => {
    if (sending) return;
    sending = true;
    try { await deliverTelegramRelayOnce(decryptToken); sendError = false; }
    catch { if (!sendError) console.error("Telegram photo relay could not process its queue."); sendError = true; }
    finally { sending = false; }
  };
  void poll(); void send();
  setInterval(() => void poll(), POLL_MS).unref();
  setInterval(() => void send(), POLL_MS).unref();
}
