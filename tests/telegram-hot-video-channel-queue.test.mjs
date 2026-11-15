import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs, { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';

// Actual migrations, queue transactions, scheduling and source-reference state.
// Only Telegram and source-scanning I/O are substituted; no network or live posts.
const fixture=mkdtempSync(path.join(tmpdir(),'hot-channel-queue-'));
writeFileSync(path.join(fixture,'package.json'),'{"type":"commonjs"}');
for(const name of ['sqlite','telegram-hot-video-limits','telegram-hot-videos'])
 writeFileSync(path.join(fixture,name+'.js'),ts.transpileModule(readFileSync(new URL('../app/lib/'+name+'.ts',import.meta.url),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText);
writeFileSync(path.join(fixture,'telegram-bot.js'),`
exports.calls=[];exports.onRequest=null;
exports.telegramRequest=async(token,method,p={})=>{
 exports.calls.push({method,p});
 if(exports.onRequest){const result=await exports.onRequest(method,p);if(result!==undefined)return result;}
 if(method==='getMe')return {ok:true,result:{id:12345678,is_bot:true,username:'FreeBonus365ChatBot'}};
 if(method==='getChat')return {ok:true,result:{id:p.chat_id,type:'channel',title:'Hot'}};
 if(method==='getChatMember')return {ok:true,result:{status:'administrator',can_post_messages:true}};
 throw new Error('Unexpected Bot API operation');
};
exports.telegramVideoFileRequest=async()=>{throw new Error('Channel references must not upload local media');};
`);
writeFileSync(path.join(fixture,'telegram-hot-video-native.js'),`
exports.checks=[];exports.media=[];exports.markers=[];exports.onSend=null;exports.onMarker=null;exports.checkFailure=null;
exports.checkHotVideoSourceAccess=async input=>{exports.checks.push(input);if(exports.checkFailure)throw exports.checkFailure;if(!input.valid())throw new Error('Stale source check');return {title:'Source '+input.sourceChatId,username:''};};
exports.sendHotChannelVideo=async input=>{
 exports.media.push(input);if(exports.onSend)return exports.onSend(input);
 input.onDispatch();return {ok:true,result:{message_id:700+exports.media.length,chat:{id:input.targetId},video:{width:1280,height:720},caption:'',reply_markup:{inline_keyboard:require('./telegram-hot-videos').hotVideoKeyboard()}}};
};
exports.markHotChannelVideoUsed=async input=>{
 exports.markers.push(input);if(exports.onMarker)return exports.onMarker(input);
 input.onDispatch();return {ok:true,result:{message_id:900+exports.markers.length,chat:{id:input.sourceChatId},text:'✅ Sent · Used',reply_to_message:{message_id:input.sourceMessageId}}};
};
exports.sendLargeHotVideo=async()=>{throw new Error('Source videos must not use file uploads');};
exports.checkLargeHotVideoAccess=async()=>true;
`);
writeFileSync(path.join(fixture,'telegram-hot-video-sources.js'),'exports.syncHotVideoSources=async()=>{throw new Error("Publishing must not implicitly scan source history");};');
const require=createRequire(import.meta.url);
const hot=require(path.join(fixture,'telegram-hot-videos.js'));
const native=require(path.join(fixture,'telegram-hot-video-native.js'));
const telegram=require(path.join(fixture,'telegram-bot.js'));
const {getSqlite}=require(path.join(fixture,'sqlite.js'));
const previousData=process.env.DATA_DIR;
const START=1800000000000,HOUR=3600000,TARGET=-1004321816132,SOURCE=-1004321816001,OTHER_SOURCE=-1004321816002;
const CIPHER='fixture-private-token-cipher',TOKEN='12345678:fixture-private-bot-token';
let now;
const clock=()=>now;
const db=()=>getSqlite();
const config=()=>db().prepare("SELECT * FROM telegram_hot_video_settings WHERE id='primary'").get();
const jobs=()=>db().prepare('SELECT * FROM telegram_hot_video_jobs ORDER BY created_at,id').all();
const video=id=>db().prepare('SELECT * FROM telegram_hot_videos WHERE id=?').get(id);
const jobFor=id=>db().prepare("SELECT * FROM telegram_hot_video_jobs WHERE video_id=? ORDER BY created_at DESC,sent_at DESC,CASE status WHEN 'sending' THEN 0 WHEN 'pending' THEN 1 WHEN 'unknown' THEN 2 WHEN 'failed' THEN 3 ELSE 4 END,id DESC LIMIT 1").get(id);
const decrypt=cipher=>{assert.equal(cipher,CIPHER);return TOKEN};
const save=(extra={})=>hot.saveHotVideoSettings(db(),{enabled:true,targetChatId:String(TARGET),intervalHours:6,firstRunAt:null,sources:[String(SOURCE)],markSourceUsed:true,...extra},decrypt,clock);
const add=(messageId=1,source=SOURCE,extra={})=>hot.registerHotChannelVideo(db(),{sourceChatId:source,sourceMessageId:messageId,sourceTitle:'Fixture source',documentId:String(700000+messageId),bytes:1702*1024*1024,createdAt:START-1000,...extra},clock);
const queue=(id,runAt=null,requestId=randomUUID())=>hot.enqueueHotVideo(db(),{videoId:id,runAt,requestId},decrypt,clock);
const deliver=()=>hot.deliverHotVideoOnce(decrypt,clock);
const mark=()=>hot.deliverHotVideoMarkerOnce(decrypt,clock);
function close(){const file=path.join(process.env.DATA_DIR,'directory.sqlite');globalThis.__directorySqlite?.get(file)?.close();globalThis.__directorySqlite?.delete(file)}
test.beforeEach(()=>{
 process.env.DATA_DIR=mkdtempSync(path.join(fixture,'case-'));now=START;
 native.checks.length=0;native.media.length=0;native.markers.length=0;native.onSend=null;native.onMarker=null;native.checkFailure=null;
 telegram.calls.length=0;telegram.onRequest=null;
 db().prepare("INSERT INTO telegram_promotion_settings(id,enabled,chat_id,token_ciphertext,chat_bot_token_ciphertext) VALUES('primary',0,'','',?)").run(CIPHER);
 db().prepare("INSERT INTO telegram_join_gate_settings(id,target_chat_id,target_title) VALUES('primary',?,'Hot')").run(TARGET);
 db().exec(`CREATE TABLE telegram_personal_sources(chat_id INTEGER PRIMARY KEY,title TEXT NOT NULL,username TEXT NOT NULL,joined INTEGER NOT NULL,selected INTEGER NOT NULL,last_message_id INTEGER NOT NULL)`);
 db().prepare("INSERT INTO telegram_personal_sources VALUES(?,'Source one','source_one',1,0,983)").run(SOURCE);
 db().prepare("INSERT INTO telegram_personal_sources VALUES(?,'Source two','source_two',1,1,321)").run(OTHER_SOURCE);
});
test.afterEach(close);
test.after(()=>{if(previousData===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previousData;rmSync(fixture,{recursive:true,force:true})});

test('migration leaves channel sources unselected and does not start forwarding an arbitrary joined channel',async()=>{
 const status=hot.hotVideoStatus(db(),clock);assert.deepEqual(status.sourceChannels,[]);assert.equal(status.enabled,false);assert.equal(status.sourceCandidates.length,2);
 assert.equal(add(),null);await deliver();assert.equal(native.media.length,0);assert.deepEqual(jobs(),[]);
});
test('importing 100 large source videos stores only references and never queues or sends the backlog immediately',async()=>{
 await save();const next=config().next_run_at;
 for(let i=1;i<=100;i++)assert.match(add(i),/^[a-f0-9-]{36}$/);
 const status=hot.hotVideoStatus(db(),clock);assert.equal(status.videoCount,100);assert.equal(status.storage.bytes,0);assert.equal(status.nextRunAt,next);assert.deepEqual(jobs(),[]);assert.equal(native.media.length,0);
 assert.deepEqual(readdirSync(hot.hotVideoStorageDirectory()),[]);await deliver();assert.deepEqual(jobs(),[]);assert.equal(native.media.length,0);assert.equal(config().next_run_at,next);
 const row=video(status.videos[0].id);assert.equal(row.origin,'channel');assert.equal(row.file_name,'');assert.equal(row.sha256,'');
});
test('source selection and source-only saves preserve the existing six-hour due time and normal relay source state',async()=>{
 const existing=db().prepare('SELECT * FROM telegram_personal_sources ORDER BY chat_id').all();await save();const next=config().next_run_at;now+=45000;
 await save({sources:[String(SOURCE),String(OTHER_SOURCE)],markSourceUsed:false});assert.equal(config().next_run_at,next);
 assert.deepEqual(db().prepare('SELECT * FROM telegram_personal_sources ORDER BY chat_id').all(),existing);
 assert.equal(native.checks.at(-1).requireSourcePost,false);assert.equal(jobs().length,0);
});
test('deduplication preserves used, unknown and deleted references rather than recreating the source message',async()=>{
 await save();const sent=add(1),unknown=add(2),deleted=add(3);
 await queue(sent);await deliver();now+=3001;await queue(unknown);native.onSend=async input=>{input.onDispatch();return null};await deliver();hot.deleteHotVideo(db(),deleted,clock);
 assert.equal(add(1),sent);assert.equal(add(2),unknown);assert.equal(add(3),deleted);
 assert.equal(video(sent).last_sent_at,START);assert.equal(jobFor(unknown).status,'unknown');assert.ok(video(deleted).deleted_at>0);
 assert.equal(db().prepare('SELECT COUNT(*) AS n FROM telegram_hot_videos').get().n,3);assert.equal(native.media.length,2);
});
test('the Hot destination cannot be configured or imported as a source',async()=>{
 await assert.rejects(save({sources:[String(TARGET)]}),e=>e.status===400);await save();
 db().prepare("INSERT INTO telegram_hot_video_sources(chat_id,selected,revision) VALUES(?,1,'fixture')").run(TARGET);
 assert.equal(add(1,TARGET),null);assert.equal(jobs().length,0);assert.equal(db().prepare('SELECT COUNT(*) AS n FROM telegram_hot_videos').get().n,0);
});
test('one automatic slot sends exactly one unused source video and never cycles used videos after exhaustion',async()=>{
 await save();const first=add(1),second=add(2);now=config().next_run_at;await deliver();
 assert.equal(native.media.length,1);assert.equal(native.media[0].sourceMessageId,1);assert.equal(video(first).last_sent_at,now);assert.equal(video(second).last_sent_at,0);
 for(let i=0;i<5;i++){now+=5000;await deliver()}assert.equal(native.media.length,1);
 now=config().next_run_at;await deliver();assert.equal(native.media.length,2);assert.equal(native.media[1].sourceMessageId,2);
 now=config().next_run_at;await deliver();now=config().next_run_at;await deliver();assert.equal(native.media.length,2);assert.equal(jobs().filter(j=>j.status==='sent').length,2);
});
test('automatic exhaustion retains the cadence and resumes for a later new video without an immediate catch-up burst',async()=>{
 await save();add(1);now=config().next_run_at;await deliver();now=config().next_run_at;await deliver();
 // An empty selected source has a bounded60-second sync grace window.
 now+=60001;await deliver();const next=config().next_run_at;
 add(2);now+=30000;await deliver();assert.equal(native.media.length,1);assert.equal(config().next_run_at,next);
 now=next;await deliver();assert.equal(native.media.length,2);
});
test('downtime with many queued references coalesces missed automatic slots into one publication',async()=>{
 await save();for(let i=1;i<=20;i++)add(i);now=config().next_run_at+25*HOUR;await deliver();assert.equal(native.media.length,1);
 const due=config().next_run_at;now+=3001;await deliver();assert.equal(native.media.length,1);assert.equal(config().next_run_at,due);assert.ok(due>now);
});
test('an outstanding manually scheduled source video is reserved and excluded from the automatic slot',async()=>{
 await save();const first=add(1),second=add(2),auto=config().next_run_at;await queue(first,auto+HOUR);now=auto;await deliver();
 assert.equal(native.media.length,1);assert.equal(native.media[0].sourceMessageId,2);assert.equal(jobFor(first).status,'pending');assert.equal(jobFor(second).status,'sent');
 now=auto+HOUR;await deliver();assert.equal(native.media.length,2);assert.equal(native.media[1].sourceMessageId,1);
});
test('manual and scheduled enqueue paths reject a second reservation and later reuse of a confirmed source video',async()=>{
 await save();const id=add(1),requestId=randomUUID();await queue(id,null,requestId);
 await queue(id,null,requestId);assert.equal(jobs().length,1);await assert.rejects(queue(id),e=>e.status===409);await assert.rejects(queue(id,now+HOUR),e=>e.status===409);
 await deliver();await assert.rejects(queue(id),e=>e.status===409);await assert.rejects(queue(id,now+HOUR),e=>e.status===409);assert.equal(native.media.length,1);
});
test('a cancelled unsubmitted reservation may be queued once again without losing its source identity',async()=>{
 await save();const id=add(1);await queue(id,now+HOUR);hot.cancelHotVideoJob(db(),jobFor(id).id,clock);await queue(id);await deliver();
 assert.equal(native.media.length,1);assert.equal(jobFor(id).status,'sent');
});
test('concurrent manual queue attempts reserve one source video at most once',async()=>{
 await save();const id=add(1);const result=await Promise.allSettled([queue(id),queue(id)]);
 assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(result.filter(r=>r.status==='rejected'&&r.reason.status===409).length,1);assert.equal(jobs().length,1);
});
test('an ambiguous actual target send remains occupied across later manual attempts, slots and reimport',async()=>{
 await save();const first=add(1),second=add(2);native.onSend=async input=>{input.onDispatch();return null};now=config().next_run_at;await deliver();
 assert.equal(jobFor(first).status,'unknown');assert.equal(video(first).last_sent_at,0);assert.equal(hot.hotVideoStatus(db(),clock).videos.find(v=>v.id===first).usageState,'unknown');
 await assert.rejects(queue(first),e=>e.status===409);assert.equal(add(1),first);native.onSend=null;now=config().next_run_at;await deliver();assert.equal(video(second).last_sent_at,now);
 now=config().next_run_at;await deliver();assert.equal(native.media.length,2);assert.equal(jobFor(first).status,'unknown');
});
test('source removal cancels pending jobs while preserving used history through reselection',async()=>{
 await save();const used=add(1),pending=add(2);await queue(used);await deliver();now+=3001;await queue(pending,now+HOUR);
 await save({sources:[]});assert.equal(jobFor(pending).status,'cancelled');assert.ok(video(used).last_sent_at>0);await assert.rejects(queue(pending),e=>e.status===409);
 await save();assert.equal(add(1),used);await assert.rejects(queue(used),e=>e.status===409);await queue(pending);await deliver();assert.equal(native.media.length,2);
});
test('channel video send and delete never open, unlink or require local video files',async t=>{
 await save();const id=add(1);
 t.mock.method(fsPromises,'open',async()=>{throw new Error('NO_LOCAL_VIDEO_READ_ALLOWED')});
 t.mock.method(fs,'unlinkSync',()=>{throw new Error('NO_LOCAL_VIDEO_UNLINK_ALLOWED')});
 await queue(id);await deliver();assert.equal(jobFor(id).status,'sent');hot.deleteHotVideo(db(),id,clock);assert.ok(video(id).deleted_at>0);assert.equal(native.media.length,1);
});
test('source identity and expected document bind the actual native send before dispatch intent is committed',async()=>{
 await save();const id=add(77);await queue(id);
 native.onSend=async input=>{
  assert.equal(input.sourceChatId,SOURCE);assert.equal(input.sourceMessageId,77);assert.equal(input.expectedDocumentId,'700077');assert.equal(input.targetId,TARGET);assert.equal(input.requireSourcePost,true);
  assert.equal(jobFor(id).dispatch_started_at,0);assert.equal(input.valid(),true);input.onDispatch();assert.ok(jobFor(id).dispatch_started_at>0);
  return {ok:true,result:{message_id:770,chat:{id:TARGET},video:{},caption:'',reply_markup:{inline_keyboard:hot.hotVideoKeyboard()}}};
 };
 await deliver();assert.equal(jobFor(id).status,'sent');assert.equal(jobFor(id).message_id,770);assert.equal(native.markers.length,0);assert.equal(jobFor(id).marker_status,'pending');
});
test('removing a source during native preflight prevents dispatch',async()=>{
 await save();const id=add(1);await queue(id);native.onSend=async input=>{db().prepare('UPDATE telegram_hot_video_sources SET selected=0 WHERE chat_id=?').run(SOURCE);assert.equal(input.valid(),false);input.onDispatch();return null};await deliver();
 assert.equal(jobFor(id).dispatch_started_at,0);assert.equal(jobFor(id).status,'cancelled');assert.equal(video(id).last_sent_at,0);
});
test('source channel reference status contains no private file paths, credentials or access hashes',async()=>{
 await save();const id=add(99);const status=hot.hotVideoStatus(db(),clock),rendered=JSON.stringify(status),row=status.videos.find(v=>v.id===id);
 assert.equal(row.origin,'channel');assert.equal(row.used,false);assert.match(row.sourceUrl,/https:\/\/t.me\/c\/4321816001\/99$/);
 for(const privateValue of [CIPHER,TOKEN,process.env.DATA_DIR,'peer_ciphertext','accessHash'])assert.equal(rendered.includes(privateValue),false);
});

test('confirmed target delivery is committed used before a separate source reply marker is attempted',async()=>{
 await save();const id=add(42);await queue(id);await deliver();assert.equal(jobFor(id).status,'sent');assert.equal(jobFor(id).marker_status,'pending');assert.equal(native.markers.length,0);
 now+=3001;native.onMarker=async input=>{
  assert.equal(jobFor(id).status,'sent');assert.ok(video(id).last_sent_at>0);assert.equal(input.sourceChatId,SOURCE);assert.equal(input.sourceMessageId,42);assert.equal(input.targetMessageId,701);assert.equal(input.expectedDocumentId,'700042');assert.ok(input.markerId);assert.equal(input.valid(),true);
  assert.equal(jobFor(id).marker_dispatch_started_at,0);input.onDispatch();assert.ok(jobFor(id).marker_dispatch_started_at>0);
  return {ok:true,result:{message_id:942,chat:{id:SOURCE},text:'✅ Sent · Used',reply_to_message:{message_id:42}}};
 };
 await mark();assert.equal(jobFor(id).status,'sent');assert.equal(jobFor(id).marker_status,'sent');assert.equal(jobFor(id).marker_message_id,942);assert.equal(native.media.length,1);assert.equal(native.markers.length,1);
 now+=3001;await mark();assert.equal(native.markers.length,1);
});
test('a source marker preparation failure never retries the already confirmed target video',async()=>{
 await save();const id=add(1);await queue(id);await deliver();now+=3001;native.onMarker=async()=>{throw new hot.HotVideoError('Source permission temporarily unavailable',403)};
 await mark();assert.equal(jobFor(id).status,'sent');assert.equal(jobFor(id).marker_dispatch_started_at,0);assert.ok(video(id).last_sent_at>0);
 now+=60000;await deliver();assert.equal(native.media.length,1);await assert.rejects(queue(id),e=>e.status===409);
});
test('an ambiguous actual marker reply becomes terminal unknown without resending either marker or target',async()=>{
 await save();const id=add(1);await queue(id);await deliver();now+=3001;native.onMarker=async input=>{input.onDispatch();return null};await mark();
 assert.equal(jobFor(id).status,'sent');assert.equal(jobFor(id).marker_status,'unknown');assert.ok(jobFor(id).marker_dispatch_started_at>0);const sentAt=video(id).last_sent_at;
 now+=240000;await mark();await deliver();assert.equal(native.media.length,1);assert.equal(native.markers.length,1);assert.equal(video(id).last_sent_at,sentAt);assert.equal(jobFor(id).status,'sent');
});
test('marker-disabled delivery stays used and never posts a source text message',async()=>{
 await save({markSourceUsed:false});const id=add(1);await queue(id);await deliver();assert.equal(jobFor(id).marker_status,'skipped');now+=3001;await mark();assert.equal(native.markers.length,0);assert.equal(native.media.length,1);
});
test('unknown target delivery never produces a false used source marker',async()=>{
 await save();const id=add(1);await queue(id);native.onSend=async input=>{input.onDispatch();return null};await deliver();now+=3001;await mark();assert.equal(jobFor(id).status,'unknown');assert.equal(native.markers.length,0);assert.equal(video(id).last_sent_at,0);
});

test('the database itself prevents competing active consumption jobs for one channel reference',async()=>{
 await save();const id=add(1);await queue(id);const original=jobFor(id);
 assert.throws(()=>db().prepare(`INSERT INTO telegram_hot_video_jobs(id,request_id,video_id,kind,run_at,created_at,settings_revision,target_chat_id,token_hash,bot_id,next_attempt_at,consumption_key)
  VALUES(?,?,?,'scheduled',?,?,?,?,?,?,?,?)`).run(randomUUID(),randomUUID(),id,now+HOUR,now,original.settings_revision,TARGET,original.token_hash,original.bot_id,now+HOUR,id),/UNIQUE/);
 assert.equal(jobs().length,1);assert.equal(native.media.length,0);
});
for(const attempted of [false,true])test('expired '+(attempted?'submitted':'preflight-only')+' source marker lease recovers without risking another target video',async()=>{
 await save();const id=add(1);await queue(id);await deliver();const lease=randomUUID();
 db().prepare("UPDATE telegram_hot_video_jobs SET marker_status='sending',marker_dispatch_started_at=?,lease_id=?,lease_until=? WHERE id=?").run(attempted?now:0,lease,now-1,jobFor(id).id);
 db().prepare("UPDATE telegram_hot_video_settings SET lease_id=?,lease_until=? WHERE id='primary'").run(lease,now-1);
 await mark();assert.equal(jobFor(id).status,'sent');assert.equal(jobFor(id).marker_status,attempted?'unknown':'sent');assert.equal(native.markers.length,attempted?0:1);assert.equal(native.media.length,1);
 now+=240000;await mark();await deliver();assert.equal(native.markers.length,attempted?0:1);assert.equal(native.media.length,1);
});
test('explicit Telegram rejection retries only the source marker with the same durable marker identity',async()=>{
 await save();const id=add(1);await queue(id);await deliver();now+=3001;
 native.onMarker=async input=>{input.onDispatch();return {ok:false,code:429,retryAfter:37}};
 await mark();assert.equal(jobFor(id).status,'sent');assert.equal(jobFor(id).marker_status,'pending');assert.equal(jobFor(id).marker_attempts,1);const markerId=native.markers[0].markerId;
 now+=36000;await mark();assert.equal(native.markers.length,1);now+=1001;native.onMarker=null;await mark();assert.equal(jobFor(id).marker_status,'sent');assert.equal(native.markers.length,2);assert.equal(native.markers[1].markerId,markerId);assert.equal(native.media.length,1);
});
test('a marker result received after its lease expires stays unknown and cannot rearm either publication',async()=>{
 await save();const id=add(1);await queue(id);await deliver();now+=3001;
 native.onMarker=async input=>{input.onDispatch();now+=120001;return {ok:true,result:{message_id:901,chat:{id:SOURCE},text:'✅ Sent · Used',reply_to_message:{message_id:1}}}};
 await mark();assert.equal(jobFor(id).status,'sent');assert.equal(jobFor(id).marker_status,'unknown');assert.equal(native.markers.length,1);now+=240000;await mark();await deliver();assert.equal(native.markers.length,1);assert.equal(native.media.length,1);
});
test('removing a source after confirmed delivery cancels only its unsent marker and retains used state',async()=>{
 await save();const id=add(1);await queue(id);await deliver();now+=3001;await save({sources:[]});await mark();assert.equal(jobFor(id).status,'sent');assert.equal(jobFor(id).marker_status,'skipped');assert.equal(native.markers.length,0);assert.equal(native.media.length,1);assert.ok(video(id).last_sent_at>0);
});
test('turning off recurring automation retains an already confirmed source marker independently of the cadence',async()=>{
 await save();const id=add(1);await queue(id);await deliver();now+=3001;await save({enabled:false});assert.equal(config().enabled,0);await mark();assert.equal(jobFor(id).marker_status,'sent');assert.equal(jobFor(id).status,'sent');assert.equal(native.media.length,1);assert.equal(native.markers.length,1);
});

for(const status of [400,404,409])test('permanent source preflight failure '+status+' does not starve later automatic videos and permits explicit retry when repaired',async()=>{
 await save();const missing=add(1),valid=add(2);native.onSend=async input=>{
  if(input.sourceMessageId===1)throw new hot.HotVideoError('Source video was deleted or changed',status);
  input.onDispatch();return {ok:true,result:{message_id:702,chat:{id:TARGET},video:{},caption:'',reply_markup:{inline_keyboard:hot.hotVideoKeyboard()}}};
 };
 now=config().next_run_at;await deliver();assert.equal(jobFor(missing).status,'failed');assert.equal(video(missing).last_sent_at,0);
 now=config().next_run_at;await deliver();assert.equal(jobFor(valid)?.status,'sent');assert.equal(video(valid).last_sent_at,now);assert.equal(native.media.filter(i=>i.sourceMessageId===1).length,1);
 assert.equal(hot.hotVideoStatus(db(),clock).videos.find(v=>v.id===missing).usageState,'failed');assert.equal(hot.hotVideoStatus(db(),clock).videos.find(v=>v.id===missing).used,false);
 now+=3001;native.onSend=null;await queue(missing);await deliver();assert.equal(jobFor(missing).status,'sent');assert.ok(video(missing).last_sent_at>0);
});

test('exact schema31 upgrade and replay preserve legacy six-hour schedule, file bytes, reservations and terminal/local jobs',async()=>{
 const database=db(),revision='legacy-six-hour-revision',tokenHash=createHash('sha256').update(CIPHER).digest('hex');
 hot.hotVideoStatus(database,clock);
 database.prepare(`UPDATE telegram_hot_video_settings SET enabled=1,target_chat_id=?,target_title='Legacy 🔞 Hot',interval_hours=6,
  next_run_at=?,revision=?,token_hash=?,bot_id=12345678,verified_at=?,last_checked_at=?,last_error='legacy warning',
  last_auto_order=2,lease_id='',lease_until=0,next_send_at=0 WHERE id='primary'`).run(TARGET,START+6*HOUR+12345,revision,tokenHash,START-12000,START-7000);
 const mediaFolder=hot.hotVideoStorageDirectory(),mediaProof=[];
 for(const [index,status] of ['sent','unknown','pending'].entries()){
  const id=randomUUID(),fileName=id+'.mp4',bytes=Buffer.from(`unchanged-private-video-${status}-\u0000\u00ff`,'utf8');
  writeFileSync(path.join(mediaFolder,fileName),bytes,{mode:0o600});mediaProof.push([fileName,bytes]);
  database.prepare(`INSERT INTO telegram_hot_videos(id,title,original_name,file_name,bytes,sha256,active,sort_order,created_at,last_sent_at)
   VALUES(?,?,?,?,?,?,1,?,?,?)`).run(id,`Legacy ${status}`,'original-'+status+'.mp4',fileName,bytes.length,createHash('sha256').update(bytes).digest('hex'),index+1,START-90000+index,status==='sent'?START-70000:0);
  database.prepare(`INSERT INTO telegram_hot_video_jobs(id,request_id,video_id,kind,status,run_at,created_at,settings_revision,target_chat_id,token_hash,bot_id,
   attempts,next_attempt_at,lease_id,lease_until,dispatch_started_at,last_error,sent_at,message_id)
   VALUES(?,?,?,'manual',?,?,?,?,?,?,12345678,?,?,'',0,?,?,?,?)`)
   .run(randomUUID(),randomUUID(),id,status,status==='pending'?START+HOUR:START-85000,START-86000+index,revision,TARGET,tokenHash,
    status==='pending'?0:2,status==='pending'?START+HOUR:START-80000,status==='pending'?0:START-82000,
    status==='unknown'?'Ambiguous legacy send: never replay':status==='sent'?'Legacy confirmed warning':'',status==='sent'?START-70000:0,status==='sent'?501:0);
 }
 const uploadId=randomUUID(),partName=uploadId+'.part',partBytes=Buffer.from('original acknowledged upload fragment');
 writeFileSync(path.join(mediaFolder,partName),partBytes,{mode:0o600});mediaProof.push([partName,partBytes]);
 database.prepare('INSERT INTO telegram_hot_video_uploads(id,bytes,created_at) VALUES(?,?,?)').run(uploadId,12*1024*1024,START-2000);
 database.prepare(`INSERT INTO telegram_hot_video_upload_sessions(id,request_id,title,original_name,bytes,received_bytes,created_at,updated_at,state)
  VALUES(?,?,'Legacy incomplete upload','incomplete.mp4',?,?,?,?,'uploading')`).run(uploadId,uploadId,12*1024*1024,partBytes.length,START-4000,START-2000);
 database.prepare('INSERT INTO telegram_hot_video_upload_chunks(upload_id,offset,bytes,sha256,created_at) VALUES(?,0,?,?,?)')
  .run(uploadId,partBytes.length,createHash('sha256').update(partBytes).digest('hex'),START-2000);
 database.prepare('INSERT INTO telegram_hot_video_bot_sessions(bot_id,token_hash,application_revision,session_ciphertext,updated_at) VALUES(12345678,?,?,?,?)')
  .run(tokenHash,'legacy-app-revision','fixture-encrypted-bot-session-must-stay-unchanged',START-3000);
 const additions={
  telegram_hot_video_settings:['mark_source_used'],
  telegram_hot_videos:['origin','source_chat_id','source_message_id','source_document_id','source_title','source_date'],
  telegram_hot_video_jobs:['consumption_key','marker_status','marker_attempts','marker_dispatch_started_at','marker_next_attempt_at','marker_message_id','marker_error'],
 };
 const preservedTables=['telegram_hot_video_settings','telegram_hot_videos','telegram_hot_video_jobs','telegram_hot_video_uploads',
  'telegram_hot_video_upload_sessions','telegram_hot_video_upload_chunks','telegram_hot_video_bot_sessions','telegram_personal_sources','telegram_promotion_settings','telegram_join_gate_settings'];
 const oldColumns=Object.fromEntries(preservedTables.map(table=>[table,database.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name).filter(name=>!additions[table]?.includes(name))]));
 const snapshot=()=>Object.fromEntries(preservedTables.map(table=>[table,db().prepare(`SELECT ${oldColumns[table].join(',')} FROM ${table} ORDER BY rowid`).all()]));
 const original=JSON.stringify(snapshot());
 database.exec(`DROP INDEX telegram_hot_video_source_reference;DROP INDEX telegram_hot_video_once_use;DROP INDEX telegram_hot_video_marker_due;DROP TABLE telegram_hot_video_sources;`);
 for(const [table,columns] of Object.entries(additions))for(const column of columns)database.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
 database.exec('PRAGMA user_version=31');assert.equal(database.prepare('PRAGMA user_version').get().user_version,31);
 assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE name='telegram_hot_video_sources'").get(),undefined);
 close();const migrated=db();assert.equal(migrated.prepare('PRAGMA user_version').get().user_version,34);
 assert.equal(JSON.stringify(snapshot()),original);
 assert.deepEqual(migrated.prepare('SELECT chat_id FROM telegram_hot_video_sources WHERE selected=1').all(),[]);
 assert.equal(config().enabled,1);assert.equal(config().interval_hours,6);assert.equal(config().next_run_at,START+6*HOUR+12345);assert.equal(config().revision,revision);assert.equal(config().bot_id,12345678);
 assert.deepEqual(migrated.prepare('SELECT DISTINCT origin,source_chat_id,source_message_id,source_document_id,source_title,source_date FROM telegram_hot_videos').all().map(row=>({...row})),
  [{origin:'upload',source_chat_id:0,source_message_id:0,source_document_id:'',source_title:'',source_date:0}]);
 assert.deepEqual(migrated.prepare('SELECT DISTINCT consumption_key,marker_status,marker_attempts,marker_dispatch_started_at,marker_next_attempt_at,marker_message_id,marker_error FROM telegram_hot_video_jobs').all().map(row=>({...row})),
  [{consumption_key:'',marker_status:'none',marker_attempts:0,marker_dispatch_started_at:0,marker_next_attempt_at:0,marker_message_id:0,marker_error:''}]);
 for(const [name,bytes] of mediaProof){assert.deepEqual(readFileSync(path.join(mediaFolder,name)),bytes);assert.equal(fs.lstatSync(path.join(mediaFolder,name)).mode&0o777,0o600)}
 await deliver();assert.equal(JSON.stringify(snapshot()),original);assert.equal(native.media.length,0);assert.equal(native.markers.length,0);assert.equal(telegram.calls.length,0);
 // Replaying the same version on an already widened schema is safe and does not reset new states either.
 migrated.prepare("UPDATE telegram_hot_video_settings SET mark_source_used=0 WHERE id='primary'").run();
 migrated.prepare("UPDATE telegram_hot_video_jobs SET marker_status='unknown',marker_dispatch_started_at=?,marker_error='Previously unconfirmed marker' WHERE status='sent'").run(START-60000);
 migrated.prepare("INSERT INTO telegram_hot_video_sources(chat_id,title,selected,revision,backfill_before_id,last_message_id,backfill_done,last_synced_at) VALUES(?,'Unselected preserved source',0,'source-revision',89,240,0,?)").run(SOURCE,START-4000);
 const fullBefore=JSON.stringify({settings:migrated.prepare('SELECT * FROM telegram_hot_video_settings').all(),videos:migrated.prepare('SELECT * FROM telegram_hot_videos ORDER BY id').all(),
  jobs:migrated.prepare('SELECT * FROM telegram_hot_video_jobs ORDER BY id').all(),sources:migrated.prepare('SELECT * FROM telegram_hot_video_sources ORDER BY chat_id').all()});
 migrated.exec('PRAGMA user_version=31');close();const replayed=db();assert.equal(replayed.prepare('PRAGMA user_version').get().user_version,34);
 const fullAfter=JSON.stringify({settings:replayed.prepare('SELECT * FROM telegram_hot_video_settings').all(),videos:replayed.prepare('SELECT * FROM telegram_hot_videos ORDER BY id').all(),
  jobs:replayed.prepare('SELECT * FROM telegram_hot_video_jobs ORDER BY id').all(),sources:replayed.prepare('SELECT * FROM telegram_hot_video_sources ORDER BY chat_id').all()});
 assert.equal(fullAfter,fullBefore);assert.equal(JSON.stringify(snapshot()),original);assert.equal(hot.hotVideoStatus(replayed,clock).sourceChannels.length,0);
 await deliver();await mark();assert.equal(native.media.length,0);assert.equal(native.markers.length,0);assert.equal(telegram.calls.length,0);
 for(const [name,bytes] of mediaProof)assert.deepEqual(readFileSync(path.join(mediaFolder,name)),bytes);
});
