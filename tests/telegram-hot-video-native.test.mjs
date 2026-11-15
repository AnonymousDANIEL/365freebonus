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
const {sendLargeHotVideo,checkLargeHotVideoAccess,sendHotChannelVideo,markHotChannelVideoUsed,checkHotVideoSourceAccess}=require(path.join(dir,'telegram-hot-video-native.js')),{getSqlite}=require(path.join(dir,'sqlite.js'));
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

const sourceId=-1007777777777,sourceChannelId=bigInt('7777777777'),sourceMessageId=42;
function cloudInput(extra={}){return {db,token:'12345678:private-bot-token',botId,targetId:target,sourceChatId:sourceId,sourceMessageId,jobId:'cloud-job',expectedDocumentId:'77',valid:()=>valid,renew:()=>{renewals++},onDispatch:()=>{calls.push('dispatch');dispatches++},...extra};}
function installCloud({sourceRights=true,sourceProtected=false,messageProtected=false,sourceVideo=true,targetVideo=true,missingSource=false,sourceDocumentId='77',targetDocumentId='77',sourceMimeType='video/mp4',sourceAnimated=false,sourceRound=false,sourceTtlSeconds=undefined,wrongPeer=false,markerReplyId=sourceMessageId,markerMode='ok'}={}){
 const oldEntity=client.getEntity;
 client.getEntity=async peer=>{
  if(peer.channelId.toString()!==sourceChannelId.toString())return oldEntity(peer);
  calls.push('source-entity');assert.equal(peer.accessHash.toString(),'0');
  return new Api.Channel({id:sourceChannelId,accessHash:bigInt(900),title:'Source videos',username:'source_videos',photo:new Api.ChatPhotoEmpty(),date:1,broadcast:true,noforwards:sourceProtected,
    adminRights:sourceRights?new Api.ChatAdminRights({postMessages:true}):undefined});
 };
 const oldInvoke=client.invoke;
 client.uploadFile=async()=>{throw new Error('Cloud copy must never upload local media')};
 client.invoke=async(request,unused,options)=>{
  if(request instanceof Api.channels.GetMessages){
   calls.push('channels.GetMessages');assert.equal(options.maxRetryCount,0);assert.equal(dispatches,0);assert.ok(request.id[0] instanceof Api.InputMessageID);
   const fromSource=request.channel.channelId.toString()===sourceChannelId.toString();
   assert.equal(request.channel.accessHash.toString(),fromSource?'900':'44');
   const video=fromSource?sourceVideo:targetVideo,docId=fromSource?sourceDocumentId:targetDocumentId;
   const attrs=video?[new Api.DocumentAttributeVideo({duration:12.5,w:1280,h:720,supportsStreaming:true,roundMessage:fromSource&&sourceRound}),...(fromSource&&sourceAnimated?[new Api.DocumentAttributeAnimated()]:[])]:[];
   const doc=new Api.Document({...document().originalArgs,id:bigInt(docId),mimeType:fromSource?sourceMimeType:'video/mp4',attributes:attrs});
   const m=new Api.Message({id:fromSource?sourceMessageId:99,peerId:new Api.PeerChannel({channelId:wrongPeer?bigInt(998):fromSource?sourceChannelId:channelId}),date:1,
    message:fromSource?'Never copy this caption https://foreign.example':'',noforwards:fromSource?messageProtected:true,media:new Api.MessageMediaDocument({document:doc,ttlSeconds:fromSource?sourceTtlSeconds:undefined})});
   return new Api.messages.ChannelMessages({pts:1,count:1,messages:fromSource&&missingSource?[]:[m],topics:[],chats:[],users:[]});
  }
  if(request instanceof Api.messages.SendMessage){
   calls.push('messages.SendMessage');assert.equal(options.maxRetryCount,0);assert.equal(options.floodSleepThreshold,0);assert.equal(dispatches,1);
   assert.equal(request.peer.channelId.toString(),sourceChannelId.toString());assert.equal(request.message,'✅ Sent · Used');
   assert.ok(request.replyTo instanceof Api.InputReplyToMessage);assert.equal(request.replyTo.replyToMsgId,sourceMessageId);assert.equal(request.replyMarkup,undefined);
   if(sendError)throw sendError;
   if(markerMode==='empty')return new Api.UpdatesTooLong();
   const message=new Api.Message({id:144,peerId:new Api.PeerChannel({channelId:markerMode==='wrong-peer'?channelId:sourceChannelId}),date:1,message:markerMode==='wrong-text'?'other':request.message,
    replyTo:new Api.MessageReplyHeader({replyToMsgId:markerReplyId})});
   return new Api.Updates({date:1,seq:1,chats:[],users:[],updates:[new Api.UpdateMessageID({id:144,randomId:request.randomId}),new Api.UpdateNewChannelMessage({message,pts:1,ptsCount:1})]});
  }
  if(request instanceof Api.messages.SendMedia){assert.ok(request.media instanceof Api.InputMediaDocument);assert.equal(request.media.id.id.toString(),'77');assert.equal(request.media.id.accessHash.toString(),'88');assert.equal(request.fwdFrom,undefined);}
  return oldInvoke(request,unused,options);
 };
}
test('channel video is copied through fresh bot-owned cloud references with empty caption and exactly three buttons',async()=>{
 metadata.failure=new Error('Local metadata must not be read');installCloud();const r=await sendHotChannelVideo(cloudInput());
 assert.equal(r.ok,true);assert.equal(r.result.caption,'');assert.deepEqual(r.result.reply_markup.inline_keyboard,hotVideoKeyboard());assert.ok(r.result.video);
 assert.deepEqual(calls,['start','entity','source-entity','channels.GetMessages','dispatch','messages.SendMedia','disconnect']);
 assert.equal(dispatches,1);assert.ok(renewals>5);
});
test('source access check allows public source channels but does not read messages or post',async()=>{
 metadata.failure=new Error('Must not read a local file');installCloud();const r=await checkHotVideoSourceAccess(cloudInput());
 assert.deepEqual(r,{title:'Source videos',username:'source_videos'});assert.deepEqual(calls,['start','source-entity','disconnect']);assert.equal(dispatches,0);
});
test('source publishing rights are required for the default used marker',async()=>{
 installCloud({sourceRights:false});await assert.rejects(sendHotChannelVideo(cloudInput()),e=>e.status===403);assert.equal(dispatches,0);assert.equal(calls.includes('channels.GetMessages'),false);
});
test('explicitly disabling source markers permits a readable source without source posting rights',async()=>{
 installCloud({sourceRights:false});const r=await sendHotChannelVideo(cloudInput({requireSourcePost:false}));assert.equal(r.ok,true);assert.equal(dispatches,1);
});
for(const [name,options,status] of [
 ['protected channel',{sourceProtected:true},400],['protected message',{messageProtected:true},400],['nonvideo source',{sourceVideo:false},400],
 ['WebM with video attributes',{sourceMimeType:'video/webm'},400],['MKV with video attributes',{sourceMimeType:'video/x-matroska'},400],
 ['QuickTime with video attributes',{sourceMimeType:'video/quicktime'},400],['animated MP4/GIF',{sourceAnimated:true},400],['round video',{sourceRound:true},400],['TTL video',{sourceTtlSeconds:30},400],
 ['deleted source',{missingSource:true},404],['replaced source video',{sourceDocumentId:'78'},409],['wrong source peer',{wrongPeer:true},404],
])test('cloud source '+name+' never reaches actual dispatch',async()=>{installCloud(options);await assert.rejects(sendHotChannelVideo(cloudInput()),e=>e.status===status);assert.equal(dispatches,0);assert.equal(calls.includes('messages.SendMedia'),false)});
test('cloud copy guards are checked again after source read and before actual send',async()=>{
 installCloud();const oldInvoke=client.invoke;client.invoke=async(...args)=>{const r=await oldInvoke(...args);if(args[0] instanceof Api.channels.GetMessages)valid=false;return r};
 await assert.rejects(sendHotChannelVideo(cloudInput()),e=>e.status===409);assert.equal(dispatches,0);
});
for(const mode of ['timeout','empty','wrong-target'])test('cloud video ambiguity is terminal unknown without a second message call: '+mode,async()=>{
 installCloud();if(mode==='timeout')sendError=new Error('PRIVATE_TIMEOUT');else replyMode=mode;
 assert.equal(await sendHotChannelVideo(cloudInput()),null);assert.equal(dispatches,1);assert.equal(calls.filter(c=>c==='messages.SendMedia').length,1);
});
test('confirmed media produces only a source reply marker after matching the published target video, even when target is protected',async()=>{
 installCloud();const r=await markHotChannelVideoUsed({...cloudInput(),targetMessageId:99,markerId:'marker-1'});
 assert.deepEqual(r,{ok:true,result:{message_id:144,chat:{id:sourceId},text:'✅ Sent · Used',reply_to_message:{message_id:sourceMessageId}}});
 assert.deepEqual(calls,['start','entity','source-entity','channels.GetMessages','channels.GetMessages','dispatch','messages.SendMessage','disconnect']);
 assert.equal(calls.includes('messages.SendMedia'),false);assert.equal(dispatches,1);
});
for(const [name,options,status] of [['target video mismatch',{targetDocumentId:'79'},409],['source replacement',{sourceDocumentId:'78'},409],['source no publish rights',{sourceRights:false},403],['target is not a video',{targetVideo:false},400]])test('marker refuses '+name+' without posting anything',async()=>{
 installCloud(options);await assert.rejects(markHotChannelVideoUsed({...cloudInput(),targetMessageId:99,markerId:'marker-1'}),e=>e.status===status);assert.equal(dispatches,0);assert.equal(calls.includes('messages.SendMessage'),false);
});
for(const [name,options] of [['wrong reply ID',{markerReplyId:999}],['unknown response',{markerMode:'empty'}],['wrong source peer',{markerMode:'wrong-peer'}],['wrong marker text',{markerMode:'wrong-text'}]])test('marker '+name+' remains unknown with exactly one attempt',async()=>{
 installCloud(options);assert.equal(await markHotChannelVideoUsed({...cloudInput(),targetMessageId:99,markerId:'marker-1'}),null);assert.equal(dispatches,1);assert.equal(calls.filter(c=>c==='messages.SendMessage').length,1);
});
test('marker transport timeout cannot cause another source reply',async()=>{
 installCloud();sendError=new Error('PRIVATE_TIMEOUT');assert.equal(await markHotChannelVideoUsed({...cloudInput(),targetMessageId:99,markerId:'marker-1'}),null);assert.equal(dispatches,1);assert.equal(calls.filter(c=>c==='messages.SendMessage').length,1);
});
test('explicit marker FloodWait rejection retains retry delay without retrying inside the transport',async()=>{
 installCloud();sendError=Object.assign(new Error(),{code:420,seconds:12,errorMessage:'FLOOD_WAIT_12'});assert.deepEqual(await markHotChannelVideoUsed({...cloudInput(),targetMessageId:99,markerId:'marker-1'}),{ok:false,code:429,retryAfter:12});assert.equal(dispatches,1);
});
test('invalid channel/message boundaries fail before authorization or any outbound operation',async()=>{
 for(const extra of [{sourceChatId:target},{sourceMessageId:0},{sourceMessageId:2147483648},{sourceChatId:1}])await assert.rejects(sendHotChannelVideo(cloudInput(extra)),e=>e.status===400);
 assert.deepEqual(calls,[]);assert.equal(dispatches,0);
});

test('inaccessible private source explains source permission needs before dispatch',async()=>{
 installCloud();const oldEntity=client.getEntity;client.getEntity=async peer=>{if(peer.channelId.toString()===sourceChannelId.toString())throw Object.assign(new Error('PRIVATE_RPC_TEXT'),{code:406,errorMessage:'CHANNEL_PRIVATE'});return oldEntity(peer)};
 await assert.rejects(checkHotVideoSourceAccess(cloudInput()),e=>e.status===403&&e.message.includes('来源频道')&&!e.message.includes('PRIVATE'));assert.equal(dispatches,0);
});
test('explicit CHANNEL_PRIVATE rejection on actual source marker stays a known permission rejection',async()=>{
 installCloud();sendError=Object.assign(new Error('PRIVATE_RPC_TEXT'),{code:406,errorMessage:'CHANNEL_PRIVATE'});
 assert.deepEqual(await markHotChannelVideoUsed({...cloudInput(),targetMessageId:99,markerId:'marker-1'}),{ok:false,code:403,retryAfter:0});assert.equal(dispatches,1);assert.equal(calls.filter(c=>c==='messages.SendMessage').length,1);
});

// Exercise the SDK's real TL serializer/decoder. Missing wire optionals are null,
// which differs from hand-constructed API fixtures and previously broke discovery.
const {BinaryReader}=require('teleproto/compat/extensions/BinaryReader');
function wire(value){return new BinaryReader(value.getBytes()).tgReadObject();}
function installWireCloud(){
 installCloud();const oldEntity=client.getEntity,oldInvoke=client.invoke;let wireSources=0;
 client.getMe=async()=>{
   const me=wire(new Api.User({id:bigInt(botId),bot:true,botInfoVersion:1,username:'FreeBonus365ChatBot',firstName:'ChatBot'}));
   assert.equal(me.lastName,null);assert.equal(me.usernames,null);return me;
 };
 client.getEntity=async peer=>{
   const channel=wire(await oldEntity(peer));assert.equal(channel.usernames,null);
   if(peer.channelId.toString()===channelId.toString())assert.equal(channel.username,null);
   return channel;
 };
 client.invoke=async(...args)=>{
   const result=wire(await oldInvoke(...args)),request=args[0];
   if(request instanceof Api.channels.GetMessages){
     assert.equal(result.messages[0].media.ttlSeconds,null);assert.equal(result.messages[0].fwdFrom,null);
     assert.equal(result.messages[0].media.altDocuments,null);wireSources++;
   }
   if(request instanceof Api.messages.SendMessage){
     const m=result.updates.find(u=>u instanceof Api.UpdateNewChannelMessage).message;
     assert.equal(m.media,null);assert.equal(m.fwdFrom,null);assert.equal(m.replyTo.replyToPeerId,null);
   }
   return result;
 };
 return ()=>wireSources;
}
test('real TL-decoded null optional fields preserve a normal MP4 cloud copy with empty caption and three exact buttons',async()=>{
 metadata.failure=new Error('No local video must be read');const reads=installWireCloud();
 const result=await sendHotChannelVideo(cloudInput());
 assert.equal(reads(),1);assert.equal(result.ok,true);assert.equal(result.result.caption,'');assert.ok(result.result.video);
 assert.deepEqual(result.result.reply_markup.inline_keyboard,hotVideoKeyboard());assert.equal(dispatches,1);
 assert.equal(calls.filter(c=>c==='messages.SendMedia').length,1);
});
test('real TL-decoded null peer optionals preserve read-only private/public source checks',async()=>{
 installWireCloud();assert.deepEqual(await checkHotVideoSourceAccess(cloudInput()),{title:'Source videos',username:'source_videos'});
 assert.equal(dispatches,0);assert.equal(calls.includes('channels.GetMessages'),false);
});
test('real TL-decoded null media and reply-peer optionals preserve exact source used-marker confirmation',async()=>{
 const reads=installWireCloud();const result=await markHotChannelVideoUsed({...cloudInput(),targetMessageId:99,markerId:'wire-marker'});
 assert.equal(reads(),2);assert.deepEqual(result,{ok:true,result:{message_id:144,chat:{id:sourceId},text:'✅ Sent · Used',reply_to_message:{message_id:sourceMessageId}}});
 assert.equal(dispatches,1);assert.equal(calls.includes('messages.SendMedia'),false);
});
for(const operation of ['channel','marker','source_check'])test('stalled '+operation+' metadata/authorization stops at the overall 90-second deadline without dispatch',async t=>{
 installCloud();client.start=async()=>new Promise(()=>{});
 t.mock.timers.enable({apis:['setTimeout','Date'],now:1800000000000});
 const promise=operation==='channel'?sendHotChannelVideo(cloudInput()):operation==='marker'
   ?markHotChannelVideoUsed({...cloudInput(),targetMessageId:99,markerId:'bounded-marker'}):checkHotVideoSourceAccess(cloudInput());
 let settled=false;const checked=assert.rejects(promise,e=>e.status===503);void checked.then(()=>{settled=true});
 t.mock.timers.tick(89999);await Promise.resolve();assert.equal(settled,false);
 t.mock.timers.tick(1);await checked;assert.equal(dispatches,0);assert.equal(calls.includes('channels.GetMessages'),false);
});
test('stalled actual cloud publication becomes unknown at 90 seconds and never retries the media request',async t=>{
 installCloud();const oldInvoke=client.invoke;client.invoke=async(...args)=>{
   if(args[0] instanceof Api.messages.SendMedia){calls.push('messages.SendMedia');return new Promise(()=>{})}return oldInvoke(...args);
 };
 t.mock.timers.enable({apis:['setTimeout','Date'],now:1800000000000});const promise=sendHotChannelVideo(cloudInput());
 await new Promise(resolve=>setImmediate(resolve));assert.equal(dispatches,1);
 t.mock.timers.tick(90000);assert.equal(await promise,null);assert.equal(calls.filter(c=>c==='messages.SendMedia').length,1);
});
test('original local-file large upload retains its separate 15-minute overall deadline',async t=>{
 client.start=async()=>new Promise(()=>{});t.mock.timers.enable({apis:['setTimeout','Date'],now:1800000000000});
 const promise=sendLargeHotVideo(input()),checked=assert.rejects(promise,e=>e.status===503);let settled=false;void checked.then(()=>{settled=true});
 await Promise.resolve();t.mock.timers.tick(90000);await Promise.resolve();assert.equal(settled,false);
 t.mock.timers.tick(810000);await checked;assert.equal(dispatches,0);
});
