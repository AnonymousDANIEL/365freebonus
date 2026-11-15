import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

// Production schema, queue, file validation, leases and scheduling; Telegram
// alone is mocked. Every test uses a private disposable directory and no network.
const fixture=mkdtempSync(path.join(tmpdir(),'telegram-hot-videos-'));
writeFileSync(path.join(fixture,'package.json'),'{"type":"commonjs"}');
for(const name of ['sqlite','telegram-hot-video-limits','telegram-hot-videos'])writeFileSync(path.join(fixture,name+'.js'),ts.transpileModule(
  readFileSync(new URL('../app/lib/'+name+'.ts',import.meta.url),'utf8'),
  {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}},
).outputText);
writeFileSync(path.join(fixture,'telegram-bot.js'),`
exports.calls=[];exports.onRequest=null;exports.onSend=null;exports.results=[];exports.name='FreeBonus365ChatBot';
exports.id=12345678;exports.role={status:'administrator',can_post_messages:true};exports.chatType='channel';exports.chatId=null;
exports.telegramRequest=async(token,method,p={})=>{
  exports.calls.push({token,method,p});
  if(exports.onRequest){const value=await exports.onRequest(method,p);if(value!==undefined)return value;}
  if(method==='getMe')return {ok:true,result:{id:exports.id,is_bot:true,username:exports.name}};
  if(method==='getChat')return {ok:true,result:{id:exports.chatId??p.chat_id,type:exports.chatType,title:'Hot'}};
  if(method==='getChatMember')return {ok:true,result:exports.role};
  throw new Error('Unexpected Hot video API method '+method);
};
exports.telegramVideoFileRequest=async(token,p,upload)=>{
  exports.calls.push({token,method:'sendVideo',p,upload});
  if(exports.onSend){const value=await exports.onSend(p,upload);if(value!==undefined)return value;}
  if(exports.results.length)return exports.results.shift();
  return {ok:true,result:{message_id:701,chat:{id:p.chat_id,type:'channel'},video:{file_id:'fixture-video'},reply_markup:p.reply_markup}};
};
`);
writeFileSync(path.join(fixture,'telegram-hot-video-native.js'),`exports.calls=[];exports.onSend=null;exports.sendLargeHotVideo=async input=>{exports.calls.push(input);if(exports.onSend)return exports.onSend(input);input.onDispatch();return {ok:true,result:{message_id:702,chat:{id:input.targetId},video:{width:1280},caption:'',reply_markup:{inline_keyboard:require('./telegram-hot-videos').hotVideoKeyboard()}}};};`);
const require=createRequire(import.meta.url);
const hot=require(path.join(fixture,'telegram-hot-videos.js'));
const telegram=require(path.join(fixture,'telegram-bot.js'));
const native=require(path.join(fixture,'telegram-hot-video-native.js'));
const {getSqlite}=require(path.join(fixture,'sqlite.js'));
const previousData=process.env.DATA_DIR;
const start=1_800_000_000_000,HOUR=3_600_000,target=-1009000;
const cipher='private-fixture-ciphertext',token='12345678:private-fixture-token';
let now=start;
const clock=()=>now;
function db(){return getSqlite();}
function config(){return db().prepare("SELECT * FROM telegram_hot_video_settings WHERE id='primary'").get();}
function jobs(){return db().prepare('SELECT * FROM telegram_hot_video_jobs ORDER BY created_at,id').all();}
function sends(){return telegram.calls.filter(call=>call.method==='sendVideo');}
function decrypt(value){assert.equal(value,cipher);return token;}
function close(){const filename=path.join(process.env.DATA_DIR,'directory.sqlite');globalThis.__directorySqlite?.get(filename)?.close();globalThis.__directorySqlite?.delete(filename);}
function mp4(){const b=Buffer.alloc(48);b.writeUInt32BE(24);b.write('ftypisom',4,'ascii');b.write('isommp42',16,'ascii');b.writeUInt32BE(24,24);b.write('mdat',28,'ascii');return b;}
function add(title='Private video',extra={}){
  const id=randomUUID(),bytes=mp4(),fileName=id+'.mp4';
  hot.reserveHotVideoUpload(db(),{id,bytes:bytes.length},clock);
  writeFileSync(path.join(hot.hotVideoStorageDirectory(),fileName),bytes,{mode:0o600});
  hot.registerHotVideo(db(),{id,title,originalName:'upload.mp4',fileName,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),...extra},clock);
  return id;
}
async function save(extra={}){return hot.saveHotVideoSettings(db(),{enabled:true,targetChatId:String(target),intervalHours:6,firstRunAt:null,...extra},decrypt,clock);}
async function queue(videoId,runAt=null,requestId=randomUUID()){return hot.enqueueHotVideo(db(),{videoId,runAt,requestId},decrypt,clock);}
async function deliver(){await hot.deliverHotVideoOnce(decrypt,clock);}
test.beforeEach(()=>{
  process.env.DATA_DIR=mkdtempSync(path.join(fixture,'case-'));now=start;
  native.calls.length=0;native.onSend=null;
  telegram.calls.length=0;telegram.results.length=0;telegram.onRequest=null;telegram.onSend=null;
  telegram.name='FreeBonus365ChatBot';telegram.id=12345678;telegram.role={status:'administrator',can_post_messages:true};telegram.chatType='channel';telegram.chatId=null;
  db().prepare(`INSERT INTO telegram_promotion_settings(id,enabled,chat_id,token_ciphertext,chat_bot_token_ciphertext) VALUES('primary',0,'','',?)`).run(cipher);
  db().prepare("INSERT INTO telegram_join_gate_settings(id,target_chat_id,target_title) VALUES('primary',?,'Hot')").run(target);
});
test.afterEach(()=>close());
test.after(()=>{if(previousData===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previousData;rmSync(fixture,{recursive:true,force:true});});

test('new Hot video module stays off and never sends until explicitly queued or enabled',async()=>{
  const status=hot.hotVideoStatus(db(),clock);
  assert.equal(status.enabled,false);assert.equal(status.intervalHours,6);assert.equal(status.targetChatId,String(target));assert.equal(status.nextRunAt,null);
  assert.deepEqual(status.videos,[]);await deliver();assert.equal(sends().length,0);assert.equal(jobs().length,0);
});

test('a scheduled request remains idempotent after its scheduled time has passed',async()=>{
  const id=add(),requestId=randomUUID(),runAt=now+60_000;
  await queue(id,runAt,requestId);
  const job=jobs()[0],before=telegram.calls.length;
  now=runAt+1000;
  await queue(id,runAt,requestId);
  assert.equal(telegram.calls.length,before);
  assert.deepEqual(jobs(),[job]);
  assert.equal(sends().length,0);
  await assert.rejects(queue(id,runAt,randomUUID()),error=>error.status===400);
});

test('upload reservations enforce Telegram platform bounds, two concurrent uploads and durable aggregate capacity',()=>{
  assert.throws(()=>hot.reserveHotVideoUpload(db(),{id:randomUUID(),bytes:hot.HOT_VIDEO_MAX_BYTES+1},clock),error=>error.status===413);
  assert.throws(()=>hot.reserveHotVideoUpload(db(),{id:'../../file',bytes:48},clock),error=>error.status===413);
  const ids=[randomUUID(),randomUUID()];for(const id of ids)hot.reserveHotVideoUpload(db(),{id,bytes:50},clock);
  assert.equal(hot.hotVideoStatus(db(),clock).storage.bytes,100);
  assert.throws(()=>hot.reserveHotVideoUpload(db(),{id:randomUUID(),bytes:50},clock),error=>error.status===429);
  hot.releaseHotVideoUpload(db(),ids[0]);hot.reserveHotVideoUpload(db(),{id:randomUUID(),bytes:50},clock);
});

test('expired upload reservations free capacity while completed videos retain their saved bytes',()=>{
  const id=add();hot.reserveHotVideoUpload(db(),{id:randomUUID(),bytes:100},clock);
  assert.equal(hot.hotVideoStatus(db(),clock).storage.bytes,148);now+=600_001;
  hot.reserveHotVideoUpload(db(),{id:randomUUID(),bytes:20},clock);
  assert.equal(hot.hotVideoStatus(db(),clock).storage.bytes,68);assert.equal(hot.hotVideoStatus(db(),clock).videos[0].id,id);
});

test('registration requires exact reserved UUID file and hides private paths and credential metadata',()=>{
  const id=add(),status=hot.hotVideoStatus(db(),clock);
  assert.equal(status.videos[0].id,id);assert.equal(db().prepare('SELECT COUNT(*) AS n FROM telegram_hot_video_uploads').get().n,0);
  const rendered=JSON.stringify(status);assert.equal(rendered.includes(process.env.DATA_DIR),false);assert.equal(rendered.includes(cipher),false);assert.equal(rendered.includes(token),false);
  assert.equal(lstatSync(path.join(hot.hotVideoStorageDirectory(),id+'.mp4')).mode&0o777,0o600);
  const bad=randomUUID();writeFileSync(path.join(hot.hotVideoStorageDirectory(),bad+'.mp4'),mp4());
  assert.throws(()=>hot.registerHotVideo(db(),{id:bad,title:'X',originalName:'x.mp4',fileName:bad+'.mp4',bytes:48,sha256:'a'.repeat(64)},clock),error=>error.status===409);
});

test('registration rejects symlinks and files whose size differs from their reservation',()=>{
  const id=randomUUID();hot.reserveHotVideoUpload(db(),{id,bytes:48},clock);
  const outside=path.join(process.env.DATA_DIR,'other.mp4');writeFileSync(outside,mp4());
  const filename=path.join(hot.hotVideoStorageDirectory(),id+'.mp4');symlinkSync(outside,filename);
  const input={id,title:'X',originalName:'x.mp4',fileName:id+'.mp4',bytes:48,sha256:'a'.repeat(64)};
  assert.throws(()=>hot.registerHotVideo(db(),input,clock),error=>error.status===409);
  rmSync(filename);writeFileSync(filename,Buffer.alloc(25));assert.throws(()=>hot.registerHotVideo(db(),input,clock),error=>error.status===409);
});

for(const failure of ['bot','permission','group','changed-target'])test('enabling verifies the exact destination and refuses '+failure+' without sending',async()=>{
  if(failure==='bot')telegram.name='DifferentBot';if(failure==='permission')telegram.role={status:'member'};
  if(failure==='group')telegram.chatType='supergroup';if(failure==='changed-target')telegram.chatId=target-1;
  await assert.rejects(save());assert.equal(sends().length,0);assert.equal(config().enabled,0);
});

test('six-hour automation starts after six hours and ordinary saves preserve the next due time',async()=>{
  const initial=await save();assert.equal(initial.nextRunAt,start+6*HOUR);assert.equal(initial.ready,true);
  assert.deepEqual(telegram.calls.map(call=>call.method),['getMe','getChat','getChatMember']);
  now+=HOUR;const saved=await save({revision:initial.revision});assert.equal(saved.nextRunAt,start+6*HOUR);
  await save({intervalHours:3});assert.equal(config().next_run_at,now+3*HOUR);
});

test('a specified first run is respected and stale settings revisions cannot overwrite it',async()=>{
  const first=start+2*HOUR;const saved=await save({firstRunAt:first});assert.equal(saved.nextRunAt,first);
  await assert.rejects(save({revision:'stale',firstRunAt:start+HOUR}),error=>error.status===409);
  assert.equal(config().next_run_at,first);assert.equal(sends().length,0);
});

test('immediate manual sending works with automation off and sends only video with the three exact buttons',async()=>{
  const id=add();await queue(id);assert.equal(jobs().length,1);assert.equal(jobs()[0].status,'pending');assert.equal(sends().length,0);
  await deliver();assert.equal(sends().length,1);assert.equal(jobs()[0].status,'sent');assert.equal(jobs()[0].message_id,701);
  const request=sends()[0];assert.equal(request.token,token);assert.equal(request.p.chat_id,target);assert.equal('caption' in request.p,false);assert.equal('parse_mode' in request.p,false);
  assert.deepEqual(request.p.reply_markup.inline_keyboard,hot.hotVideoKeyboard());assert.equal(request.upload.bytes,48);assert.ok(existsSync(request.upload.path));
  now+=10_000;await deliver();assert.equal(sends().length,1);assert.equal(config().enabled,0);
});

test('manual request identifiers survive retries without creating another delivery',async()=>{
  const id=add(),requestId=randomUUID();await queue(id,null,requestId);await deliver();now+=10000;await queue(id,null,requestId);
  assert.equal(jobs().length,1);await deliver();assert.equal(sends().length,1);
  const other=add('Other');await assert.rejects(queue(other,null,requestId),error=>error.status===409);
});

test('one-time scheduled videos wait until their exact due time',async()=>{
  const id=add(),due=start+HOUR;await queue(id,due);await deliver();assert.equal(sends().length,0);
  now=due-1;await deliver();assert.equal(sends().length,0);now=due;await deliver();assert.equal(sends().length,1);assert.equal(jobs()[0].kind,'scheduled');
});

test('automatic videos rotate in uploaded order and repeat over 24 hours without duplicating a slot',async()=>{
  const ids=[add('First'),add('Second')];await save();
  for(let hour=6;hour<=24;hour+=6){now=start+hour*HOUR;await deliver();await deliver();}
  assert.equal(sends().length,4);assert.deepEqual(jobs().map(job=>job.video_id),[ids[0],ids[1],ids[0],ids[1]]);
  assert.equal(new Set(jobs().map(job=>job.request_id)).size,4);assert.equal(config().next_run_at,start+30*HOUR);
});

test('missed automatic slots produce one current occurrence and keep the original anchor',async()=>{
  add();await save();now=start+25*HOUR;await deliver();assert.equal(sends().length,1);assert.equal(jobs().length,1);
  assert.equal(jobs()[0].run_at,start+24*HOUR);assert.equal(config().next_run_at,start+30*HOUR);
  now+=10_000;await deliver();assert.equal(sends().length,1);
});

test('automation without active videos skips an elapsed slot and continues its six-hour schedule',async()=>{
  const id=add();hot.updateHotVideo(db(),{id,active:false},clock);await save();now=start+6*HOUR;await deliver();
  assert.equal(sends().length,0);assert.equal(jobs().length,0);assert.equal(config().next_run_at,start+12*HOUR);assert.match(config().last_error,/视频/);
});

test('reopening the production database preserves schedule, rotation and sent occurrences',async()=>{
  const ids=[add('First'),add('Second')];await save();now=start+6*HOUR;await deliver();close();
  assert.equal(hot.hotVideoStatus(db(),clock).nextRunAt,start+12*HOUR);now=start+12*HOUR;await deliver();
  assert.deepEqual(jobs().map(job=>job.video_id),ids);assert.equal(sends().length,2);
});

for(const code of [429,403])test('a definite '+code+' rejection retries the same occurrence after backoff and only to its pinned target',async()=>{
  const id=add();await queue(id);telegram.results.push({ok:false,code,retryAfter:60});await deliver();
  assert.equal(jobs()[0].status,'pending');assert.equal(jobs()[0].attempts,1);now+=59_999;await deliver();assert.equal(sends().length,1);
  now++;await deliver();assert.equal(sends().length,2);assert.equal(jobs().length,1);assert.equal(jobs()[0].status,'sent');
  assert.ok(sends().every(call=>call.p.chat_id===target));
});

test('explicit rejection retries are bounded instead of keeping a video in an infinite send loop',async()=>{
  const id=add();await queue(id);
  for(let i=0;i<5;i++){telegram.results.push({ok:false,code:429,retryAfter:1});await deliver();now=jobs()[0].next_attempt_at;}
  assert.equal(sends().length,5);assert.equal(jobs()[0].status,'failed');now+=HOUR;await deliver();assert.equal(sends().length,5);
});

for(const reply of [null,{ok:false,code:500,retryAfter:0}])test('an unconfirmed transport reply is terminal unknown and is never resent after restart '+String(reply?.code||'null'),async()=>{
  const id=add();await queue(id);telegram.results.push(reply);await deliver();assert.equal(jobs()[0].status,'unknown');assert.equal(sends().length,1);
  close();now+=24*HOUR;await deliver();assert.equal(sends().length,1);assert.equal(jobs()[0].status,'unknown');
});

test('dispatch intent is durable before the streaming transport and blocks concurrent send, cancel or deletion',async()=>{
  const id=add();await queue(id);telegram.onSend=async()=>{
    const job=jobs()[0];assert.equal(job.status,'sending');assert.equal(job.dispatch_started_at,now);assert.ok(job.lease_until>now);
    await deliver();assert.equal(sends().length,1);
    assert.throws(()=>hot.cancelHotVideoJob(db(),job.id,clock),error=>error.status===409);
    assert.throws(()=>hot.deleteHotVideo(db(),id,clock),error=>error.status===409);
  };
  await deliver();assert.equal(sends().length,1);assert.equal(jobs()[0].status,'sent');
});

for(const dispatched of [false,true])test('an expired '+(dispatched?'submitted':'preflight-only')+' lease is recovered according to whether a send could have happened',async()=>{
  const id=add();await queue(id);const job=jobs()[0];
  db().prepare("UPDATE telegram_hot_video_jobs SET status='sending',lease_id='dead',lease_until=?,dispatch_started_at=? WHERE id=?").run(now-1,dispatched?now-1000:0,job.id);
  db().prepare("UPDATE telegram_hot_video_settings SET lease_id='dead',lease_until=?").run(now-1);
  await deliver();assert.equal(jobs()[0].status,dispatched?'unknown':'sent');assert.equal(sends().length,dispatched?0:1);
});

test('changing the saved target cancels old queued work and does not retarget it to the new channel',async()=>{
  const id=add();await queue(id,start+HOUR);await save({targetChatId:String(target-1),enabled:false});now+=HOUR;await deliver();
  assert.equal(jobs()[0].status,'cancelled');assert.equal(sends().length,0);
});

test('a changed ChatBot credential invalidates old pending jobs instead of sending with the replacement token',async()=>{
  const id=add();await queue(id);db().prepare("UPDATE telegram_promotion_settings SET chat_bot_token_ciphertext='different-credential'").run();
  await deliver();assert.equal(jobs()[0].status,'cancelled');assert.equal(sends().length,0);
});

test('disabling automation stops automatic work while keeping explicitly scheduled manual videos',async()=>{
  const id=add();await save();await queue(id,start+HOUR);await save({enabled:false});now=start+6*HOUR;await deliver();
  assert.equal(sends().length,1);assert.equal(jobs()[0].kind,'scheduled');assert.equal(config().next_run_at,0);
});

test('inactive videos are skipped in automatic rotation but may still be sent manually',async()=>{
  const first=add('First'),second=add('Second');hot.updateHotVideo(db(),{id:first,active:false},clock);await save();now=start+6*HOUR;await deliver();
  assert.equal(jobs()[0].video_id,second);now+=10000;await queue(first);await deliver();assert.equal(jobs()[1].video_id,first);assert.equal(sends().length,2);
});

test('cancel and delete remove pending work and files without deleting sent delivery history',async()=>{
  const id=add();await queue(id,start+HOUR);hot.cancelHotVideoJob(db(),jobs()[0].id,clock);hot.cancelHotVideoJob(db(),jobs()[0].id,clock);
  await queue(id);await deliver();hot.deleteHotVideo(db(),id,clock);assert.equal(existsSync(path.join(hot.hotVideoStorageDirectory(),id+'.mp4')),false);
  assert.equal(hot.hotVideoStatus(db(),clock).videos.length,0);assert.equal(hot.hotVideoStatus(db(),clock).storage.bytes,0);
  assert.ok(jobs().some(job=>job.status==='sent'));assert.ok(jobs().some(job=>job.status==='cancelled'));
});

test('a changed file is detected before any send request and fails visibly',async()=>{
  const id=add();await queue(id);const filename=path.join(hot.hotVideoStorageDirectory(),id+'.mp4');const altered=mp4();altered[47]=1;writeFileSync(filename,altered);
  await deliver();assert.equal(sends().length,0);assert.equal(jobs()[0].status,'failed');assert.match(jobs()[0].last_error,/视频/);
});

test('source permissions are revalidated just before sending and missing posting rights never submit media',async()=>{
  const id=add();await queue(id);telegram.role={status:'administrator',can_post_messages:false};await deliver();
  assert.equal(sends().length,0);assert.equal(jobs()[0].status,'pending');assert.match(jobs()[0].last_error,/权限/);
  for(let attempt=1;attempt<5;attempt++){now=jobs()[0].next_attempt_at;await deliver();}
  assert.equal(jobs()[0].status,'failed');assert.equal(jobs()[0].attempts,5);assert.equal(sends().length,0);
});

test('a successful message with altered buttons is kept sent with a warning and is not posted again',async()=>{
  const id=add();await queue(id);telegram.results.push({ok:true,result:{message_id:702,chat:{id:target},video:{file_id:'x'},reply_markup:{inline_keyboard:[]}}});
  await deliver();assert.equal(jobs()[0].status,'sent');assert.match(jobs()[0].last_error,/按钮/);now+=HOUR;await deliver();assert.equal(sends().length,1);
});

test('a public channel cannot be enabled as the private Hot video destination',async()=>{
  telegram.onRequest=async(method,p)=>method==='getChat'?{ok:true,result:{id:p.chat_id,type:'channel',title:'Hot',username:'public_hot'}}:undefined;
  await assert.rejects(save(),error=>error.status===400);assert.equal(sends().length,0);assert.equal(config().enabled,0);
});

test('a Hot destination that becomes public is stopped before any upload is submitted',async()=>{
  const id=add();await queue(id);
  telegram.onRequest=async(method,p)=>method==='getChat'?{ok:true,result:{id:p.chat_id,type:'channel',title:'Hot',active_usernames:['public_hot']}}:undefined;
  await deliver();assert.equal(sends().length,0);assert.equal(jobs()[0].status,'failed');
});

test('an old rejected automatic occurrence is cancelled before a later slot rather than bursting two uploads after downtime',async()=>{
  const ids=[add('First'),add('Second')];await save();now=start+6*HOUR;
  telegram.results.push({ok:false,code:429,retryAfter:60});await deliver();assert.equal(jobs()[0].status,'pending');
  now=start+12*HOUR;await deliver();assert.equal(sends().length,2);assert.equal(jobs().length,2);
  assert.equal(jobs()[0].status,'cancelled');assert.equal(jobs()[1].status,'sent');assert.equal(jobs()[1].video_id,ids[1]);
  now+=10000;await deliver();assert.equal(sends().length,2);
});

test('new automatic slots preserve old unknown sends and explicit overdue schedules',async()=>{
  const ids=[add('First'),add('Second')];await save();await queue(ids[1],start+7*HOUR);
  now=start+6*HOUR;telegram.results.push(null);await deliver();assert.equal(jobs().find(job=>job.kind==='automatic').status,'unknown');
  now=start+12*HOUR;await deliver();assert.equal(jobs().find(job=>job.kind==='scheduled').status,'sent');
  assert.equal(jobs().find(job=>job.run_at===start+6*HOUR).status,'unknown');
  now+=3000;await deliver();assert.equal(sends().length,3);assert.equal(jobs().filter(job=>job.kind==='automatic'&&job.status==='sent').length,1);
});

test('a credential change during recipient verification cancels that pending send without submitting video',async()=>{
  const id=add();await queue(id);
  telegram.onRequest=async(method)=>{if(method==='getChatMember')db().prepare("UPDATE telegram_promotion_settings SET chat_bot_token_ciphertext='new-cipher'").run();};
  await deliver();assert.equal(jobs()[0].status,'cancelled');assert.equal(sends().length,0);
});

for(const credential of ['', 'rotated-credential'])test('automation can be stopped without Telegram access after its credential is '+(credential?'rotated':'removed'),async()=>{
  add();await save();db().prepare('UPDATE telegram_promotion_settings SET chat_bot_token_ciphertext=?').run(credential);
  const before=telegram.calls.length;await save({enabled:false});assert.equal(telegram.calls.length,before);
  assert.equal(config().enabled,0);assert.equal(config().next_run_at,0);
});

test('a disabled destination draft does not use the network or inherit old destination verification',async()=>{
  await save();const before=telegram.calls.length;
  const status=await save({enabled:false,targetChatId:String(target-1)});
  assert.equal(telegram.calls.length,before);assert.equal(status.targetChatId,String(target-1));assert.equal(status.ready,false);
});

test('larger original videos use actual free disk rather than the old 300 MiB quota',t=>{
  t.mock.method(fs.default,'statfsSync',()=>({bavail:800,bsize:1024*1024}));
  const id=add();db().prepare('UPDATE telegram_hot_videos SET bytes=? WHERE id=?').run(400*1024*1024,id);
  hot.reserveHotVideoUpload(db(),{id:randomUUID(),bytes:500*1024*1024},clock);
  assert.equal(hot.hotVideoStatus(db(),clock).storage.availableBytes,236*1024*1024);
  assert.throws(()=>hot.reserveHotVideoUpload(db(),{id:randomUUID(),bytes:237*1024*1024},clock),error=>error.status===413);
  hot.reserveHotVideoUpload(db(),{id:randomUUID(),bytes:236*1024*1024},clock);
  assert.equal(hot.hotVideoStatus(db(),clock).storage.availableBytes,0);
});

test('replacing a saved file with a symlink cannot bypass the last pre-dispatch validation',async()=>{
  const id=add();await queue(id);const filename=path.join(hot.hotVideoStorageDirectory(),id+'.mp4');
  const outside=path.join(process.env.DATA_DIR,'outside.mp4');writeFileSync(outside,mp4());rmSync(filename);symlinkSync(outside,filename);
  await deliver();assert.equal(sends().length,0);assert.equal(jobs()[0].status,'failed');
});

async function addLarge(){
 const id=add(),filename=path.join(hot.hotVideoStorageDirectory(),id+'.mp4'),bytes=60*1024*1024;
 fs.default.truncateSync(filename,bytes);
 const digest=createHash('sha256');for await(const part of fs.default.createReadStream(filename))digest.update(part);
 db().prepare('UPDATE telegram_hot_videos SET bytes=?,sha256=? WHERE id=?').run(bytes,digest.digest('hex'),id);return id;
}
test('large original videos select the native bot path and keep the six-hour schedule unchanged',async()=>{
 const id=await addLarge();await save();const next=config().next_run_at;await queue(id);await deliver();
 assert.equal(sends().length,0);assert.equal(native.calls.length,1);assert.equal(jobs()[0].status,'sent');assert.equal(jobs()[0].message_id,702);assert.ok(jobs()[0].dispatch_started_at>0);assert.equal(config().next_run_at,next);
});
test('long native preparation renews its own unexpired leases before committing a message attempt',async()=>{
 const id=await addLarge();await queue(id);
 native.onSend=async input=>{
   for(let i=0;i<4;i++){now+=110000;assert.equal(input.valid(),true);input.renew();assert.equal(jobs()[0].dispatch_started_at,0);}
   input.onDispatch();return {ok:true,result:{message_id:703,chat:{id:target},video:{},reply_markup:{inline_keyboard:hot.hotVideoKeyboard()}}};
 };
 await deliver();assert.equal(jobs()[0].status,'sent');assert.equal(jobs()[0].message_id,703);assert.equal(sends().length,0);
});
test('native preparation failure is retryable without a committed send attempt',async()=>{
 const id=await addLarge();await queue(id);native.onSend=async()=>{throw new hot.HotVideoError('Temporary preparation failure',503)};await deliver();
 assert.equal(jobs()[0].status,'pending');assert.equal(jobs()[0].dispatch_started_at,0);assert.equal(native.calls.length,1);assert.equal(sends().length,0);
});
test('a native timeout after dispatch becomes terminal unknown and is never automatically resent',async()=>{
 const id=await addLarge();await queue(id);native.onSend=async input=>{input.onDispatch();throw new Error('ambiguous transport')};await deliver();
 assert.equal(jobs()[0].status,'unknown');assert.ok(jobs()[0].dispatch_started_at>0);now+=240000;await deliver();assert.equal(native.calls.length,1);assert.equal(sends().length,0);
});
test('expired native preparation cannot renew or submit after another lease could have claimed it',async()=>{
 const id=await addLarge();await queue(id);native.onSend=async input=>{now+=120001;assert.equal(input.valid(),false);assert.throws(input.renew,e=>e.status===409);input.onDispatch();return null};await deliver();
 assert.equal(jobs()[0].dispatch_started_at,0);assert.equal(jobs()[0].status,'cancelled');assert.equal(sends().length,0);
});
