import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { telegramRequest } from "./telegram-bot";

export const PRIVATE_FOLLOWUP_DELAY_MS = 60 * 60 * 1000;
const LEASE_MS = 45_000;
const MAX_ATTEMPTS = 3;
const UNCERTAIN = "Telegram 未确认自动跟进的发送结果，已停止重试以避免重复。";
export type FollowupSettings = {
  private_enabled: number;
  private_followup_enabled: number;
  private_followup_message: string;
  private_followup_started_at: number;
  private_followup_revision: string;
};
export type FollowupPollClaim = { revision: string; leaseId: string };
type FollowupRow = {
  chat_id: number; revision: string; settings_revision: string;
  customer_update_id: number; customer_message_id: number; customer_at: number;
  due_at: number; status: string; attempts: number; next_attempt_at: number;
  lease_id: string; lease_until: number; last_outbound_at: number;
  last_outbound_message_id: number; opted_out: number;
};
type CustomerInput = {
  chatId: number; updateId: number; messageId: number; at: number;
  unmatched: boolean; command?: "start" | "stop";
};
function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const value = work(); db.exec("COMMIT"); return value; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
function enabled(settings: FollowupSettings): boolean {
  return settings.private_enabled === 1 && settings.private_followup_enabled === 1
    && Boolean(settings.private_followup_revision) && settings.private_followup_started_at > 0
    && Boolean(settings.private_followup_message.trim());
}
function row(db: DatabaseSync, chatId: number) {
  return db.prepare("SELECT * FROM telegram_private_followups WHERE chat_id=?").get(chatId) as FollowupRow | undefined;
}
function customerAfterOutbound(value: Pick<FollowupRow, "last_outbound_message_id" | "last_outbound_at">, messageId: number, at: number): boolean {
  if (value.last_outbound_message_id > 0 && messageId > 0) return messageId > value.last_outbound_message_id;
  return at > value.last_outbound_at;
}
// This runs in the poll cursor transaction. Received text and user profiles are
// never retained: only the latest event's identifiers and delivery metadata.
export function observePrivateFollowupInput(db: DatabaseSync, settings: FollowupSettings, input: CustomerInput) {
  const previous = row(db, input.chatId);
  if (!previous && !enabled(settings) && !input.command) return;
  // Chat message IDs also handle Telegram assigning lower update IDs after a
  // long idle period. A replay of an older message cannot reset the deadline.
  if (previous && input.messageId > 0 && previous.customer_message_id > 0
    && input.messageId <= previous.customer_message_id && input.at <= previous.customer_at) return;
  const optedOut = input.command === "stop" ? 1 : input.command === "start" ? 0 : previous?.opted_out || 0;
  const canSchedule = input.unmatched && enabled(settings) && !optedOut
    && input.at >= settings.private_followup_started_at * 1000
    && (!previous || customerAfterOutbound(previous, input.messageId, input.at));
  const revision = randomUUID();
  const dueAt = canSchedule ? input.at + PRIVATE_FOLLOWUP_DELAY_MS : 0;
  db.prepare(`INSERT INTO telegram_private_followups
    (chat_id,revision,settings_revision,customer_update_id,customer_message_id,customer_at,due_at,status,next_attempt_at,opted_out)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(chat_id) DO UPDATE SET revision=excluded.revision,settings_revision=excluded.settings_revision,
      customer_update_id=excluded.customer_update_id,customer_message_id=excluded.customer_message_id,
      customer_at=excluded.customer_at,due_at=excluded.due_at,status=excluded.status,
      attempts=0,next_attempt_at=excluded.next_attempt_at,lease_id='',lease_until=0,last_error='',sent_at=NULL,opted_out=excluded.opted_out`)
    .run(input.chatId, revision, settings.private_followup_revision, input.updateId,
      input.messageId || previous?.customer_message_id || 0, input.at, dueAt, canSchedule ? "pending" : "cancelled", dueAt, optedOut);
}
export function privateFollowupSnapshot(db: DatabaseSync, chatId: number): string | undefined { return row(db, chatId)?.revision; }
export function cancelPrivateFollowupReply(db: DatabaseSync, chatId: number, revision: string | undefined) {
  if (!revision) return;
  db.prepare(`UPDATE telegram_private_followups SET status='cancelled',revision=?,lease_id='',lease_until=0
    WHERE chat_id=? AND revision=? AND status IN ('pending','sending')`).run(randomUUID(), chatId, revision);
}
// Use Telegram's actual outgoing message ID/date. Comparing IDs resolves a new
// customer message that arrives in the same second while a send is in flight.
export function recordPrivateFollowupOutbound(db: DatabaseSync, chatId: number, messageId: number, at: number) {
  db.prepare("INSERT INTO telegram_private_followups(chat_id,revision) VALUES (?,?) ON CONFLICT(chat_id) DO NOTHING").run(chatId, randomUUID());
  const previous = row(db, chatId)!;
  if (previous.last_outbound_message_id > 0 && messageId > 0 && messageId <= previous.last_outbound_message_id) return;
  if (!messageId && at < previous.last_outbound_at) return;
  const cancel = !customerAfterOutbound({ last_outbound_message_id: messageId, last_outbound_at: at }, previous.customer_message_id, previous.customer_at);
  db.prepare(`UPDATE telegram_private_followups SET last_outbound_at=?,last_outbound_message_id=?,
    status=CASE WHEN ? AND status='pending' THEN 'cancelled' ELSE status END,
    revision=CASE WHEN ? AND status='pending' THEN ? ELSE revision END,
    lease_id=CASE WHEN ? AND status='pending' THEN '' ELSE lease_id END,
    lease_until=CASE WHEN ? AND status='pending' THEN 0 ELSE lease_until END WHERE chat_id=?`)
    .run(at, messageId, Number(cancel), Number(cancel), randomUUID(), Number(cancel), Number(cancel), chatId);
}
function currentSettings(db: DatabaseSync) {
  return db.prepare(`SELECT private_enabled,private_followup_enabled,private_followup_message,
    private_followup_started_at,private_followup_revision,welcome_revision
    FROM telegram_promotion_settings WHERE id='primary'`).get() as (FollowupSettings & { welcome_revision: string }) | undefined;
}
function ownsPoll(db: DatabaseSync, claim: FollowupPollClaim, now: number): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM telegram_welcome_state
    WHERE id='primary' AND revision=? AND lease_id=? AND lease_until>?`).get(claim.revision, claim.leaseId, now));
}
function claimDue(db: DatabaseSync, claim: FollowupPollClaim, clock: () => number) {
  return transaction(db, () => {
    const now = clock();
    const settings = currentSettings(db);
    if (!settings || !enabled(settings) || settings.welcome_revision !== claim.revision || !ownsPoll(db, claim, now)) return null;
    db.prepare(`UPDATE telegram_private_followups SET status='unknown',last_error=?,lease_id='',lease_until=0
      WHERE status='sending' AND lease_until<=?`).run(UNCERTAIN, now);
    db.prepare(`UPDATE telegram_private_followups SET status='cancelled',lease_id='',lease_until=0
      WHERE status='pending' AND settings_revision<>?`).run(settings.private_followup_revision);
    const pending = db.prepare(`SELECT * FROM telegram_private_followups
      WHERE status='pending' AND opted_out=0 AND settings_revision=? AND due_at<=? AND next_attempt_at<=?
        AND chat_id>0 AND chat_id<=9007199254740991
        AND EXISTS(SELECT 1 FROM telegram_private_contacts WHERE user_id=telegram_private_followups.chat_id)
      ORDER BY next_attempt_at,chat_id LIMIT 1`).get(settings.private_followup_revision, now, now) as FollowupRow | undefined;
    if (!pending) return null;
    if (!customerAfterOutbound(pending, pending.customer_message_id, pending.customer_at)) {
      cancelPrivateFollowupReply(db, pending.chat_id, pending.revision); return null;
    }
    const leaseId = randomUUID();
    const claimed = db.prepare(`UPDATE telegram_private_followups SET status='sending',attempts=attempts+1,lease_id=?,lease_until=?
      WHERE chat_id=? AND revision=? AND status='pending' AND opted_out=0 AND settings_revision=?`).run(leaseId, now + LEASE_MS, pending.chat_id, pending.revision, settings.private_followup_revision);
    if (!claimed.changes) return null;
    db.prepare(`UPDATE telegram_welcome_state SET lease_until=? WHERE id='primary' AND revision=? AND lease_id=?`).run(now + LEASE_MS, claim.revision, claim.leaseId);
    return { ...pending, attempts: pending.attempts + 1, lease_id: leaseId, text: settings.private_followup_message.trim() };
  });
}
export async function sendDuePrivateFollowups(db: DatabaseSync, claim: FollowupPollClaim, token: string, clock = Date.now, max = 1) {
  for (let i = 0; i < max; i++) {
    const delivery = claimDue(db, claim, clock);
    if (!delivery) return;
    const sentAt = clock();
    // There is no await between this final authorization and request dispatch.
    const settings = currentSettings(db);
    const active = row(db, delivery.chat_id);
    if (!settings || !enabled(settings) || settings.private_followup_revision !== delivery.settings_revision
      || !ownsPoll(db, claim, sentAt) || active?.revision !== delivery.revision
      || active.status !== "sending" || active.lease_id !== delivery.lease_id) continue;
    const reply = await telegramRequest(token, "sendMessage", {
      chat_id: delivery.chat_id, text: delivery.text, link_preview_options: { is_disabled: true },
    }).catch(() => null);
    transaction(db, () => {
      const current = row(db, delivery.chat_id);
      const stillOwned = current?.revision === delivery.revision && current.status === "sending" && current.lease_id === delivery.lease_id;
      const successful = reply?.ok && typeof reply.result.message_id === "number" && Number.isSafeInteger(reply.result.message_id) && reply.result.message_id > 0;
      if (successful) {
        if (stillOwned) db.prepare(`UPDATE telegram_private_followups SET status='sent',sent_at=?,last_error='',lease_id='',lease_until=0
          WHERE chat_id=? AND revision=? AND lease_id=?`).run(clock(), delivery.chat_id, delivery.revision, delivery.lease_id);
        const date = reply.result.date;
        recordPrivateFollowupOutbound(db, delivery.chat_id, reply.result.message_id as number,
          typeof date === "number" && Number.isSafeInteger(date) && date > 0 ? date * 1000 : sentAt);
        return;
      }
      if (!stillOwned) return;
      const code = reply && !reply.ok ? reply.code : 0;
      if (code === 429 && delivery.attempts < MAX_ATTEMPTS) {
        const seconds = reply && !reply.ok ? reply.retryAfter : 0;
        db.prepare(`UPDATE telegram_private_followups SET status='pending',next_attempt_at=?,last_error=?,lease_id='',lease_until=0
          WHERE chat_id=? AND revision=? AND lease_id=?`).run(clock() + Math.max(5_000, seconds > 0 ? seconds * 1000 : 60_000),
          "Telegram 正在限制自动跟进频率，稍后重试。", delivery.chat_id, delivery.revision, delivery.lease_id);
      } else {
        const definitive = code === 400 || code === 401 || code === 403 || code === 429;
        const error = code === 403 ? "顾客已禁止机器人发消息，自动跟进已停止。"
          : code === 401 ? "无法使用聊天机器人凭据，自动跟进已停止。"
          : code === 429 ? "Telegram 连续限制发送频率，自动跟进已停止。"
          : code === 400 ? "Telegram 拒绝自动跟进，请检查机器人权限。" : UNCERTAIN;
        db.prepare(`UPDATE telegram_private_followups SET status=?,last_error=?,lease_id='',lease_until=0
          WHERE chat_id=? AND revision=? AND lease_id=?`).run(definitive ? "failed" : "unknown", error, delivery.chat_id, delivery.revision, delivery.lease_id);
        if (code === 403) db.prepare("DELETE FROM telegram_private_contacts WHERE user_id=?").run(delivery.chat_id);
      }
    });
  }
}
