import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const fixture=mkdtempSync(path.join(tmpdir(),'hot-video-chunk-routes-')),origin='https://directory.example';
const oldUrl=process.env.APP_URL;
function write(p,s){const dest=path.join(fixture,p);mkdirSync(path.dirname(dest),{recursive:true});writeFileSync(dest,s);}
write('package.json','{"type":"commonjs"}');
symlinkSync(fileURLToPath(new URL('../node_modules',import.meta.url)),path.join(fixture,'node_modules'),'dir');
for(const name of ['app/api/admin/telegram/hot-videos/uploads/route','app/api/admin/telegram/hot-videos/uploads/[id]/route',
  'app/api/admin/telegram/hot-videos/uploads/[id]/complete/route','app/api/admin/_security','app/lib/auth-core','app/lib/telegram-hot-video-limits'])
  write(name+'.js',ts.transpileModule(readFileSync(new URL('../'+name+'.ts',import.meta.url),'utf8'),
    {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText);
write('app/chatgpt-auth.js','exports.authenticated=true;exports.getChatGPTUser=async()=>exports.authenticated?{username:"fixture"}:null;');
write('app/lib/directory.js','exports.SettingsValidationError=class extends Error{};exports.PromotionValidationError=class extends Error{};');
write('app/lib/sqlite.js','exports.getSqlite=()=>({tag:"db"});');
write('app/lib/telegram-hot-videos.js','exports.HotVideoError=class extends Error{constructor(m,s=400){super(m);this.status=s;}};');
write('app/lib/telegram-promotions.js','exports.telegramHotVideoStatus=()=>({enabled:true,intervalHours:6,videos:[{id:"saved"}]});');
write('app/lib/telegram-hot-video-chunks.js',`
exports.calls=[];exports.failure=null;exports.status={id:'123e4567-e89b-42d3-a456-426614174000',bytes:24,receivedBytes:0,chunkBytes:1048576,state:'uploading'};
for(const name of ['startHotVideoUpload','hotVideoUploadStatus','appendHotVideoChunk','finalizeHotVideoUpload','cancelHotVideoUpload'])
exports[name]=async(...args)=>{exports.calls.push({name,args});if(exports.failure)throw exports.failure;return exports.status;};
`);
const require=createRequire(import.meta.url),auth=require(path.join(fixture,'app/chatgpt-auth.js'));
const service=require(path.join(fixture,'app/lib/telegram-hot-video-chunks.js'));
const {HotVideoError}=require(path.join(fixture,'app/lib/telegram-hot-videos.js'));
const start=require(path.join(fixture,'app/api/admin/telegram/hot-videos/uploads/route.js'));
const chunk=require(path.join(fixture,'app/api/admin/telegram/hot-videos/uploads/[id]/route.js'));
const complete=require(path.join(fixture,'app/api/admin/telegram/hot-videos/uploads/[id]/complete/route.js'));
const id='123e4567-e89b-42d3-a456-426614174000',context=()=>({params:Promise.resolve({id})});
const valid=()=>({requestId:id,title:'Video',originalName:'video.mp4',bytes:24});
function request(method,body,headers={}){return new Request(origin+'/api/admin/telegram/hot-videos/uploads/'+id,{method,
  headers:{origin,'content-type':'application/json',...headers},...(body===undefined?{}:{body:typeof body==='string'||body instanceof Uint8Array?body:JSON.stringify(body)})});}
async function check(response,status){assert.equal(response.status,status);assert.equal(response.headers.get('cache-control'),'no-store');return response.json();}
test.beforeEach(()=>{process.env.APP_URL=origin;auth.authenticated=true;service.calls.length=0;service.failure=null;});
test.after(()=>{if(oldUrl===undefined)delete process.env.APP_URL;else process.env.APP_URL=oldUrl;rmSync(fixture,{recursive:true,force:true});});

test('every chunk protocol endpoint checks administrator before reading body or accessing storage',async()=>{
  auth.authenticated=false;
  for(const [fn,req] of [[start.POST,request('POST',valid())],[chunk.GET,request('GET')],[chunk.PUT,request('PUT','bytes')],
    [chunk.DELETE,request('DELETE')],[complete.POST,request('POST')]]){
    await check(await fn(req,context()),401);assert.equal(req.bodyUsed,false);
  }assert.deepEqual(service.calls,[]);
});
test('all chunk mutations reject foreign origins and forged fetch context before storage',async()=>{
  for(const headers of [{origin:'https://other.example'},{origin:''},{'sec-fetch-site':'cross-site'}])
    for(const [fn,method,body] of [[start.POST,'POST',valid()],[chunk.PUT,'PUT','video'],[chunk.DELETE,'DELETE'],[complete.POST,'POST']])
      await check(await fn(request(method,body,headers),context()),403);
  assert.deepEqual(service.calls,[]);
});
test('session start rejects malformed or excessive metadata and credential/caption fields',async()=>{
  for(const body of ['{bad',new Uint8Array([255]),{...valid(),bytes:2000*1024*1024+1},{...valid(),bytes:'24'},
    {...valid(),requestId:'not-a-uuid'},{...valid(),title:''},{...valid(),caption:'never send'}, {...valid(),token:'never accept'}])
    await check(await start.POST(request('POST',body)),400);
  await check(await start.POST(request('POST',valid(),{'content-length':'30001'})),413);
  await check(await start.POST(request('POST',valid(),{'content-type':'text/plain'})),415);
  assert.deepEqual(service.calls,[]);
});
test('session start passes only validated bounded metadata and returns authoritative progress',async()=>{
  assert.deepEqual(await check(await start.POST(request('POST',valid())),200),service.status);
  assert.equal(service.calls[0].name,'startHotVideoUpload');assert.deepEqual(service.calls[0].args[1],valid());
});
test('dynamic upload IDs and chunk offsets are validated before reading binary bytes',async()=>{
  const bad={params:Promise.resolve({id:'../../private'})};
  await check(await chunk.GET(request('GET'),bad),400);await check(await chunk.DELETE(request('DELETE'),bad),400);
  await check(await complete.POST(request('POST'),bad),400);
  for(const offset of ['', '-1','1.5','01','10000000000','NaN']){
    const req=request('PUT','bytes',{'content-type':'application/octet-stream','x-video-offset':offset});
    await check(await chunk.PUT(req,context()),400);assert.equal(req.bodyUsed,false);
  }
  await check(await chunk.PUT(request('PUT','bytes',{'content-type':'video/mp4','x-video-offset':'0'}),context()),415);
  assert.deepEqual(service.calls,[]);
});
test('chunk, status and cancellation wire the authenticated ID and raw request without JSON parsing',async()=>{
  const req=request('PUT',new Uint8Array([1,2,3]),{'content-type':'application/octet-stream','x-video-offset':'1048576'});
  await check(await chunk.PUT(req,context()),200);
  assert.equal(service.calls[0].name,'appendHotVideoChunk');assert.equal(service.calls[0].args[1],id);assert.equal(service.calls[0].args[2],1048576);assert.equal(service.calls[0].args[3],req);
  await check(await chunk.GET(request('GET'),context()),200);assert.equal(service.calls[1].name,'hotVideoUploadStatus');
  assert.deepEqual(await check(await chunk.DELETE(request('DELETE'),context()),200),{cancelled:true});assert.equal(service.calls[2].name,'cancelHotVideoUpload');
});
test('idempotent completion returns the current library only after storage finalization',async()=>{
  assert.deepEqual(await check(await complete.POST(request('POST'),context()),200),{enabled:true,intervalHours:6,videos:[{id:'saved'}]});
  assert.equal(service.calls[0].name,'finalizeHotVideoUpload');assert.equal(service.calls[0].args[1],id);
  service.failure=new HotVideoError('上传还未完成。',409);
  assert.deepEqual(await check(await complete.POST(request('POST'),context()),409),{error:'上传还未完成。'});
});

test('chunk offset format supports positions above 100 MB and within the large-video range',async()=>{
 const req=request('PUT','bytes',{'content-type':'application/octet-stream','x-video-offset':'125829120'});
 await check(await chunk.PUT(req,context()),200);assert.equal(service.calls[0].args[2],125829120);
});
