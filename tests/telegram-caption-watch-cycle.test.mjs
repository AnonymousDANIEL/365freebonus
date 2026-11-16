import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';

const fixture = mkdtempSync(path.join(tmpdir(), 'caption-serial-cycle-'));
writeFileSync(path.join(fixture, 'package.json'), '{"type":"commonjs"}');
writeFileSync(path.join(fixture, 'cycle.js'), ts.transpileModule(
  readFileSync(new URL('../app/lib/telegram-caption-watch-cycle.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText);
const require = createRequire(import.meta.url);
const { ensureCaptionWatchCycleSchema: schema, captionWatchFocus: focus, completeCaptionWatchFocus: complete,
  deferCaptionWatchFocus: defer, captionWatchCycleStatus: status } = require(path.join(fixture, 'cycle.js'));
const {captionWatchAccountPriority: priority}=require(path.join(fixture,'cycle.js'));
const now = 1_800_000_000_000, hour = 3_600_000;
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
    CREATE TABLE telegram_relay_source_edits(outbox_id INTEGER,source_version INTEGER,status TEXT);
    CREATE TABLE telegram_relay_outbox(id INTEGER PRIMARY KEY,revision TEXT,status TEXT,message_id INTEGER,
      origin TEXT,account_generation TEXT,source_chat_id INTEGER,source_message_id INTEGER,queued_at INTEGER,
      source_version INTEGER DEFAULT 0,source_content_hash TEXT DEFAULT '',caption TEXT DEFAULT 'PRIVATE_CAPTION',
      caption_watch_outcome TEXT DEFAULT '',caption_watch_source_version INTEGER DEFAULT -1,
      caption_watch_checked_at INTEGER DEFAULT 0);`);
  schema(db); return db;
}
function add(db, id, { state = 'sent', invalid = false, source = -1001 } = {}) {
  db.prepare(`INSERT INTO telegram_relay_outbox(id,revision,status,message_id,origin,account_generation,
    source_chat_id,source_message_id,queued_at,source_content_hash) VALUES(?,'current',?,?,'account','account-private',?,?,?,?)`)
    .run(id, state, id + 100, source, id, now - 1000, invalid ? 'invalid:caption' : 'hash');
  db.prepare('INSERT INTO telegram_personal_source_posts VALUES(?,?,?, ?,1)').run(source, id, 'account-private', 'current');
}
function mark(db, id, at, version = 0) {
  db.prepare("UPDATE telegram_relay_outbox SET caption_watch_outcome='consistent',caption_watch_source_version=?,caption_watch_checked_at=? WHERE id=?")
    .run(version, at, id);
}
function saved(db) { return { ...db.prepare("SELECT * FROM telegram_relay_caption_watch_cycle WHERE id='primary'").get() }; }

test('the current unresolved caption survives retries and restart; only fresh exact readback advances', () => {
  const filename = path.join(fixture, 'restart.sqlite'); let db = database(filename);
  try {
    add(db, 1); add(db, 2); const first = focus(db, now);
    assert.equal(first.outboxId, 1); assert.deepEqual([first.position, first.total, first.completed], [1, 2, 0]);
    assert.equal(complete(db, 1, 0, now + 100), false);
    mark(db, 1, now - 1); assert.equal(complete(db, 1, 0, now + 100), false);
    assert.equal(defer(db, 1, now + 120_000, 'backoff'), true);
    db.close(); db = new DatabaseSync(filename);
    const resumed = focus(db, now + 1000);
    assert.equal(resumed.outboxId, 1); assert.equal(resumed.currentStartedAt, now);
    assert.equal(resumed.retryAt, now + 120_000); assert.equal(focus(db, now + 180_000).outboxId, 1);
    mark(db, 1, now + 180_001); assert.equal(complete(db, 1, 0, now + 180_001), true);
    assert.equal(saved(db).current_outbox_id, 0);
    const second = focus(db, now + 180_002); assert.equal(second.outboxId, 2);
    assert.deepEqual([second.position, second.total, second.completed], [2, 2, 1]);
  } finally { db.close(); }
});

test('a newer source version, pending edit or future readback cannot prematurely advance the current caption', () => {
  const db = database(); try {
    add(db, 1); add(db, 2); focus(db, now); mark(db, 1, now);
    db.exec('UPDATE telegram_relay_outbox SET source_version=1 WHERE id=1');
    assert.equal(complete(db, 1, 0, now), false);
    assert.equal(focus(db, now + 1).sourceVersion, 1);
    mark(db, 1, now + 2, 1); assert.equal(complete(db, 1, 1, now + 1), false);
    db.exec("INSERT INTO telegram_relay_source_edits VALUES(1,1,'pending')");
    assert.equal(complete(db, 1, 1, now + 2), false);
    db.exec("UPDATE telegram_relay_source_edits SET status='attempting'");
    assert.equal(complete(db, 1, 1, now + 2), false);
    db.exec("UPDATE telegram_relay_source_edits SET status='confirmed'");
    assert.equal(complete(db, 1, 1, now + 2), true);
  } finally { db.close(); }
});

test('snapshot ceilings keep new posts for the next hourly cycle, with a one-minute floor after a slow cycle', () => {
  const db = database(); try {
    add(db, 1); add(db, 2); focus(db, now); add(db, 3);
    mark(db, 1, now + 1); assert.equal(complete(db, 1, 0, now + 1), true);
    assert.equal(focus(db, now + 2).outboxId, 2);
    mark(db, 2, now + 3); complete(db, 2, 0, now + 3);
    assert.equal(focus(db, now + hour - 1), null);
    assert.equal(status(db, now + 4).position, 0); assert.equal(status(db, now + 4).nextCycleAt, now + hour);
    const next = focus(db, now + hour); assert.equal(next.cycleNumber, 2); assert.equal(next.total, 3);
    for (const id of [1, 2, 3]) {
      assert.equal(focus(db, now + 3 * hour + id).outboxId, id);
      mark(db, id, now + 3 * hour + id); complete(db, id, 0, now + 3 * hour + id);
    }
    assert.equal(status(db, now + 3 * hour + 4).nextCycleAt, now + 3 * hour + 3 + 60_000);
  } finally { db.close(); }
});

test('paused cycles preserve their current caption, while changed target/account scope starts an isolated cycle', () => {
  const db = database(); try {
    add(db, 1); const first = focus(db, now); const before = saved(db);
    db.exec('UPDATE telegram_promotion_settings SET relay_caption_serial_enabled=0');
    assert.equal(focus(db, now + 1), null); assert.equal(complete(db, 1, 0, now + 1), false);
    assert.deepEqual(saved(db), before); assert.equal(status(db, now + 1).paused, true);
    db.exec('UPDATE telegram_promotion_settings SET relay_caption_serial_enabled=1');
    assert.equal(focus(db, now + 2).currentStartedAt, first.currentStartedAt);
    db.exec('UPDATE telegram_relay_state SET target_chat_id=-10098');
    assert.equal(focus(db, now + 3).currentStartedAt, now + 3);
    assert.equal(saved(db).target_chat_id, -10098);
    db.exec("UPDATE telegram_personal_account SET generation='different-account'");
    assert.equal(focus(db, now + 4), null);
    assert.equal(saved(db).account_generation, 'different-account');
  } finally { db.close(); }
});

test('invalid source captions stay focused, but removed/protected sources retire only the private pointer', () => {
  const db = database(); try {
    add(db, 1, { invalid: true }); add(db, 2, { state: 'unknown' });
    const queue = db.prepare('SELECT * FROM telegram_relay_outbox ORDER BY id').all();
    assert.equal(focus(db, now).outboxId, 1); defer(db, 1, now + 5000, 'source_invalid');
    assert.equal(focus(db, now + hour).outboxId, 1);
    mark(db, 1, now + hour); assert.equal(complete(db, 1, 0, now + hour), false);
    db.exec("UPDATE telegram_relay_outbox SET caption_watch_outcome='',caption_watch_source_version=-1,caption_watch_checked_at=0 WHERE id=1");
    db.exec('UPDATE telegram_personal_sources SET blocked=1');
    assert.equal(focus(db, now + hour + 1), null);
    assert.deepEqual(db.prepare('SELECT * FROM telegram_relay_outbox ORDER BY id').all(), queue);
    assert.equal(db.prepare('SELECT last_message_id FROM telegram_personal_sources').get().last_message_id, 1234);
    assert.equal(db.prepare('SELECT next_send_at FROM telegram_relay_state').get().next_send_at, 456);
  } finally { db.close(); }
});

test('status is read-only, aggregates omit identifiers/content and missing legacy schemas are inert', () => {
  const db = database(); try {
    add(db, 1); focus(db, now); defer(db, 1, now + 1000, 'PRIVATE_RAW_ERROR');
    const before = saved(db), result = status(db, now);
    assert.equal(result.lastReason, 'waiting'); assert.equal(result.retryAt, now + 1000);
    assert.equal(result.total, 1); assert.equal(result.position, 1);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|account-private|outbox|1001|10099/);
    assert.deepEqual(saved(db), before);
  } finally { db.close(); }
  const legacy = new DatabaseSync(':memory:'); try {
    assert.equal(focus(legacy, now), null); assert.equal(status(legacy, now), null);
    assert.equal(complete(legacy, 1, 0, now), false); assert.equal(defer(legacy, 1, now, 'waiting'), false);
    assert.equal(legacy.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n, 0);
  } finally { legacy.close(); }
});

test('scheduling writes compose safely inside an existing SQLite transaction', () => {
  const db = database(); try {
    add(db, 1); db.exec('BEGIN IMMEDIATE'); assert.equal(focus(db, now).outboxId, 1);
    mark(db, 1, now); assert.equal(complete(db, 1, 0, now), true); db.exec('ROLLBACK');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM telegram_relay_caption_watch_cycle').get().n, 0);
    assert.equal(focus(db, now + 1).outboxId, 1);
  } finally { db.close(); }
});

for (const missing of ['row', 'tables']) test('Bot focus does not require personal account '+missing,()=>{
  const db=database();try{
    add(db,1);add(db,2);db.exec("UPDATE telegram_relay_outbox SET origin='bot' WHERE id=1");
    if(missing==='row')db.exec('DELETE FROM telegram_personal_account');
    else db.exec('DROP TABLE telegram_personal_account; DROP TABLE telegram_personal_sources; DROP TABLE telegram_personal_source_posts');
    const current=focus(db,now);assert.equal(current.outboxId,1);assert.equal(current.sourceEvidence,'bot_updates');
    defer(db,1,now+5000,'bot_updates_gap');assert.equal(status(db,now).lastReason,'bot_updates_gap');
    assert.equal(status(db,now).sourceEvidence,'bot_updates');
    mark(db,1,now+1);assert.equal(complete(db,1,0,now+1),true);
    assert.equal(focus(db,now+2),null);
  }finally{db.close();}
});

test('a revoked Bot source retires only its private focus while invalid caption data still waits',()=>{
  const db=database();try{
    add(db,1);add(db,2);db.exec("UPDATE telegram_relay_outbox SET origin='bot' WHERE id=1");
    assert.equal(focus(db,now).outboxId,1);
    db.exec("UPDATE telegram_relay_outbox SET source_content_hash='invalid:caption' WHERE id=1");
    assert.equal(focus(db,now+1).outboxId,1);
    db.exec("UPDATE telegram_relay_outbox SET source_content_hash='invalid:source_inactive' WHERE id=1");
    assert.equal(focus(db,now+2).outboxId,2);
    assert.equal(db.prepare('SELECT status FROM telegram_relay_outbox WHERE id=1').get().status,'sent');
  }finally{db.close();}
});

test('busy lease upper bounds resume when released, with only a fifteen-second caption priority window',()=>{
  const db=database();try{
    add(db,1);focus(db,now);defer(db,1,now+60000,'busy');
    db.prepare('UPDATE telegram_personal_account SET lease_until=?').run(now+60000);
    assert.equal(priority(db,now+1000),false);assert.equal(focus(db,now+1000).retryAt,now+60000);
    db.exec('UPDATE telegram_personal_account SET lease_until=0');
    assert.equal(priority(db,now+2000),true);assert.equal(focus(db,now+2000).retryAt,now+2000);
    assert.equal(priority(db,now+16999),true);assert.equal(priority(db,now+17000),false);
    assert.equal(focus(db,now+17000).retryAt,now+2000);
  }finally{db.close();}
});

test('caption priority never advances Telegram backoff or a non-busy retry deadline',()=>{
  const db=database();try{
    add(db,1);focus(db,now);defer(db,1,now+60000,'busy');
    db.prepare('UPDATE telegram_personal_account SET next_attempt_at=?').run(now+120000);
    assert.equal(priority(db,now+1000),false);assert.equal(focus(db,now+1000).retryAt,now+60000);
    db.exec('UPDATE telegram_personal_account SET next_attempt_at=0');
    defer(db,1,now+60000,'backoff');assert.equal(priority(db,now+2000),false);
    assert.equal(focus(db,now+2000).retryAt,now+60000);assert.equal(priority(db,now+60000),true);
  }finally{db.close();}
});

test('each completed caption leaves a durable ten-second background slot before the next priority window',()=>{
  const db=database();try{
    add(db,1);add(db,2);focus(db,now);mark(db,1,now);complete(db,1,0,now);
    const second=focus(db,now+1);assert.equal(second.retryAt,now+10001);
    assert.equal(priority(db,now+10000),false);assert.equal(priority(db,now+10001),true);
    assert.equal(priority(db,now+25001),false);
    const row=saved(db);db.exec('UPDATE telegram_promotion_settings SET relay_caption_watch_enabled=0');
    assert.equal(priority(db,now+11000),false);assert.deepEqual(saved(db),row);
  }finally{db.close();}
});
