import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getSqlite } from "./sqlite";
import { sendTelegramBrandCard, telegramPublicOrigin, type TelegramBrandCard } from "./telegram-brand-card";
import { recordPrivateFollowupOutbound } from "./telegram-followups";

type DecryptToken = (ciphertext: string) => string;
type UpdateSettings = {
  private_enabled: number;
  private_updates_enabled: number;
  private_updates_started_at: number;
  private_updates_revision: string;
  chat_bot_token_ciphertext: string;
  promotion_message: string;
};
type UpdateStatus = "pending" | "sending" | "sent" | "failed" | "unknown" | "cancelled";
type Delivery = {
  brand_id: string; promotion_revision: string; user_id: number; settings_revision: string;
  status: UpdateStatus; attempts: number; next_attempt_at: number; lease_id: string; lease_until: number;
};
type Claim = Delivery & { settings: UpdateSettings; brand: TelegramBrandCard };
const LEASE_MS = 60_000;
const SEND_INTERVAL_MS = 1_000;
const MAX_ATTEMPTS = 5;
const UNCERTAIN = "Telegram 未确认私聊品牌通知的发送结果，已停止重试以避免重复。";
const LIMITED = "Telegram 正在限制私聊品牌通知频率，稍后重试。";
const jobKey = "brand_id = ? AND promotion_revision = ? AND user_id = ?";
const eligible = `b.published = 1 AND (b.publish_at IS NULL OR b.publish_at <= ?)
  AND b.category IN ('Update', 'New') AND b.promotion_expires_at > ?
  AND (b.promotion_starts_at IS NULL OR b.promotion_starts_at <= ?)
  AND c.updates_enabled = 1 AND c.user_id > 0 AND c.user_id <= 9007199254740991
  AND MAX(o.created_at, COALESCE(b.promotion_starts_at, o.created_at)) >= ?
  AND MAX(o.created_at, COALESCE(b.promotion_starts_at, o.created_at)) >= c.updates_started_at
  AND NOT EXISTS (SELECT 1 FROM telegram_private_followups f WHERE f.chat_id = c.user_id AND f.opted_out = 1)`;

function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const value = work(); db.exec("COMMIT"); return value; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

function settings(db: DatabaseSync): UpdateSettings | undefined {
  return db.prepare(`SELECT private_enabled, private_updates_enabled, private_updates_started_at,
    private_updates_revision, chat_bot_token_ciphertext, promotion_message
    FROM telegram_promotion_settings WHERE id = 'primary'`).get() as UpdateSettings | undefined;
}

function enabled(value: UpdateSettings | undefined): value is UpdateSettings {
  return value?.private_enabled === 1 && value.private_updates_enabled === 1
    && value.private_updates_started_at > 0 && Boolean(value.private_updates_revision)
    && Boolean(value.chat_bot_token_ciphertext);
}

/** Cancel queued notices without releasing a request already in flight. */
export function cancelPrivateBrandUpdates(db: DatabaseSync) {
  db.prepare(`UPDATE telegram_private_brand_updates SET status='cancelled', lease_id='', lease_until=0
    WHERE status IN ('pending','sending')`).run();
}

export function privateBrandUpdateStatus(db: DatabaseSync) {
  const counts = { pending: 0, sending: 0, sent: 0, failed: 0, unknown: 0, cancelled: 0 };
  const rows = db.prepare("SELECT status, COUNT(*) AS count FROM telegram_private_brand_updates GROUP BY status")
    .all() as { status: UpdateStatus; count: number }[];
  for (const row of rows) if (row.status in counts) counts[row.status] += row.count;
  const error = db.prepare(`SELECT last_error FROM telegram_private_brand_updates WHERE last_error <> ''
    ORDER BY next_attempt_at DESC, user_id DESC LIMIT 1`).get() as { last_error: string } | undefined;
  const current = settings(db);
  return { counts, lastError: enabled(current) && !telegramPublicOrigin()
    ? "服务器尚未配置公开网站地址，无法发送私聊品牌通知。" : error?.last_error || "" };
}

function eligibleBrand(db: DatabaseSync, delivery: Delivery, current: UpdateSettings, now: number): TelegramBrandCard | null {
  const row = db.prepare(`SELECT b.id, b.name, b.slug, b.category, b.tagline, b.description, b.link, b.image_url AS imageUrl
    FROM brands b JOIN telegram_promotion_outbox o ON o.brand_id=b.id
    JOIN telegram_private_contacts c ON c.user_id=?
    WHERE b.id=? AND o.revision=? AND ${eligible}`)
    .get(delivery.user_id, delivery.brand_id, delivery.promotion_revision,
      now, now, now, current.private_updates_started_at) as TelegramBrandCard | undefined;
  return row || null;
}

function claimDelivery(db: DatabaseSync, verifiedCiphertext: string, now: number): Claim | null {
  return transaction(db, () => {
    db.prepare(`UPDATE telegram_private_brand_updates SET status='unknown', last_error=?, lease_id='', lease_until=0
      WHERE status='sending' AND lease_until<=?`).run(UNCERTAIN, now);
    const current = settings(db);
    if (!enabled(current)) { cancelPrivateBrandUpdates(db); return null; }
    if (current.chat_bot_token_ciphertext !== verifiedCiphertext) return null;
    db.prepare(`UPDATE telegram_private_brand_updates AS d SET status='cancelled', lease_id='', lease_until=0
      WHERE d.status='pending' AND (d.settings_revision<>? OR NOT EXISTS (
        SELECT 1 FROM brands b JOIN telegram_promotion_outbox o ON o.brand_id=b.id
        JOIN telegram_private_contacts c ON c.user_id=d.user_id
        WHERE b.id=d.brand_id AND o.revision=d.promotion_revision AND ${eligible}
      ))`).run(current.private_updates_revision, now, now, now, current.private_updates_started_at);
    // The event timestamp includes a future promotion start, so schedules saved
    // before activation are delivered when due, while old active notices are not.
    db.prepare(`INSERT OR IGNORE INTO telegram_private_brand_updates
      (brand_id,promotion_revision,user_id,settings_revision,next_attempt_at)
      SELECT b.id,o.revision,c.user_id,?,? FROM brands b
      JOIN telegram_promotion_outbox o ON o.brand_id=b.id CROSS JOIN telegram_private_contacts c
      WHERE ${eligible}`)
      .run(current.private_updates_revision, now, now, now, now, current.private_updates_started_at);
    db.prepare("INSERT OR IGNORE INTO telegram_private_updates_state(id) VALUES ('primary')").run();
    const state = db.prepare("SELECT lease_until, next_send_at FROM telegram_private_updates_state WHERE id='primary'")
      .get() as { lease_until: number; next_send_at: number };
    if (state.lease_until > now || state.next_send_at > now) return null;
    const pending = db.prepare(`SELECT * FROM telegram_private_brand_updates
      WHERE status='pending' AND settings_revision=? AND next_attempt_at<=?
      ORDER BY next_attempt_at, brand_id, user_id LIMIT 1`).get(current.private_updates_revision, now) as Delivery | undefined;
    if (!pending) return null;
    const brand = eligibleBrand(db, pending, current, now);
    if (!brand) return null;
    const leaseId = randomUUID();
    db.prepare(`UPDATE telegram_private_updates_state SET lease_id=?, lease_until=?, next_send_at=? WHERE id='primary'`)
      .run(leaseId, now + LEASE_MS, now + SEND_INTERVAL_MS);
    db.prepare(`UPDATE telegram_private_brand_updates SET status='sending', attempts=attempts+1, lease_id=?, lease_until=?
      WHERE ${jobKey} AND status='pending'`)
      .run(leaseId, now + LEASE_MS, pending.brand_id, pending.promotion_revision, pending.user_id);
    return { ...pending, status: "sending", attempts: pending.attempts + 1, lease_id: leaseId,
      lease_until: now + LEASE_MS, settings: current, brand };
  });
}

function stillOwned(db: DatabaseSync, delivery: Claim, now: number): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM telegram_private_brand_updates WHERE ${jobKey}
    AND status='sending' AND lease_id=? AND lease_until>?
    AND EXISTS (SELECT 1 FROM telegram_private_updates_state WHERE id='primary' AND lease_id=? AND lease_until>?)`)
    .get(delivery.brand_id, delivery.promotion_revision, delivery.user_id, delivery.lease_id, now, delivery.lease_id, now));
}

function canDispatch(db: DatabaseSync, delivery: Claim, now: number): boolean {
  const current = settings(db);
  return enabled(current) && current.private_updates_revision === delivery.settings_revision
    && current.chat_bot_token_ciphertext === delivery.settings.chat_bot_token_ciphertext
    && stillOwned(db, delivery, now) && eligibleBrand(db, delivery, current, now) !== null;
}

export async function deliverTelegramPrivateUpdateOnce(decryptToken: DecryptToken, clock = Date.now) {
  const db = getSqlite();
  const current = settings(db);
  if (!enabled(current)) { transaction(db, () => cancelPrivateBrandUpdates(db)); return; }
  const origin = telegramPublicOrigin();
  if (!origin) return;
  let token = "";
  try { token = decryptToken(current.chat_bot_token_ciphertext); } catch { /* Never log stored credentials. */ }
  if (!token) return;
  const delivery = claimDelivery(db, current.chat_bot_token_ciphertext, clock());
  if (!delivery) return;
  const dispatchAt = clock();
  const reply = await sendTelegramBrandCard(token, delivery.user_id, delivery.brand, origin, {
    template: delivery.settings.promotion_message,
    beforeSend: () => canDispatch(db, delivery, clock()),
  }).catch(() => null);
  transaction(db, () => {
    const now = clock();
    const owned = stillOwned(db, delivery, now);
    const success = reply?.ok && typeof reply.result.message_id === "number" && Number.isSafeInteger(reply.result.message_id) && reply.result.message_id > 0;
    let nextSend = now + SEND_INTERVAL_MS;
    if (success) {
      if (owned) db.prepare(`UPDATE telegram_private_brand_updates SET status='sent', sent_at=?, message_id=?, last_error='', lease_id='', lease_until=0
        WHERE ${jobKey} AND lease_id=?`).run(now, reply.result.message_id as number, delivery.brand_id, delivery.promotion_revision, delivery.user_id, delivery.lease_id);
      const date = reply.result.date;
      recordPrivateFollowupOutbound(db, delivery.user_id, reply.result.message_id as number,
        typeof date === "number" && Number.isSafeInteger(date) && date > 0 ? date * 1000 : dispatchAt);
    } else if (owned) {
      const code = reply && !reply.ok ? reply.code : 0;
      if (code === 429) {
        const retryAfter = reply && !reply.ok ? reply.retryAfter : 0;
        nextSend = Math.min(Number.MAX_SAFE_INTEGER,
          now + Math.max(5_000, retryAfter * 1000, 5_000 * 2 ** (delivery.attempts - 1)));
        const retry = delivery.attempts < MAX_ATTEMPTS;
        db.prepare(`UPDATE telegram_private_brand_updates SET status=?, next_attempt_at=?, last_error=?, lease_id='', lease_until=0
          WHERE ${jobKey} AND lease_id=?`).run(retry ? "pending" : "failed", nextSend,
            retry ? LIMITED : "Telegram 连续限制私聊品牌通知，已停止重试。",
            delivery.brand_id, delivery.promotion_revision, delivery.user_id, delivery.lease_id);
      } else if (reply === undefined) {
        // A same-bot credential rotation may happen during image preparation.
        // The shared sender returns undefined only before dispatch, or before a
        // fallback after definitively rejected media; retrying that is safe.
        const latest = settings(db);
        const rotated = enabled(latest) && latest.private_updates_revision === delivery.settings_revision
          && latest.chat_bot_token_ciphertext !== delivery.settings.chat_bot_token_ciphertext
          && eligibleBrand(db, delivery, latest, now) !== null;
        db.prepare(`UPDATE telegram_private_brand_updates SET status=?, next_attempt_at=?,
          attempts=MAX(0,attempts-1), last_error='', lease_id='', lease_until=0
          WHERE ${jobKey} AND lease_id=?`).run(rotated ? "pending" : "cancelled", nextSend,
            delivery.brand_id, delivery.promotion_revision, delivery.user_id, delivery.lease_id);
      } else {
        const status: UpdateStatus = [400, 401, 403].includes(code) ? "failed" : "unknown";
        const error = code === 403 ? "顾客已禁止机器人发消息，私聊品牌通知已停止。"
          : code === 401 ? "无法使用聊天机器人凭据，私聊品牌通知已停止。"
          : code === 400 ? "Telegram 拒绝私聊品牌通知，请检查机器人权限。" : UNCERTAIN;
        db.prepare(`UPDATE telegram_private_brand_updates SET status=?, last_error=?, lease_id='', lease_until=0
          WHERE ${jobKey} AND lease_id=?`).run(status, error, delivery.brand_id, delivery.promotion_revision, delivery.user_id, delivery.lease_id);
        if (code === 401) nextSend = now + 60_000;
        if (code === 403) {
          db.prepare("DELETE FROM telegram_private_contacts WHERE user_id=?").run(delivery.user_id);
          db.prepare(`UPDATE telegram_private_brand_updates SET status='cancelled', lease_id='', lease_until=0
            WHERE user_id=? AND status='pending'`).run(delivery.user_id);
        }
      }
    }
    db.prepare(`UPDATE telegram_private_updates_state SET lease_id='', lease_until=0, next_send_at=MAX(next_send_at,?)
      WHERE id='primary' AND lease_id=?`).run(nextSend, delivery.lease_id);
  });
}

const workers = globalThis as typeof globalThis & { telegramPrivateUpdatesWorkerStarted?: boolean };
export function startTelegramPrivateUpdatesWorker(decryptToken: DecryptToken) {
  if (workers.telegramPrivateUpdatesWorkerStarted) return;
  workers.telegramPrivateUpdatesWorkerStarted = true;
  let running = false;
  let reportedError = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await deliverTelegramPrivateUpdateOnce(decryptToken); reportedError = false; }
    catch {
      if (!reportedError) console.error("Telegram private brand notices could not be processed.");
      reportedError = true;
    } finally { running = false; }
  };
  void tick();
  setInterval(() => void tick(), SEND_INTERVAL_MS).unref();
}
