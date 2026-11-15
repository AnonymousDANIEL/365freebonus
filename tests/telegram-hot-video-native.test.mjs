import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const dir=mkdtempSync(path.join(tmpdir(),'hot-video-native-'));
writeFileSync(path.join(dir,'package.json'),'{"type":"commonjs"}');
symlinkSync(fileURLToPath(new URL('../node_modules',import.meta.url)),path.join(dir,'node_modules'),'dir');
for(const name of ['sqlite','telegram-hot-video-native']) writeFileSync(path.join(dir,name+'.js'),ts.transpileModule(readFileSync(new URL('../app/lib/'+name+'.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText);
writeFileSync(path.join(dir,'telegram-account.js'),`exports.client=null;exports.application={apiId:123,apiHash:'fixture-app-hash',revision:''};exports.hotVideoBotApplication=()=>exports.application;exports.createTelegramAccountClient=(app,session)=>{exports.savedSession=session;return exports.client;};`);
writeFileSync(path.join(dir,'telegram-hot-video-mp4.js'),`exports.failure=null;exports.readHotVideoMetadata=async()=>{if(exports.failure)throw exports.failure;return {width:1280,height:720,duration:12.5,supportsStreaming:true};};`);
// Reuse the production keyboard and error class while prohibiting transport imports.
const source=readFileSync(new URL('../app/lib/telegram-hot-videos.ts',import.meta.url),'utf8');
const keyboard=source.slice(source.indexOf('export function hotVideoKeyboard()'),source.indexOf('export function hotVideoStorageDirectory'));
writeFileSync(path.join(dir,'telegram-hot-videos.js'),ts.transpileModule('export class HotVideoError extends Error{constructor(message:string,readonly status=400,readonly retryAfter=0){super(message)}}\n'+keyboard,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText);
const require=createRequire(import.meta.url),{Api}=require('teleproto'),bigInt=require('big-integer');
const account=require(path.join(dir,'telegram-account.js')),metadata=require(path.join(dir,'telegram-hot-video-mp4.js'));
const {sendLargeHotVideo,checkLargeHotVideoAccess}=require(path.join(dir,'telegram-hot-video-native.js')),{getSqlite}=require(path.join(dir,'sqlite.js'));
const {HotVideoError,hotVideoKeyboard}=require(path.join(dir,'telegram-hot-videos.js'));
const oldData=process.env.DATA_DIR,oldSecret=process.env.SESSION_SECRET;
const botId=12345678,target=-1004321816132,channelId=bigInt('4321816132'),appCipher='private-application-cipher';
let calls,db,client,dispatches,renewals,valid,uploadError,sendError,replyMode,entityOverride,meOverride;
function document(){return new Api.Document({id:bigInt(77),accessHash:bigInt(88),fileReference:Buffer.from('fixture'),date:1,mimeType:'video/mp4',size:bigInt(60*1024*1024),dcId:4,attributes:[new Api.DocumentAttributeVideo({duration:12.5,w:1280,h:720,supportsStreaming:true})]});}
function reply(request){
 const markup=new Api.ReplyInlineMarkup({rows:hotVideoKeyboard().map(row=>new Api.KeyboardInlineButtonRow({buttons:row.map(b=>new Api.KeyboardInlineButton({text:b.text,type:new Api.InlineButtonTypeUrl({url:b.url})}))}))});
 const m=new Api.Message({id:99,peerId:new Api.PeerChannel({channelId}),date:1,message:replyMode==='caption'?'unexpected caption':'',media:new Api.MessageMediaDocument({document:document()}),replyMarkup:markup});
 if(replyMode==='wrong-media')m.media=new Api.MessageMediaDocument({document:new Api.Document({...document().originalArgs,attributes:[]})});
 if(replyMode==='wrong-target')m.peerId=new Api.PeerChannel({channelId:bigInt(999)});
 return new Api.Updates({date:1,seq:1,chats:[],users:[],updates:[new Api.UpdateMessageID({id:99,randomId:request.randomId}),new Api.UpdateNewChannelMessage({message:m,pts:1,ptsCount:1})]});
}
function input(extra={}){return {db,token:'12345678:private-bot-token',botId,targetId:target,filename:'/private/original.mp4',bytes:60*1024*1024,jobId:'fixture-job',valid:()=>valid,renew:()=>{renewals++},onDispatch:()=>{calls.push('dispatch');dispatches++},...extra};}
test.beforeEach(()=>{
 process.env.DATA_DIR=mkdtempSync(path.join(dir,'case-'));process.env.SESSION_SECRET='fixture-secret-of-at-least-thirty-two-characters';db=getSqlite();
 db.exec("CREATE TABLE telegram_personal_account(id TEXT PRIMARY KEY,config_ciphertext TEXT NOT NULL)");
 db.prepare("INSERT INTO telegram_personal_account(id,config_ciphertext) VALUES('primary',?)").run(appCipher);
 account.application={apiId:123,apiHash:'fixture-app-hash',revision:createHash('sha256').update(appCipher).digest('hex')};
 calls=[];dispatches=0;renewals=0;valid=true;uploadError=null;sendError=null;replyMode='ok';entityOverride=null;meOverride=null;metadata.failure=null;
 client={session:{save:()=> 'private-independent-bot-session'},start:async args=>{calls.push('start');assert.equal(args.botAuthToken,'12345678:private-bot-token');},
  getMe:async()=>meOverride||new Api.User({id:bigInt(botId),bot:true,username:'FreeBonus365ChatBot'}),
  getEntity:async peer=>{calls.push('entity');assert.equal(peer.accessHash.toString(),'0');return entityOverride||new Api.Channel({id:channelId,accessHash:bigInt(44),title:'Hot',photo:new Api.ChatPhotoEmpty(),date:1,broadcast:true,adminRights:new Api.ChatAdminRights({postMessages:true})});},
  uploadFile:async args=>{calls.push('upload');assert.equal(dispatches,0);assert.equal(args.workers,1);assert.equal(args.maxBufferSize,1024*1024);assert.equal(args.file.path,'/private/original.mp4');assert.equal(args.file.buffer,undefined);args.onProgress(0);if(uploadError)throw uploadError;return new Api.InputFileBig({id:bigInt(1),parts:120,name:'hot-video.mp4'});},
  invoke:async(request,unused,options)=>{
   calls.push(request.className);assert.equal(options.maxRetryCount,0);assert.equal(options.floodSleepThreshold,0);
   if(request instanceof Api.messages.UploadMedia){assert.equal(dispatches,0);assert.ok(request.peer instanceof Api.InputPeerEmpty);assert.equal(request.media.forceFile,false);assert.equal(request.media.mimeType,'video/mp4');assert.deepEqual(request.media.attributes.filter(a=>a instanceof Api.DocumentAttributeVideo).map(a=>[a.w,a.h,a.duration,a.supportsStreaming]),[[1280,720,12.5,true]]);return new Api.MessageMediaDocument({document:document()});}
   assert.ok(request instanceof Api.messages.SendMedia);assert.equal(dispatches,1);assert.equal(request.message,'');assert.ok(request.media instanceof Api.InputMediaDocument);assert.equal(request.peer.channelId.toString(),channelId.toString());
   assert.deepEqual(request.replyMarkup.rows.map(r=>r.buttons.map(b=>({text:b.text,url:b.type.url}))),hotVideoKeyboard());
   if(sendError)throw sendError;return replyMode==='empty'?new Api.UpdatesTooLong():reply(request);
  },disconnect:async()=>{calls.push('disconnect')},
 };account.client=client;
});
test.afterEach(()=>{const f=path.join(process.env.DATA_DIR,'directory.sqlite');globalThis.__directorySqlite?.get(f)?.close();globalThis.__directorySqlite?.delete(f)});
test.after(()=>{if(oldData===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=oldData;if(oldSecret===undefined)delete process.env.SESSION_SECRET;else process.env.SESSION_SECRET=oldSecret;rmSync(dir,{recursive:true,force:true});});
test('large video uploads bytes before dispatch, sends playable native video with empty caption and exact three buttons',async()=>{
 const result=await sendLargeHotVideo(input());assert.equal(result.ok,true);assert.equal(result.result.message_id,99);assert.equal(result.result.caption,'');assert.ok(result.result.video);assert.deepEqual(result.result.reply_markup.inline_keyboard,hotVideoKeyboard());
 assert.deepEqual(calls,['start','entity','upload','messages.UploadMedia','dispatch','messages.SendMedia','disconnect']);assert.ok(renewals>=5);
 const stored=db.prepare('SELECT * FROM telegram_hot_video_bot_sessions').get();assert.equal(stored.bot_id,botId);assert.ok(stored.session_ciphertext.startsWith('v1.'));assert.equal(JSON.stringify(stored).includes('private-independent-bot-session'),false);assert.equal(JSON.stringify(stored).includes('private-bot-token'),false);
 calls=[];dispatches=0;await sendLargeHotVideo(input());assert.equal(account.savedSession,'private-independent-bot-session');
});
test('an invalid MP4 stops before native authorization or any message attempt',async()=>{metadata.failure=new Error('bad file');await assert.rejects(sendLargeHotVideo(input()),e=>e instanceof HotVideoError&&e.status===400);assert.equal(dispatches,0);assert.deepEqual(calls,['disconnect']);});
test('missing application configuration is explicit and does not authorize or send',async()=>{account.application=null;await assert.rejects(sendLargeHotVideo(input()),e=>e.status===409);assert.equal(dispatches,0);assert.deepEqual(calls,[]);});
for(const mismatch of ['identity','public','no-rights'])test('native preflight rejects '+mismatch+' before uploading or dispatching',async()=>{
 if(mismatch==='identity')meOverride=new Api.User({id:bigInt(999),bot:true,username:'FreeBonus365ChatBot'});
 else entityOverride=new Api.Channel({id:channelId,broadcast:true,username:mismatch==='public'?'publicchannel':undefined,title:'Hot',photo:new Api.ChatPhotoEmpty(),date:1});
 await assert.rejects(sendLargeHotVideo(input()),e=>e.status===403||e.status===409);assert.equal(dispatches,0);assert.equal(calls.includes('upload'),false);
});
test('a preparation transport failure remains safely before dispatch',async()=>{uploadError=new Error('PRIVATE_NETWORK_DETAILS');await assert.rejects(sendLargeHotVideo(input()),e=>e.status===503&&!e.message.includes('PRIVATE'));assert.equal(dispatches,0);});
test('settings changes during upload prevent a later message call',async()=>{client.uploadFile=async()=>{valid=false;return new Api.InputFileBig({id:bigInt(1),parts:120,name:'hot-video.mp4'})};await assert.rejects(sendLargeHotVideo(input()),e=>e.status===409);assert.equal(dispatches,0);});
for(const mode of ['timeout','empty','wrong-target'])test('ambiguous or unrelated actual-send response is unknown without retry: '+mode,async()=>{
 if(mode==='timeout')sendError=new Error('PRIVATE_TIMEOUT');else replyMode=mode;
 assert.equal(await sendLargeHotVideo(input()),null);assert.equal(dispatches,1);assert.equal(calls.filter(c=>c==='messages.SendMedia').length,1);
});
test('explicit FloodWait rejection is safely classified for bounded retry',async()=>{sendError=Object.assign(new Error(),{code:420,seconds:37,errorMessage:'FLOOD_WAIT_37'});assert.deepEqual(await sendLargeHotVideo(input()),{ok:false,code:429,retryAfter:37});assert.equal(dispatches,1)});
test('confirmed video with unexpected caption stays confirmed for delivery warning rather than automatic duplicate',async()=>{replyMode='caption';const r=await sendLargeHotVideo(input());assert.equal(r.ok,true);assert.equal(r.result.caption,'unexpected caption');assert.equal(dispatches,1)});
test('confirmed nonvideo never masquerades as a playable video',async()=>{replyMode='wrong-media';const r=await sendLargeHotVideo(input());assert.equal(r.ok,true);assert.equal(r.result.video,undefined);assert.equal(dispatches,1)});
test('encrypted bot session rejects tampering before any network operation',async()=>{await sendLargeHotVideo(input());calls=[];db.prepare("UPDATE telegram_hot_video_bot_sessions SET session_ciphertext=session_ciphertext||'X'").run();await assert.rejects(sendLargeHotVideo(input()),e=>e.status===409);assert.deepEqual(calls,[])});

test('read-only capability verification never reads video bytes, uploads media or dispatches a message',async()=>{
 metadata.failure=new Error('no media should be read');
 assert.equal(await checkLargeHotVideoAccess({db,token:'12345678:private-bot-token',botId,targetId:target,valid:()=>true}),true);
 assert.deepEqual(calls,['start','entity','disconnect']);assert.equal(dispatches,0);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM telegram_hot_video_bot_sessions').get().n,1);
});
