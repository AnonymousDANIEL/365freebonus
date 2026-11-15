import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';

// Actual SQLite migrations/status/dispatch/scheduler loops. Native Telegram and
// metadata transport alone are mocked; the fixture never opens a network socket.
const fixture=mkdtempSync(path.join(tmpdir(),'hot-video-scheduler-'));
writeFileSync(path.join(fixture,'package.json'),'{"type":"commonjs"}');
for(const name of ['sqlite','telegram-hot-video-limits','telegram-hot-videos'])
 writeFileSync(path.join(fixture,name+'.js'),ts.transpileModule(readFileSync(new URL('../app/lib/'+name+'.ts',import.meta.url),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText);
writeFileSync(path.join(fixture,'telegram-bot.js'),`
exports.calls=[];
exports.telegramRequest=async(token,method,p={})=>{
 exports.calls.push({method,p});
 if(method==='getMe')return {ok:true,result:{id:12345678,is_bot:true,username:'FreeBonus365ChatBot'}};
 if(method==='getChat')return {ok:true,result:{id:p.chat_id,type:'channel',title:'Hot'}};
 if(method==='getChatMember')return {ok:true,result:{status:'administrator',can_post_messages:true}};
 throw new Error('Unexpected HTTP Bot API operation');
};
exports.telegramVideoFileRequest=async()=>{throw new Error('Scheduler fixtures must not upload media');};
`);
writeFileSync(path.join(fixture,'telegram-hot-video-native.js'),`
exports.media=[];exports.markers=[];exports.onSend=null;
exports.checkHotVideoSourceAccess=async()=>({title:'Fixture source',username:''});
exports.sendHotChannelVideo=async input=>{
 exports.media.push(input);input.onDispatch();if(exports.onSend)await exports.onSend(input);
 return {ok:true,result:{message_id:700+exports.media.length,chat:{id:input.targetId},video:{width:1280},caption:'',reply_markup:{inline_keyboard:require('./telegram-hot-videos').hotVideoKeyboard()}}};
};
exports.markHotChannelVideoUsed=async input=>{exports.markers.push(input);input.onDispatch();return {ok:true,result:{message_id:900+exports.markers.length,chat:{id:input.sourceChatId},text:'✅ Sent · Used',reply_to_message:{message_id:input.sourceMessageId}}};};
exports.sendLargeHotVideo=async()=>{throw new Error('Scheduler fixtures must not upload media');};
`);
writeFileSync(path.join(fixture,'telegram-hot-video-sources.js'),`
exports.calls=[];exports.onSync=null;
exports.syncHotVideoSources=async db=>{exports.calls.push({at:Date.now()});if(exports.onSync)await exports.onSync(db);
 db.prepare('UPDATE telegram_hot_video_sources SET next_attempt_at=? WHERE selected=1').run(Date.now()+30000);
 return {scanned:1,discovered:0,skipped:0};};
`);
const require=createRequire(import.meta.url),hot=require(path.join(fixture,'telegram-hot-videos.js'));
const native=require(path.join(fixture,'telegram-hot-video-native.js')),source=require(path.join(fixture,'telegram-hot-video-sources.js'));
const telegram=require(path.join(fixture,'telegram-bot.js'));
const {getSqlite}=require(path.join(fixture,'sqlite.js'));
const oldData=process.env.DATA_DIR;
const START=1800000000000,HOUR=3600000,TARGET=-1004321816132,SOURCE=-1004321816001,CIPHER='fixture-encrypted-chatbot-token';
let now,intervals,releases;
const db=()=>getSqlite(),clock=()=>now;
const config=()=>db().prepare("SELECT * FROM telegram_hot_video_settings WHERE id='primary'").get();
const runtime=()=>db().prepare("SELECT * FROM telegram_hot_video_runtime WHERE id='primary'").get();
const jobs=()=>db().prepare('SELECT * FROM telegram_hot_video_jobs ORDER BY run_at,created_at,id').all();
const scheduler=()=>hot.hotVideoStatus(db(),clock).scheduler;
const decrypt=value=>{assert.equal(value,CIPHER);return '12345678:fixture-private-token'};
const save=(extra={})=>hot.saveHotVideoSettings(db(),{enabled:true,targetChatId:String(TARGET),intervalHours:6,firstRunAt:null,sources:[String(SOURCE)],markSourceUsed:false,...extra},decrypt,clock);
const add=(id=1)=>hot.registerHotChannelVideo(db(),{sourceChatId:SOURCE,sourceMessageId:id,sourceTitle:'Fixture source',documentId:String(10000+id),bytes:1702*1024*1024,createdAt:START-1000},clock);
const queue=(id,runAt=null)=>hot.enqueueHotVideo(db(),{videoId:id,runAt,requestId:randomUUID()},decrypt,clock);
const deliver=()=>hot.deliverHotVideoOnce(decrypt,clock);
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});releases.push(resolve);return {promise,resolve}};
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();await new Promise(done=>setImmediate(done))};
async function until(predicate){for(let i=0;i<60;i++){if(predicate())return;await flush()}assert.ok(predicate(),'asynchronous fixture reached the expected state')}
function start(t){
 t.mock.method(globalThis,'setInterval',(callback,ms)=>{intervals.push({callback,ms});return {unref(){}}});
 t.mock.method(console,'info',()=>undefined);
 hot.startTelegramHotVideoWorker(decrypt);assert.equal(intervals.length,2);assert.deepEqual(intervals.map(i=>i.ms),[5000,5000]);
}
function close(){const filename=path.join(process.env.DATA_DIR,'directory.sqlite');globalThis.__directorySqlite?.get(filename)?.close();globalThis.__directorySqlite?.delete(filename)}
test.beforeEach(t=>{
 process.env.DATA_DIR=mkdtempSync(path.join(fixture,'case-'));now=START;intervals=[];releases=[];
 t.mock.method(Date,'now',()=>now);delete globalThis.telegramHotVideoWorkerStarted;
 native.media.length=0;native.markers.length=0;native.onSend=null;source.calls.length=0;source.onSync=null;
 db().prepare("INSERT INTO telegram_promotion_settings(id,enabled,chat_id,token_ciphertext,chat_bot_token_ciphertext) VALUES('primary',0,'','',?)").run(CIPHER);
 db().prepare("INSERT INTO telegram_join_gate_settings(id,target_chat_id,target_title) VALUES('primary',?,'Hot')").run(TARGET);
});
test.afterEach(async()=>{for(const release of releases)release();await flush();await flush();close();delete globalThis.telegramHotVideoWorkerStarted});
test.after(()=>{if(oldData===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=oldData;rmSync(fixture,{recursive:true,force:true})});

test('scheduler status reports server time, actual eligibility and genuine saved jobs instead of inventing per-video times',async()=>{
 await save();const eligible=add(1),reserved=add(2),unknown=add(3),failed=add(4),used=add(5),inactive=add(6);
 await queue(reserved,now+HOUR);await queue(unknown);db().prepare("UPDATE telegram_hot_video_jobs SET status='unknown',dispatch_started_at=? WHERE video_id=?").run(now,unknown);
 await queue(failed);db().prepare("UPDATE telegram_hot_video_jobs SET status='failed' WHERE video_id=?").run(failed);
 db().prepare('UPDATE telegram_hot_videos SET last_sent_at=? WHERE id=?').run(now-1000,used);hot.updateHotVideo(db(),{id:inactive,active:false},clock);
 db().prepare("UPDATE telegram_hot_video_runtime SET heartbeat_at=?,last_tick_at=?,last_completed_at=?,phase='idle',scan_phase='idle' WHERE id='primary'").run(now-1000,now-1000,now-2000);
 const state=scheduler();assert.equal(state.now,now);assert.equal(state.heartbeatAt,now-1000);assert.equal(state.workerHealthy,true);assert.equal(state.eligibleCount,1);assert.equal(state.unusedCount,4);assert.equal(state.queuedCount,1);assert.equal(state.sourceCount,1);
 assert.equal(state.nextRunAt,config().next_run_at);assert.deepEqual(state.nextJobs.map(j=>[j.videoId,j.runAt,j.kind,j.status]),[[reserved,now+HOUR,'scheduled','pending']]);
 assert.equal(state.nextJobs.some(j=>j.videoId===eligible),false);assert.equal(state.blockedReason,'');
});
test('worker health uses the persisted heartbeat age and accurately signals startup or recovery',async()=>{
 await save();add();assert.equal(scheduler().workerHealthy,false);assert.match(scheduler().blockedReason,/启动|恢复/);
 db().prepare("UPDATE telegram_hot_video_runtime SET heartbeat_at=? WHERE id='primary'").run(now-19999);assert.equal(scheduler().workerHealthy,true);
 db().prepare("UPDATE telegram_hot_video_runtime SET heartbeat_at=? WHERE id='primary'").run(now-20000);assert.equal(scheduler().workerHealthy,false);
});
test('scheduler phase derives actual media and source-marker leases rather than a stale idle flag',async()=>{
 await save();const id=add();await queue(id);const lease=randomUUID();db().prepare("UPDATE telegram_hot_video_runtime SET heartbeat_at=?,phase='idle' WHERE id='primary'").run(now);
 db().prepare("UPDATE telegram_hot_video_jobs SET status='sending',lease_id=?,lease_until=? WHERE video_id=?").run(lease,now+120000,id);assert.equal(scheduler().phase,'sending');
 db().prepare("UPDATE telegram_hot_video_jobs SET status='sent',marker_status='sending' WHERE video_id=?").run(id);assert.equal(scheduler().phase,'marker');assert.equal(scheduler().queuedCount,0);
});
test('selected empty source queue holds the original due slot for at most sixty seconds without claiming a send',async()=>{
 await save();const due=config().next_run_at;now=due;await deliver();assert.equal(config().next_run_at,due);assert.equal(jobs().length,0);assert.equal(native.media.length,0);assert.match(config().last_error,/同步/);
 now=due+59999;await deliver();assert.equal(config().next_run_at,due);assert.equal(jobs().length,0);
 now=due+60000;await deliver();assert.equal(config().next_run_at,due+6*HOUR);assert.equal(jobs().length,0);assert.equal(native.media.length,0);assert.match(config().last_error,/跳过/);
});
test('source video arriving during the synchronization grace sends once and keeps the next slot anchored to the original cadence',async()=>{
 await save();const due=config().next_run_at;now=due;await deliver();now=due+30000;const id=add();await deliver();
 assert.equal(native.media.length,1);assert.equal(jobs()[0].video_id,id);assert.equal(jobs()[0].status,'sent');assert.equal(jobs()[0].run_at,due);assert.equal(jobs()[0].sent_at,now);assert.equal(config().next_run_at,due+6*HOUR);
 now+=5000;await deliver();assert.equal(native.media.length,1);assert.equal(jobs().length,1);
});
test('empty grace expiration coalesces a later long downtime without a burst of fake or catch-up jobs',async()=>{
 await save();const firstDue=config().next_run_at;now=firstDue+60000;await deliver();assert.equal(config().next_run_at,firstDue+6*HOUR);
 now=firstDue+31*HOUR+60000;await deliver();assert.equal(config().next_run_at,firstDue+36*HOUR);assert.equal(jobs().length,0);assert.equal(native.media.length,0);
 now+=5000;await deliver();assert.equal(jobs().length,0);assert.equal(native.media.length,0);
});
test('an actual one-time scheduled job still executes while the empty automatic queue waits within its grace',async()=>{
 await save();const due=config().next_run_at,id=add();await queue(id,due);now=due;await deliver();
 assert.equal(native.media.length,1);assert.equal(jobs()[0].kind,'scheduled');assert.equal(jobs()[0].status,'sent');assert.equal(config().next_run_at,due);
 now=due+60000;await deliver();assert.equal(config().next_run_at,due+6*HOUR);assert.equal(native.media.length,1);
});
test('a source marker waiting for a future retry does not block an independent source scan',async t=>{
 await save({markSourceUsed:true});const id=add();await queue(id);await deliver();db().prepare("UPDATE telegram_hot_video_jobs SET marker_next_attempt_at=? WHERE video_id=?").run(now+HOUR,id);
 start(t);await until(()=>source.calls.length===1 && runtime().scan_phase==='idle');assert.equal(native.media.length,1);assert.equal(native.markers.length,0);assert.equal(jobs()[0].marker_status,'pending');
});
test('a slow metadata scan cannot prevent a separately scheduled publication from running',async t=>{
 await save();const scan=deferred();source.onSync=()=>scan.promise;start(t);await until(()=>source.calls.length===1 && runtime().scan_phase==='running' && runtime().phase==='idle');
 const id=add(),runAt=now+10000;await queue(id,runAt);now=runAt;intervals[0].callback();await until(()=>jobs()[0]?.status==='sent');
 assert.equal(native.media.length,1);assert.equal(runtime().scan_phase,'running');assert.equal(source.calls.length,1);assert.equal(jobs()[0].run_at,runAt);scan.resolve();await until(()=>runtime().scan_phase==='idle');
});
test('a slow actual native publication cannot prevent the source worker from scanning again',async t=>{
 await save();const id=add();await queue(id);const send=deferred();native.onSend=()=>send.promise;start(t);
 await until(()=>native.media.length===1 && source.calls.length===1 && runtime().scan_phase==='idle');assert.equal(jobs()[0].status,'sending');
 now+=35000;intervals[1].callback();await until(()=>source.calls.length===2 && runtime().scan_phase==='idle');assert.equal(jobs()[0].status,'sending');assert.equal(native.media.length,1);
 send.resolve();await until(()=>jobs()[0].status==='sent' && runtime().phase==='idle');
});
test('the publishing heartbeat keeps advancing while an asynchronous media request is still in flight',async t=>{
 await save();const id=add();await queue(id);const send=deferred();native.onSend=()=>send.promise;start(t);await until(()=>native.media.length===1 && jobs()[0].status==='sending');
 const initialTick=runtime().last_tick_at;assert.equal(runtime().heartbeat_at,START);
 now+=5000;intervals[0].callback();await flush();assert.equal(runtime().heartbeat_at,now);assert.equal(runtime().last_tick_at,initialTick);assert.equal(scheduler().workerHealthy,true);assert.equal(scheduler().phase,'sending');
 now+=20000;intervals[0].callback();await flush();assert.equal(runtime().heartbeat_at,now);assert.equal(native.media.length,1);
 send.resolve();await until(()=>jobs()[0].status==='sent' && runtime().phase==='idle');assert.equal(runtime().last_completed_at,now);
});
test('a fresh process owner clears stale in-progress runtime flags and resumes with fresh heartbeats',async t=>{
 await save();db().prepare("UPDATE telegram_hot_video_sources SET next_attempt_at=?").run(now+HOUR);
 db().prepare("UPDATE telegram_hot_video_runtime SET owner_id='retired-process',heartbeat_at=?,phase='sending',scan_phase='running',last_error='stale process error' WHERE id='primary'").run(now-HOUR);
 start(t);await until(()=>runtime().phase==='idle');assert.notEqual(runtime().owner_id,'retired-process');assert.equal(runtime().scan_phase,'idle');assert.equal(runtime().last_error,'');assert.equal(runtime().heartbeat_at,now);assert.equal(scheduler().workerHealthy,true);assert.equal(source.calls.length,0);assert.equal(native.media.length,0);
});
test('a transient publishing phase database write failure does not freeze the worker running flag',async t=>{
 await save();db().prepare("UPDATE telegram_hot_video_sources SET next_attempt_at=?").run(now+HOUR);const database=db(),prepare=database.prepare.bind(database);let failures=0;
 t.mock.method(database,'prepare',sql=>{if(failures===0 && sql.includes("last_tick_at=?,phase='checking'")){failures++;throw new Error('Temporary SQLite write contention')}return prepare(sql)});
 start(t);await until(()=>failures===1);await flush();now+=5000;intervals[0].callback();await until(()=>runtime().last_completed_at===now && runtime().phase==='idle');assert.equal(runtime().last_tick_at,now);assert.equal(runtime().heartbeat_at,now);
});
test('a transient source phase write failure does not freeze the independent scanning flag',async t=>{
 await save();const database=db(),prepare=database.prepare.bind(database);let failures=0;
 t.mock.method(database,'prepare',sql=>{if(failures===0 && sql.includes("scan_started_at=?,scan_phase='running'")){failures++;throw new Error('Temporary source phase contention')}return prepare(sql)});
 start(t);await until(()=>failures===1);await flush();now+=5000;intervals[1].callback();await until(()=>source.calls.length===1 && runtime().scan_phase==='idle');assert.equal(runtime().last_scan_at,now);
});

test('a transient publishing heartbeat write failure is caught and retried by the next timer tick',async t=>{
 await save();db().prepare("UPDATE telegram_hot_video_sources SET next_attempt_at=?").run(now+HOUR);const database=db(),prepare=database.prepare.bind(database);let failures=0;
 t.mock.method(database,'prepare',sql=>{if(failures===0 && sql.startsWith('UPDATE telegram_hot_video_runtime SET heartbeat_at=')){failures++;throw new Error('Temporary heartbeat contention')}return prepare(sql)});
 start(t);await until(()=>failures===1);await flush();now+=5000;intervals[0].callback();await until(()=>runtime().phase==='idle' && runtime().heartbeat_at===now);assert.equal(runtime().last_completed_at,now);assert.equal(scheduler().workerHealthy,true);
});
test('a source heartbeat failure before scanning starts cannot disable later source timer checks',async t=>{
 await save();const database=db(),prepare=database.prepare.bind(database);let failures=0;
 t.mock.method(database,'prepare',sql=>{if(failures===0 && sql.startsWith('UPDATE telegram_hot_video_runtime SET scan_heartbeat_at=')){failures++;throw new Error('Temporary source heartbeat contention')}return prepare(sql)});
 start(t);await until(()=>failures===1);await flush();assert.equal(source.calls.length,0);now+=5000;intervals[1].callback();await until(()=>source.calls.length===1 && runtime().scan_phase==='idle');assert.equal(runtime().scan_heartbeat_at,now);assert.equal(runtime().last_scan_at,now);
});

test('time-only saves are local and preserve source cursors/backoff plus the original verification timestamps',async t=>{
 await save();const verifiedAt=config().verified_at,lastCheckedAt=config().last_checked_at;
 now+=120000;
 db().prepare(`UPDATE telegram_hot_video_sources SET last_error='Original source backoff warning',next_attempt_at=?,last_message_id=82,
  backfill_before_id=40,backfill_done=1,last_synced_at=?,scan_version=1 WHERE chat_id=?`).run(now+HOUR,now-1000,SOURCE);
 const sourceBefore=JSON.stringify(db().prepare('SELECT * FROM telegram_hot_video_sources WHERE chat_id=?').get(SOURCE));
 const http=t.mock.method(telegram,'telegramRequest',async()=>{throw new Error('A local time save must not call Telegram')});
 const checks=t.mock.method(native,'checkHotVideoSourceAccess',async()=>{throw new Error('A local time save must not recheck unchanged sources')});
 const first=now+2*HOUR;await save({intervalHours:3,firstRunAt:first});
 assert.equal(config().interval_hours,3);assert.equal(config().next_run_at,first);assert.equal(config().verified_at,verifiedAt);assert.equal(config().last_checked_at,lastCheckedAt);
 assert.equal(JSON.stringify(db().prepare('SELECT * FROM telegram_hot_video_sources WHERE chat_id=?').get(SOURCE)),sourceBefore);
 assert.equal(http.mock.callCount(),0);assert.equal(checks.mock.callCount(),0);assert.equal(native.media.length,0);
 now+=30000;await save({intervalHours:3,firstRunAt:null});assert.equal(config().next_run_at,first);assert.equal(config().verified_at,verifiedAt);
 assert.equal(http.mock.callCount(),0);assert.equal(checks.mock.callCount(),0);assert.equal(JSON.stringify(db().prepare('SELECT * FROM telegram_hot_video_sources WHERE chat_id=?').get(SOURCE)),sourceBefore);
});
test('changing destination or bot credential cannot reuse the cached target verification',async t=>{
 await save();const before=JSON.stringify(config()),requests=[];
 t.mock.method(telegram,'telegramRequest',async(token,method,parameters)=>{requests.push({token,method,parameters});return {ok:false,code:403,retryAfter:0}});
 const sourceChecks=t.mock.method(native,'checkHotVideoSourceAccess',async()=>{throw new Error('Target validation must succeed before checking source grants')});
 await assert.rejects(save({targetChatId:'-1004321816999'}),error=>error.status===403);
 assert.equal(requests.length,1);assert.equal(requests[0].method,'getMe');assert.equal(JSON.stringify(config()),before);assert.equal(sourceChecks.mock.callCount(),0);
 const rotatedCipher='fixture-rotated-encrypted-token',rotatedToken='12345678:fixture-rotated-private-token';
 db().prepare("UPDATE telegram_promotion_settings SET chat_bot_token_ciphertext=? WHERE id='primary'").run(rotatedCipher);
 await assert.rejects(hot.saveHotVideoSettings(db(),{enabled:true,targetChatId:String(TARGET),intervalHours:6,firstRunAt:null,sources:[String(SOURCE)],markSourceUsed:false},
  value=>{assert.equal(value,rotatedCipher);return rotatedToken},clock),error=>error.status===403);
 assert.equal(requests.length,2);assert.equal(requests[1].token,rotatedToken);assert.equal(requests[1].method,'getMe');assert.equal(JSON.stringify(config()),before);
 assert.equal(hot.hotVideoStatus(db(),clock).ready,false);assert.equal(hot.hotVideoStatus(db(),clock).sourceChannels[0].ready,false);assert.equal(native.media.length,0);
});
test('new or reselected sources and source-marker permission upgrades still require fresh native checks',async t=>{
 await save();const original=JSON.stringify(config()),checks=[];
 const http=t.mock.method(telegram,'telegramRequest',async()=>{throw new Error('Unchanged verified target should remain local')});
 t.mock.method(native,'checkHotVideoSourceAccess',async input=>{checks.push(input);throw new hot.HotVideoError('Fixture source permission denied',403)});
 await assert.rejects(save({markSourceUsed:true}),error=>error.status===403);
 assert.equal(checks.length,1);assert.equal(checks[0].sourceChatId,SOURCE);assert.equal(checks[0].requireSourcePost,true);assert.equal(config().mark_source_used,0);assert.equal(JSON.stringify(config()),original);
 const other=-1004321816002;
 await assert.rejects(save({sources:[String(SOURCE),String(other)]}),error=>error.status===403);
 assert.equal(checks.length,2);assert.equal(checks[1].sourceChatId,other);assert.equal(checks[1].requireSourcePost,false);
 assert.equal(db().prepare('SELECT 1 FROM telegram_hot_video_sources WHERE chat_id=?').get(other),undefined);assert.equal(JSON.stringify(config()),original);
 await save({sources:[]});assert.equal(db().prepare('SELECT selected FROM telegram_hot_video_sources WHERE chat_id=?').get(SOURCE).selected,0);
 await assert.rejects(save(),error=>error.status===403);assert.equal(checks.length,3);assert.equal(checks[2].sourceChatId,SOURCE);assert.equal(db().prepare('SELECT selected FROM telegram_hot_video_sources WHERE chat_id=?').get(SOURCE).selected,0);
 assert.equal(http.mock.callCount(),0);assert.equal(native.media.length,0);
});
