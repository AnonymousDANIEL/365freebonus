import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getAdminPath } from "./auth-core";
import { brandAnnouncementPath } from "./brand-links";
import { getSqlite } from "./sqlite";
import { answerTelegramCallback, telegramRequest, telegramUpdates } from "./telegram-bot";
import { sendTelegramBrandCard, telegramPublicOrigin } from "./telegram-brand-card";
import { readPublicTelegramBrand, searchPublicTelegramBrands } from "./telegram-brand-search";
import { normalizeTelegramKeyword } from "./telegram-keywords";
import { joinGateMenuEnabled, observeJoinGateUpdate, startJoinGateWorker } from "./telegram-join-gate";
import { cancelPrivateFollowupReply, observePrivateFollowupInput, privateFollowupSnapshot, recordPrivateFollowupOutbound, sendDuePrivateFollowups, type FollowupSettings } from "./telegram-followups";

type DecryptToken = (ciphertext: string) => string;
type ChatSettings = FollowupSettings & {
  chat_bot_token_ciphertext: string;
  welcome_enabled: number;
  welcome_chat_id: string;
  welcome_message: string;
  welcome_started_at: number;
  welcome_revision: string;
  keyword_enabled: number;
  keyword_started_at: number;
  private_enabled: number;
  private_started_at: number;
  private_start_message: string;
};
type PollClaim = { revision: string; leaseId: string; offset: number; ciphertext: string };
type PollState = { revision: string; next_offset: number; last_polled_at: number; next_poll_at: number; lease_until: number };
type InlineButton = { text: string } & ({ url: string } | { callback_data: string });
type ChatReply = {
  kind: "welcome" | "keyword" | "private";
  chatId: number;
  text?: string;
  messageId?: number;
  threadId?: number;
  callbackId?: string;
  buttonRuleId?: number;
  brandId?: string;
  followupRevision?: string;
  keyboard?: InlineButton[][];
  privateKeyboardPage?: number;
};

const POLL_MS = 5_000;
const LEASE_MS = 30_000;
const IDLE_CURSOR_MS = 7 * 24 * 60 * 60 * 1_000;
const SLOW_RETRY_MS = 60_000;
const ownedState = "id = 'primary' AND revision = ? AND lease_id = ?";
const RATE_LIMIT_ERROR = "Telegram 正在限制发送频率，稍后重试。";
const INVALID_TOKEN_ERROR = "无法使用 Telegram 机器人 Token，请检查设置。";
const PRIVATE_START_URL = "https://t.me/FreeBonus365ChatBot?start=welcome";
const DEFAULT_PRIVATE_GREETING = "欢迎使用 365 Free Bonus。请选择下方菜单，或直接输入关键词。";
const DEFAULT_PRIVATE_TEXT_GREETING = "欢迎使用 365 Free Bonus。请直接输入关键词。";
const MENU_PAGE_SIZE = 8;
const BRAND_CARD_LEASE_MS = 60_000;

function inTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function readSettings(db: DatabaseSync) {
  return db.prepare(`SELECT chat_bot_token_ciphertext, welcome_enabled, welcome_chat_id, welcome_message,
    welcome_started_at, welcome_revision, keyword_enabled, keyword_started_at,
    private_enabled, private_started_at, private_start_message,
    private_followup_enabled, private_followup_message, private_followup_started_at, private_followup_revision
    FROM telegram_promotion_settings WHERE id = 'primary'`).get() as ChatSettings | undefined;
}

function chatReady(settings: ChatSettings | undefined): settings is ChatSettings {
  if (!settings?.welcome_revision || !settings.chat_bot_token_ciphertext) return false;
  if (settings.private_enabled === 1) return true;
  return /^-[1-9]\d{0,15}$/.test(settings.welcome_chat_id) && Number.isSafeInteger(Number(settings.welcome_chat_id))
    && (settings.welcome_enabled === 1 || settings.keyword_enabled === 1);
}

function claimPoll(db: DatabaseSync, now: number): PollClaim | null {
  return inTransaction(db, () => {
    const settings = readSettings(db);
    if (!chatReady(settings)) return null;
    const revision = settings.welcome_revision;
    let state = db.prepare(`SELECT revision, next_offset, last_polled_at, next_poll_at, lease_until
      FROM telegram_welcome_state WHERE id = 'primary'`).get() as PollState | undefined;
    if (state?.revision !== revision) {
      db.prepare("DELETE FROM telegram_welcome_state WHERE id = 'primary'").run();
      db.prepare("INSERT INTO telegram_welcome_state (id, revision) VALUES ('primary', ?)").run(revision);
      state = undefined;
    }
    if (state && (state.next_poll_at > now || state.lease_until > now)) return null;

    // Telegram may assign a lower, random update ID after a week without updates.
    // Its pending updates expire long before an idle cursor is discarded.
    const offset = state && now - state.last_polled_at < IDLE_CURSOR_MS ? state.next_offset : 0;
    const leaseId = randomUUID();
    db.prepare(`UPDATE telegram_welcome_state SET next_offset = ?, lease_id = ?, lease_until = ?
      WHERE id = 'primary' AND revision = ?`).run(offset, leaseId, now + LEASE_MS, revision);
    return { revision, leaseId, offset, ciphertext: settings.chat_bot_token_ciphertext };
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function membership(value: unknown): boolean | null {
  const member = asRecord(value);
  switch (member?.status) {
    case "member": case "administrator": case "creator": return true;
    case "left": case "kicked": return false;
    case "restricted": return typeof member.is_member === "boolean" ? member.is_member : null;
    default: return null;
  }
}

function shorten(text: string, limit: number) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, "")}…`;
}

function displayText(value: unknown) {
  return typeof value === "string" ? shorten(value.replace(/[\x00-\x1f\x7f]/g, " ").trim(), 128) : "";
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isCurrentEvent(date: unknown, cutoff: number): boolean {
  return positiveInteger(cutoff) && positiveInteger(date) && date >= cutoff;
}

function targetChat(value: unknown, settings: ChatSettings, allowChannel = false): Record<string, unknown> | null {
  const chat = asRecord(value);
  const chatId = Number(settings.welcome_chat_id);
  if (!chat || !Number.isSafeInteger(chatId) || chatId >= 0 || chat.id !== chatId) return null;
  return chat.type === "group" || chat.type === "supergroup" || (allowChannel && chat.type === "channel") ? chat : null;
}

function welcomeReply(db: DatabaseSync, update: Record<string, unknown>, settings: ChatSettings): ChatReply | null {
  if (settings.welcome_enabled !== 1) return null;
  const change = asRecord(update.chat_member);
  if (!change || !isCurrentEvent(change.date, settings.welcome_started_at)) return null;
  const privateEnabled = settings.private_enabled === 1;
  const chat = targetChat(change.chat, settings, privateEnabled);
  if (!chat || membership(change.old_chat_member) !== false || membership(change.new_chat_member) !== true) return null;
  const user = asRecord(asRecord(change.new_chat_member)?.user);
  if (!user || user.is_bot !== false || !positiveInteger(user.id)) return null;
  const name = [displayText(user.first_name), displayText(user.last_name)].filter(Boolean).join(" ") || "新成员";
  const group = displayText(chat.title) || (chat.type === "channel" ? "Telegram 频道" : "Telegram 群组");
  const text = shorten(settings.welcome_message.replace(/\{(name|group)\}/g, (_, key) => key === "name" ? name : group).trim(), 4_096);
  if (!text) return null;
  if (privateEnabled && db.prepare("SELECT 1 FROM telegram_private_contacts WHERE user_id = ?").get(user.id)) {
    return { kind: "welcome", chatId: user.id, text, privateKeyboardPage: 0 };
  }
  if (chat.type === "channel") return null;
  return {
    kind: "welcome", chatId: Number(settings.welcome_chat_id), text,
    keyboard: privateEnabled ? [[{ text: "开启私聊", url: PRIVATE_START_URL }]] : undefined,
  };
}

function originalText(message: Record<string, unknown>): string | null {
  if (message.sender_chat != null || message.forward_origin != null || message.via_bot != null || message.is_automatic_forward === true) return null;
  return typeof message.text === "string" ? message.text : null;
}

function keywordResponse(db: DatabaseSync, text: string): { text: string; showButton: boolean } | null {
  const key = normalizeTelegramKeyword(text);
  if (!key) return null;
  const rule = db.prepare(`SELECT response, show_button FROM telegram_keyword_rules
    WHERE (match_mode = 'exact' AND keyword_key = ?)
      OR (match_mode = 'contains' AND keyword_key <> '' AND instr(?, keyword_key) > 0)
    ORDER BY match_mode = 'exact' DESC, length(keyword_key) DESC, id ASC LIMIT 1`).get(key, key);
  if (typeof rule?.response !== "string" || !rule.response.trim()) return null;
  return { text: shorten(rule.response.trim(), 4_096), showButton: rule.show_button === 1 };
}

function brandSearchReply(db: DatabaseSync, input: string, target: Pick<ChatReply, "kind" | "chatId" | "messageId" | "threadId">, now: number): ChatReply | null {
  const origin = telegramPublicOrigin();
  if (!origin) return null;
  const matches = searchPublicTelegramBrands(db, input, now);
  if (!matches.length) return null;
  if (matches.length === 1) return { ...target, brandId: matches[0].id };
  const keyboard: InlineButton[][] = matches.slice(0, MENU_PAGE_SIZE).map(brand => [{
    text: shorten(brand.name, 64),
    ...(/^[A-Za-z0-9_-]{1,58}$/.test(brand.id)
      ? { callback_data: `brand:${brand.id}` }
      : { url: new URL(brandAnnouncementPath(brand.slug, brand.id, getAdminPath()), origin).href }),
  }]);
  return { ...target, text: `Found ${matches.length} brands. Choose a brand below.${matches.length > MENU_PAGE_SIZE ? " Showing the first 8; type more of the brand name to narrow your search." : ""}`, keyboard };
}

function brandCallbackReply(db: DatabaseSync, update: Record<string, unknown>, settings: ChatSettings, now: number): ChatReply | null {
  const callback = asRecord(update.callback_query);
  const message = asRecord(callback?.message);
  const sender = asRecord(callback?.from);
  if (!callback || !message || !sender || sender.is_bot !== false || !positiveInteger(sender.id)
    || !positiveInteger(message.message_id) || typeof callback.id !== "string" || !callback.id || callback.id.length > 128
    || typeof callback.data !== "string") return null;
  const match = /^brand:([A-Za-z0-9_-]{1,58})$/.exec(callback.data);
  if (!match) return null;
  const privateId = privateChatId(message.chat, sender);
  let target: Pick<ChatReply, "kind" | "chatId" | "messageId" | "threadId">;
  if (privateId !== null && settings.private_enabled === 1 && isCurrentEvent(message.date, settings.private_started_at)) {
    target = { kind: "private", chatId: privateId };
  } else if (settings.keyword_enabled === 1 && targetChat(message.chat, settings) && isCurrentEvent(message.date, settings.keyword_started_at)) {
    target = { kind: "keyword", chatId: Number(settings.welcome_chat_id), messageId: message.message_id,
      threadId: message.is_topic_message === true && positiveInteger(message.message_thread_id) ? message.message_thread_id : undefined };
  } else return null;
  const brand = readPublicTelegramBrand(db, match[1], now);
  return { ...target, callbackId: callback.id, ...(brand
    ? { brandId: brand.id } : { text: "This brand is no longer available. Please search for another brand." }) };
}

function keywordReply(db: DatabaseSync, update: Record<string, unknown>, settings: ChatSettings, now: number): ChatReply | null {
  if (settings.keyword_enabled !== 1) return null;
  const message = asRecord(update.message);
  if (!message || !isCurrentEvent(message.date, settings.keyword_started_at) || !targetChat(message.chat, settings)) return null;
  const sender = asRecord(message.from);
  if (!sender || sender.is_bot !== false || !positiveInteger(sender.id) || !positiveInteger(message.message_id)) return null;
  const input = originalText(message);
  const matched = input && keywordResponse(db, input);
  const threadId = message.is_topic_message === true && positiveInteger(message.message_thread_id) ? message.message_thread_id : undefined;
  const target = { kind: "keyword" as const, chatId: Number(settings.welcome_chat_id), messageId: message.message_id, threadId };
  return matched ? { ...target, text: matched.text } : input ? brandSearchReply(db, input, target, now) : null;
}

function privateChatId(chatValue: unknown, senderValue: unknown): number | null {
  const chat = asRecord(chatValue);
  const sender = asRecord(senderValue);
  if (chat?.type !== "private" || sender?.is_bot !== false || !positiveInteger(sender.id) || chat.id !== sender.id) return null;
  return sender.id;
}

type PrivateReplyMarkup = { remove_keyboard: true } | {
  keyboard: { text: string }[][];
  is_persistent: true;
  resize_keyboard: true;
  one_time_keyboard: false;
};

/** Preserve complete keywords; escape command prefixes so a choice cannot issue /stop. */
function privateKeyboard(db: DatabaseSync, page: number): { page: number; hasButtons: boolean; markup: PrivateReplyMarkup } {
  const rules = db.prepare("SELECT keyword FROM telegram_keyword_rules WHERE show_button = 1 ORDER BY id LIMIT ? OFFSET ?")
    .all(MENU_PAGE_SIZE + 1, page * MENU_PAGE_SIZE) as { keyword: string }[];
  if (page > 0 && !rules.length) return privateKeyboard(db, 0);
  const hotEntry = joinGateMenuEnabled(db);
  if (!rules.length && !hotEntry) return { page: 0, hasButtons: false, markup: { remove_keyboard: true } };
  const buttons = rules.slice(0, MENU_PAGE_SIZE).map(rule => ({ text: rule.keyword.startsWith("/") ? `／${rule.keyword.slice(1)}` : rule.keyword }));
  const keyboard: { text: string }[][] = [];
  for (let index = 0; index < buttons.length; index += 2) keyboard.push(buttons.slice(index, index + 2));
  const navigation: { text: string }[] = [];
  if (page > 0 || rules.length > MENU_PAGE_SIZE) {
    const keywords = new Set((db.prepare("SELECT keyword FROM telegram_keyword_rules").all() as { keyword: string }[])
      .map(rule => normalizeTelegramKeyword(rule.keyword)));
    const label = (direction: string, targetPage: number) => {
      let text = `${direction} › ${targetPage + 1}`;
      while (keywords.has(normalizeTelegramKeyword(text))) text += " ›";
      keywords.add(normalizeTelegramKeyword(text));
      return { text };
    };
    if (page > 0) navigation.push(label("上一页", page - 1));
    if (rules.length > MENU_PAGE_SIZE) navigation.push(label("下一页", page + 1));
  }
  if (navigation.length) keyboard.push(navigation);
  if (hotEntry) keyboard.push([{ text: "🔒 Hot 频道" }]);
  return { page, hasButtons: true, markup: { keyboard, is_persistent: true, resize_keyboard: true, one_time_keyboard: false } };
}

function privateMenu(db: DatabaseSync, settings: ChatSettings, chatId: number, page: number): ChatReply {
  const menu = privateKeyboard(db, page);
  const text = shorten(settings.private_start_message.trim() || (menu.hasButtons ? DEFAULT_PRIVATE_GREETING : DEFAULT_PRIVATE_TEXT_GREETING), 4_096);
  return { kind: "private", chatId, text, privateKeyboardPage: menu.page };
}

function privateButtonReply(db: DatabaseSync, chatId: number, input: string): ChatReply | null {
  const rule = db.prepare("SELECT id,response FROM telegram_keyword_rules WHERE show_button = 1 AND keyword_key = ?")
    .get(normalizeTelegramKeyword(input)) as { id: number; response: string } | undefined;
  if (!rule || typeof rule.response !== "string" || !rule.response.trim()) return null;
  const before = db.prepare("SELECT COUNT(*) AS count FROM telegram_keyword_rules WHERE show_button = 1 AND id < ?")
    .get(rule.id) as { count: number };
  return { kind: "private", chatId, text: shorten(rule.response.trim(), 4_096), buttonRuleId: rule.id,
    privateKeyboardPage: Math.floor(before.count / MENU_PAGE_SIZE) };
}

function callbackReply(db: DatabaseSync, update: Record<string, unknown>, settings: ChatSettings): ChatReply | null {
  const callback = asRecord(update.callback_query);
  const message = asRecord(callback?.message);
  if (!callback || !message || !positiveInteger(message.message_id) || typeof callback.id !== "string" || !callback.id || callback.id.length > 128) return null;
  const chatId = privateChatId(message.chat, callback.from);
  if (chatId === null || typeof callback.data !== "string") return null;
  const action = /^dm:(rule|page):(\d{1,16})$/.exec(callback.data);
  if (!action) return null;
  const id = Number(action[2]);
  if (!Number.isSafeInteger(id)) return null;
  if (action[1] === "page") {
    if (id > Math.floor(Number.MAX_SAFE_INTEGER / MENU_PAGE_SIZE)) return null;
    return { ...privateMenu(db, settings, chatId, id), callbackId: callback.id };
  }
  const rule = db.prepare("SELECT response FROM telegram_keyword_rules WHERE id = ? AND show_button = 1").get(id);
  const text = typeof rule?.response === "string" ? shorten(rule.response.trim(), 4_096) : "";
  return { kind: "private", chatId, text, callbackId: callback.id, buttonRuleId: id, privateKeyboardPage: text ? 0 : undefined };
}

function privateReply(db: DatabaseSync, update: Record<string, unknown>, settings: ChatSettings, now: number): ChatReply | null {
  if (settings.private_enabled !== 1) return null;
  if (update.callback_query) return callbackReply(db, update, settings);
  const message = asRecord(update.message);
  if (!message || !positiveInteger(message.message_id) || !isCurrentEvent(message.date, settings.private_started_at)) return null;
  const chatId = privateChatId(message.chat, message.from);
  if (chatId === null) return null;
  db.prepare(`INSERT OR IGNORE INTO telegram_private_contacts (user_id, updates_enabled, updates_started_at)
    SELECT ?, NOT EXISTS (SELECT 1 FROM telegram_private_followups WHERE chat_id = ? AND opted_out = 1), ?`)
    .run(chatId, chatId, now);
  const input = originalText(message);
  if (!input) return null;
  if (/^\/stop(?:@FreeBonus365ChatBot)?(?:\s|$)/i.test(input.trim())) {
    db.prepare("UPDATE telegram_private_contacts SET updates_enabled = 0 WHERE user_id = ?").run(chatId);
    db.prepare("UPDATE telegram_private_brand_updates SET status = 'cancelled' WHERE user_id = ? AND status = 'pending'").run(chatId);
    return { kind: "private", chatId, text: "已暂停自动跟进和品牌更新通知。发送 /start 可重新开启。" };
  }
  if (/^\/start(?:@FreeBonus365ChatBot)?(?:\s|$)/i.test(input.trim())) {
    db.prepare("UPDATE telegram_private_contacts SET updates_enabled = 1, updates_started_at = ? WHERE user_id = ? AND updates_enabled = 0").run(now, chatId);
    return privateMenu(db, settings, chatId, 0);
  }
  const menuCommand = /^\/menu(?:@FreeBonus365ChatBot)?(?:\s+([1-9]\d{0,15}))?\s*$/i.exec(input.trim());
  if (menuCommand) {
    const page = menuCommand[1] ? Number(menuCommand[1]) - 1 : 0;
    return Number.isSafeInteger(page) && page <= Math.floor(Number.MAX_SAFE_INTEGER / MENU_PAGE_SIZE)
      ? privateMenu(db, settings, chatId, page) : null;
  }
  // A visible menu choice wins over broad or text-only matching rules. Reply
  // keyboard text and manually typed text have the same Telegram semantics.
  const button = privateButtonReply(db, chatId, input);
  if (button) return button;
  const navigation = /^(?:上一页|下一页) › ([1-9]\d{0,15})(?: ›)*$/.exec(input.trim());
  if (navigation && !db.prepare("SELECT 1 FROM telegram_keyword_rules WHERE keyword_key = ?").get(normalizeTelegramKeyword(input))) {
    const page = Number(navigation[1]) - 1;
    return Number.isSafeInteger(page) && page <= Math.floor(Number.MAX_SAFE_INTEGER / MENU_PAGE_SIZE)
      ? privateMenu(db, settings, chatId, page) : null;
  }
  const matched = keywordResponse(db, input);
  return matched ? { kind: "private", chatId, text: matched.text, privateKeyboardPage: matched.showButton ? 0 : undefined }
    : brandSearchReply(db, input, { kind: "private", chatId }, now);
}

function observeFollowupEvent(db: DatabaseSync, settings: ChatSettings, id: number, update: Record<string, unknown>, reply: ChatReply | null, now: number) {
  if (settings.private_enabled !== 1) return;
  // Callback acknowledgments alone are not visible replies. A recognized
  // callback cancels pending followup only when its answer is dispatched below.
  if (update.callback_query) return;
  const message = asRecord(update.message);
  if (!message || !positiveInteger(message.message_id) || !isCurrentEvent(message.date, settings.private_started_at)) return;
  const chatId = privateChatId(message.chat, message.from);
  if (chatId === null || message.sender_chat != null || message.via_bot != null || message.is_automatic_forward === true) return;
  const content = typeof message.text === "string" || ["photo", "animation", "audio", "document", "sticker", "video", "video_note", "voice", "contact", "location"].some(key => message[key] != null);
  if (!content) return;
  const input = originalText(message)?.trim() || "";
  const command = /^\/stop(?:@FreeBonus365ChatBot)?(?:\s|$)/i.test(input) ? "stop"
    : /^\/start(?:@FreeBonus365ChatBot)?(?:\s|$)/i.test(input) ? "start" : undefined;
  observePrivateFollowupInput(db, settings, { chatId, updateId: id, messageId: message.message_id, at: Number(message.date) * 1000, unmatched: !reply, command });
}

function claimUpdate(db: DatabaseSync, claim: PollClaim, id: number, update: Record<string, unknown>, now: number) {
  return inTransaction(db, () => {
    const settings = readSettings(db);
    if (!chatReady(settings) || settings.welcome_revision !== claim.revision) return null;
    // Persist consumption before any send. A crash or an ambiguous reply can
    // lose a welcome, but cannot cause an automatic duplicate.
    const result = db.prepare(`UPDATE telegram_welcome_state SET next_offset = ?, lease_until = ?
      WHERE ${ownedState} AND next_offset <= ?`).run(id + 1, now + LEASE_MS, claim.revision, claim.leaseId, id);
    if (!result.changes) return null;
    if (observeJoinGateUpdate(db, update, id, now)) {
      const gateMessage = asRecord(update.message) ?? asRecord(asRecord(update.callback_query)?.message);
      const gateChat = asRecord(gateMessage?.chat);
      if (gateChat?.type === "private" && positiveInteger(gateChat.id))
        cancelPrivateFollowupReply(db, gateChat.id, privateFollowupSnapshot(db, gateChat.id));
      return { reply: null };
    }
    const reply = welcomeReply(db, update, settings) ?? brandCallbackReply(db, update, settings, now)
      ?? keywordReply(db, update, settings, now) ?? privateReply(db, update, settings, now);
    observeFollowupEvent(db, settings, id, update, reply, now);
    if (reply && reply.chatId > 0) reply.followupRevision = privateFollowupSnapshot(db, reply.chatId);
    return { reply };
  });
}

function finishPoll(db: DatabaseSync, claim: PollClaim, nextPollAt = 0, error: string | null = null, retryOffset: number | null = null) {
  db.prepare(`UPDATE telegram_welcome_state SET lease_id = '', lease_until = 0, next_poll_at = ?,
    last_error = COALESCE(?, last_error), next_offset = COALESCE(?, next_offset)
    WHERE ${ownedState}`).run(nextPollAt, error, retryOffset, claim.revision, claim.leaseId);
}

function retryAt(now: number, seconds: number) {
  return Math.min(Number.MAX_SAFE_INTEGER, now + (seconds > 0 ? Math.max(POLL_MS, seconds * 1_000) : SLOW_RETRY_MS));
}

function replyScopeActive(db: DatabaseSync, claim: PollClaim, action: ChatReply, now: number): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM telegram_welcome_state WHERE ${ownedState} AND lease_until > ?
    AND EXISTS (SELECT 1 FROM telegram_promotion_settings WHERE id = 'primary' AND welcome_revision = ?
      AND ((? > 0 AND private_enabled = 1) OR (? < 0 AND keyword_enabled = 1 AND welcome_chat_id = ?)))`)
    .get(claim.revision, claim.leaseId, now, claim.revision, action.chatId, action.chatId, String(action.chatId)));
}

export async function pollTelegramWelcomeOnce(decryptToken: DecryptToken, clock = Date.now) {
  const db = getSqlite();
  const claim = claimPoll(db, clock());
  if (!claim) return;

  let token = "";
  try { token = decryptToken(claim.ciphertext); } catch { /* Report a redacted error below. */ }
  if (!token) {
    finishPoll(db, claim, clock() + SLOW_RETRY_MS, INVALID_TOKEN_ERROR);
    return;
  }
  const updates = await telegramUpdates(token, claim.offset).catch(() => null);
  if (!updates || !updates.ok) {
    const now = clock();
    if (updates?.code === 429) finishPoll(db, claim, retryAt(now, updates.retryAfter), RATE_LIMIT_ERROR);
    else {
      const error = updates?.code === 409 ? "机器人正由另一项轮询或 Webhook 使用，请检查 Telegram 连接。"
        : updates?.code === 401 ? INVALID_TOKEN_ERROR : "暂时无法读取 Telegram 群组更新，请稍后再试。";
      finishPoll(db, claim, now + (updates?.code === 409 || updates?.code === 401 ? SLOW_RETRY_MS : 3 * POLL_MS), error);
    }
    return;
  }

  const polledAt = clock();
  // An empty successful poll with this offset confirms prior updates upstream.
  const accepted = db.prepare(`UPDATE telegram_welcome_state SET last_polled_at = ?, lease_until = ?,
    next_offset = CASE WHEN ? THEN 0 ELSE next_offset END WHERE ${ownedState}`)
    .run(polledAt, polledAt + LEASE_MS, Number(updates.result.length === 0), claim.revision, claim.leaseId);
  if (!accepted.changes) return;
  const sorted = updates.result.flatMap(update => {
    const id = update.update_id;
    return typeof id === "number" && Number.isSafeInteger(id) && id > 0 && id < Number.MAX_SAFE_INTEGER ? [{ id, update }] : [];
  }).sort((a, b) => a.id - b.id);

  let offset = claim.offset;
  for (const { id, update } of sorted) {
    if (id < offset) continue;
    const delivery = claimUpdate(db, claim, id, update, clock());
    if (!delivery) { finishPoll(db, claim); return; }
    offset = id + 1;
    const action = delivery.reply;
    if (!action) continue;
    if (action.callbackId) {
      await answerTelegramCallback(token, action.callbackId).catch(() => false);
      if (!action.text && !action.brandId) continue;
      const active = replyScopeActive(db, claim, action, clock());
      if (!active) { finishPoll(db, claim); return; }
      // A rule may be hidden or deleted while Telegram acknowledges the click.
      // Do not send an old button's queued answer after that configuration change.
    }
    if (action.buttonRuleId !== undefined) {
      const currentRule = db.prepare("SELECT response FROM telegram_keyword_rules WHERE id = ? AND show_button = 1")
        .get(action.buttonRuleId) as { response: string } | undefined;
      if (!currentRule || typeof currentRule.response !== "string" || !currentRule.response.trim()) continue;
      action.text = shorten(currentRule.response.trim(), 4_096);
    }
    if (!action.text && !action.brandId) continue;
    if (action.chatId > 0) cancelPrivateFollowupReply(db, action.chatId, action.followupRevision);
    const dispatchAt = clock();
    const parameters = action.messageId === undefined ? {} : {
      reply_parameters: { message_id: action.messageId, allow_sending_without_reply: false },
      ...(action.threadId === undefined ? {} : { message_thread_id: action.threadId }),
    };
    let reply;
    if (action.brandId) {
      const origin = telegramPublicOrigin();
      const brand = readPublicTelegramBrand(db, action.brandId, dispatchAt);
      if (!origin || !brand) continue;
      const extended = db.prepare(`UPDATE telegram_welcome_state SET lease_until = ? WHERE ${ownedState}`)
        .run(dispatchAt + BRAND_CARD_LEASE_MS, claim.revision, claim.leaseId);
      if (!extended.changes) { finishPoll(db, claim); return; }
      reply = await sendTelegramBrandCard(token, action.chatId, brand, origin, {
        parameters,
        beforeSend: () => replyScopeActive(db, claim, action, clock())
          && readPublicTelegramBrand(db, brand.id, clock()) !== null,
      }).catch(() => null);
      if (reply === undefined) continue;
    } else {
      reply = await telegramRequest(token, "sendMessage", {
        ...parameters, chat_id: action.chatId, text: action.text, link_preview_options: { is_disabled: true },
        ...(action.chatId > 0 && action.privateKeyboardPage !== undefined
          ? { reply_markup: privateKeyboard(db, action.privateKeyboardPage).markup }
          : action.keyboard?.length ? { reply_markup: { inline_keyboard: action.keyboard } } : {}),
      }).catch(() => null);
    }
    if (reply?.ok && Number.isSafeInteger(reply.result.message_id)) {
      if (action.chatId > 0) {
        const date = reply.result.date;
        inTransaction(db, () => recordPrivateFollowupOutbound(db, action.chatId, Number(reply.result.message_id),
          typeof date === "number" && Number.isSafeInteger(date) && date > 0 ? date * 1000 : dispatchAt));
      }
      db.prepare(`UPDATE telegram_welcome_state SET sent = sent + ?, keyword_replies = keyword_replies + ?,
        private_replies = private_replies + ?, last_error = '' WHERE ${ownedState}`)
        .run(Number(action.kind === "welcome"), Number(action.kind === "keyword"), Number(action.kind === "private"), claim.revision, claim.leaseId);
    } else if (reply && !reply.ok && reply.code === 429) {
      // This request was rejected. Telegram still holds the update until the
      // next poll acknowledges it, so retry its ID after the specified delay.
      finishPoll(db, claim, retryAt(clock(), reply.retryAfter), RATE_LIMIT_ERROR, id);
      return;
    } else {
      const code = reply && !reply.ok ? reply.code : 0;
      if (code === 403 && action.chatId > 0) {
        db.prepare(`DELETE FROM telegram_private_contacts WHERE user_id = ?
          AND EXISTS (SELECT 1 FROM telegram_welcome_state WHERE ${ownedState})`).run(action.chatId, claim.revision, claim.leaseId);
        continue;
      }
      const label = action.kind === "welcome" ? "欢迎消息" : action.kind === "private" ? "私聊回复" : "关键词回复";
      const error = code === 401 ? INVALID_TOKEN_ERROR
        : code === 400 || code === 403 ? `Telegram 拒绝发送${label}，请检查群组和机器人权限。`
        : `Telegram 未确认${label}的发送结果，该消息不会自动重发。`;
      finishPoll(db, claim, clock() + (code === 401 || code === 403 ? SLOW_RETRY_MS : POLL_MS), error);
      return;
    }
  }
  if (updates.result.length === 0) await sendDuePrivateFollowups(db, claim, token, clock, 1);
  finishPoll(db, claim);
}

const workers = globalThis as typeof globalThis & { telegramWelcomeWorkerStarted?: boolean };

export function startTelegramWelcomeWorker(decryptToken: DecryptToken) {
  if (workers.telegramWelcomeWorkerStarted) return;
  workers.telegramWelcomeWorkerStarted = true;
  startJoinGateWorker(decryptToken);
  let running = false;
  let reportedError = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await pollTelegramWelcomeOnce(decryptToken);
      reportedError = false;
    } catch {
      if (!reportedError) console.error("Telegram welcome worker could not check group updates.");
      reportedError = true;
    } finally { running = false; }
  };
  void tick();
  setInterval(() => void tick(), POLL_MS).unref();
}
