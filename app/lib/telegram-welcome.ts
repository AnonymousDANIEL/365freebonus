import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getSqlite } from "./sqlite";
import { telegramRequest, telegramUpdates } from "./telegram-bot";

type DecryptToken = (ciphertext: string) => string;
type WelcomeSettings = {
  token_ciphertext: string;
  welcome_enabled: number;
  welcome_chat_id: string;
  welcome_message: string;
  welcome_started_at: number;
  welcome_revision: string;
};
type PollClaim = { revision: string; leaseId: string; offset: number; ciphertext: string };
type PollState = { revision: string; next_offset: number; last_polled_at: number; next_poll_at: number; lease_until: number };

const POLL_MS = 5_000;
const LEASE_MS = 30_000;
const IDLE_CURSOR_MS = 7 * 24 * 60 * 60 * 1_000;
const SLOW_RETRY_MS = 60_000;
const ownedState = "id = 'primary' AND revision = ? AND lease_id = ?";
const RATE_LIMIT_ERROR = "Telegram 正在限制发送频率，稍后重试。";
const INVALID_TOKEN_ERROR = "无法使用 Telegram 机器人 Token，请检查设置。";
const UNCERTAIN_SEND_ERROR = "Telegram 未确认欢迎消息的发送结果，该消息不会自动重发。";

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
  return db.prepare(`SELECT token_ciphertext, welcome_enabled, welcome_chat_id, welcome_message,
    welcome_started_at, welcome_revision FROM telegram_promotion_settings WHERE id = 'primary'`).get() as WelcomeSettings | undefined;
}

function welcomeReady(settings: WelcomeSettings | undefined): settings is WelcomeSettings {
  return Boolean(settings && settings.welcome_enabled === 1 && settings.welcome_revision && settings.token_ciphertext
    && /^-[1-9]\d{0,15}$/.test(settings.welcome_chat_id) && Number.isSafeInteger(Number(settings.welcome_chat_id))
    && Number.isSafeInteger(settings.welcome_started_at) && settings.welcome_started_at > 0 && settings.welcome_message.trim());
}

function claimPoll(db: DatabaseSync, now: number): PollClaim | null {
  return inTransaction(db, () => {
    const settings = readSettings(db);
    if (!welcomeReady(settings)) return null;
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
    return { revision, leaseId, offset, ciphertext: settings.token_ciphertext };
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

function welcomeText(update: Record<string, unknown>, settings: WelcomeSettings): string {
  const change = asRecord(update.chat_member);
  if (!change || typeof change.date !== "number" || !Number.isSafeInteger(change.date) || change.date < settings.welcome_started_at) return "";
  const chat = asRecord(change.chat);
  if (!chat || chat.id !== Number(settings.welcome_chat_id) || (chat.type !== "group" && chat.type !== "supergroup")) return "";
  if (membership(change.old_chat_member) !== false || membership(change.new_chat_member) !== true) return "";
  const user = asRecord(asRecord(change.new_chat_member)?.user);
  if (!user || user.is_bot !== false || !Number.isSafeInteger(user.id)) return "";
  const name = [displayText(user.first_name), displayText(user.last_name)].filter(Boolean).join(" ") || "新成员";
  const group = displayText(chat.title) || "Telegram 群组";
  return shorten(settings.welcome_message.replace(/\{(name|group)\}/g, (_, key) => key === "name" ? name : group).trim(), 4_096);
}

function claimUpdate(db: DatabaseSync, claim: PollClaim, id: number, update: Record<string, unknown>, now: number) {
  return inTransaction(db, () => {
    const settings = readSettings(db);
    if (!welcomeReady(settings) || settings.welcome_revision !== claim.revision) return null;
    // Persist consumption before any send. A crash or an ambiguous reply can
    // lose a welcome, but cannot cause an automatic duplicate.
    const result = db.prepare(`UPDATE telegram_welcome_state SET next_offset = ?, lease_until = ?
      WHERE ${ownedState} AND next_offset <= ?`).run(id + 1, now + LEASE_MS, claim.revision, claim.leaseId, id);
    if (!result.changes) return null;
    return { chatId: Number(settings.welcome_chat_id), text: welcomeText(update, settings) };
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
        : updates?.code === 401 ? INVALID_TOKEN_ERROR : "暂时无法检查 Telegram 新成员，请稍后再试。";
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
    if (!delivery) return;
    offset = id + 1;
    if (!delivery.text) continue;
    const reply = await telegramRequest(token, "sendMessage", {
      chat_id: delivery.chatId, text: delivery.text, link_preview_options: { is_disabled: true },
    }).catch(() => null);
    if (reply?.ok && Number.isSafeInteger(reply.result.message_id)) {
      db.prepare(`UPDATE telegram_welcome_state SET sent = sent + 1, last_error = '' WHERE ${ownedState}`)
        .run(claim.revision, claim.leaseId);
    } else if (reply && !reply.ok && reply.code === 429) {
      // This request was rejected. Telegram still holds the update until the
      // next poll acknowledges it, so retry its ID after the specified delay.
      finishPoll(db, claim, retryAt(clock(), reply.retryAfter), RATE_LIMIT_ERROR, id);
      return;
    } else {
      const code = reply && !reply.ok ? reply.code : 0;
      const error = code === 401 ? INVALID_TOKEN_ERROR
        : code === 400 || code === 403 ? "Telegram 拒绝发送欢迎消息，请检查群组和机器人权限。" : UNCERTAIN_SEND_ERROR;
      finishPoll(db, claim, clock() + (code === 401 || code === 403 ? SLOW_RETRY_MS : POLL_MS), error);
      return;
    }
  }
  finishPoll(db, claim);
}

const workers = globalThis as typeof globalThis & { telegramWelcomeWorkerStarted?: boolean };

export function startTelegramWelcomeWorker(decryptToken: DecryptToken) {
  if (workers.telegramWelcomeWorkerStarted) return;
  workers.telegramWelcomeWorkerStarted = true;
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
