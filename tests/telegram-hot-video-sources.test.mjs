import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
const fixture=mkdtempSync(path.join(tmpdir(),'hot-channel-source-sync-'));
writeFileSync(path.join(fixture,'package.json'),'{"type":"commonjs"}');
for(const name of ['sqlite','telegram-hot-video-sources'])writeFileSync(path.join(fixture,name+'.js'),ts.transpileModule(readFileSync(new URL('../app/lib/'+name+'.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText);
writeFileSync(path.join(fixture,'telegram-account.js'),`exports.calls=[];exports.onRead=null;exports.result=null;exports.readHotVideoSourcePages=async(db,input)=>{exports.calls.push(input);if(exports.onRead)await exports.onRead(db,input);return exports.result;};`);
writeFileSync(path.join(fixture,'telegram-hot-videos.js'),`exports.failAt=0;exports.calls=[];exports.registerHotChannelVideo=(db,input)=>{exports.calls.push(input);if(exports.failAt===exports.calls.length)throw Error('Simulated registration failure');const id='source:'+input.sourceChatId+':'+input.sourceMessageId;const result=db.prepare('INSERT OR IGNORE INTO fixture_references(id,source_message_id,document_id,used) VALUES(?,?,?,0)').run(id,input.sourceMessageId,input.documentId);db.prepare("INSERT OR IGNORE INTO telegram_hot_videos(id,title,original_name,file_name,bytes,sha256,sort_order,created_at,origin,source_chat_id,source_message_id,source_document_id) VALUES(?,'Fixture','video.mp4','',?,'',1,?,'channel',?,?,?)").run(id,input.bytes,Date.now(),input.sourceChatId,input.sourceMessageId,input.documentId);return id;};`);
const require=createRequire(import.meta.url),{syncHotVideoSources}=require(path.join(fixture,'telegram-hot-video-sources.js'));
const {getSqlite}=require(path.join(fixture,'sqlite.js')),reader=require(path.join(fixture,'telegram-account.js')),hot=require(path.join(fixture,'telegram-hot-videos.js'));
const oldData=process.env.DATA_DIR,chat=-1001001,revision='source-configuration-revision';let db;
function source(id=chat,extra={}){
 db.prepare(`INSERT INTO telegram_hot_video_sources(chat_id,title,username,selected,revision,last_synced_at,next_attempt_at) VALUES(?,'Source','source',1,?,?,?)`).run(id,revision,extra.syncedAt||0,extra.nextAttemptAt||0);
}
function selected(){return db.prepare('SELECT * FROM telegram_hot_video_sources WHERE chat_id=?').get(chat)}
function reference(messageId){return {sourceMessageId:messageId,documentId:String(700000+messageId),bytes:1702*1024*1024,createdAt:Date.now()-10000}}
test.beforeEach(()=>{
 process.env.DATA_DIR=mkdtempSync(path.join(fixture,'case-'));db=getSqlite();
 db.exec(`CREATE TABLE IF NOT EXISTS telegram_hot_video_sources(chat_id INTEGER PRIMARY KEY,title TEXT NOT NULL DEFAULT '',username TEXT NOT NULL DEFAULT '',selected INTEGER NOT NULL DEFAULT 1,revision TEXT NOT NULL,backfill_before_id INTEGER NOT NULL DEFAULT 0,last_message_id INTEGER NOT NULL DEFAULT 0,backfill_done INTEGER NOT NULL DEFAULT 0,last_synced_at INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '',next_attempt_at INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE telegram_personal_account(id TEXT PRIMARY KEY,generation TEXT,stage TEXT);
 INSERT INTO telegram_personal_account VALUES('primary','account-generation','connected');
 CREATE TABLE fixture_references(id TEXT PRIMARY KEY,source_message_id INTEGER,document_id TEXT,used INTEGER);`);
 if(!db.prepare('PRAGMA table_info(telegram_hot_video_sources)').all().some(c=>c.name==='scan_version'))db.exec('ALTER TABLE telegram_hot_video_sources ADD COLUMN scan_version INTEGER NOT NULL DEFAULT 0');
 reader.calls=[];reader.onRead=null;hot.calls=[];hot.failAt=0;
 reader.result={state:'ok',accountGeneration:'account-generation',sourceTitle:'Private library',sourceUsername:'library',lastMessageId:99,backfillBeforeId:50,backfillDone:false,retryAfterMs:30000,videos:[reference(99),reference(50)]};
});
test.afterEach(()=>{const file=path.join(process.env.DATA_DIR,'directory.sqlite');globalThis.__directorySqlite?.get(file)?.close();globalThis.__directorySqlite?.delete(file)});
test.after(()=>{if(oldData===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=oldData;rmSync(fixture,{recursive:true,force:true})});
test('metadata synchronization imports references and durable independent cursors without creating a publication task',async()=>{
 source();const result=await syncHotVideoSources(db);assert.deepEqual(result,{scanned:1,discovered:2,skipped:0});
 assert.deepEqual(reader.calls,[{chatId:chat,revision,beforeId:0,afterId:0,backfillDone:false}]);
 assert.deepEqual(hot.calls[0],{sourceChatId:chat,sourceMessageId:99,sourceTitle:'Private library',documentId:'700099',bytes:1702*1024*1024,createdAt:reader.result.videos[0].createdAt});
 assert.equal(selected().last_message_id,99);assert.equal(selected().backfill_before_id,50);assert.equal(selected().backfill_done,0);assert.equal(selected().title,'Private library');assert.equal(selected().username,'library');assert.equal(selected().last_error,'');assert.ok(selected().last_synced_at>0);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM telegram_hot_video_jobs').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM telegram_hot_video_uploads').get().n,0);
});
test('checkpoint and every new reference roll back together when registration cannot finish',async()=>{
 source();hot.failAt=2;await assert.rejects(syncHotVideoSources(db),/registration/);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fixture_references').get().n,0);assert.equal(selected().last_message_id,0);assert.equal(selected().backfill_before_id,0);assert.equal(selected().last_synced_at,0);
 hot.calls=[];hot.failAt=0;await syncHotVideoSources(db);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fixture_references').get().n,2);assert.equal(selected().last_message_id,99);
});
for(const change of ['deselect','revision','account-generation','disconnect'])test('a '+change+' during the history read cannot commit a stale snapshot',async()=>{
 source();reader.onRead=db=>{if(change==='deselect')db.prepare('UPDATE telegram_hot_video_sources SET selected=0').run();else if(change==='revision')db.prepare("UPDATE telegram_hot_video_sources SET revision='replaced'").run();else if(change==='account-generation')db.prepare("UPDATE telegram_personal_account SET generation='changed'").run();else db.prepare("UPDATE telegram_personal_account SET stage='disconnected'").run()};
 const result=await syncHotVideoSources(db);assert.equal(result.scanned,0);assert.equal(hot.calls.length,0);assert.equal(selected().last_message_id,0);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fixture_references').get().n,0);
});
test('protected source surfaces a fixed explanation and retries later without importing or advancing cursors',async()=>{
 source();reader.result={...reader.result,state:'protected',videos:[]};await syncHotVideoSources(db);assert.match(selected().last_error,/限制转发/);assert.ok(selected().next_attempt_at>Date.now());assert.equal(selected().last_message_id,0);assert.equal(hot.calls.length,0);
 await syncHotVideoSources(db);assert.equal(reader.calls.length,1);
});
test('source import duplicate leaves an already used entry used and advances only its own scanner cursor',async()=>{
 source();await syncHotVideoSources(db);db.prepare('UPDATE fixture_references SET used=1').run();db.prepare('UPDATE telegram_hot_video_sources SET next_attempt_at=0').run();
 const r=await syncHotVideoSources(db);assert.equal(r.discovered,0);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fixture_references WHERE used=1').get().n,2);
});
test('default pass scans one due source and explicit refresh remains bounded to ten due selected sources',async()=>{
 for(let i=1;i<=15;i++)source(-1002000-i);
 source(-1003000,{nextAttemptAt:Date.now()+600000});db.prepare('UPDATE telegram_hot_video_sources SET selected=0 WHERE chat_id=?').run(-1002001);
 assert.equal((await syncHotVideoSources(db)).scanned,1);assert.equal(reader.calls.length,1);
 reader.calls=[];assert.equal((await syncHotVideoSources(db,{all:true})).scanned,10);assert.equal(reader.calls.length,10);assert.equal(reader.calls.some(c=>[-1003000,-1002001].includes(c.chatId)),false);
});

test('a still-selected source that disappeared from joined peers displays a fixed actionable error',async()=>{
 source();reader.result={...reader.result,state:'changed',videos:[]};const r=await syncHotVideoSources(db);
 assert.equal(r.scanned,0);assert.match(selected().last_error,/刷新频道列表/);assert.match(selected().last_error,/已加入来源频道/);assert.equal(selected().last_message_id,0);assert.equal(hot.calls.length,0);assert.ok(selected().next_attempt_at>Date.now());
});

test('an explicit multi-source refresh stops starting new reads after its wall-clock budget',async t=>{
 for(let i=1;i<=5;i++)source(-1004000-i);
 let now=Date.now();t.mock.method(Date,'now',()=>now);reader.onRead=()=>{now+=16000};
 const r=await syncHotVideoSources(db,{all:true});assert.equal(r.scanned,1);assert.equal(reader.calls.length,1);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM telegram_hot_video_sources WHERE last_synced_at=0').get().n,4);
});

test('parser recovery rechecks an already advanced empty source and checkpoints the new parser version atomically',async()=>{
 source();db.prepare('UPDATE telegram_hot_video_sources SET last_message_id=999,backfill_before_id=1,backfill_done=1,scan_version=0').run();
 const r=await syncHotVideoSources(db);assert.equal(r.discovered,2);assert.deepEqual(reader.calls,[{chatId:chat,revision,beforeId:0,afterId:0,backfillDone:false}]);assert.equal(selected().scan_version,1);assert.equal(selected().last_message_id,99);assert.equal(selected().backfill_before_id,50);assert.equal(selected().backfill_done,0);
 db.prepare('UPDATE telegram_hot_video_sources SET next_attempt_at=0').run();reader.calls=[];await syncHotVideoSources(db);assert.deepEqual(reader.calls,[{chatId:chat,revision,beforeId:50,afterId:99,backfillDone:false}]);
});
test('failed parser recovery keeps the previous cursor and recovery budget until an import commits',async()=>{
 source();db.prepare('UPDATE telegram_hot_video_sources SET last_message_id=999,backfill_before_id=1,backfill_done=1,scan_version=0').run();hot.failAt=2;
 await assert.rejects(syncHotVideoSources(db),/registration/);assert.equal(selected().scan_version,0);assert.equal(selected().last_message_id,999);assert.equal(selected().backfill_before_id,1);assert.equal(selected().backfill_done,1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fixture_references').get().n,0);
});
test('parser recovery preserves previously used references and terminal unknown publication records',async()=>{
 source();await syncHotVideoSources(db);db.prepare('UPDATE fixture_references SET used=1').run();db.prepare('UPDATE telegram_hot_videos SET last_sent_at=?').run(Date.now());
 const first=db.prepare('SELECT id FROM telegram_hot_videos LIMIT 1').get().id;
 db.prepare(`INSERT INTO telegram_hot_video_jobs(id,request_id,video_id,kind,status,run_at,created_at,settings_revision,target_chat_id,token_hash,bot_id,dispatch_started_at,last_error) VALUES('existing-unknown','existing-request',?,'manual','unknown',1,1,'saved-revision',-1009999,'private-token-hash',123,1,'unconfirmed')`).run(first);
 const jobs=db.prepare('SELECT * FROM telegram_hot_video_jobs').all(),videos=db.prepare('SELECT id,last_sent_at FROM telegram_hot_videos ORDER BY id').all();db.prepare('UPDATE telegram_hot_video_sources SET scan_version=0,next_attempt_at=0').run();
 const r=await syncHotVideoSources(db);assert.equal(r.discovered,0);assert.equal(selected().scan_version,1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fixture_references WHERE used=1').get().n,2);assert.deepEqual(db.prepare('SELECT id,last_sent_at FROM telegram_hot_videos ORDER BY id').all(),videos);assert.deepEqual(db.prepare('SELECT * FROM telegram_hot_video_jobs').all(),jobs);
});
