import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';

const fixture = mkdtempSync(path.join(tmpdir(), 'caption-overlapping-windows-'));
writeFileSync(path.join(fixture, 'package.json'), '{"type":"commonjs"}');
writeFileSync(path.join(fixture, 'cycle.js'), ts.transpileModule(
  readFileSync(new URL('../app/lib/telegram-caption-watch-cycle.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText);
const require = createRequire(import.meta.url);
const { ensureCaptionWatchCycleSchema: schema, captionWatchFocus: focus, completeCaptionWatchFocus: complete,
  deferCaptionWatchFocus: defer, captionWatchCycleStatus: status, captionWatchAccountPriority: priority,
  registerCaptionWatchWindow: register, isCaptionWatchFocusCurrent: isCurrent } = require(path.join(fixture, 'cycle.js'));
const now = 1_800_000_000_000, minute = 60_000, duration = 20 * minute;
test.after(() => rmSync(fixture, { recursive: true, force: true }));
function database(filename = ':memory:') {
  const db = new DatabaseSync(filename);
  db.exec(`CREATE TABLE telegram_promotion_settings(id TEXT,relay_enabled INTEGER,relay_revision TEXT,
    relay_caption_watch_enabled INTEGER,relay_caption_serial_enabled INTEGER);
    INSERT INTO telegram_promotion_settings VALUES('primary',1,'current',1,1);
    CREATE TABLE telegram_relay_state(id TEXT,revision TEXT,target_chat_id INTEGER,next_send_at INTEGER);
    INSERT INTO telegram_relay_state VALUES('primary','current',-10099,456);
    CREATE TABLE telegram_personal_account(id TEXT,generation TEXT,stage TEXT,lease_until INTEGER DEFAULT 0,next_attempt_at INTEGER DEFAULT 0);
    INSERT INTO telegram_personal_account(id,generation,stage) VALUES('primary','account-private','connected');
    CREATE TABLE telegram_personal_sources(chat_id INTEGER,selected INTEGER,joined INTEGER,blocked INTEGER,
      selected_at INTEGER,last_message_id INTEGER);
    INSERT INTO telegram_personal_sources VALUES(-1001,1,1,0,1,1234);
    CREATE TABLE telegram_personal_source_posts(source_chat_id INTEGER,source_message_id INTEGER,
      account_generation TEXT,relay_revision TEXT,selected_at INTEGER);
    CREATE TABLE telegram_relay_source_edits(outbox_id INTEGER,source_version INTEGER,status TEXT,created_at INTEGER DEFAULT 0);
    CREATE TABLE telegram_relay_outbox(id INTEGER PRIMARY KEY,revision TEXT,status TEXT,message_id INTEGER,
      origin TEXT,account_generation TEXT,source_chat_id INTEGER,source_message_id INTEGER,queued_at INTEGER,sent_at INTEGER,
      source_version INTEGER DEFAULT 0,source_content_hash TEXT DEFAULT '',caption TEXT DEFAULT 'PRIVATE_CAPTION',
      caption_watch_outcome TEXT DEFAULT '',caption_watch_source_version INTEGER DEFAULT -1,
      caption_watch_checked_at INTEGER DEFAULT 0);`);
  schema(db); return db;
}
function add(db, id, { state = 'sent', invalid = false, source = -1001, at = now } = {}) {
  db.prepare(`INSERT INTO telegram_relay_outbox(id,revision,status,message_id,origin,account_generation,
    source_chat_id,source_message_id,queued_at,sent_at,source_content_hash) VALUES(?,'current',?,?,'account','account-private',?,?,?,?,?)`)
    .run(id, state, id + 100, source, id, at - 1000, at, invalid ? 'invalid:caption' : 'hash');
  db.prepare('INSERT INTO telegram_personal_source_posts VALUES(?,?,?, ?,1)').run(source, id, 'account-private', 'current');
}
function mark(db, id, at, version = 0) {
  db.prepare("UPDATE telegram_relay_outbox SET caption_watch_outcome='consistent',caption_watch_source_version=?,caption_watch_checked_at=? WHERE id=?")
    .run(version, at, id);
}
function windows(db) { return db.prepare('SELECT * FROM telegram_relay_caption_watch_windows ORDER BY outbox_id,source_version').all().map(row => ({ ...row })); }
function saved(db) { return db.prepare('SELECT * FROM telegram_relay_caption_watch_cycle').all().map(row => ({ ...row })); }

test('A and newly arriving B retain independent minute schedules and fixed twenty-minute windows', () => {
  const db = database(); try {
    add(db, 1); const a = focus(db, now); assert.equal(a.outboxId, 1);
    assert.equal(a.windowStartedAt, now); assert.equal(a.windowEndsAt, now + duration);
    mark(db, 1, now + 100); assert.equal(complete(db, 1, 0, now + 100), true);
    assert.equal(focus(db, now + 101).retryAt, now + minute);
    add(db, 2, { at: now + 10_000 }); assert.equal(focus(db, now + 10_000).outboxId, 2);
    mark(db, 2, now + 10_100); assert.equal(complete(db, 2, 0, now + 10_100), true);
    assert.equal(focus(db, now + minute).outboxId, 1);
    mark(db, 1, now + minute + 1); complete(db, 1, 0, now + minute + 1);
    assert.equal(focus(db, now + minute + 10_000).outboxId, 2);
    assert.deepEqual(windows(db).map(w => [w.started_at, w.expires_at]), [[now, now + duration], [now + 10_000, now + 10_000 + duration]]);
    assert.equal(status(db, now + minute).active, 2);
  } finally { db.close(); }
});

test('failed or deferred A never blocks due B and does not count as verified', () => {
  const db = database(); try {
    add(db, 1); add(db, 2); focus(db, now);
    assert.equal(defer(db, 1, now + minute, 'connection', 0), true);
    const b = focus(db, now + 1); assert.equal(b.outboxId, 2);
    mark(db, 2, now + 2); assert.equal(complete(db, 2, 0, now + 2), true);
    assert.equal(windows(db)[0].verified_count, 0); assert.equal(windows(db)[1].verified_count, 1);
    assert.equal(focus(db, now + minute).outboxId, 1);
    assert.equal(status(db, now + minute).verifiedChecks, 1);
  } finally { db.close(); }
});

test('each minute requires a fresh readback; stale, future, wrong version or pending edit cannot pass', () => {
  const db = database(); try {
    add(db, 1); focus(db, now); mark(db, 1, now); assert.equal(complete(db, 1, 0, now), true);
    assert.equal(complete(db, 1, 0, now + 1), false);
    focus(db, now + minute); assert.equal(complete(db, 1, 0, now + minute), false);
    mark(db, 1, now + minute + 2); assert.equal(complete(db, 1, 0, now + minute + 1), false);
    db.exec("INSERT INTO telegram_relay_source_edits VALUES(1,0,'pending',0)");
    assert.equal(complete(db, 1, 0, now + minute + 2), false);
    db.exec("UPDATE telegram_relay_source_edits SET status='attempting'");
    assert.equal(complete(db, 1, 0, now + minute + 2), false);
    db.exec("UPDATE telegram_relay_source_edits SET status='confirmed'");
    assert.equal(complete(db, 1, 0, now + minute + 2), true);
    assert.equal(windows(db)[0].verified_count, 2);
  } finally { db.close(); }
});

test('new source revision gets its own lifetime, supersedes old revision and rejects stale RPC completion or defer', () => {
  const db = database(); try {
    add(db, 1); const original = focus(db, now);
    db.exec("UPDATE telegram_relay_outbox SET source_version=1,source_content_hash='new' WHERE id=1");
    assert.equal(register(db, 1, now + minute), true);
    assert.equal(isCurrent(db, 1, 0, original.currentStartedAt, now + minute), false);
    assert.equal(defer(db, 1, now + 5 * minute, 'backoff', 0), false);
    assert.equal(complete(db, 1, 0, now + minute), false);
    const changed = focus(db, now + minute); assert.equal(changed.sourceVersion, 1);
    assert.equal(changed.windowStartedAt, now + minute); assert.equal(changed.windowEndsAt, now + minute + duration);
    assert.equal(isCurrent(db, 1, 1, changed.currentStartedAt, now + minute), true);
    assert.equal(windows(db)[0].status, 'superseded'); assert.equal(windows(db)[1].retry_at, 0);
    mark(db, 1, now + minute + 1, 1); assert.equal(complete(db, 1, 1, now + minute + 1), true);
    assert.equal(status(db, now + minute + 1).superseded, 1);
  } finally { db.close(); }
});

test('delayed ticks skip missed slots without fabricating checks or shifting original minute boundaries', () => {
  const db = database(); try {
    add(db, 1); focus(db, now); mark(db, 1, now + 2 * minute + 20_000);
    assert.equal(complete(db, 1, 0, now + 2 * minute + 20_000), true);
    assert.equal(windows(db)[0].verified_count, 1);
    assert.equal(windows(db)[0].next_check_at, now + 3 * minute);
    assert.equal(windows(db)[0].expires_at, now + duration);
  } finally { db.close(); }
});

test('restart resumes unexpired windows and never renews an expired version or fabricates downtime checks', () => {
  const filename = path.join(fixture, 'restart.sqlite'); let db = database(filename);
  try {
    add(db, 1); focus(db, now); mark(db, 1, now); complete(db, 1, 0, now);
    defer(db, 1, now + 4 * minute, 'backoff', 0); const before = windows(db)[0];
    db.close(); db = new DatabaseSync(filename);
    assert.equal(focus(db, now + 2 * minute).retryAt, now + 4 * minute);
    assert.equal(windows(db)[0].started_at, before.started_at); assert.equal(windows(db)[0].verified_count, 1);
    assert.equal(focus(db, now + duration), null); assert.equal(windows(db)[0].status, 'expired');
    assert.equal(register(db, 1, now + 30 * minute), true);
    assert.equal(focus(db, now + 30 * minute), null); assert.equal(windows(db)[0].started_at, now);
    assert.equal(status(db, now + 30 * minute).expiredUnverified, 1);
    add(db, 2, { at: now + 31 * minute }); assert.equal(focus(db, now + 31 * minute).outboxId, 2);
  } finally { db.close(); }
});

test('migration discovers old posts as expired history without launching a new backlog; fresh edit timestamps still launch', () => {
  const db = database(); try {
    add(db, 1, { at: now - 3_600_000 }); assert.equal(focus(db, now), null);
    assert.equal(status(db, now).active, 0); assert.equal(windows(db)[0].verified_count, 0);
    db.exec("UPDATE telegram_relay_outbox SET source_version=1 WHERE id=1");
    db.prepare("INSERT INTO telegram_relay_source_edits VALUES(1,1,'pending',?)").run(now + 1);
    assert.equal(focus(db, now + 1).sourceVersion, 1); assert.equal(windows(db)[1].started_at, now + 1);
  } finally { db.close(); }
});

test('paused windows preserve starts and scope changes never claim obsolete account work', () => {
  const db = database(); try {
    add(db, 1); focus(db, now); const before = windows(db);
    db.exec('UPDATE telegram_promotion_settings SET relay_caption_serial_enabled=0');
    assert.equal(focus(db, now + 1), null); assert.equal(complete(db, 1, 0, now + 1), false);
    assert.deepEqual(windows(db), before); assert.equal(status(db, now + 1).paused, true);
    db.exec('UPDATE telegram_promotion_settings SET relay_caption_serial_enabled=1');
    assert.equal(focus(db, now + 2).windowStartedAt, now);
    db.exec("UPDATE telegram_personal_account SET generation='different-account'");
    assert.equal(focus(db, now + 3), null);
  } finally { db.close(); }
});

test('invalid source windows expire without a successful check and removed sources only retire scheduling metadata', () => {
  const db = database(); try {
    add(db, 1, { invalid: true }); add(db, 2, { state: 'unknown' });
    const queue = db.prepare('SELECT * FROM telegram_relay_outbox ORDER BY id').all();
    focus(db, now); defer(db, 1, now + minute, 'source_invalid', 0);
    mark(db, 1, now + minute); assert.equal(complete(db, 1, 0, now + minute), false);
    db.exec("UPDATE telegram_relay_outbox SET caption_watch_outcome='',caption_watch_source_version=-1,caption_watch_checked_at=0 WHERE id=1");
    db.exec('UPDATE telegram_personal_sources SET blocked=1'); assert.equal(focus(db, now + minute), null);
    assert.deepEqual(db.prepare('SELECT * FROM telegram_relay_outbox ORDER BY id').all(), queue);
    assert.equal(windows(db)[0].status, 'inactive');
    assert.equal(db.prepare('SELECT last_message_id FROM telegram_personal_sources').get().last_message_id, 1234);
    assert.equal(db.prepare('SELECT next_send_at FROM telegram_relay_state').get().next_send_at, 456);
  } finally { db.close(); }
});

test('read-only status distinguishes active, successful checks, overdue work and expiry without exposing content or IDs', () => {
  const db = database(); try {
    add(db, 1); focus(db, now); defer(db, 1, now, 'PRIVATE_RAW_ERROR', 0);
    const before = windows(db), pointer = saved(db), result = status(db, now + 2 * minute);
    assert.deepEqual([result.active, result.due, result.overdue, result.verifiedChecks], [1, 1, 1, 0]);
    assert.equal(result.mode, 'overlapping'); assert.equal(result.windowMinutes, 20); assert.equal(result.checkIntervalSeconds, 60);
    assert.equal(result.lastReason, 'waiting'); assert.equal(result.nextExpiryAt, now + duration);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|account-private|outbox|1001|10099/);
    assert.deepEqual(windows(db), before); assert.deepEqual(saved(db), pointer);
    const ended = status(db, now + duration); assert.equal(ended.active, 0); assert.equal(ended.completed, 1);
    assert.equal(ended.expiredUnverified, 1); assert.equal(ended.verifiedChecks, 0);
  } finally { db.close(); }
});

test('missing legacy schema is inert and all writes compose within an existing transaction', () => {
  const legacy = new DatabaseSync(':memory:'); try {
    assert.equal(focus(legacy, now), null); assert.equal(status(legacy, now), null);
    assert.equal(complete(legacy, 1, 0, now), false); assert.equal(defer(legacy, 1, now, 'waiting'), false);
    assert.equal(register(legacy, 1, now), false); assert.equal(isCurrent(legacy, 1, 0, now, now), false);
    assert.equal(legacy.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n, 0);
  } finally { legacy.close(); }
  const db = database(); try {
    add(db, 1); db.exec('BEGIN IMMEDIATE'); assert.equal(focus(db, now).outboxId, 1);
    mark(db, 1, now); assert.equal(complete(db, 1, 0, now), true); db.exec('ROLLBACK');
    assert.equal(windows(db).length, 0); assert.equal(focus(db, now + 1).outboxId, 1);
  } finally { db.close(); }
});

for (const missing of ['row', 'tables']) test('Bot windows do not require personal account ' + missing, () => {
  const db = database(); try {
    add(db, 1); add(db, 2); db.exec("UPDATE telegram_relay_outbox SET origin='bot' WHERE id=1");
    if (missing === 'row') db.exec('DELETE FROM telegram_personal_account');
    else db.exec('DROP TABLE telegram_personal_account; DROP TABLE telegram_personal_sources; DROP TABLE telegram_personal_source_posts');
    const current = focus(db, now); assert.equal(current.outboxId, 1); assert.equal(current.sourceEvidence, 'bot_updates');
    defer(db, 1, now + minute, 'bot_updates_gap', 0); assert.equal(status(db, now).lastReason, 'bot_updates_gap');
    assert.equal(status(db, now).sourceEvidence, 'bot_updates'); assert.equal(status(db, now).active, 1);
    assert.equal(isCurrent(db, 1, 0, current.currentStartedAt, now + 1), false);
  } finally { db.close(); }
});

test('busy lease upper bounds resume on actual release and priority cannot be renewed every tick', () => {
  const db = database(); try {
    add(db, 1); focus(db, now); defer(db, 1, now + minute, 'busy', 0);
    db.prepare('UPDATE telegram_personal_account SET lease_until=?').run(now + minute);
    assert.equal(priority(db, now + 1000), false);
    db.exec('UPDATE telegram_personal_account SET lease_until=0');
    assert.equal(priority(db, now + 2000), true); assert.equal(focus(db, now + 2000).retryAt, now + 2000);
    assert.equal(priority(db, now + 16999), true); assert.equal(priority(db, now + 17000), false);
    assert.equal(priority(db, now + 18000), false); assert.equal(focus(db, now + 18000).currentStartedAt, now + 2000);
  } finally { db.close(); }
});

test('future Telegram backoff remains intact and is not counted as overdue runnable work', () => {
  const db = database(); try {
    add(db, 1); focus(db, now); defer(db, 1, now + 5 * minute, 'backoff', 0);
    db.prepare('UPDATE telegram_personal_account SET next_attempt_at=?').run(now + 5 * minute);
    assert.equal(priority(db, now + minute), false); assert.equal(focus(db, now + minute).retryAt, now + 5 * minute);
    assert.deepEqual([status(db, now + 2 * minute).due, status(db, now + 2 * minute).overdue], [0, 0]);
    assert.equal(priority(db, now + 5 * minute), true);
  } finally { db.close(); }
});

test('twenty observed minute slots end without renewing the window, and missed final slots remain unverified', () => {
  const db = database(); try {
    add(db, 1); add(db, 2);
    for (let slot = 0; slot < 20; slot++) {
      const at = now + slot * minute;
      assert.equal(focus(db, at).outboxId, 1);
      mark(db, 1, at); assert.equal(complete(db, 1, 0, at), true);
      if (slot === 0) { assert.equal(focus(db, at).outboxId, 2); mark(db, 2, at); complete(db, 2, 0, at); }
      else { focus(db, at); defer(db, 2, at + minute, 'connection', 0); }
    }
    assert.equal(focus(db, now + duration), null);
    const result = status(db, now + duration);
    assert.deepEqual([result.completed, result.expiredUnverified, result.verifiedChecks], [2, 1, 21]);
    assert.equal(windows(db)[0].expires_at, now + duration);
    assert.equal(focus(db, now + duration + minute), null);
  } finally { db.close(); }
});

test('in-flight identity expires exactly at its window boundary and cannot reuse a previous minute attempt', () => {
  const db = database(); try {
    add(db, 1); const first = focus(db, now);
    assert.equal(isCurrent(db, 1, 0, first.currentStartedAt, now), true);
    mark(db, 1, now); complete(db, 1, 0, now);
    const second = focus(db, now + minute);
    assert.equal(isCurrent(db, 1, 0, first.currentStartedAt, now + minute), false);
    assert.equal(isCurrent(db, 1, 0, second.currentStartedAt, now + duration - 1), true);
    assert.equal(isCurrent(db, 1, 0, second.currentStartedAt, now + duration), false);
    mark(db, 1, now + duration); assert.equal(complete(db, 1, 0, now + duration), false);
  } finally { db.close(); }
});
