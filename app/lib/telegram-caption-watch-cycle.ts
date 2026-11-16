import type { DatabaseSync } from "node:sqlite";

const HOUR = 60 * 60_000;
const MINUTE = 60_000;
const TABLE = "telegram_relay_caption_watch_cycle";
type Scope = { relay_revision: string; target_chat_id: number; account_generation: string; active: boolean; accountSources: boolean };
type Cycle = {
  relay_revision: string; target_chat_id: number; account_generation: string;
  cycle_number: number; cycle_started_at: number; cycle_finished_at: number; cycle_ceiling_id: number;
  cursor_id: number; current_outbox_id: number; current_started_at: number; next_cycle_at: number;
  retry_at: number; completed_count: number; last_reason: string;
};
type Job = { id: number; origin: string; source_version: number; source_content_hash: string; caption_watch_outcome: string;
  caption_watch_source_version: number; caption_watch_checked_at: number };
export type CaptionWatchFocus = {
  outboxId: number; sourceVersion: number; currentStartedAt: number; cycleNumber: number;
  cycleStartedAt: number; nextCycleAt: number; retryAt: number; position: number; total: number; completed: number;
  sourceEvidence: "source_read" | "bot_updates";
};

/** Only private scheduling metadata lives here; existing delivery states and cursors are never rewritten. */
export function ensureCaptionWatchCycleSchema(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    id TEXT PRIMARY KEY CHECK(id='primary'),relay_revision TEXT NOT NULL DEFAULT '',
    target_chat_id INTEGER NOT NULL DEFAULT 0,account_generation TEXT NOT NULL DEFAULT '',
    cycle_number INTEGER NOT NULL DEFAULT 0,cycle_started_at INTEGER NOT NULL DEFAULT 0,
    cycle_finished_at INTEGER NOT NULL DEFAULT 0,cycle_ceiling_id INTEGER NOT NULL DEFAULT 0,
    cursor_id INTEGER NOT NULL DEFAULT 0,current_outbox_id INTEGER NOT NULL DEFAULT 0,
    current_started_at INTEGER NOT NULL DEFAULT 0,next_cycle_at INTEGER NOT NULL DEFAULT 0,
    retry_at INTEGER NOT NULL DEFAULT 0,completed_count INTEGER NOT NULL DEFAULT 0,last_reason TEXT NOT NULL DEFAULT ''
  )`);
}

function absentSchema(error: unknown) {
  return error instanceof Error && /no such (?:table|column)/i.test(error.message);
}
function scope(db: DatabaseSync): Scope | null {
  try {
    const hasAccount = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='telegram_personal_account'").get());
    const accountSources = hasAccount && ["telegram_personal_sources", "telegram_personal_source_posts"].every(table =>
      Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)));
    const value = db.prepare(`SELECT p.relay_revision,r.target_chat_id,${hasAccount ? "COALESCE(a.generation,'')" : "''"} AS account_generation,
      p.relay_enabled,p.relay_caption_watch_enabled,p.relay_caption_serial_enabled,r.revision AS target_revision
      FROM telegram_promotion_settings p JOIN telegram_relay_state r ON r.id='primary'
      ${hasAccount ? "LEFT JOIN telegram_personal_account a ON a.id='primary'" : ""}
      WHERE p.id='primary'`).get() as {
        relay_revision: string; target_chat_id: number; account_generation: string;
        relay_enabled: number; relay_caption_watch_enabled: number; relay_caption_serial_enabled: number; target_revision: string;
      } | undefined;
    if (!value || !value.relay_revision || value.target_revision !== value.relay_revision
      || !Number.isSafeInteger(value.target_chat_id) || value.target_chat_id >= 0) return null;
    // Legacy test fixtures may omit entire source/edit tables. Production migration creates all of them.
    for (const table of [TABLE, "telegram_relay_outbox", "telegram_relay_source_edits"]) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return null;
    }
    return { relay_revision: value.relay_revision, target_chat_id: value.target_chat_id,
      account_generation: value.account_generation, accountSources,
      active: value.relay_enabled === 1 && value.relay_caption_watch_enabled === 1 && value.relay_caption_serial_enabled === 1 };
  } catch (error) { if (absentSchema(error)) return null; throw error; }
}
function current(db: DatabaseSync) { return db.prepare(`SELECT * FROM ${TABLE} WHERE id='primary'`).get() as Cycle | undefined; }
function matches(cycle: Cycle | undefined, value: Scope): cycle is Cycle {
  return !!cycle && cycle.relay_revision === value.relay_revision && cycle.target_chat_id === value.target_chat_id
    && cycle.account_generation === value.account_generation;
}
function eligible(value: Scope) { return `o.status='sent' AND o.message_id>0 AND o.revision=? AND o.source_chat_id<>?
  AND (o.origin<>'bot' OR o.source_content_hash<>'invalid:source_inactive')
  AND (o.origin<>'account' OR (o.account_generation=? AND ${value.accountSources ? `EXISTS(
    SELECT 1 FROM telegram_personal_sources s JOIN telegram_personal_source_posts w
      ON w.source_chat_id=s.chat_id AND w.selected_at=s.selected_at
    WHERE s.chat_id=o.source_chat_id AND s.selected=1 AND s.joined=1 AND s.blocked=0 AND s.selected_at<=o.queued_at
      AND w.source_message_id=o.source_message_id AND w.account_generation=o.account_generation AND w.relay_revision=o.revision)` : "0"}))`; }
function args(value: Scope) { return [value.relay_revision, value.target_chat_id, value.account_generation] as const; }
function job(db: DatabaseSync, value: Scope, id: number) {
  return db.prepare(`SELECT o.id,o.origin,o.source_version,o.source_content_hash,o.caption_watch_outcome,o.caption_watch_source_version,o.caption_watch_checked_at
    FROM telegram_relay_outbox o WHERE ${eligible(value)} AND o.id=?`).get(...args(value), id) as Job | undefined;
}
function remaining(db: DatabaseSync, value: Scope, cycle: Cycle) {
  return (db.prepare(`SELECT COUNT(*) AS count FROM telegram_relay_outbox o WHERE ${eligible(value)}
    AND o.id>? AND o.id<=?`).get(...args(value), cycle.cursor_id, cycle.cycle_ceiling_id) as { count: number }).count;
}
function finish(db: DatabaseSync, cycle: Cycle, now: number) {
  db.prepare(`UPDATE ${TABLE} SET current_outbox_id=0,current_started_at=0,retry_at=0,last_reason='',
    cycle_finished_at=?,next_cycle_at=? WHERE id='primary'`)
    .run(now, Math.max(cycle.cycle_started_at + HOUR, now + MINUTE));
}
function atomic<T>(db: DatabaseSync, work: () => T): T {
  db.exec("SAVEPOINT caption_watch_cycle_write");
  try { const result = work(); db.exec("RELEASE caption_watch_cycle_write"); return result; }
  catch (error) { db.exec("ROLLBACK TO caption_watch_cycle_write; RELEASE caption_watch_cycle_write"); throw error; }
}
function focusValue(db: DatabaseSync, value: Scope, cycle: Cycle, item: Job): CaptionWatchFocus {
  return { outboxId: item.id, sourceVersion: item.source_version, currentStartedAt: cycle.current_started_at,
    cycleNumber: cycle.cycle_number, cycleStartedAt: cycle.cycle_started_at, nextCycleAt: cycle.next_cycle_at,
    retryAt: cycle.retry_at, position: cycle.completed_count + 1, total: cycle.completed_count + remaining(db, value, cycle),
    completed: cycle.completed_count, sourceEvidence: item.origin === "account" ? "source_read" : "bot_updates" };
}

/** An unresolved post remains the focus across ticks and process restarts, including invalid source snapshots. */
export function captionWatchFocus(db: DatabaseSync, now = Date.now()): CaptionWatchFocus | null {
  const value = scope(db);
  if (!value?.active) return null;
  try { return atomic(db, () => {
    // Re-read inside the caller's transaction/savepoint, so a changed scope cannot claim old work.
    const active = scope(db);
    if (!active?.active) return null;
    let cycle = current(db);
    if (!matches(cycle, active)) {
      db.prepare(`INSERT INTO ${TABLE}(id,relay_revision,target_chat_id,account_generation) VALUES('primary',?,?,?)
        ON CONFLICT(id) DO UPDATE SET relay_revision=excluded.relay_revision,target_chat_id=excluded.target_chat_id,
          account_generation=excluded.account_generation,cycle_number=0,cycle_started_at=0,cycle_finished_at=0,
          cycle_ceiling_id=0,cursor_id=0,current_outbox_id=0,current_started_at=0,next_cycle_at=0,
          retry_at=0,completed_count=0,last_reason=''`).run(...args(active));
      cycle = current(db)!;
    }
    if (cycle.cycle_finished_at > 0 && cycle.next_cycle_at > now) return null;
    if (!cycle.cycle_started_at || cycle.cycle_finished_at > 0) {
      const ceiling = (db.prepare(`SELECT COALESCE(MAX(o.id),0) AS id FROM telegram_relay_outbox o WHERE ${eligible(active)}`)
        .get(...args(active)) as { id: number }).id;
      db.prepare(`UPDATE ${TABLE} SET cycle_number=cycle_number+1,cycle_started_at=?,cycle_finished_at=0,
        cycle_ceiling_id=?,cursor_id=0,current_outbox_id=0,current_started_at=0,next_cycle_at=?,retry_at=0,
        completed_count=0,last_reason='' WHERE id='primary'`).run(now, ceiling, now + HOUR);
      cycle = current(db)!;
    }
    if (cycle.current_outbox_id > 0) {
      const item = job(db, active, cycle.current_outbox_id);
      if (item) {
        // A lease deadline is an upper bound, not the actual release time.
        // Resume a busy caption as soon as the shared account is genuinely free.
        if (cycle.last_reason === "busy" && cycle.retry_at > now && active.accountSources) {
          const account = db.prepare("SELECT stage,lease_until,next_attempt_at FROM telegram_personal_account WHERE id='primary'")
            .get() as { stage: string; lease_until: number; next_attempt_at: number } | undefined;
          if (account?.stage === "connected" && account.lease_until <= now && account.next_attempt_at <= now) {
            db.prepare(`UPDATE ${TABLE} SET retry_at=? WHERE id='primary' AND current_outbox_id=?
              AND retry_at=? AND last_reason='busy'`).run(now, item.id, cycle.retry_at);
            cycle = current(db)!;
          }
        }
        return focusValue(db, active, cycle, item);
      }
      // Deactivated/deleted sources are no longer authorized work. Retire only this private scheduling pointer.
      db.prepare(`UPDATE ${TABLE} SET cursor_id=MAX(cursor_id,current_outbox_id),current_outbox_id=0,
        current_started_at=0,retry_at=0,last_reason='' WHERE id='primary'`).run();
      cycle = current(db)!;
    }
    const item = db.prepare(`SELECT o.id,o.origin,o.source_version,o.source_content_hash,o.caption_watch_outcome,o.caption_watch_source_version,o.caption_watch_checked_at
      FROM telegram_relay_outbox o WHERE ${eligible(active)} AND o.id>? AND o.id<=? ORDER BY o.id LIMIT 1`)
      .get(...args(active), cycle.cursor_id, cycle.cycle_ceiling_id) as Job | undefined;
    if (!item) { finish(db, cycle, now); return null; }
    // Leave a real receive/Hot work slot between captions, including after a restart.
    db.prepare(`UPDATE ${TABLE} SET current_outbox_id=?,current_started_at=?,retry_at=?,last_reason=''
      WHERE id='primary'`).run(item.id, now, cycle.completed_count > 0 ? now + 10_000 : 0);
    return focusValue(db, active, current(db)!, item);
  }); } catch (error) { if (absentSchema(error)) return null; throw error; }
}

/** A bounded arbitration hint; never takes or clears an account lease or Telegram backoff. */
export function captionWatchAccountPriority(db: DatabaseSync, now = Date.now()): boolean {
  const focus = captionWatchFocus(db, now);
  if (!focus || focus.retryAt > now) return false;
  try {
    const account = db.prepare("SELECT stage,lease_until,next_attempt_at FROM telegram_personal_account WHERE id='primary'")
      .get() as { stage: string; lease_until: number; next_attempt_at: number } | undefined;
    if (account?.stage !== "connected" || account.lease_until > now || account.next_attempt_at > now) return false;
    const anchor = focus.retryAt || focus.currentStartedAt;
    return now >= anchor && now - anchor < 15_000;
  } catch (error) { if (absentSchema(error)) return false; throw error; }
}

/** Advance only after a fresh, exact readback for the still-current source version. */
export function completeCaptionWatchFocus(db: DatabaseSync, outboxId: number, sourceVersion: number, now = Date.now()): boolean {
  const value = scope(db);
  if (!value?.active) return false;
  try { return atomic(db, () => {
    const active = scope(db), cycle = current(db);
    if (!active?.active || !matches(cycle, active) || cycle.current_outbox_id !== outboxId) return false;
    const item = job(db, active, outboxId);
    if (!item || item.source_content_hash.startsWith("invalid:") || item.source_version !== sourceVersion || item.caption_watch_source_version !== sourceVersion
      || item.caption_watch_outcome !== "consistent" || item.caption_watch_checked_at < cycle.current_started_at
      || item.caption_watch_checked_at > now) return false;
    if (db.prepare(`SELECT 1 FROM telegram_relay_source_edits WHERE outbox_id=? AND source_version=?
      AND status IN ('pending','attempting') LIMIT 1`).get(outboxId, sourceVersion)) return false;
    db.prepare(`UPDATE ${TABLE} SET cursor_id=?,current_outbox_id=0,current_started_at=0,retry_at=0,
      completed_count=completed_count+1,last_reason='' WHERE id='primary'`).run(outboxId);
    const updated = current(db)!;
    if (!remaining(db, active, updated)) finish(db, updated, now);
    return true;
  }); } catch (error) { if (absentSchema(error)) return false; throw error; }
}

const reasons = new Set(["waiting", "connection", "backoff", "uncertain", "mismatch", "source_invalid", "permission", "source_pending", "busy", "bot_updates_pending", "bot_updates_gap"]);
export function deferCaptionWatchFocus(db: DatabaseSync, outboxId: number, nextAt: number, reason: string): boolean {
  const value = scope(db);
  if (!value?.active || !Number.isSafeInteger(nextAt) || nextAt < 0) return false;
  try { return db.prepare(`UPDATE ${TABLE} SET retry_at=MAX(retry_at,?),last_reason=?
    WHERE id='primary' AND relay_revision=? AND target_chat_id=? AND account_generation=? AND current_outbox_id=?`)
    .run(nextAt, reasons.has(reason) ? reason : "waiting", ...args(value), outboxId).changes > 0;
  } catch (error) { if (absentSchema(error)) return false; throw error; }
}

/** Read-only public-to-admin aggregate: no outbox IDs, captions, usernames, tokens or raw errors. */
export function captionWatchCycleStatus(db: DatabaseSync, now = Date.now()) {
  const value = scope(db);
  if (!value) return null;
  try {
    const saved = current(db), cycle = matches(saved, value) ? saved : undefined;
    const item = cycle?.current_outbox_id ? job(db, value, cycle.current_outbox_id) : undefined;
    const count = cycle ? remaining(db, value, cycle) : 0;
    const complete = cycle?.completed_count || 0;
    return { enabled: value.active, paused: !value.active, intervalMinutes: 60, cycleNumber: cycle?.cycle_number || 0,
      cycleStartedAt: cycle?.cycle_started_at || null, currentStartedAt: item ? cycle!.current_started_at : null,
      nextCycleAt: cycle?.next_cycle_at || null, nextAttemptAt: value.active
        ? item ? Math.max(now, cycle!.retry_at) : cycle?.cycle_finished_at ? Math.max(now, cycle.next_cycle_at) : now : null,
      position: item ? complete + 1 : 0, total: complete + count, completed: complete,
      sourceEvidence: item ? item.origin === "account" ? "source_read" : "bot_updates" : null,
      retryAt: item && cycle!.retry_at > 0 ? cycle!.retry_at : null,
      lastReason: item && reasons.has(cycle!.last_reason) ? cycle!.last_reason : "",
      currentState: !value.active ? "paused" : item ? item.caption_watch_outcome === "checking" ? "checking" : "waiting"
        : cycle?.cycle_finished_at ? "scheduled" : "idle",
      reason: item && reasons.has(cycle!.last_reason) ? cycle!.last_reason : "" };
  } catch (error) { if (absentSchema(error)) return null; throw error; }
}
