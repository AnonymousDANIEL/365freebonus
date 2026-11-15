import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

// Real private files, SQLite reservations and upload leases. Telegram is never
// used by the upload path and is replaced with a failing transport as proof.
const fixture=mkdtempSync(path.join(tmpdir(),'telegram-hot-chunks-'));
writeFileSync(path.join(fixture,'package.json'),'{"type":"commonjs"}');
for(const name of ['sqlite','telegram-hot-video-limits','telegram-hot-videos','telegram-hot-video-chunks'])writeFileSync(path.join(fixture,name+'.js'),ts.transpileModule(
  readFileSync(new URL('../app/lib/'+name+'.ts',import.meta.url),'utf8'),
  {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}},
).outputText);
writeFileSync(path.join(fixture,'telegram-bot.js'),`
exports.calls=[];
exports.telegramRequest=async(...args)=>{exports.calls.push(args);throw new Error('Uploads must not call Telegram');};
exports.telegramVideoFileRequest=async(...args)=>{exports.calls.push(args);throw new Error('Uploads must not send videos');};
`);
const require=createRequire(import.meta.url);
const chunks=require(path.join(fixture,'telegram-hot-video-chunks.js'));
const hot=require(path.join(fixture,'telegram-hot-videos.js'));
const telegram=require(path.join(fixture,'telegram-bot.js'));
const {getSqlite}=require(path.join(fixture,'sqlite.js'));
const previousData=process.env.DATA_DIR;
const initial=1_800_000_000_000,CHUNK=1024*1024;
let now=initial;
const clock=()=>now;
function db(){return getSqlite();}
function close(){const filename=path.join(process.env.DATA_DIR,'directory.sqlite');globalThis.__directorySqlite?.get(filename)?.close();globalThis.__directorySqlite?.delete(filename);}
function file(id,extension='part'){return path.join(hot.hotVideoStorageDirectory(),id+'.'+extension);}
function videos(){return db().prepare('SELECT * FROM telegram_hot_videos ORDER BY sort_order,id').all();}
function jobs(){return db().prepare('SELECT * FROM telegram_hot_video_jobs').all();}
function reservations(){return db().prepare('SELECT * FROM telegram_hot_video_uploads ORDER BY id').all();}
function session(id){return db().prepare('SELECT * FROM telegram_hot_video_upload_sessions WHERE id=?').get(id);}
function mp4(size=48){const b=Buffer.alloc(size,0x6d);b.writeUInt32BE(24);b.write('ftypisom',4,'ascii');b.write('isommp42',16,'ascii');b.writeUInt32BE(size-24,24);b.write('mdat',28,'ascii');return b;}
function input(bytes=48,extra={}){return {requestId:randomUUID(),title:'Hot fixture',originalName:'fixture.mp4',bytes,...extra};}
async function start(bytes=48,extra={}){const value=input(bytes,extra);return {value,status:await chunks.startHotVideoUpload(db(),value,clock)};}
function body(bytes,{length=bytes.length,headers={},signal}={}){
  return new Request('https://fixture.example/api/admin/telegram/hot-videos/uploads/chunk',{method:'PUT',
    headers:{'Content-Type':'application/octet-stream',...(length===null?{}:{'Content-Length':String(length)}),...headers},body:bytes,signal});
}
async function put(id,offset,bytes,options){return await chunks.appendHotVideoChunk(db(),id,offset,body(bytes,options),clock);}
async function completed(bytes=mp4()){
  const result=await start(bytes.length);
  for(let offset=0;offset<bytes.length;offset+=CHUNK)await put(result.status.id,offset,bytes.subarray(offset,offset+CHUNK));
  return {...result,result:await chunks.finalizeHotVideoUpload(db(),result.status.id,clock),bytes};
}
test.beforeEach(()=>{process.env.DATA_DIR=mkdtempSync(path.join(fixture,'case-'));now=initial;telegram.calls.length=0;db();});
test.afterEach(()=>{assert.equal(telegram.calls.length,0);close();});
test.after(()=>{if(previousData===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previousData;rmSync(fixture,{recursive:true,force:true});});

test('initialization reserves a private upload and exposes only resumable progress',async()=>{
  const {value,status}=await start();
  assert.equal(status.id,value.requestId);assert.equal(status.requestId,value.requestId);assert.equal(status.bytes,48);
  assert.equal(status.receivedBytes,0);assert.equal(status.chunkBytes,CHUNK);assert.equal(status.state,'uploading');
  assert.equal(status.videoId,null);assert.ok(status.expiresAt>now);assert.equal(reservations().length,1);
  assert.equal(videos().length,0);assert.equal(jobs().length,0);
  assert.equal(JSON.stringify(status).includes(process.env.DATA_DIR),false);
});

test('repeating initialization with the same metadata does not reserve more space',async()=>{
  const {value,status}=await start();
  assert.deepEqual(await chunks.startHotVideoUpload(db(),value,clock),status);
  assert.equal(reservations().length,1);assert.equal(hot.hotVideoStatus(db(),clock).storage.bytes,48);
});

for(const field of ['bytes','title','originalName'])test('an initialization ID cannot be rebound to different '+field,async()=>{
  const {value}=await start();
  await assert.rejects(async()=>chunks.startHotVideoUpload(db(),{...value,[field]:field==='bytes'?49:'other.mp4'},clock),error=>error.status===409);
  assert.equal(reservations().length,1);assert.equal(videos().length,0);
});

for(const change of [
  {requestId:'../../escape'}, {bytes:0}, {bytes:23}, {bytes:hot.HOT_VIDEO_MAX_BYTES+1},
  {originalName:'movie.gif'}, {originalName:'bad\rname.mp4'}, {title:' '},
])test('initialization rejects invalid upload metadata '+JSON.stringify(change),async()=>{
  await assert.rejects(async()=>chunks.startHotVideoUpload(db(),input(48,change),clock),error=>[400,413,415].includes(error.status));
  assert.equal(reservations().length,0);assert.equal(videos().length,0);
});

test('two upload sessions share the existing concurrent reservation limit',async()=>{
  await start();await start();await assert.rejects(start(),error=>error.status===429);
  assert.equal(reservations().length,2);
});

test('one valid chunk acknowledges saved bytes without publishing or registering the video',async()=>{
  const {status}=await start();const bytes=mp4();
  const result=await put(status.id,0,bytes);
  assert.equal(result.receivedBytes,bytes.length);assert.equal(result.state,'uploading');
  assert.deepEqual(readFileSync(file(status.id)),bytes);assert.equal(lstatSync(file(status.id)).mode&0o777,0o600);
  assert.equal(videos().length,0);assert.equal(jobs().length,0);
});

test('finalization creates one verified private video and releases its reservation',async()=>{
  const {status,result,bytes}=await completed();
  assert.equal(result.state,'complete');assert.equal(result.videoId,status.id);assert.equal(result.receivedBytes,bytes.length);
  assert.equal(reservations().length,0);assert.equal(videos().length,1);assert.equal(videos()[0].id,status.id);
  assert.equal(videos()[0].sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(readFileSync(file(status.id,'mp4')),bytes);assert.equal(existsSync(file(status.id)),false);assert.equal(jobs().length,0);
});

test('lost finalization replies can be retried without another video, reservation or send job',async()=>{
  const {status,value}=await completed();
  assert.equal((await chunks.finalizeHotVideoUpload(db(),status.id,clock)).state,'complete');
  assert.equal((await chunks.hotVideoUploadStatus(db(),status.id,clock)).state,'complete');
  assert.equal((await chunks.startHotVideoUpload(db(),value,clock)).state,'complete');
  assert.equal(videos().length,1);assert.equal(reservations().length,0);assert.equal(jobs().length,0);
});

test('finalization recovers a completed file renamed before the registration transaction committed',async()=>{
  const {status}=await start();await put(status.id,0,mp4());
  renameSync(file(status.id),file(status.id,'mp4'));close();
  const result=await chunks.finalizeHotVideoUpload(db(),status.id,clock);
  assert.equal(result.state,'complete');assert.equal(videos().length,1);assert.equal(videos()[0].id,status.id);
  assert.equal(reservations().length,0);assert.deepEqual(readFileSync(file(status.id,'mp4')),mp4());
});

test('finalization infers a committed video if its session completion reply was lost',async()=>{
  const {status}=await completed();
  db().prepare("UPDATE telegram_hot_video_upload_sessions SET state='uploading' WHERE id=?").run(status.id);close();
  assert.equal((await chunks.hotVideoUploadStatus(db(),status.id,clock)).state,'complete');
  assert.equal((await chunks.finalizeHotVideoUpload(db(),status.id,clock)).state,'complete');
  assert.equal(videos().length,1);assert.equal(reservations().length,0);assert.equal(jobs().length,0);
});

test('the same acknowledged chunk can be retried but different bytes at that offset cannot replace it',async()=>{
  const {status}=await start();const bytes=mp4();await put(status.id,0,bytes);
  assert.equal((await put(status.id,0,bytes)).receivedBytes,bytes.length);
  const different=Buffer.from(bytes);different[different.length-1]^=1;
  await assert.rejects(put(status.id,0,different),error=>error.status===409);
  assert.deepEqual(readFileSync(file(status.id)),bytes);assert.equal(videos().length,0);
});

test('multiple one MiB chunks retain an exact byte sequence and progress after reopening SQLite',async()=>{
  const bytes=mp4(2*CHUNK+48),{status}=await start(bytes.length);
  assert.equal((await put(status.id,0,bytes.subarray(0,CHUNK))).receivedBytes,CHUNK);
  close();assert.equal((await chunks.hotVideoUploadStatus(db(),status.id,clock)).receivedBytes,CHUNK);
  assert.equal((await put(status.id,CHUNK,bytes.subarray(CHUNK,2*CHUNK))).receivedBytes,2*CHUNK);
  assert.equal((await put(status.id,2*CHUNK,bytes.subarray(2*CHUNK))).receivedBytes,bytes.length);
  await chunks.finalizeHotVideoUpload(db(),status.id,clock);
  assert.deepEqual(readFileSync(file(status.id,'mp4')),bytes);assert.equal(videos().length,1);
});

test('missing bytes cannot be finalized or filled out of order',async()=>{
  const {status}=await start(CHUNK+48);
  await assert.rejects(chunks.finalizeHotVideoUpload(db(),status.id,clock),error=>error.status===409);
  await assert.rejects(put(status.id,CHUNK,mp4()),error=>[400,409].includes(error.status));
  assert.equal((await chunks.hotVideoUploadStatus(db(),status.id,clock)).receivedBytes,0);assert.equal(videos().length,0);
});

test('an oversized chunk is rejected without acknowledging or registering partial content',async()=>{
  const {status}=await start(2*CHUNK);
  await assert.rejects(put(status.id,0,Buffer.alloc(CHUNK+1)),error=>error.status===413);
  assert.equal((await chunks.hotVideoUploadStatus(db(),status.id,clock)).receivedBytes,0);assert.equal(videos().length,0);
});

test('a truncated declared chunk can be retried from its last durable acknowledgment',async()=>{
  const {status}=await start();
  await assert.rejects(put(status.id,0,mp4().subarray(0,12),{length:48}),error=>[400,409].includes(error.status));
  assert.equal((await chunks.hotVideoUploadStatus(db(),status.id,clock)).receivedBytes,0);
  assert.equal((await put(status.id,0,mp4())).receivedBytes,48);
});

test('a midstream transport failure does not acknowledge the failed chunk',async()=>{
  const {status}=await start();let reads=0;
  const stream=new ReadableStream({pull(controller){if(reads++===0)controller.enqueue(mp4().subarray(0,12));else controller.error(new Error('fixture disconnected'));}});
  const request=new Request('https://fixture.example/chunk',{method:'PUT',duplex:'half',headers:{'Content-Type':'application/octet-stream','Content-Length':'48'},body:stream});
  await assert.rejects(chunks.appendHotVideoChunk(db(),status.id,0,request,clock));
  assert.equal((await chunks.hotVideoUploadStatus(db(),status.id,clock)).receivedBytes,0);
  if(existsSync(file(status.id)))assert.equal(lstatSync(file(status.id)).size,0);
  await put(status.id,0,mp4());assert.equal((await chunks.finalizeHotVideoUpload(db(),status.id,clock)).state,'complete');
});

test('the upload lease is durable before reading a chunk and blocks concurrent append and cancel',async()=>{
  const {status}=await start();let controller;
  const stream=new ReadableStream({start(value){controller=value;}});
  const request=new Request('https://fixture.example/chunk',{method:'PUT',duplex:'half',headers:{'Content-Type':'application/octet-stream','Content-Length':'48'},body:stream});
  const pending=chunks.appendHotVideoChunk(db(),status.id,0,request,clock);
  try {
    for(let spin=0;spin<30&&!session(status.id)?.lease_id;spin++)await new Promise(resolve=>setImmediate(resolve));
    assert.ok(session(status.id).lease_id);assert.ok(session(status.id).lease_until>now);assert.equal(session(status.id).received_bytes,0);
    await assert.rejects(put(status.id,0,mp4()),error=>[409,423].includes(error.status));
    await assert.rejects(async()=>chunks.cancelHotVideoUpload(db(),status.id,clock),error=>[409,423].includes(error.status));
  } finally {controller.enqueue(mp4());controller.close();}
  assert.equal((await pending).receivedBytes,48);
  assert.equal(session(status.id).received_bytes,48);assert.deepEqual(readFileSync(file(status.id)),mp4());
});

test('an expired old chunk writer cannot overwrite a newer acknowledged chunk after restarting its lease',async()=>{
  const {status}=await start();let controller;
  const stream=new ReadableStream({start(value){controller=value;}});
  const request=new Request('https://fixture.example/chunk',{method:'PUT',duplex:'half',headers:{'Content-Type':'application/octet-stream','Content-Length':'48'},body:stream});
  const pending=chunks.appendHotVideoChunk(db(),status.id,0,request,clock);
  const observed=pending.then(value=>({value}),error=>({error}));
  for(let spin=0;spin<30&&!session(status.id)?.lease_id;spin++)await new Promise(resolve=>setImmediate(resolve));
  assert.ok(session(status.id).lease_id);
  now=session(status.id).lease_until+1;
  try {assert.equal((await put(status.id,0,mp4())).receivedBytes,48);}
  finally {const changed=mp4();changed[47]^=1;controller.enqueue(changed);controller.close();}
  const old=await observed;assert.ok(old.error);assert.equal(old.error.status,409);
  assert.equal(session(status.id).received_bytes,48);assert.deepEqual(readFileSync(file(status.id)),mp4());
});

test('unacknowledged tail bytes left by a restart are discarded before the next chunk',async()=>{
  const bytes=mp4(CHUNK+48),{status}=await start(bytes.length);
  await put(status.id,0,bytes.subarray(0,CHUNK));
  appendFileSync(file(status.id),Buffer.from('unacknowledged tail'));close();
  assert.equal((await chunks.hotVideoUploadStatus(db(),status.id,clock)).receivedBytes,CHUNK);
  await put(status.id,CHUNK,bytes.subarray(CHUNK));await chunks.finalizeHotVideoUpload(db(),status.id,clock);
  assert.deepEqual(readFileSync(file(status.id,'mp4')),bytes);
});

test('a file truncated below the acknowledged offset is not silently completed with missing bytes',async()=>{
  const bytes=mp4(CHUNK+48),{status}=await start(bytes.length);
  await put(status.id,0,bytes.subarray(0,CHUNK));truncateSync(file(status.id),100);
  await assert.rejects(put(status.id,CHUNK,bytes.subarray(CHUNK)),error=>[409,410].includes(error.status));
  assert.equal(videos().length,0);assert.equal(jobs().length,0);
});

test('a private upload symlink cannot overwrite another file',async()=>{
  const {status}=await start(),outside=path.join(process.env.DATA_DIR,'outside.mp4');
  writeFileSync(outside,Buffer.from('private other file'));
  if(existsSync(file(status.id)))unlinkSync(file(status.id));symlinkSync(outside,file(status.id));
  await assert.rejects(put(status.id,0,mp4()),error=>[409,410,503].includes(error.status));
  assert.equal(readFileSync(outside,'utf8'),'private other file');assert.equal(videos().length,0);
});

test('active chunks extend upload expiry and retain the same storage reservation',async()=>{
  const bytes=mp4(CHUNK+48),{status}=await start(bytes.length);
  now+=5*60_000;await put(status.id,0,bytes.subarray(0,CHUNK));
  now+=9*60_000;
  const result=await chunks.hotVideoUploadStatus(db(),status.id,clock);
  assert.equal(result.state,'uploading');assert.equal(result.receivedBytes,CHUNK);assert.ok(result.expiresAt>now);
  assert.equal(reservations().length,1);await put(status.id,CHUNK,bytes.subarray(CHUNK));
  assert.equal((await chunks.finalizeHotVideoUpload(db(),status.id,clock)).state,'complete');
});

test('expired sessions cannot acknowledge or finalize new content',async()=>{
  const {status}=await start();now+=10*60_000+1;
  await assert.rejects(async()=>chunks.hotVideoUploadStatus(db(),status.id,clock),error=>[409,410].includes(error.status));
  await assert.rejects(put(status.id,0,mp4()),error=>[409,410].includes(error.status));
  await assert.rejects(chunks.finalizeHotVideoUpload(db(),status.id,clock),error=>[409,410].includes(error.status));
  assert.equal(videos().length,0);
});

test('cancelling an upload frees its reservation and private temporary file without touching published videos',async()=>{
  const saved=await completed(),{status}=await start();
  await put(status.id,0,mp4());await chunks.cancelHotVideoUpload(db(),status.id,clock);
  assert.equal(existsSync(file(status.id)),false);assert.equal(reservations().length,0);
  assert.equal(videos().length,1);assert.equal(videos()[0].id,saved.status.id);assert.equal(existsSync(file(saved.status.id,'mp4')),true);
});

test('a malformed completed MP4 is never registered or sent',async()=>{
  const {status}=await start();await put(status.id,0,Buffer.alloc(48));
  await assert.rejects(chunks.finalizeHotVideoUpload(db(),status.id,clock),error=>[400,415].includes(error.status));
  assert.equal(videos().length,0);assert.equal(jobs().length,0);
});

test('uploading, completing and cancelling do not reset an enabled schedule or existing send records',async()=>{
  const oldId=randomUUID(),bytes=mp4();
  hot.reserveHotVideoUpload(db(),{id:oldId,bytes:bytes.length},clock);writeFileSync(file(oldId,'mp4'),bytes,{mode:0o600});
  hot.registerHotVideo(db(),{id:oldId,title:'Existing',originalName:'old.mp4',fileName:oldId+'.mp4',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},clock);
  db().prepare(`INSERT INTO telegram_hot_video_settings(id,enabled,target_chat_id,next_run_at,revision,last_auto_order)
    VALUES('primary',1,-1009000,?,'unchanged-schedule',7)`).run(now+6*3_600_000);
  db().prepare(`INSERT INTO telegram_hot_video_jobs(id,request_id,video_id,kind,status,run_at,created_at,settings_revision,
    target_chat_id,token_hash,bot_id,attempts,dispatch_started_at,last_error)
    VALUES(?,?,?,'automatic','unknown',?,?,'unchanged-schedule',-1009000,'fixture-hash',77,1,?,'Unconfirmed fixture send')`)
    .run(randomUUID(),randomUUID(),oldId,now-1000,now-1000,now-1000);
  const configBefore=db().prepare("SELECT * FROM telegram_hot_video_settings WHERE id='primary'").get(),jobsBefore=jobs();
  await completed();const pending=await start();await chunks.cancelHotVideoUpload(db(),pending.status.id,clock);
  assert.deepEqual(db().prepare("SELECT * FROM telegram_hot_video_settings WHERE id='primary'").get(),configBefore);
  assert.deepEqual(jobs(),jobsBefore);assert.equal(videos().length,2);assert.equal(reservations().length,0);
});
