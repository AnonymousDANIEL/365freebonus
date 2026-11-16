import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const fixture=mkdtempSync(path.join(tmpdir(),'caption-watch-status-'));
writeFileSync(path.join(fixture,'package.json'),'{"type":"commonjs"}');
writeFileSync(path.join(fixture,'status.js'),ts.transpileModule(
  readFileSync(new URL('../app/lib/telegram-caption-watch-status.ts',import.meta.url),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}},
).outputText);
writeFileSync(path.join(fixture,'telegram-caption-watch-cycle.js'),ts.transpileModule(
  readFileSync(new URL('../app/lib/telegram-caption-watch-cycle.ts',import.meta.url),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}},
).outputText);
const require=createRequire(import.meta.url);
const {relayCaptionWatchStatus}=require(path.join(fixture,'status.js'));
const now=1_800_000_000_000;
function database(){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE telegram_promotion_settings(id TEXT,relay_enabled INTEGER,relay_revision TEXT,
    relay_caption_watch_enabled INTEGER,relay_caption_watch_interval_seconds INTEGER);
    INSERT INTO telegram_promotion_settings VALUES('primary',1,'current',1,30);
    CREATE TABLE telegram_relay_outbox(id INTEGER PRIMARY KEY,revision TEXT,status TEXT,message_id INTEGER,
      origin TEXT,account_generation TEXT,source_chat_id INTEGER,source_message_id INTEGER,queued_at INTEGER,source_version INTEGER DEFAULT 0,
      source_content_hash TEXT DEFAULT '',
      caption_watch_checked_at INTEGER DEFAULT 0,caption_watch_next_at INTEGER DEFAULT 0,
      caption_watch_outcome TEXT DEFAULT '',caption_watch_source_version INTEGER DEFAULT 0,
      caption TEXT DEFAULT 'PRIVATE_CAPTION',last_error TEXT DEFAULT 'PRIVATE_ERROR');
    CREATE TABLE telegram_relay_source_edits(outbox_id INTEGER,source_version INTEGER,status TEXT,next_attempt_at INTEGER);
    CREATE TABLE telegram_personal_account(id TEXT,stage TEXT,generation TEXT,next_attempt_at INTEGER DEFAULT 0,lease_until INTEGER DEFAULT 0);
    INSERT INTO telegram_personal_account(id,stage,generation) VALUES('primary','connected','account');
    CREATE TABLE telegram_personal_sources(chat_id INTEGER,selected INTEGER,joined INTEGER,blocked INTEGER,selected_at INTEGER);
    INSERT INTO telegram_personal_sources VALUES(-10,1,1,0,1);
    CREATE TABLE telegram_personal_source_posts(source_chat_id INTEGER,source_message_id INTEGER,account_generation TEXT,
      relay_revision TEXT,selected_at INTEGER);`);
  return db;
}
function add(db,id,outcome='',extra={}){
  db.prepare(`INSERT INTO telegram_relay_outbox(id,revision,status,message_id,origin,account_generation,
    source_chat_id,source_message_id,queued_at,caption_watch_outcome,caption_watch_checked_at,caption_watch_next_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,extra.revision||'current',extra.status||'sent',id+100,
      extra.origin||'account','account',extra.source||-10,id,now-1000,outcome,
      extra.checked??(outcome?now-100:0),extra.next??now+30_000);
  db.prepare('INSERT INTO telegram_personal_source_posts VALUES(?,?,?,?,1)').run(extra.source||-10,id,'account',extra.revision||'current');
}
test.after(()=>rmSync(fixture,{recursive:true,force:true}));

test('watch counts distinguish verified consistency, pending revisions and unknown media without modifying rows',()=>{
  const db=database();
  try{
    add(db,1,'consistent'); add(db,2); add(db,3,'mismatch'); add(db,4,'waiting'); add(db,5,'checking');
    add(db,6,'consistent'); add(db,7,'consistent',{status:'unknown'});
    add(db,8,'consistent',{revision:'old'}); add(db,9,'consistent',{source:-11});
    db.prepare("INSERT INTO telegram_relay_source_edits VALUES(6,0,'pending',?)").run(now+5000);
    const before=db.prepare('SELECT * FROM telegram_relay_outbox').all();
    const result=relayCaptionWatchStatus(db,now);
    assert.equal(result.watched,6);
    assert.deepEqual([result.pending,result.checking,result.consistent,result.mismatch,result.waiting],[2,1,1,1,1]);
    assert.equal(result.lastCheckedAt,now-100); assert.equal(result.nextCheckAt,now+5000);
    assert.deepEqual(db.prepare('SELECT * FROM telegram_relay_outbox').all(),before);
    assert.equal(JSON.stringify(result).includes('PRIVATE_'),false);
  } finally{db.close();}
});

test('disabled observation preserves counts but does not advertise a scheduled next check',()=>{
  const db=database();
  try{
    add(db,1); db.exec('UPDATE telegram_promotion_settings SET relay_caption_watch_enabled=0');
    const result=relayCaptionWatchStatus(db,now);
    assert.equal(result.watched,1); assert.equal(result.pending,1);
    assert.equal(result.lastCheckedAt,null); assert.equal(result.nextCheckAt,null);
  } finally{db.close();}
});

test('a terminal source edit remains waiting until positive current target readback exists',()=>{
  const db=database();
  try{
    add(db,1); db.exec("INSERT INTO telegram_relay_source_edits VALUES(1,0,'uncertain',0)");
    assert.equal(relayCaptionWatchStatus(db,now).waiting,1);
    db.exec("UPDATE telegram_relay_outbox SET caption_watch_outcome='consistent'");
    assert.equal(relayCaptionWatchStatus(db,now).consistent,1);
    assert.equal(db.prepare('SELECT status FROM telegram_relay_source_edits').get().status,'uncertain');
  } finally{db.close();}
});

test('old version consistency cannot report a newly failed source version as matching',()=>{
  const db=database();
  try{
    add(db,1,'consistent');
    db.exec("UPDATE telegram_relay_outbox SET source_version=1; INSERT INTO telegram_relay_source_edits VALUES(1,1,'uncertain',0)");
    const result=relayCaptionWatchStatus(db,now);
    assert.equal(result.consistent,0); assert.equal(result.waiting,1);
  } finally{db.close();}
});

test('disconnected account shows existing tracked deliveries as waiting rather than an empty monitor',()=>{
  const db=database();
  try{
    add(db,1,'consistent'); db.exec("UPDATE telegram_personal_account SET stage='disconnected'");
    const result=relayCaptionWatchStatus(db,now);
    assert.equal(result.watched,1); assert.equal(result.waiting,1); assert.equal(result.consistent,0);
    assert.equal(result.nextCheckAt,null);
  } finally{db.close();}
});

test('removed or protected source watches are excluded even if delivery history remains',()=>{
  const db=database();
  try{
    add(db,1,'consistent'); db.exec('DELETE FROM telegram_personal_source_posts');
    assert.equal(relayCaptionWatchStatus(db,now).watched,0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM telegram_relay_outbox').get().n,1);
  } finally{db.close();}
});

test('bot-origin target checks also wait for the personal account used for Telegram readback',()=>{
  const db=database();
  try{
    add(db,1,'consistent',{origin:'bot'}); db.exec("UPDATE telegram_personal_account SET stage='disconnected'");
    const result=relayCaptionWatchStatus(db,now);
    assert.equal(result.watched,1); assert.equal(result.waiting,1); assert.equal(result.nextCheckAt,null);
  } finally{db.close();}
});

test('invalid source metadata requires attention rather than showing an endless pending check',()=>{
  const db=database();
  try{
    add(db,1); db.exec("UPDATE telegram_relay_outbox SET source_content_hash='invalid:media_changed'");
    const result=relayCaptionWatchStatus(db,now);
    assert.equal(result.waiting,1); assert.equal(result.mismatch,0); assert.equal(result.pending,0); assert.equal(result.nextCheckAt,null);
  } finally{db.close();}
});

test('next check respects the account rate-limit and lease deadlines',()=>{
  const db=database();
  try{
    add(db,1); db.prepare('UPDATE telegram_personal_account SET next_attempt_at=?,lease_until=?').run(now+120_000,now+10_000);
    assert.equal(relayCaptionWatchStatus(db,now).nextCheckAt,now+120_000);
  } finally{db.close();}
});
