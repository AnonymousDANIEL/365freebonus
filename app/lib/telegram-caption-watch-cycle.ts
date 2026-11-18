import type { DatabaseSync } from "node:sqlite";

const MINUTE = 60_000;
const WINDOW = 60 * MINUTE;
const TABLE = "telegram_relay_caption_watch_cycle";
const WINDOWS = "telegram_relay_caption_watch_windows";
type Scope = { relay_revision: string; target_chat_id: number; account_generation: string; active: boolean; accountSources: boolean };
type Job = { id: number; origin: string; source_version: number; source_content_hash: string; caption_watch_outcome: string;
  caption_watch_source_version: number; caption_watch_checked_at: number; observed_at?: number };
type Window = { relay_revision: string; target_chat_id: number; account_generation: string; outbox_id: number; source_version: number;
  started_at: number; expires_at: number; next_check_at: number; retry_at: number; attempt_started_at: number;
  check_count: number; verified_count: number; last_verified_at: number; last_reason: string; status: string };
export type CaptionWatchFocus = {
  outboxId: number; sourceVersion: number; currentStartedAt: number; windowStartedAt: number; windowEndsAt: number; cycleNumber: number;
  cycleStartedAt: number; nextCycleAt: number; retryAt: number; position: number; total: number; completed: number;
  sourceEvidence: "source_read" | "bot_updates";
};

/** Only private scheduling metadata lives here; delivery states and source cursors are never rewritten. */
export function ensureCaptionWatchCycleSchema(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    id TEXT PRIMARY KEY CHECK(id='primary'),relay_revision TEXT NOT NULL DEFAULT '',
    target_chat_id INTEGER NOT NULL DEFAULT 0,account_generation TEXT NOT NULL DEFAULT '',
    cycle_number INTEGER NOT NULL DEFAULT 0,cycle_started_at INTEGER NOT NULL DEFAULT 0,
    cycle_finished_at INTEGER NOT NULL DEFAULT 0,cycle_ceiling_id INTEGER NOT NULL DEFAULT 0,
    cursor_id INTEGER NOT NULL DEFAULT 0,current_outbox_id INTEGER NOT NULL DEFAULT 0,
    current_started_at INTEGER NOT NULL DEFAULT 0,next_cycle_at INTEGER NOT NULL DEFAULT 0,
    retry_at INTEGER NOT NULL DEFAULT 0,completed_count INTEGER NOT NULL DEFAULT 0,last_reason TEXT NOT NULL DEFAULT ''
  ); CREATE TABLE IF NOT EXISTS ${WINDOWS} (
    relay_revision TEXT NOT NULL,target_chat_id INTEGER NOT NULL,account_generation TEXT NOT NULL,
    outbox_id INTEGER NOT NULL,source_version INTEGER NOT NULL,started_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
    next_check_at INTEGER NOT NULL,retry_at INTEGER NOT NULL DEFAULT 0,attempt_started_at INTEGER NOT NULL DEFAULT 0,
    check_count INTEGER NOT NULL DEFAULT 0,verified_count INTEGER NOT NULL DEFAULT 0,last_verified_at INTEGER NOT NULL DEFAULT 0,
    last_reason TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'active',
    PRIMARY KEY(relay_revision,target_chat_id,account_generation,outbox_id,source_version)
  ); CREATE INDEX IF NOT EXISTS telegram_relay_caption_watch_windows_due ON ${WINDOWS}
    (relay_revision,target_chat_id,account_generation,status,next_check_at,retry_at);`);
  // Continue active windows created by the former 20-minute release for the full 60 minutes.
  // Historical, inactive, superseded and delivery/source state are intentionally untouched.
  db.prepare(`UPDATE ${WINDOWS} SET expires_at=started_at+?
    WHERE status='active' AND expires_at-started_at=?`).run(WINDOW, 20 * MINUTE);
}
function absentSchema(error: unknown) {
  return error instanceof Error && /no such (?:table|column)/i.test(error.message);
}
function hasTable(db: DatabaseSync, table: string) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}
function scope(db: DatabaseSync): Scope | null {
  try {
    const hasAccount = hasTable(db, "telegram_personal_account");
    const accountSources = hasAccount && ["telegram_personal_sources", "telegram_personal_source_posts"].every(table => hasTable(db, table));
    const value = db.prepare(`SELECT p.relay_revision,r.target_chat_id,${hasAccount ? "COALESCE(a.generation,'')" : "''"} AS account_generation,
      p.relay_enabled,p.relay_caption_watch_enabled,p.relay_caption_serial_enabled,r.revision AS target_revision
      FROM telegram_promotion_settings p JOIN telegram_relay_state r ON r.id='primary'
      ${hasAccount ? "LEFT JOIN telegram_personal_account a ON a.id='primary'" : ""} WHERE p.id='primary'`).get() as {
        relay_revision: string; target_chat_id: number; account_generation: string;
        relay_enabled: number; relay_caption_watch_enabled: number; relay_caption_serial_enabled: number; target_revision: string;
      } | undefined;
    if (!value || !value.relay_revision || value.target_revision !== value.relay_revision
      || !Number.isSafeInteger(value.target_chat_id) || value.target_chat_id >= 0) return null;
    for (const table of [TABLE, WINDOWS, "telegram_relay_outbox", "telegram_relay_source_edits"]) if (!hasTable(db, table)) return null;
    return { relay_revision: value.relay_revision, target_chat_id: value.target_chat_id,
      account_generation: value.account_generation, accountSources,
      active: value.relay_enabled === 1 && value.relay_caption_watch_enabled === 1 && value.relay_caption_serial_enabled === 1 };
  } catch (error) { if (absentSchema(error)) return null; throw error; }
}
function eligible(value: Scope) { return `o.status='sent' AND o.message_id>0 AND o.revision=? AND o.source_chat_id<>?
  AND (o.origin<>'bot' OR o.source_content_hash<>'invalid:source_inactive')
  AND (o.origin<>'account' OR (o.account_generation=? AND ${value.accountSources ? `EXISTS(
    SELECT 1 FROM telegram_personal_sources s JOIN telegram_personal_source_posts w
      ON w.source_chat_id=s.chat_id AND w.selected_at=s.selected_at
    WHERE s.chat_id=o.source_chat_id AND s.selected=1 AND s.joined=1 AND s.blocked=0 AND s.selected_at<=o.queued_at
      AND w.source_message_id=o.source_message_id AND w.account_generation=o.account_generation AND w.relay_revision=o.revision)` : "0"}))`; }
function args(value: Scope) { return [value.relay_revision, value.target_chat_id, value.account_generation] as const; }
const windowScope = "relay_revision=? AND target_chat_id=? AND account_generation=?";
function job(db: DatabaseSync, value: Scope, id: number) {
  return db.prepare(`SELECT o.id,o.origin,o.source_version,o.source_content_hash,o.caption_watch_outcome,o.caption_watch_source_version,o.caption_watch_checked_at
    FROM telegram_relay_outbox o WHERE ${eligible(value)} AND o.id=?`).get(...args(value), id) as Job | undefined;
}
function window(db: DatabaseSync, value: Scope, id: number, version: number) {
  return db.prepare(`SELECT * FROM ${WINDOWS} WHERE ${windowScope} AND outbox_id=? AND source_version=?`)
    .get(...args(value), id, version) as Window | undefined;
}
function atomic<T>(db: DatabaseSync, work: () => T): T {
  db.exec("SAVEPOINT caption_watch_cycle_write");
  try { const result = work(); db.exec("RELEASE caption_watch_cycle_write"); return result; }
  catch (error) { db.exec("ROLLBACK TO caption_watch_cycle_write; RELEASE caption_watch_cycle_write"); throw error; }
}
function insert(db: DatabaseSync, value: Scope, item: Job, observedAt: number, now: number) {
  // A version's start is immutable: rediscovery, successful checks, pauses and restarts never renew its window.
  const start = Math.min(now, Math.max(1, observedAt));
  db.prepare(`INSERT OR IGNORE INTO ${WINDOWS}(relay_revision,target_chat_id,account_generation,outbox_id,source_version,
    started_at,expires_at,next_check_at,status) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(...args(value), item.id, item.source_version, start, start + WINDOW, start, start + WINDOW <= now ? "historical" : "active");
  db.prepare(`UPDATE ${WINDOWS} SET status='superseded',attempt_started_at=0 WHERE ${windowScope}
    AND outbox_id=? AND source_version<>? AND status='active'`).run(...args(value), item.id, item.source_version);
}

/** Event hook for a newly sent caption or a freshly observed source revision. Safe in a surrounding transaction. */
export function registerCaptionWatchWindow(db: DatabaseSync, outboxId: number, observedAt = Date.now()): boolean {
  if (!Number.isSafeInteger(observedAt) || observedAt <= 0) return false;
  const value = scope(db);
  if (!value?.active) return false;
  try { return atomic(db, () => {
    const item = job(db, value, outboxId);
    if (!item) return false;
    insert(db, value, item, observedAt, observedAt);
    return true;
  }); } catch (error) { if (absentSchema(error)) return false; throw error; }
}
function discover(db: DatabaseSync, value: Scope, now: number) {
  // Old delivered posts are historical metadata, not a new 20-minute workload after deployment.
  const outboxColumns = new Set((db.prepare("PRAGMA table_info(telegram_relay_outbox)").all() as { name: string }[]).map(row => row.name));
  const editColumns = new Set((db.prepare("PRAGMA table_info(telegram_relay_source_edits)").all() as { name: string }[]).map(row => row.name));
  const delivered = outboxColumns.has("sent_at") ? "COALESCE(NULLIF(o.sent_at,0),o.queued_at)" : "o.queued_at";
  const changed = editColumns.has("created_at") ? `(SELECT MAX(e.created_at) FROM telegram_relay_source_edits e
    WHERE e.outbox_id=o.id AND e.source_version=o.source_version)` : "0";
  const rows = db.prepare(`SELECT o.id,o.origin,o.source_version,MAX(${delivered},COALESCE(${changed},0)) AS observed_at
    FROM telegram_relay_outbox o WHERE ${eligible(value)} AND NOT EXISTS(SELECT 1 FROM ${WINDOWS} w
      WHERE w.relay_revision=? AND w.target_chat_id=? AND w.account_generation=? AND w.outbox_id=o.id AND w.source_version=o.source_version)`)
    .all(...args(value), ...args(value)) as Job[];
  for (const item of rows) insert(db, value, item, Number(item.observed_at) || 1, now);
  db.prepare(`UPDATE ${WINDOWS} SET status='expired',attempt_started_at=0 WHERE ${windowScope} AND status='active' AND expires_at<=?`)
    .run(...args(value), now);
  db.prepare(`UPDATE ${WINDOWS} SET status='superseded',attempt_started_at=0 WHERE ${windowScope} AND status='active'
    AND EXISTS(SELECT 1 FROM telegram_relay_outbox o WHERE o.id=outbox_id AND o.source_version<>${WINDOWS}.source_version)`)
    .run(...args(value));
  db.prepare(`UPDATE ${WINDOWS} SET status='inactive',attempt_started_at=0 WHERE ${windowScope} AND status='active'
    AND NOT EXISTS(SELECT 1 FROM telegram_relay_outbox o WHERE ${eligible(value)} AND o.id=outbox_id AND o.source_version=${WINDOWS}.source_version)`)
    .run(...args(value), ...args(value));
}
function point(db: DatabaseSync, value: Scope, row: Window | undefined, now: number) {
  db.prepare(`INSERT INTO ${TABLE}(id,relay_revision,target_chat_id,account_generation,current_outbox_id,current_started_at,
    retry_at,last_reason,cycle_started_at,next_cycle_at) VALUES('primary',?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET relay_revision=excluded.relay_revision,target_chat_id=excluded.target_chat_id,
      account_generation=excluded.account_generation,current_outbox_id=excluded.current_outbox_id,
      current_started_at=excluded.current_started_at,retry_at=excluded.retry_at,last_reason=excluded.last_reason,
      cycle_started_at=excluded.cycle_started_at,next_cycle_at=excluded.next_cycle_at`)
    .run(...args(value), row?.outbox_id || 0, row?.attempt_started_at || 0, row ? Math.max(row.next_check_at, row.retry_at) : 0,
      row?.last_reason || "", row?.started_at || 0, row?.expires_at || 0);
}
function focusValue(db: DatabaseSync, value: Scope, row: Window, item: Job): CaptionWatchFocus {
  const counts = db.prepare(`SELECT COUNT(*) AS total,SUM(status='expired') AS completed FROM ${WINDOWS} WHERE ${windowScope}`)
    .get(...args(value)) as { total: number; completed: number };
  return { outboxId: row.outbox_id, sourceVersion: row.source_version, currentStartedAt: row.attempt_started_at,
    windowStartedAt: row.started_at, windowEndsAt: row.expires_at, cycleNumber: 0,
    cycleStartedAt: row.started_at, nextCycleAt: row.expires_at, retryAt: Math.max(row.next_check_at, row.retry_at),
    position: 1, total: counts.total, completed: counts.completed || 0,
    sourceEvidence: item.origin === "account" ? "source_read" : "bot_updates" };
}

/** Select due work fairly. Deferring A leaves B runnable; each caption retains its own fixed lifetime. */
export function captionWatchFocus(db: DatabaseSync, now = Date.now()): CaptionWatchFocus | null {
  const value = scope(db);
  if (!value?.active) return null;
  try { return atomic(db, () => {
    const active = scope(db);
    if (!active?.active) return null;
    discover(db, active, now);
    let row = db.prepare(`SELECT * FROM ${WINDOWS} WHERE ${windowScope} AND status='active' AND expires_at>?
      ORDER BY CASE WHEN attempt_started_at>0 AND MAX(next_check_at,retry_at)<=? THEN 0 ELSE 1 END,
        MAX(next_check_at,retry_at),started_at,outbox_id LIMIT 1`).get(...args(active), now, now) as Window | undefined;
    if (!row) { point(db, active, undefined, now); return null; }
    const item = job(db, active, row.outbox_id);
    if (!item || item.source_version !== row.source_version) return null;
    // A busy lease deadline is only an upper bound; resume promptly after its actual release.
    if (row.last_reason === "busy" && row.retry_at > now && active.accountSources) {
      const account = db.prepare("SELECT stage,lease_until,next_attempt_at FROM telegram_personal_account WHERE id='primary'")
        .get() as { stage: string; lease_until: number; next_attempt_at: number } | undefined;
      if (account?.stage === "connected" && account.lease_until <= now && account.next_attempt_at <= now) {
        db.prepare(`UPDATE ${WINDOWS} SET retry_at=? WHERE ${windowScope} AND outbox_id=? AND source_version=? AND last_reason='busy'`)
          .run(now, ...args(active), row.outbox_id, row.source_version);
        row = window(db, active, row.outbox_id, row.source_version)!;
      }
    }
    if (Math.max(row.next_check_at, row.retry_at) <= now && !row.attempt_started_at) {
      db.prepare(`UPDATE ${WINDOWS} SET attempt_started_at=? WHERE ${windowScope} AND outbox_id=? AND source_version=? AND attempt_started_at=0`)
        .run(now, ...args(active), row.outbox_id, row.source_version);
      row = window(db, active, row.outbox_id, row.source_version)!;
    }
    point(db, active, row, now);
    return focusValue(db, active, row, item);
  }); } catch (error) { if (absentSchema(error)) return null; throw error; }
}

/** Guard an in-flight RPC without selecting another caption or extending the window. */
export function isCaptionWatchFocusCurrent(db: DatabaseSync, outboxId: number, sourceVersion: number, attemptStartedAt: number, now = Date.now()): boolean {
  const value = scope(db);
  if (!value?.active || attemptStartedAt <= 0) return false;
  try {
    const row = window(db, value, outboxId, sourceVersion), item = job(db, value, outboxId);
    return !!row && row.status === "active" && row.started_at <= now && row.expires_at > now
      && row.attempt_started_at === attemptStartedAt && !!item && item.source_version === sourceVersion;
  } catch (error) { if (absentSchema(error)) return false; throw error; }
}

/** Bounded fairness hint only; never takes or clears an account lease or Telegram backoff. */
export function captionWatchAccountPriority(db: DatabaseSync, now = Date.now()): boolean {
  const focus = captionWatchFocus(db, now);
  if (!focus || !focus.currentStartedAt || focus.retryAt > now) return false;
  try {
    const account = db.prepare("SELECT stage,lease_until,next_attempt_at FROM telegram_personal_account WHERE id='primary'")
      .get() as { stage: string; lease_until: number; next_attempt_at: number } | undefined;
    if (account?.stage !== "connected" || account.lease_until > now || account.next_attempt_at > now) return false;
    const anchor = Math.max(focus.retryAt, focus.currentStartedAt);
    return now >= anchor && now - anchor < 15_000;
  } catch (error) { if (absentSchema(error)) return false; throw error; }
}

/** Record only fresh exact readback, then schedule this same caption on its next original minute boundary. */
export function completeCaptionWatchFocus(db: DatabaseSync, outboxId: number, sourceVersion: number, now = Date.now()): boolean {
  const value = scope(db);
  if (!value?.active) return false;
  try { return atomic(db, () => {
    const row = window(db, value, outboxId, sourceVersion), item = job(db, value, outboxId);
    if (!row || row.status !== "active" || !row.attempt_started_at || row.expires_at <= now
      || !item || item.source_content_hash.startsWith("invalid:") || item.source_version !== sourceVersion
      || item.caption_watch_source_version !== sourceVersion || item.caption_watch_outcome !== "consistent"
      || item.caption_watch_checked_at < row.attempt_started_at || item.caption_watch_checked_at > now) return false;
    if (db.prepare(`SELECT 1 FROM telegram_relay_source_edits WHERE outbox_id=? AND source_version=?
      AND status IN ('pending','attempting') LIMIT 1`).get(outboxId, sourceVersion)) return false;
    const next = row.started_at + (Math.floor((now - row.started_at) / MINUTE) + 1) * MINUTE;
    db.prepare(`UPDATE ${WINDOWS} SET next_check_at=?,retry_at=0,attempt_started_at=0,check_count=check_count+1,
      verified_count=verified_count+1,last_verified_at=?,last_reason='' WHERE ${windowScope} AND outbox_id=? AND source_version=?`)
      .run(next, item.caption_watch_checked_at, ...args(value), outboxId, sourceVersion);
    db.prepare(`UPDATE ${TABLE} SET current_outbox_id=0,current_started_at=0,retry_at=0,last_reason=''
      WHERE id='primary' AND current_outbox_id=?`).run(outboxId);
    return true;
  }); } catch (error) { if (absentSchema(error)) return false; throw error; }
}
const reasons = new Set(["waiting", "connection", "backoff", "uncertain", "mismatch", "source_invalid", "permission", "source_pending", "busy", "bot_updates_pending", "bot_updates_gap"]);
export function deferCaptionWatchFocus(db: DatabaseSync, outboxId: number, nextAt: number, reason: string, sourceVersion?: number): boolean {
  const value = scope(db);
  if (!value?.active || !Number.isSafeInteger(nextAt) || nextAt < 0) return false;
  try {
    const item = job(db, value, outboxId);
    if (!item || sourceVersion !== undefined && item.source_version !== sourceVersion) return false;
    const changed = db.prepare(`UPDATE ${WINDOWS} SET retry_at=MAX(retry_at,?),last_reason=?,attempt_started_at=0,
      check_count=check_count+1 WHERE ${windowScope} AND outbox_id=? AND source_version=? AND status='active'`)
      .run(nextAt, reasons.has(reason) ? reason : "waiting", ...args(value), outboxId, item.source_version).changes > 0;
    if (changed) db.prepare(`UPDATE ${TABLE} SET current_outbox_id=0,current_started_at=0,retry_at=0,last_reason=''
      WHERE id='primary' AND current_outbox_id=?`).run(outboxId);
    return changed;
  } catch (error) { if (absentSchema(error)) return false; throw error; }
}

/** Read-only admin aggregate; expiration is never described as a successful verification. */
export function captionWatchCycleStatus(db: DatabaseSync, now = Date.now()) {
  const value = scope(db);
  if (!value) return null;
  try {
    const counts = db.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(status='active' AND expires_at>?),0) AS active,
      COALESCE(SUM(status='expired' OR status='active' AND expires_at<=?),0) AS completed,
      COALESCE(SUM((status='expired' OR status='active' AND expires_at<=?) AND (verified_count=0 OR last_reason<>'' OR last_verified_at<expires_at-60000)),0) AS expired_unverified,
      COALESCE(SUM(status='superseded'),0) AS superseded,COALESCE(SUM(verified_count),0) AS verified_checks,
      COALESCE(SUM(status='active' AND expires_at>? AND MAX(next_check_at,retry_at)<=?),0) AS due,
      COALESCE(SUM(status='active' AND expires_at>? AND MAX(next_check_at,retry_at)<?),0) AS overdue,
      MIN(CASE WHEN status='active' AND expires_at>? THEN expires_at END) AS next_expiry,
      MIN(CASE WHEN status='active' AND expires_at>? THEN MAX(next_check_at,retry_at) END) AS next_attempt
      FROM ${WINDOWS} WHERE ${windowScope}`).get(now, now, now, now, now, now, now - MINUTE, now, now, ...args(value)) as {
        total: number; active: number; completed: number; expired_unverified: number; superseded: number;
        verified_checks: number; due: number; overdue: number; next_expiry: number | null; next_attempt: number | null;
      };
    const row = db.prepare(`SELECT * FROM ${WINDOWS} WHERE ${windowScope} AND status='active' AND expires_at>?
      ORDER BY CASE WHEN attempt_started_at>0 THEN 0 ELSE 1 END,MAX(next_check_at,retry_at),started_at,outbox_id LIMIT 1`)
      .get(...args(value), now) as Window | undefined;
    const item = row ? job(db, value, row.outbox_id) : undefined;
    const lastReason = row && reasons.has(row.last_reason) ? row.last_reason : "";
    return { enabled: value.active, paused: !value.active, mode: "overlapping" as const,
      windowMinutes: 60, checkIntervalSeconds: 60, active: counts.active, completed: counts.completed,
      due: counts.due, overdue: counts.overdue, expiredUnverified: counts.expired_unverified, superseded: counts.superseded, verifiedChecks: counts.verified_checks,
      nextExpiryAt: counts.next_expiry, intervalMinutes: 1, cycleNumber: 0,
      cycleStartedAt: row?.started_at || null, currentStartedAt: row?.attempt_started_at || null,
      nextCycleAt: counts.next_expiry, nextAttemptAt: value.active && counts.next_attempt !== null ? Math.max(now, counts.next_attempt) : null,
      position: row ? 1 : 0, total: counts.total, sourceEvidence: item ? item.origin === "account" ? "source_read" : "bot_updates" : null,
      retryAt: row && row.retry_at > 0 ? row.retry_at : null, lastReason,
      currentState: !value.active ? "paused" : row ? item?.caption_watch_outcome === "checking" ? "checking"
        : Math.max(row.next_check_at, row.retry_at) > now ? "scheduled" : "waiting" : "idle", reason: lastReason };
  } catch (error) { if (absentSchema(error)) return null; throw error; }
}

