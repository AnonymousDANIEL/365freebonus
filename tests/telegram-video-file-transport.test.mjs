import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import ts from 'typescript';

const fixture=mkdtempSync(path.join(tmpdir(),'telegram-video-file-transport-'));
writeFileSync(path.join(fixture,'package.json'),'{"type":"commonjs"}');
writeFileSync(path.join(fixture,'telegram-bot.js'),ts.transpileModule(readFileSync(new URL('../app/lib/telegram-bot.ts',import.meta.url),'utf8'),
  {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText);
const require=createRequire(import.meta.url),https=require('node:https');
const {telegramVideoFileRequest}=require(path.join(fixture,'telegram-bot.js'));
const video=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom0000000000000'),Buffer.alloc(150000,7)]);
const filename=path.join(fixture,'private.mp4');writeFileSync(filename,video);
const upload={path:filename,fileName:'private.mp4',bytes:video.length};
const parameters={chat_id:-100123,reply_markup:{inline_keyboard:[[{text:'Website',url:'https://365freebonus.com/'}]]},supports_streaming:true};
test.after(()=>rmSync(fixture,{recursive:true,force:true}));
function transport(t,reply,{early=false,error=false}={}) {
  const requests=[];
  t.mock.method(https,'request',(options,callback)=>{
    const chunks=[],entry={options,chunks};requests.push(entry);let answered=false;
    const answer=()=>{if(answered)return;answered=true;const response=new EventEmitter();response.setEncoding=()=>{};
      response.destroy=()=>response.emit('error',new Error('closed'));
      callback(response);queueMicrotask(()=>{response.emit('data',typeof reply==='string'?reply:JSON.stringify(reply));response.emit('end');response.emit('close');});};
    const outgoing=new Writable({autoDestroy:false,write(chunk,_encoding,done){chunks.push(Buffer.from(chunk));
      if(error){done(new Error('network unavailable'));return;}if(early)answer();done();},final(done){answer();done();}});
    entry.outgoing=outgoing;return outgoing;
  });return requests;
}

test('private video transport streams one MP4 with exact multipart length and no caption or public URL',async t=>{
  const requests=transport(t,{ok:true,result:{message_id:7,chat:{id:-100123},video:{file_id:'fixture'}}});
  const result=await telegramVideoFileRequest('fixture-token',parameters,upload);
  assert.equal(result.ok,true);assert.equal(requests.length,1);
  const {options,chunks}=requests[0],body=Buffer.concat(chunks),text=body.toString('latin1');
  assert.equal(options.path,'/botfixture-token/sendVideo');assert.equal(options.hostname,'api.telegram.org');
  assert.equal(body.length,options.headers['Content-Length']);assert.equal(body.includes(video),true);
  assert.ok(chunks.length>2,'file is written in bounded chunks');
  assert.ok(text.includes('name="video"; filename="private.mp4"'));assert.ok(text.includes('Content-Type: video/mp4'));
  assert.equal(text.includes('name="caption"'),false);assert.equal(text.includes(filename),false);
});
test('private video transport preserves explicit rejection and retry metadata even when Telegram responds early',async t=>{
  const requests=transport(t,{ok:false,error_code:429,parameters:{retry_after:37}},{early:true});
  assert.deepEqual(await telegramVideoFileRequest('fixture-token',parameters,upload),{ok:false,code:429,retryAfter:37});
  assert.equal(requests.length,1);assert.ok(Buffer.concat(requests[0].chunks).length<video.length);
});
test('private video transport does not automatically retry an ambiguous network result',async t=>{
  const requests=transport(t,null,{error:true});
  assert.equal(await telegramVideoFileRequest('fixture-token',parameters,upload),null);assert.equal(requests.length,1);
});
test('private video transport rejects replaced size, symlinks and caption fields before networking',async t=>{
  const requests=transport(t,{ok:true,result:{message_id:7}}),link=path.join(fixture,'symlink.mp4');symlinkSync(filename,link);
  for(const [params,file] of [[parameters,{...upload,bytes:video.length+1}],
    [parameters,{...upload,path:link}],[{...parameters,caption:'must never send text'},upload],
    [parameters,{...upload,bytes:50*1024*1024+1}]]) assert.equal(await telegramVideoFileRequest('fixture-token',params,file),null);
  assert.equal(requests.length,0);
});
test('private video transport treats malformed Telegram results as unknown',async t=>{
  const requests=transport(t,'{broken json');assert.equal(await telegramVideoFileRequest('fixture-token',parameters,upload),null);assert.equal(requests.length,1);
});
