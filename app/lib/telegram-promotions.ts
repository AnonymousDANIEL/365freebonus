import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getSqlite } from "./sqlite";
import { telegramRequest } from "./telegram-bot";

type StoredSettings = { enabled: number; chat_id: string; token_ciphertext: string };
type SettingsInput = { enabled: boolean; chatId: string; token?: string };
type DeliveryStatus = "pending" | "sending" | "sent" | "failed" | "unknown" | "skipped";
type Delivery = {
  brand_id: string;
  revision: string;
  attempts: number;
  name: string;
  tagline: string;
  category: "Update" | "New";
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
  return db.prepare("SELECT enabled, chat_id, token_ciphertext FROM telegram_promotion_settings WHERE id = 'primary'").get() as StoredSettings | undefined
    ?? { enabled: 0, chat_id: "", token_ciphertext: "" };
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

function publicOrigin() {
  const url = process.env.APP_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "");
  try {
    const origin = new URL(url);
    return ["https:", "http:"].includes(origin.protocol) && !origin.username && !origin.password ? origin.origin : "";
  } catch { return ""; }
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

async function verifyChat(token: string, chatId: string): Promise<string> {
  const target = validChatId(chatId) ? Number(chatId) : chatId;
  const [bot, chat] = await Promise.all([telegramRequest(token, "getMe"), telegramRequest(token, "getChat", { chat_id: target })]);
  if (!bot || !chat || (!bot.ok && (bot.code >= 500 || bot.code === 429)) || (!chat.ok && (chat.code >= 500 || chat.code === 429))) {
    throw new TelegramSettingsError("暂时无法连接 Telegram 验证机器人和发送目标，请稍后再试。", 503);
  }
  if (!bot.ok || bot.result.is_bot !== true || !Number.isSafeInteger(bot.result.id)) {
    throw new TelegramSettingsError("Telegram 无法验证机器人 Token，请核对后重试。");
  }
  if (!chat.ok) {
    throw new TelegramSettingsError("Telegram 找不到这个发送目标。请核对公开链接或 Chat ID，并确认机器人已加入目标群组或频道。");
  }
  const chatType = chat.result.type;
  if (!["group", "supergroup", "channel"].includes(String(chatType))) {
    throw new TelegramSettingsError("公告只能发送到 Telegram 群组或频道。个人帐号和机器人不能作为发送目标。");
  }
  if (!validChatId(String(chat.result.id))) {
    throw new TelegramSettingsError("Telegram 未返回有效的群组或频道 Chat ID，请核对发送目标。");
  }
  const member = await telegramRequest(token, "getChatMember", { chat_id: chat.result.id, user_id: bot.result.id });
  if (!member || (!member.ok && (member.code >= 500 || member.code === 429))) {
    throw new TelegramSettingsError("暂时无法检查 Telegram 发送权限，请稍后再试。", 503);
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
  let lastError = recent?.last_error || "";
  if (settings.enabled && !decryptToken(settings.token_ciphertext)) lastError = "无法读取已保存的机器人 Token，请重新填写。";
  else if (settings.enabled && !publicOrigin()) lastError = "服务器尚未配置公开网站地址，无法生成公告链接。";
  return { enabled: settings.enabled === 1, chatId: settings.chat_id, hasToken: Boolean(settings.token_ciphertext), counts, lastError };
}

export async function saveTelegramPromotionSettings(input: SettingsInput) {
  const db = getSqlite();
  const previous = storedSettings(db);
  const newToken = input.token?.trim() || "";
  if (newToken && !TOKEN_FORMAT.test(newToken)) throw new TelegramSettingsError("请输入完整的 Telegram 机器人 Token。");
  let chatId = normalizeChatTarget(input.chatId);
  const ciphertext = newToken ? encryptToken(newToken) : previous.token_ciphertext;
  if (input.enabled) {
    const token = newToken || decryptToken(previous.token_ciphertext);
    if (!token) throw new TelegramSettingsError(previous.token_ciphertext ? "无法读取已保存的机器人 Token，请重新填写。" : "请填写 Telegram 机器人 Token。");
    if (!chatId) throw new TelegramSettingsError("请填写 Telegram 群组或频道的 Chat ID、@用户名或公开链接。");
    if (!publicOrigin()) throw new TelegramSettingsError("服务器尚未配置公开网站地址，无法生成公告链接。", 503);
    chatId = await verifyChat(token, chatId);
  }
  writeTransaction(db, () => {
    const current = storedSettings(db);
    if (current.enabled !== previous.enabled || current.chat_id !== previous.chat_id || current.token_ciphertext !== previous.token_ciphertext) {
      throw new TelegramSettingsError("Telegram 设置已更新，请刷新后再保存。", 409);
    }
    if (input.enabled && (!current.enabled || current.chat_id !== chatId)) {
      // Only upcoming or unpublished promotions should start posting in a new connection.
      db.prepare(`UPDATE telegram_promotion_outbox SET status='skipped', last_error='', next_attempt_at=0
        WHERE status='pending' AND brand_id IN (
          SELECT id FROM brands WHERE published=1 AND (promotion_starts_at IS NULL OR promotion_starts_at < ?)
        )`).run(Date.now());
    }
    db.prepare(`INSERT INTO telegram_promotion_settings (id, enabled, chat_id, token_ciphertext) VALUES ('primary', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, chat_id = excluded.chat_id, token_ciphertext = excluded.token_ciphertext`)
      .run(Number(input.enabled), chatId, ciphertext);
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
    const origin = publicOrigin();
    if (!settings.enabled || !validChatId(settings.chat_id) || !origin) return null;
    const token = decryptToken(settings.token_ciphertext);
    if (!token) return null;
    const blocked = db.prepare(`SELECT 1 FROM telegram_promotion_outbox WHERE next_attempt_at > ?
      AND (status = 'sending' OR last_error = ?) LIMIT 1`).get(now, RATE_LIMIT_ERROR);
    if (blocked) return null;
    const row = db.prepare(`SELECT o.brand_id, o.revision, o.attempts, b.name, b.tagline, b.category
      FROM telegram_promotion_outbox o JOIN brands b ON b.id = o.brand_id
      WHERE o.status = 'pending' AND o.next_attempt_at <= ? AND b.published = 1 AND b.category IN ('Update', 'New')
        AND (b.promotion_starts_at IS NULL OR b.promotion_starts_at <= ?) AND b.promotion_expires_at > ?
      ORDER BY o.next_attempt_at, o.rowid LIMIT 1`).get(now, now, now) as Delivery | undefined;
    if (!row) return null;
    db.prepare(`UPDATE telegram_promotion_outbox SET status = 'sending', attempts = attempts + 1, next_attempt_at = ?, last_error = ''
      WHERE brand_id = ? AND revision = ?`).run(now + LEASE_MS, row.brand_id, row.revision);
    return { ...row, attempts: row.attempts + 1, token, chatId: Number(settings.chat_id), origin };
  });
}

async function deliverPromotion() {
  const db = getSqlite();
  const delivery = claimDelivery(db);
  if (!delivery) return;
  const url = new URL(`/#brand-card-${encodeURIComponent(delivery.brand_id)}`, delivery.origin);
  const text = [`${delivery.category} · ${delivery.name}`, delivery.tagline.trim(), url.href].filter(Boolean).join("\n\n");
  const response = await telegramRequest(delivery.token, "sendMessage", { chat_id: delivery.chatId, text, link_preview_options: { is_disabled: true } });
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
  let running = false;
  let reportedError = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await deliverPromotion();
      reportedError = false;
    } catch {
      if (!reportedError) console.error("Telegram promotion worker could not process its outbox.");
      reportedError = true;
    } finally { running = false; }
  };
  void tick();
  setInterval(() => void tick(), POLL_MS).unref();
}
