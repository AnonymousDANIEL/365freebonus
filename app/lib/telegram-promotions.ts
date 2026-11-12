import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getSqlite } from "./sqlite";
import { telegramRequest } from "./telegram-bot";
import { sendTelegramBrandCard, telegramPublicOrigin } from "./telegram-brand-card";
import { startTelegramWelcomeWorker } from "./telegram-welcome";

type StoredSettings = {
  enabled: number;
  chat_id: string;
  token_ciphertext: string;
  chat_bot_token_ciphertext: string;
  promotion_message: string;
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
  private_followup_enabled: number;
  private_followup_message: string;
  private_followup_started_at: number;
  private_followup_revision: string;
};
type SettingsInput = {
  enabled: boolean;
  chatId: string;
  token?: string;
  promotionMessage?: string;
  welcome?: { enabled: boolean; chatId: string; message: string };
  chatBot?: { token?: string; keywordEnabled: boolean; privateEnabled?: boolean; privateStartMessage?: string; followup?: { enabled: boolean; message: string } };
};
type DeliveryStatus = "pending" | "sending" | "sent" | "failed" | "unknown" | "skipped";
type Delivery = {
  brand_id: string;
  revision: string;
  attempts: number;
  name: string;
  slug: string;
  tagline: string;
  description: string;
  link: string;
  category: "Update" | "New";
  image_url: string;
};

const TOKEN_FORMAT = /^[1-9]\d{0,15}:[A-Za-z0-9_-]{20,128}$/;
const USERNAME_FORMAT = /^@[A-Za-z0-9_]{1,32}$/;
const PUBLIC_LINK_FORMAT = /^https:\/\/(?:t|telegram)\.me\/([A-Za-z0-9_]{1,32})\/?$/i;
const PRIVATE_INVITE_FORMAT = /^(?:https?:\/\/(?:t|telegram)\.me\/(?:\+|%2b|joinchat(?:\/|$))|tg:\/\/join(?:\?|$))/i;
const POLL_MS = 5_000;
const LEASE_MS = 45_000;
const MAX_ATTEMPTS = 5;
const RATE_LIMIT_ERROR = "Telegram 正在限制发送频率，稍后重试。";
const UNCERTAIN_ERROR = "Telegram 未确认发送结果，已停止自动重试以避免重复。";
const EXPIRED_ERROR = "活动已结束，公告未发送。";
const KEY_CONTEXT = "365freebonus:telegram-promotion-token:v1";
const PROMOTION_BOT = "FreeBonus365Bot";
const CHAT_BOT = "FreeBonus365ChatBot";

export class TelegramSettingsError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function encryptionKey() {
  const secret = process.env.SESSION_SECRET || "";
  if (secret.length < 32) throw new TelegramSettingsError("服务器尚未配置 Telegram Token 加密，请联系网站管理员。", 503);
  return createHmac("sha256", secret).update(KEY_CONTEXT).digest();
}

function encryptToken(token: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(KEY_CONTEXT));
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${ciphertext.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
}

function decryptToken(stored: string) {
  const [version, iv, ciphertext, tag] = stored.split(".");
  if (version !== "v1" || !iv || !ciphertext || !tag) return "";
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(KEY_CONTEXT));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const token = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
    return TOKEN_FORMAT.test(token) ? token : "";
  } catch { return ""; }
}

function storedSettings(db: DatabaseSync): StoredSettings {
  return db.prepare(`SELECT enabled, chat_id, token_ciphertext, chat_bot_token_ciphertext, promotion_message, welcome_enabled,
    welcome_chat_id, welcome_message, welcome_started_at, welcome_revision, keyword_enabled, keyword_started_at,
    private_enabled, private_started_at, private_start_message,
    private_followup_enabled, private_followup_message, private_followup_started_at, private_followup_revision
    FROM telegram_promotion_settings WHERE id = 'primary'`).get() as StoredSettings | undefined
    ?? {
      enabled: 0, chat_id: "", token_ciphertext: "", chat_bot_token_ciphertext: "", promotion_message: "",
      welcome_enabled: 0, welcome_chat_id: "", welcome_message: "", welcome_started_at: 0, welcome_revision: "",
      keyword_enabled: 0, keyword_started_at: 0,
      private_enabled: 0, private_started_at: 0, private_start_message: "",
      private_followup_enabled: 0, private_followup_message: "", private_followup_started_at: 0, private_followup_revision: "",
    };
}

function writeTransaction<T>(db: DatabaseSync, write: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = write();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}


function validChatId(chatId: string) {
  return /^-[1-9]\d{0,15}$/.test(chatId) && Number.isSafeInteger(Number(chatId));
}

function normalizeChatTarget(value: string) {
  const target = value.trim();
  if (!target || validChatId(target) || USERNAME_FORMAT.test(target)) return target;
  if (PRIVATE_INVITE_FORMAT.test(target)) {
    throw new TelegramSettingsError("私密邀请链接不能用于自动发送。请把机器人加入群组或频道，并填写该群组或频道的负数 Chat ID。");
  }
  const publicLink = PUBLIC_LINK_FORMAT.exec(target);
  if (publicLink) return `@${publicLink[1]}`;
  throw new TelegramSettingsError("请输入负数 Chat ID、@用户名，或群组和频道的公开 t.me 链接。");
}

async function verifyBot(token: string, expectedUsername: string) {
  const bot = await telegramRequest(token, "getMe");
  if (!bot || (!bot.ok && (bot.code >= 500 || bot.code === 429))) {
    throw new TelegramSettingsError("暂时无法连接 Telegram 验证机器人，请稍后再试。", 503);
  }
  if (!bot.ok || bot.result.is_bot !== true || typeof bot.result.id !== "number" || !Number.isSafeInteger(bot.result.id)) {
    throw new TelegramSettingsError(`Telegram 无法验证 @${expectedUsername} 的 Token，请核对后重试。`);
  }
  if (typeof bot.result.username !== "string" || bot.result.username.toLowerCase() !== expectedUsername.toLowerCase()) {
    throw new TelegramSettingsError(`请填写 @${expectedUsername} 的 Token。`);
  }
  return bot.result.id;
}

async function verifyChatBotUpdates(token: string) {
  const webhook = await telegramRequest(token, "getWebhookInfo");
  if (!webhook?.ok || typeof webhook.result.url !== "string") {
    throw new TelegramSettingsError("暂时无法检查 Telegram 机器人的接收方式，请稍后再试。", 503);
  }
  if (webhook.result.url) {
    throw new TelegramSettingsError("ChatBot 已连接到其他 Webhook，请先解除该连接再启用自动回复。");
  }
}

async function verifyChat(token: string, chatId: string, username: string, allowChannelWelcome = false): Promise<string> {
  const isChatBot = username === CHAT_BOT;
  const target = validChatId(chatId) ? Number(chatId) : chatId;
  const [botId, chat] = await Promise.all([
    verifyBot(token, username),
    telegramRequest(token, "getChat", { chat_id: target }),
    isChatBot ? verifyChatBotUpdates(token) : null,
  ]);
  if (!chat || (!chat.ok && (chat.code >= 500 || chat.code === 429))) {
    throw new TelegramSettingsError("暂时无法连接 Telegram 验证机器人和发送目标，请稍后再试。", 503);
  }
  if (!chat.ok) {
    throw new TelegramSettingsError("Telegram 找不到这个发送目标。请核对公开链接或 Chat ID，并确认机器人已加入目标群组或频道。");
  }
  const chatType = chat.result.type;
  if (isChatBot && chatType !== "group" && chatType !== "supergroup" && !(allowChannelWelcome && chatType === "channel")) {
    throw new TelegramSettingsError("群内关键词回复需要 Telegram 群组。频道欢迎请选择 1 对 1 私聊，并关闭群内关键词回复。");
  }
  if (!["group", "supergroup", "channel"].includes(String(chatType))) {
    throw new TelegramSettingsError("公告只能发送到 Telegram 群组或频道。个人帐号和机器人不能作为发送目标。");
  }
  if (!validChatId(String(chat.result.id))) {
    throw new TelegramSettingsError("Telegram 未返回有效的群组或频道 Chat ID，请核对发送目标。");
  }
  const member = await telegramRequest(token, "getChatMember", { chat_id: chat.result.id, user_id: botId });
  if (!member || (!member.ok && (member.code >= 500 || member.code === 429))) {
    throw new TelegramSettingsError("暂时无法检查 Telegram 发送权限，请稍后再试。", 503);
  }
  if (isChatBot) {
    if (!member.ok || !["creator", "administrator"].includes(String(member.result.status))) {
      throw new TelegramSettingsError(`请先将 @${CHAT_BOT} 设为目标${chatType === "channel" ? "频道" : "群组"}的管理员。`);
    }
    return String(chat.result.id);
  }
  if (chatType === "channel") {
    const canPost = member.ok && (member.result.status === "creator"
      || (member.result.status === "administrator" && member.result.can_post_messages === true));
    if (!canPost) throw new TelegramSettingsError("请将机器人设为 Telegram 频道管理员，并开启「发布消息」权限。");
    return String(chat.result.id);
  }
  if (!member.ok) throw new TelegramSettingsError("请将机器人加入 Telegram 群组，并允许它发送消息。");
  const permissions = chat.result.permissions as { can_send_messages?: boolean } | undefined;
  const canSend = ["creator", "administrator"].includes(String(member.result.status))
    || (member.result.status === "member" && permissions?.can_send_messages === true)
    || (member.result.status === "restricted" && member.result.is_member === true && member.result.can_send_messages === true);
  if (!canSend) throw new TelegramSettingsError("请将机器人加入 Telegram 群组，并允许它发送消息。");
  // Bind the public username to its verified numeric Chat ID.
  return String(chat.result.id);
}

export function telegramPromotionStatus() {
  const db = getSqlite();
  const settings = storedSettings(db);
  const counts: Record<DeliveryStatus, number> = { pending: 0, sending: 0, sent: 0, failed: 0, unknown: 0, skipped: 0 };
  const rows = db.prepare("SELECT status, COUNT(*) AS count FROM telegram_promotion_outbox GROUP BY status").all() as { status: DeliveryStatus; count: number }[];
  for (const row of rows) counts[row.status] = row.count;
  const recent = db.prepare("SELECT last_error FROM telegram_promotion_outbox WHERE last_error <> '' ORDER BY next_attempt_at DESC LIMIT 1").get() as { last_error: string } | undefined;
  const welcome = db.prepare("SELECT sent, keyword_replies, private_replies, last_polled_at, last_error FROM telegram_welcome_state WHERE id = 'primary' AND revision = ?")
    .get(settings.welcome_revision) as { sent: number; keyword_replies: number; private_replies: number; last_polled_at: number; last_error: string } | undefined;
  const chatEnabled = settings.welcome_enabled || settings.keyword_enabled || settings.private_enabled;
  const followupCounts = { pending: 0, sent: 0, failed: 0, unknown: 0, cancelled: 0 };
  const followupRows = db.prepare("SELECT status, COUNT(*) AS count FROM telegram_private_followups GROUP BY status").all() as { status: string; count: number }[];
  for (const row of followupRows) {
    const status = row.status === "sending" ? "pending" : row.status;
    if (status in followupCounts) followupCounts[status as keyof typeof followupCounts] += row.count;
  }
  const followupError = db.prepare("SELECT last_error FROM telegram_private_followups WHERE last_error <> '' ORDER BY next_attempt_at DESC, chat_id DESC LIMIT 1").get() as { last_error: string } | undefined;
  let lastError = recent?.last_error || "";
  if (settings.enabled && !decryptToken(settings.token_ciphertext)) lastError = "无法读取已保存的机器人 Token，请重新填写。";
  else if (settings.enabled && !telegramPublicOrigin()) lastError = "服务器尚未配置公开网站地址，无法生成公告链接。";
  return {
    enabled: settings.enabled === 1, chatId: settings.chat_id, hasToken: Boolean(settings.token_ciphertext), counts, lastError,
    promotionMessage: settings.promotion_message,
    chatBot: {
      hasToken: Boolean(settings.chat_bot_token_ciphertext), keywordEnabled: settings.keyword_enabled === 1,
      keywordReplies: welcome?.keyword_replies ?? 0,
      privateEnabled: settings.private_enabled === 1,
      privateStartMessage: settings.private_start_message,
      privateReplies: welcome?.private_replies ?? 0,
      followup: {
        enabled: settings.private_followup_enabled === 1,
        message: settings.private_followup_message,
        delayMinutes: 60,
        counts: followupCounts,
        lastError: followupError?.last_error || "",
      },
    },
    welcome: {
      enabled: settings.welcome_enabled === 1, chatId: settings.welcome_chat_id, message: settings.welcome_message,
      sent: welcome?.sent ?? 0, lastPolledAt: welcome?.last_polled_at || null,
      lastError: chatEnabled && !decryptToken(settings.chat_bot_token_ciphertext)
        ? `无法读取 @${CHAT_BOT} 的 Token，请重新填写。` : welcome?.last_error || "",
    },
  };
}

export async function saveTelegramPromotionSettings(input: SettingsInput) {
  const db = getSqlite();
  const previous = storedSettings(db);
  const newToken = input.token?.trim() || "";
  const newChatToken = input.chatBot?.token?.trim() || "";
  if (newToken && !TOKEN_FORMAT.test(newToken)) throw new TelegramSettingsError(`请输入完整的 @${PROMOTION_BOT} Token。`);
  if (newChatToken && !TOKEN_FORMAT.test(newChatToken)) throw new TelegramSettingsError(`请输入完整的 @${CHAT_BOT} Token。`);
  const previousToken = decryptToken(previous.token_ciphertext);
  const previousChatToken = decryptToken(previous.chat_bot_token_ciphertext);
  const tokenChanged = Boolean(newToken && newToken !== previousToken);
  const chatTokenChanged = Boolean(newChatToken && newChatToken !== previousChatToken);
  const token = newToken || previousToken;
  const chatToken = newChatToken || previousChatToken;
  const chatBotId = chatToken.split(":", 1)[0];
  if (token && chatToken && token.split(":", 1)[0] === chatBotId) {
    throw new TelegramSettingsError("品牌通知和 ChatBot 需要分别填写两个不同机器人的 Token。");
  }
  let chatId = normalizeChatTarget(input.chatId);
  const promotionMessage = input.promotionMessage?.trim() ?? previous.promotion_message;
  const welcomeEnabled = input.welcome?.enabled ?? (previous.welcome_enabled === 1);
  const keywordEnabled = input.chatBot?.keywordEnabled ?? (previous.keyword_enabled === 1);
  const privateEnabled = input.chatBot?.privateEnabled ?? (previous.private_enabled === 1);
  const privateStartMessage = input.chatBot?.privateStartMessage?.trim() ?? previous.private_start_message;
  const followupEnabled = input.chatBot?.followup?.enabled ?? (privateEnabled && previous.private_followup_enabled === 1);
  const followupMessage = input.chatBot?.followup?.message.trim() ?? previous.private_followup_message;
  if (followupEnabled && !privateEnabled) throw new TelegramSettingsError("请先启用 1 对 1 私聊，再开启未识别消息跟进。");
  if (followupEnabled && !followupMessage) throw new TelegramSettingsError("请输入未识别消息的跟进文案。");
  if (followupMessage.length > 2_000) throw new TelegramSettingsError("跟进文案最多 2000 个字符。");
  const targetEnabled = welcomeEnabled || keywordEnabled;
  const chatEnabled = targetEnabled || privateEnabled;
  const welcomeMessage = input.welcome?.message.trim() ?? previous.welcome_message;
  let welcomeChatId = input.welcome ? normalizeChatTarget(input.welcome.chatId) : previous.welcome_chat_id;
  if (input.enabled && !token) throw new TelegramSettingsError(`请填写 @${PROMOTION_BOT} 的 Token。`);
  if (chatEnabled && !chatToken) throw new TelegramSettingsError(`请填写 @${CHAT_BOT} 的 Token。`);
  if (targetEnabled && !welcomeChatId) {
    throw new TelegramSettingsError("请填写 ChatBot 的欢迎目标或关键词回复群组。");
  }
  if (welcomeEnabled && !welcomeMessage) {
    throw new TelegramSettingsError("请输入欢迎消息内容。");
  }
  if (input.enabled) {
    if (!chatId) throw new TelegramSettingsError("请填写 Telegram 群组或频道的 Chat ID、@用户名或公开链接。");
    if (!telegramPublicOrigin()) throw new TelegramSettingsError("服务器尚未配置公开网站地址，无法生成公告链接。", 503);
  }
  const previouslyTargetEnabled = previous.welcome_enabled || previous.keyword_enabled;
  const privateModeChanged = privateEnabled !== (previous.private_enabled === 1);
  const followupChanged = followupEnabled !== (previous.private_followup_enabled === 1)
    || followupMessage !== previous.private_followup_message || privateModeChanged || chatTokenChanged;
  const channelWelcome = welcomeEnabled && privateEnabled && !keywordEnabled;
  const previouslyChannelWelcome = previous.welcome_enabled === 1 && previous.private_enabled === 1 && previous.keyword_enabled === 0;
  const validateTarget = targetEnabled && (!previouslyTargetEnabled || welcomeChatId !== previous.welcome_chat_id
    || chatTokenChanged || channelWelcome !== previouslyChannelWelcome);
  const chatVerification = validateTarget ? verifyChat(chatToken, welcomeChatId, CHAT_BOT, channelWelcome)
    : privateEnabled && (privateModeChanged || chatTokenChanged)
      ? Promise.all([verifyBot(chatToken, CHAT_BOT), verifyChatBotUpdates(chatToken)])
      : chatTokenChanged ? verifyBot(chatToken, CHAT_BOT) : null;
  const [verifiedChat, verifiedChatBotGroup] = await Promise.all([
    input.enabled && (!previous.enabled || chatId !== previous.chat_id || tokenChanged)
      ? verifyChat(token, chatId, PROMOTION_BOT) : tokenChanged ? verifyBot(token, PROMOTION_BOT) : null,
    chatVerification,
  ]);
  if (typeof verifiedChat === "string") chatId = verifiedChat;
  if (typeof verifiedChatBotGroup === "string") welcomeChatId = verifiedChatBotGroup;
  const ciphertext = tokenChanged ? encryptToken(newToken) : previous.token_ciphertext;
  const chatCiphertext = chatTokenChanged ? encryptToken(newChatToken) : previous.chat_bot_token_ciphertext;
  const groupChanged = welcomeChatId !== previous.welcome_chat_id;
  writeTransaction(db, () => {
    const current = storedSettings(db);
    if ((Object.keys(previous) as (keyof StoredSettings)[]).some(key => current[key] !== previous[key])) {
      throw new TelegramSettingsError("Telegram 设置已更新，请刷新后再保存。", 409);
    }
    if (input.enabled && (!current.enabled || current.chat_id !== chatId)) {
      // Only upcoming or unpublished promotions should start posting in a new connection.
      db.prepare(`UPDATE telegram_promotion_outbox SET status='skipped', last_error='', next_attempt_at=0
        WHERE status='pending' AND brand_id IN (
          SELECT id FROM brands WHERE published=1 AND (promotion_starts_at IS NULL OR promotion_starts_at < ?)
        )`).run(Date.now());
    }
    // Keep the Telegram cursor for the same bot across group edits and toggles.
    if (chatTokenChanged) {
      db.prepare("DELETE FROM telegram_welcome_state WHERE id = 'primary'").run();
      if (chatBotId !== previousChatToken.split(":", 1)[0]) db.exec("DELETE FROM telegram_private_contacts");
    }
    const now = Math.floor(Date.now() / 1_000);
    const welcomeStartedAt = welcomeEnabled ? (!current.welcome_enabled || groupChanged || chatTokenChanged || privateModeChanged ? now : current.welcome_started_at) : 0;
    const keywordStartedAt = keywordEnabled ? (!current.keyword_enabled || groupChanged || chatTokenChanged ? now : current.keyword_started_at) : 0;
    const privateStartedAt = privateEnabled ? (!current.private_enabled || chatTokenChanged ? now : current.private_started_at) : 0;
    const followupStartedAt = followupEnabled ? (followupChanged ? now : current.private_followup_started_at) : 0;
    const followupRevision = followupChanged ? randomUUID() : current.private_followup_revision;
    if (followupChanged) {
      db.prepare(`UPDATE telegram_private_followups SET status='cancelled', due_at=0, next_attempt_at=0,
        lease_id='', lease_until=0, last_error='' WHERE status IN ('pending','sending')`).run();
      if (chatTokenChanged && chatBotId !== previousChatToken.split(":", 1)[0]) db.exec("DELETE FROM telegram_private_followups");
    }
    let welcomeRevision = chatTokenChanged ? "" : current.welcome_revision;
    if (chatEnabled && !welcomeRevision) welcomeRevision = randomUUID();
    db.prepare(`INSERT INTO telegram_promotion_settings (
      id, enabled, chat_id, token_ciphertext, promotion_message, welcome_enabled,
      welcome_chat_id, welcome_message, welcome_started_at, welcome_revision,
      chat_bot_token_ciphertext, keyword_enabled, keyword_started_at, private_enabled, private_started_at, private_start_message,
      private_followup_enabled, private_followup_message, private_followup_started_at, private_followup_revision
    ) VALUES ('primary', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, chat_id = excluded.chat_id,
      token_ciphertext = excluded.token_ciphertext, promotion_message = excluded.promotion_message,
      welcome_enabled = excluded.welcome_enabled, welcome_chat_id = excluded.welcome_chat_id,
      welcome_message = excluded.welcome_message, welcome_started_at = excluded.welcome_started_at,
      welcome_revision = excluded.welcome_revision, chat_bot_token_ciphertext = excluded.chat_bot_token_ciphertext,
      keyword_enabled = excluded.keyword_enabled, keyword_started_at = excluded.keyword_started_at,
      private_enabled = excluded.private_enabled, private_started_at = excluded.private_started_at,
      private_start_message = excluded.private_start_message,
      private_followup_enabled = excluded.private_followup_enabled,
      private_followup_message = excluded.private_followup_message,
      private_followup_started_at = excluded.private_followup_started_at,
      private_followup_revision = excluded.private_followup_revision`)
      .run(Number(input.enabled), chatId, ciphertext, promotionMessage, Number(welcomeEnabled),
        welcomeChatId, welcomeMessage, welcomeStartedAt, welcomeRevision, chatCiphertext, Number(keywordEnabled), keywordStartedAt,
        Number(privateEnabled), privateStartedAt, privateStartMessage,
        Number(followupEnabled), followupMessage, followupStartedAt, followupRevision);
  });
  return telegramPromotionStatus();
}

function claimDelivery(db: DatabaseSync) {
  return writeTransaction(db, () => {
    const now = Date.now();
    db.prepare(`UPDATE telegram_promotion_outbox SET status = 'unknown', last_error = ?, next_attempt_at = ?
      WHERE status = 'sending' AND next_attempt_at <= ?`).run(UNCERTAIN_ERROR, now, now);
    db.prepare(`UPDATE telegram_promotion_outbox SET status = 'failed', last_error = ?, next_attempt_at = ?
      WHERE status = 'pending' AND brand_id IN (SELECT id FROM brands WHERE promotion_expires_at <= ?)
        AND (last_error <> ? OR next_attempt_at <= ?)`).run(EXPIRED_ERROR, now, now, RATE_LIMIT_ERROR, now);

    const settings = storedSettings(db);
    const origin = telegramPublicOrigin();
    if (!settings.enabled || !validChatId(settings.chat_id) || !origin) return null;
    const token = decryptToken(settings.token_ciphertext);
    if (!token) return null;
    const blocked = db.prepare(`SELECT 1 FROM telegram_promotion_outbox WHERE next_attempt_at > ?
      AND (status = 'sending' OR last_error = ?) LIMIT 1`).get(now, RATE_LIMIT_ERROR);
    if (blocked) return null;
    const row = db.prepare(`SELECT o.brand_id, o.revision, o.attempts, b.name, b.slug, b.tagline, b.description, b.link, b.category, b.image_url
      FROM telegram_promotion_outbox o JOIN brands b ON b.id = o.brand_id
      WHERE o.status = 'pending' AND o.next_attempt_at <= ? AND b.published = 1 AND b.category IN ('Update', 'New')
        AND (b.publish_at IS NULL OR b.publish_at <= ?)
        AND (b.promotion_starts_at IS NULL OR b.promotion_starts_at <= ?) AND b.promotion_expires_at > ?
      ORDER BY o.next_attempt_at, o.rowid LIMIT 1`).get(now, now, now, now) as Delivery | undefined;
    if (!row) return null;
    db.prepare(`UPDATE telegram_promotion_outbox SET status = 'sending', attempts = attempts + 1, next_attempt_at = ?, last_error = ''
      WHERE brand_id = ? AND revision = ?`).run(now + LEASE_MS, row.brand_id, row.revision);
    return { ...row, attempts: row.attempts + 1, token, chatId: Number(settings.chat_id), origin, message: settings.promotion_message };
  });
}


export async function deliverTelegramPromotionOnce() {
  const db = getSqlite();
  const delivery = claimDelivery(db);
  if (!delivery) return;
  const response = await sendTelegramBrandCard(delivery.token, delivery.chatId, {
    id: delivery.brand_id, name: delivery.name, slug: delivery.slug, category: delivery.category,
    tagline: delivery.tagline, description: delivery.description, link: delivery.link, imageUrl: delivery.image_url,
  }, delivery.origin, { template: delivery.message });
  const now = Date.now();
  const finish = (status: DeliveryStatus, lastError = "", nextAttemptAt = now, messageId: number | null = null) => {
    db.prepare(`UPDATE telegram_promotion_outbox SET status = ?, next_attempt_at = ?, last_error = ?, sent_at = ?, message_id = ?
      WHERE brand_id = ? AND revision = ? AND status = 'sending' AND attempts = ?`)
      .run(status, nextAttemptAt, lastError, status === "sent" ? now : null, messageId, delivery.brand_id, delivery.revision, delivery.attempts);
  };
  if (!response) { finish("unknown", UNCERTAIN_ERROR); return; }
  if (response.ok) {
    const id = response.result.message_id;
    if (typeof id === "number" && Number.isSafeInteger(id)) finish("sent", "", now, id);
    else finish("unknown", UNCERTAIN_ERROR);
    return;
  }
  const limited = response.code === 429;
  if (limited || response.code >= 500) {
    const delay = Math.max(10_000 * 2 ** (delivery.attempts - 1), response.retryAfter * 1_000);
    const retry = delivery.attempts < MAX_ATTEMPTS;
    const message = limited ? RATE_LIMIT_ERROR : retry ? "Telegram 暂时拒绝发送，稍后重试。" : "Telegram 暂时无法发送，已达重试上限。";
    finish(retry ? "pending" : "failed", message, Math.min(Number.MAX_SAFE_INTEGER, now + delay));
    return;
  }
  const message = [400, 403].includes(response.code) ? "请检查机器人在 Telegram 群组或频道的发送权限。"
    : response.code === 401 ? "Telegram 机器人 Token 已失效，请更新设置。"
    : "Telegram 拒绝发送这条公告，请检查群组或频道设置。";
  finish("failed", message);
}

const workers = globalThis as typeof globalThis & { telegramPromotionWorkerStarted?: boolean };

export function startTelegramPromotionWorker() {
  if (workers.telegramPromotionWorkerStarted) return;
  workers.telegramPromotionWorkerStarted = true;
  startTelegramWelcomeWorker(decryptToken);
  let running = false;
  let reportedError = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await deliverTelegramPromotionOnce();
      reportedError = false;
    } catch {
      if (!reportedError) console.error("Telegram promotion worker could not process its outbox.");
      reportedError = true;
    } finally { running = false; }
  };
  void tick();
  setInterval(() => void tick(), POLL_MS).unref();
}
