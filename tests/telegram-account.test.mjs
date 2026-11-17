import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import ts from 'typescript';

// The real additive SQLite schema, encryption and durable cursors are exercised.
// Telegram is entirely replaced: no credentials or network traffic are used.
const fixture = mkdtempSync(path.join(tmpdir(), 'telegram-personal-account-'));
writeFileSync(path.join(fixture, 'package.json'), '{"type":"commonjs"}');
for (const name of ['sqlite', 'telegram-relay-content', 'telegram-caption-watch-cycle', 'telegram-account']) writeFileSync(path.join(fixture, `${name}.js`), ts.transpileModule(
  readFileSync(new URL(`../app/lib/${name}.ts`, import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } },
).outputText);
mkdirSync(path.join(fixture, 'node_modules/teleproto/sessions'), { recursive: true });
mkdirSync(path.join(fixture, 'node_modules/big-integer'), { recursive: true });
writeFileSync(path.join(fixture, 'node_modules/big-integer/index.js'), 'module.exports = value => ({toString:()=>String(value)});');
writeFileSync(path.join(fixture, 'node_modules/teleproto/sessions/index.js'), `
exports.StringSession=class {constructor(value){this.value=value||'fixture-session';}save(){return this.value;}delete(){this.value='';}};
`);
writeFileSync(path.join(fixture, 'node_modules/teleproto/index.js'), `
class Box {constructor(value={}){Object.assign(this,value);this.className=this.constructor.name;}}
class User extends Box {} class Username extends Box {} class Channel extends Box {} class Photo extends Box {} class Document extends Box {}
class MessageMediaPhoto extends Box {} class MessageMediaDocument extends Box {} class DocumentAttributeAnimated extends Box {} class DocumentAttributeVideo extends Box {}
class Message extends Box {get photo(){return this.media?.photo;}get document(){return this.media?.document;}}
class InputPeerChannel extends Box {} class PeerChannel extends Box {} class ReplyInlineMarkup extends Box {} class InlineButtonTypeUrl extends Box {}
class KeyboardInlineButton extends Box {} class KeyboardInlineButtonRow extends Box {} class InlineButtonTypeCallback extends Box {}
class MessageEntityCustomEmoji extends Box {} class MessageEntityBold extends Box {} class MessageEntityItalic extends Box {}
class MessageEntityUnderline extends Box {} class MessageEntityStrike extends Box {} class MessageEntitySpoiler extends Box {}
class MessageEntityCode extends Box {} class MessageEntityPre extends Box {} class MessageEntityBlockquote extends Box {}
class MessageEntityFormattedDate extends Box {} class MessageEntityTextUrl extends Box {} class MessageEntityUrl extends Box {} class MessageEntityMentionName extends Box {}
class MessageEntityHashtag extends Box {} class MessageEntityCashtag extends Box {} class MessageEntityBotCommand extends Box {}
class MessageEntityUnknown extends Box {}
class Authorization extends Box {} class SignIn extends Box {} class LogOut extends Box {} class GetAdminedBots extends Box {} class EditMessage extends Box {}
exports.Api={User,Username,Channel,Photo,Document,MessageMediaPhoto,MessageMediaDocument,DocumentAttributeAnimated,DocumentAttributeVideo,Message,InputPeerChannel,PeerChannel,ReplyInlineMarkup,InlineButtonTypeUrl,KeyboardInlineButton,KeyboardInlineButtonRow,InlineButtonTypeCallback,
MessageEntityCustomEmoji,MessageEntityBold,MessageEntityItalic,MessageEntityUnderline,MessageEntityStrike,MessageEntitySpoiler,MessageEntityCode,MessageEntityPre,MessageEntityBlockquote,MessageEntityFormattedDate,MessageEntityTextUrl,MessageEntityUrl,MessageEntityMentionName,MessageEntityHashtag,MessageEntityCashtag,MessageEntityBotCommand,MessageEntityUnknown,auth:{Authorization,SignIn,LogOut},bots:{GetAdminedBots},messages:{EditMessage}};
exports.utils={getPeerId:entity=>'-100'+(entity.channelId||entity.id)};
exports.Logger=class {setLevel(){};};
exports.state={};
exports.reset=()=>Object.assign(exports.state,{calls:[],dialogs:[],messages:[],error:null,passwordNeeded:false,media:Buffer.from('fixture-image'),targetVisualHash:'',consume:true,queue:[],observations:[],onObserve:null,onDownload:null,onEnqueue:null,me:null,ownedBots:[],onOwnedBots:null,resolvedTarget:null,onEntity:null,onGetMessages:null,onGetMe:null,onEdit:null,applyEdit:true});
exports.reset();
function fail(method){const e=exports.state.error;if(e&&e.method===method)throw Object.assign(new Error('PRIVATE RAW DETAIL'),e);}
exports.TelegramClient=class {
  constructor(session,apiId,apiHash,options){this.session=session;exports.state.calls.push({method:'construct',options});}
  setLogLevel(){}
  async connect(){exports.state.calls.push({method:'connect'});fail('connect');}
  async disconnect(){exports.state.calls.push({method:'disconnect'});}
  async destroy(){exports.state.calls.push({method:'destroy'});}
  async sendCode(){exports.state.calls.push({method:'sendCode'});fail('sendCode');return {phoneCodeHash:'private-code-hash',isCodeViaApp:true};}
  async invoke(request,_dcId,options){exports.state.calls.push({method:request.className,request,options});fail(request.className);
    if(request instanceof SignIn){if(exports.state.passwordNeeded)throw Object.assign(new Error(),{errorMessage:'SESSION_PASSWORD_NEEDED'});return new Authorization({user:new User()});}
    if(request instanceof GetAdminedBots){if(exports.state.onOwnedBots)await exports.state.onOwnedBots();return exports.state.ownedBots;}
    if(request instanceof EditMessage){if(exports.state.onEdit)await exports.state.onEdit(request);if(exports.state.applyEdit)exports.state.messages=exports.state.messages.map(message=>message.id===request.id?new Message({...message,message:request.message,entities:request.entities}):message);return {};}
    return {};}
  async signInWithPassword(_creds,params){exports.state.calls.push({method:'password'});await params.password();fail('password');return new User();}
  async getMe(){exports.state.calls.push({method:'getMe'});fail('getMe');if(exports.state.onGetMe)await exports.state.onGetMe();return exports.state.me||new User();}
  iterDialogs(){fail('dialogs');return (async function*(){for(const dialog of exports.state.dialogs)yield dialog;})();}
  async getEntity(peer){exports.state.calls.push({method:'entity',peer});fail('entity');if(exports.state.onEntity)await exports.state.onEntity();return typeof peer==='string'?exports.state.resolvedTarget:exports.state.dialogs.find(d=>String(d.entity.id)===peer.channelId.toString())?.entity;}
  async getMessages(peer,params){exports.state.calls.push({method:'getMessages',peer,params});fail('getMessages');if(exports.state.onGetMessages)await exports.state.onGetMessages();return exports.state.messages.filter(message=>params.ids.includes(message.id));}
  iterMessages(peer,params){exports.state.calls.push({method:'history',peer:peer.channelId.toString(),params});fail('history');
    return {async *[Symbol.asyncIterator](){let messages=exports.state.messages.filter(m=>m.id>(params.minId||0)&&(!params.maxId||m.id<params.maxId));
      if(!params.reverse)messages=messages.toSorted((a,b)=>b.id-a.id);
      for(const m of messages.slice(0,params.limit||messages.length))yield m;}};}
  async downloadMedia(message,params){exports.state.calls.push({method:'download',id:message.id});fail('download');if(exports.state.onDownload)await exports.state.onDownload(message,params);return exports.state.media;}
};
`);
writeFileSync(path.join(fixture, 'telegram-relay.js'), `
exports.enqueuePersonalRelayMedia=async value=>{const s=require('teleproto').state;s.queue.push(value);if(s.onEnqueue)await s.onEnqueue(value);return s.consume;};
exports.observeRelaySourceCaption=value=>{const s=require('teleproto').state;s.observations.push(value);if(s.onObserve)s.onObserve(value);return s.consume;};
`);
writeFileSync(path.join(fixture, 'telegram-relay-media.js'), `
exports.relayMediaIdentity=async bytes=>({contentHash:require('node:crypto').createHash('sha256').update(bytes).digest('hex'),visualHash:require('teleproto').state.targetVisualHash||''});
`);
const require = createRequire(import.meta.url);
const account = require(path.join(fixture, 'telegram-account.js'));
const cycle = require(path.join(fixture, 'telegram-caption-watch-cycle.js'));
const telegram = require(path.join(fixture, 'node_modules/teleproto'));
const { Api } = telegram;
const relayContent = require(path.join(fixture, 'telegram-relay-content.js'));
const { getSqlite } = require(path.join(fixture, 'sqlite.js'));
const previousData = process.env.DATA_DIR;
const previousSecret = process.env.SESSION_SECRET;
const nativeSetTimeout = globalThis.setTimeout;
const apiHash = 'a'.repeat(32);
const source = -1001001;
const target = -1009999;
function db() { return getSqlite(); }
function stored() { return db().prepare("SELECT * FROM telegram_personal_account WHERE id='primary'").get(); }
function channel(id=1001,{broadcast=true,protectedChannel=false,latest=40}={}) {
  return {entity:new Api.Channel({id:String(id),accessHash:'secret-access-hash',title:'Channel '+id,username:'channel'+id,broadcast,noforwards:protectedChannel}),dialog:{topMessage:latest},message:{id:latest}};
}
function photo(id=41,extra={}) {
  return new Api.Message({id,date:Math.floor(Date.now()/1000),message:'Caption https://example.test',
    peerId:new Api.PeerChannel({channelId:'1001'}),
    media:new Api.MessageMediaPhoto({photo:new Api.Photo({id:'media-'+id})}),...extra});
}
function video(id=41,{caption='Video caption https://source.example',mimeType='video/mp4',size=1024,roundMessage=false,animated=false,videoAttribute=true,...extra}={}) {
  return new Api.Message({id,date:Math.floor(Date.now()/1000),message:caption,
    peerId:new Api.PeerChannel({channelId:'1001'}),
    media:new Api.MessageMediaDocument({document:new Api.Document({id:'video-'+id,mimeType,size,
      attributes:[...(videoAttribute?[new Api.DocumentAttributeVideo({roundMessage})]:[]),...(animated?[new Api.DocumentAttributeAnimated()]:[])]})}),...extra});
}
async function sendCode() { return await account.handleAccountAction({action:'sendCode',apiId:123456,apiHash,phone:'+60123456789'}); }
async function login() {
  telegram.state.dialogs=[channel(),channel(1002,{broadcast:false}),{entity:new Api.User({id:'123'}),dialog:{topMessage:1}}];
  await sendCode();
  return await account.handleAccountAction({action:'code',code:'12345'});
}
async function select(ids=[String(source)]) { return await account.handleAccountAction({action:'select',channelIds:ids}); }
function ready() {
  db().prepare(`INSERT INTO telegram_promotion_settings(id,enabled,chat_id,token_ciphertext,relay_enabled,relay_revision,relay_started_at,relay_caption_serial_enabled)
    VALUES('primary',0,'','fixture',1,'relay-generation',?,0)`).run(Date.now()-10000);
  db().prepare("UPDATE telegram_relay_state SET target_chat_id=?,target_verified_at=?,ready_until=?,bot_id=77,revision='relay-generation' WHERE id='primary'").run(target,Date.now(),Date.now()+600000);
}
function delivery(messageId=701,{caption='⭐ Offer https://365freebonus.com/',custom=true,...extra}={}) {
  const entities=[...(custom?[{type:'custom_emoji',offset:0,length:1,custom_emoji_id:'-9007199254740993123'}]:[]),
    {type:'url',offset:caption.indexOf('https://'),length:'https://365freebonus.com/'.length}];
  const message=new Api.Message({id:messageId,date:Math.floor(Date.now()/1000),message:caption,
    peerId:new Api.PeerChannel({channelId:'9999'}),entities:entities.map(entity=>entity.type==='custom_emoji'
      ?new Api.MessageEntityCustomEmoji({offset:entity.offset,length:entity.length,documentId:{toString:()=>entity.custom_emoji_id}})
      :new Api.MessageEntityUrl({offset:entity.offset,length:entity.length})),
    replyMarkup:new Api.ReplyInlineMarkup({rows:relayContent.relayKeyboard().map(row=>new Api.KeyboardInlineButtonRow({buttons:row.map(button=>new Api.KeyboardInlineButton({text:button.text,type:new Api.InlineButtonTypeUrl({url:button.url})}))}))}),...extra});
  return {message,caption,entities};
}
function sentReference(value=delivery(),{revision='relay-generation',status='sent',sentAt=Date.now()-1000,messageId=value.message.id,captionEntities=JSON.stringify(value.entities)}={}) {
  const sequence=db().prepare('SELECT COUNT(*) AS n FROM telegram_relay_outbox').get().n+1;
  db().prepare(`INSERT INTO telegram_relay_outbox(source_chat_id,source_message_id,fingerprint,queued_at,revision,media_kind,file_id,file_unique_id,caption,caption_entities,status,sent_at,message_id)
    VALUES(?,?,?,?,?,'photo','fixture-file','fixture-unique',?,?,?,?,?)`).run(source,sequence,'delivery-'+sequence,Date.now()-1000,revision,value.caption,captionEntities,status,sentAt,messageId);
}
async function readyDelivery(value=delivery()) {
  await login();await select();ready();
  telegram.state.resolvedTarget=channel(9999,{broadcast:false}).entity;
  telegram.state.messages=[value.message];
  sentReference(value);
  return value;
}
async function readyAccountEdit(value=delivery()) {
  await readyDelivery(value);
  telegram.state.resolvedTarget=new Api.Channel({id:'9999',broadcast:true,creator:true});
  telegram.state.me=new Api.User({id:'private-owner',premium:true});
  value.message.post=true;
  value.message.media=new Api.MessageMediaPhoto({photo:new Api.Photo({id:{toString:()=>'555555555555555555'}})});
  value.message.entities=value.message.entities.filter(entity=>!(entity instanceof Api.MessageEntityCustomEmoji));
  const lease='fixture-edit-lease',until=Date.now()+60000;
  db().prepare("UPDATE telegram_relay_outbox SET caption_edit_outcome='account_attempting',lease_id=?,lease_until=?").run(lease,until);
  db().prepare('UPDATE telegram_relay_state SET send_lease_id=?,send_lease_until=?').run(lease,until);
  return {targetChatId:target,relayRevision:'relay-generation',messageId:value.message.id,caption:value.caption,captionEntities:value.entities};
}
function cursor(id=source) { return db().prepare('SELECT last_message_id FROM telegram_personal_sources WHERE chat_id=?').get(id).last_message_id; }
function closeDb() {
  const filename=path.join(process.env.DATA_DIR,'directory.sqlite');
  globalThis.__directorySqlite?.get(filename)?.close();
  globalThis.__directorySqlite?.delete(filename);
}
test.beforeEach(t=>{
  // Only Telegram fixtures run here. Keep bounded retry ordering while avoiding
  // real one/two-second waits for each deliberately persistent unsafe fixture.
  t.mock.method(globalThis,'setTimeout',(callback,delay,...args)=>nativeSetTimeout(callback,delay===1000||delay===2000?0:delay,...args));
  process.env.DATA_DIR=mkdtempSync(path.join(fixture,'case-'));
  process.env.SESSION_SECRET='fixture-encryption-secret-'.repeat(3);
  telegram.reset();
});
test.afterEach(closeDb);
test.after(()=>{
  if(previousData===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previousData;
  if(previousSecret===undefined)delete process.env.SESSION_SECRET;else process.env.SESSION_SECRET=previousSecret;
  rmSync(fixture,{recursive:true,force:true});
});

test('personal login stores only encrypted credentials and returns subscribed broadcast channels',async()=>{
  const pending=await sendCode();
  assert.equal(pending.stage,'code');
  assert.ok(stored().generation);
  assert.ok(!JSON.stringify(stored()).includes(apiHash));
  assert.ok(!JSON.stringify(stored()).includes('+60123456789'));
  assert.ok(!JSON.stringify(stored()).includes('private-code-hash'));
  telegram.state.dialogs=[channel(),channel(1002,{broadcast:false}),{entity:new Api.User({id:'123'}),dialog:{topMessage:1}}];
  const connected=await account.handleAccountAction({action:'code',code:'12345'});
  assert.equal(connected.connected,true);
  assert.equal(connected.stage,'connected');
  assert.deepEqual(connected.channels.map(value=>value.id),[String(source)]);
  assert.equal(stored().pending_ciphertext,'');
  assert.equal(stored().pending_until,0);
  assert.ok(!JSON.stringify(connected).includes('secret-access-hash'));
  assert.ok(!JSON.stringify(connected).includes('fixture-session'));
  assert.equal(telegram.state.calls.filter(call=>call.method==='destroy').length,2);
});

test('two-step password flow never persists the code or password',async()=>{
  await sendCode();
  telegram.state.passwordNeeded=true;
  const passwordStage=await account.handleAccountAction({action:'code',code:'93847'});
  assert.equal(passwordStage.stage,'password');
  assert.ok(!JSON.stringify(stored()).includes('93847'));
  const result=await account.handleAccountAction({action:'password',password:'private-password-fixture'});
  assert.equal(result.stage,'connected');
  assert.ok(!JSON.stringify(stored()).includes('private-password-fixture'));
});

test('expired pending login cannot call Telegram',async()=>{
  await sendCode();
  db().prepare("UPDATE telegram_personal_account SET pending_until=?").run(Date.now()-1);
  telegram.state.calls.length=0;
  assert.equal(account.accountStatus().stage,'disconnected');
  await assert.rejects(account.handleAccountAction({action:'code',code:'12345'}),error=>error.status===400);
  assert.equal(telegram.state.calls.length,0);
});

test('send-code throttle survives disconnect',async()=>{
  await sendCode();
  const throttle=stored().next_code_at;
  await account.handleAccountAction({action:'disconnect'});
  assert.equal(stored().next_code_at,throttle);
  const before=telegram.state.calls.length;
  await assert.rejects(sendCode(),error=>error.status===429);
  assert.equal(telegram.state.calls.length,before);
});

test('connection failure exposes a local cooldown without blaming Telegram rate limits or leaking details',async t=>{
  const logs=[];t.mock.method(console,'warn',(...values)=>logs.push(values.join(' ')));
  telegram.state.error={method:'connect'};
  await assert.rejects(sendCode(),error=>error.status===502);
  const status=account.accountStatus();
  assert.equal(status.retrySource,'connection');
  assert.ok(status.retryAt>Date.now());
  assert.doesNotMatch(status.lastError,/自动重试/);
  const calls=telegram.state.calls.length;
  await assert.rejects(sendCode(),error=>error.status===429&&/系统正在等待重试/.test(error.message)&&!/限制请求频率/.test(error.message));
  assert.equal(telegram.state.calls.length,calls);
  assert.doesNotMatch(logs.join('\n'),/PRIVATE RAW DETAIL|secret-access-hash/);
  assert.ok(logs.some(line=>line.includes('unexpected')));
});

test('Telegram wait status remains distinct and blocks another code request without shortening the wait',async()=>{
  telegram.state.error={method:'sendCode',errorMessage:'FLOOD_WAIT_120',seconds:120};
  await assert.rejects(sendCode(),error=>error.status===429);
  const status=account.accountStatus();
  assert.equal(status.retrySource,'telegram');
  assert.ok(status.retryAt>=Date.now()+119000);
  const calls=telegram.state.calls.length;
  await assert.rejects(sendCode(),error=>error.status===429&&/Telegram 正在限制请求频率/.test(error.message));
  assert.equal(telegram.state.calls.length,calls);
  assert.equal(account.accountStatus().retryAt,status.retryAt);
});

test('published API credentials error is actionable instead of a generic Telegram flood wait',async()=>{
  telegram.state.error={method:'sendCode',errorMessage:'API_ID_PUBLISHED_FLOOD'};
  await assert.rejects(sendCode(),error=>error.status===400&&/API ID 和 API Hash/.test(error.message));
  assert.equal(account.accountStatus().retrySource,'connection');
});

test('long Telegram flood wait blocks refresh, selection and relogin without shortening it',async()=>{
  await login();
  telegram.state.error={method:'dialogs',errorMessage:'FLOOD_WAIT_200000',seconds:200000};
  const before=Date.now();
  await assert.rejects(account.handleAccountAction({action:'refresh'}),error=>error.status===429&&!error.message.includes('PRIVATE'));
  const until=stored().next_attempt_at;
  assert.ok(until>=before+200000000);
  telegram.state.error=null;
  const calls=telegram.state.calls.length;
  await assert.rejects(account.handleAccountAction({action:'refresh'}),error=>error.status===429);
  await assert.rejects(select(),error=>error.status===429);
  assert.equal(stored().next_attempt_at,until);
  assert.equal(telegram.state.calls.length,calls);
  await account.handleAccountAction({action:'disconnect'});
  assert.equal(stored().next_attempt_at,until);
  await assert.rejects(sendCode(),error=>error.status===429);
  assert.equal(telegram.state.calls.length,calls,'remote logout must also respect flood wait');
});

test('selection seeds current top ID, preserves existing cursor and reselection timestamp increases',async()=>{
  await login();
  telegram.state.dialogs[0].dialog.topMessage=55;
  await select();
  assert.equal(cursor(),55);
  const stamp=db().prepare('SELECT selected_at FROM telegram_personal_sources WHERE chat_id=?').get(source).selected_at;
  db().prepare('UPDATE telegram_personal_sources SET last_message_id=56 WHERE chat_id=?').run(source);
  await select();
  assert.equal(cursor(),56,'saving same selection must not replay or skip its cursor');
  await select([]);
  telegram.state.dialogs[0].dialog.topMessage=80;
  await select();
  assert.equal(cursor(),80);
  assert.ok(db().prepare('SELECT selected_at FROM telegram_personal_sources WHERE chat_id=?').get(source).selected_at>stamp);
});

test('queue pressure retains cursor and next poll resumes with same message',async()=>{
  await login();await select();ready();
  telegram.state.messages=[photo()];telegram.state.consume=false;
  await account.pollTelegramAccountOnce();
  assert.equal(cursor(),40);
  telegram.state.consume=true;
  await account.pollTelegramAccountOnce();
  assert.equal(cursor(),41);
  assert.equal(telegram.state.queue.length,2);
  assert.equal(telegram.state.queue[1].sourceDate,telegram.state.messages[0].date);
  assert.equal(telegram.state.queue[1].relayRevision,'relay-generation');
  assert.ok(Buffer.isBuffer(telegram.state.queue[1].bytes));
  assert.equal(telegram.state.queue[1].accountGeneration,stored().generation);
  await account.pollTelegramAccountOnce();
  assert.equal(telegram.state.queue.length,2,'durable cursor prevents replay after worker re-entry');
});

test('empty media download is retried without consuming source cursor',async()=>{
  await login();await select();ready();
  telegram.state.messages=[photo()];telegram.state.media=Buffer.alloc(0);
  await account.pollTelegramAccountOnce();
  assert.equal(cursor(),40);
  assert.equal(telegram.state.queue.length,0);
  assert.ok(stored().next_attempt_at>Date.now());
});

test('captioned attached MP4 video is downloaded and enqueued as video with its caption',async()=>{
  await login();await select();ready();
  telegram.state.messages=[video()];telegram.state.media=Buffer.from('fixture-mp4-video');
  await account.pollTelegramAccountOnce();
  assert.equal(cursor(),41);
  assert.equal(telegram.state.queue.length,1);
  const queued=telegram.state.queue[0];
  assert.equal(queued.mediaKind,'video');
  assert.equal(queued.mimeType,'video/mp4');
  assert.equal(queued.caption,'Video caption https://source.example');
  assert.equal(queued.sourceMediaId,'video-video-41');
  assert.deepEqual(queued.bytes,telegram.state.media);
});

test('custom emoji document IDs and UTF-16 positions survive personal caption conversion without changing text',async()=>{
  await login();await select();ready();
  const caption='  Friday plans? 😹\n⭐ ⭐\n➡️FREE RM20 CASH\n\n  ';
  const emoji=(text,id,start=0)=>new Api.MessageEntityCustomEmoji({offset:caption.indexOf(text,start),length:text.length,documentId:{toString:()=>id}});
  const firstStar=caption.indexOf('⭐');
  const entities=[emoji('😹','5368324170671202286'),emoji('⭐','9007199254740993123'),
    emoji('⭐','9007199254740993124',firstStar+1),emoji('➡️','5368324170671202287'),
    new Api.MessageEntityBold({offset:caption.indexOf('FREE'),length:'FREE RM20 CASH'.length})];
  telegram.state.messages=[photo(41,{message:caption,entities})];
  await account.pollTelegramAccountOnce();
  assert.equal(cursor(),41);
  assert.equal(telegram.state.queue[0].caption,caption,'spaces, blank lines and fallback glyphs remain byte-for-byte identical');
  assert.deepEqual(telegram.state.queue[0].captionEntities,entities.map(entity=>({
    type:entity.className==='MessageEntityCustomEmoji'?'custom_emoji':'bold',offset:entity.offset,length:entity.length,
    ...(entity.documentId?{custom_emoji_id:entity.documentId.toString()}:{}),
  })));
  assert.equal(telegram.state.queue[0].expectedCustomEmojiCount,4);
});

test('negative signed custom emoji IDs for original letter and logo artwork survive personal conversion',async()=>{
  await login();await select();ready();
  const caption='  🆎50%!\n🟦🟦\n';
  const ids=['-9223372036854775808','-9007199254740993123','9223372036854775807'];
  const offsets=[caption.indexOf('🆎'),caption.indexOf('🟦'),caption.lastIndexOf('🟦')];
  const entities=offsets.map((offset,index)=>new Api.MessageEntityCustomEmoji({offset,length:2,documentId:{toString:()=>ids[index]}}));
  telegram.state.messages=[photo(41,{message:caption,entities})];
  await account.pollTelegramAccountOnce();
  const queued=telegram.state.queue[0];
  assert.equal(queued.caption,caption);
  assert.equal(queued.expectedCustomEmojiCount,3);
  assert.deepEqual(queued.captionEntities,offsets.map((offset,index)=>({type:'custom_emoji',offset,length:2,custom_emoji_id:ids[index]})));
});

test('personal conversion retains source custom emoji count even when an invalid ID cannot be converted',async()=>{
  await login();await select();ready();
  const caption='🆎🟦';
  const ids=['-1','0','9223372036854775808','-9223372036854775809'];
  const entities=ids.map(id=>new Api.MessageEntityCustomEmoji({offset:0,length:2,documentId:{toString:()=>id}}));
  telegram.state.messages=[photo(41,{message:caption,entities})];
  await account.pollTelegramAccountOnce();
  const queued=telegram.state.queue[0];
  assert.equal(queued.caption,caption);
  assert.equal(queued.expectedCustomEmojiCount,4);
  assert.deepEqual(queued.captionEntities,[{type:'custom_emoji',offset:0,length:2,custom_emoji_id:'-1'}]);
});

test('source emoji audit reads at most three selected channels and five recent messages without sending or changing cursors',async()=>{
  await login();
  telegram.state.dialogs=[channel(1001),channel(1002),channel(1003),channel(1004)];
  await account.handleAccountAction({action:'refresh'});
  await select(telegram.state.dialogs.map(d=>'-100'+d.entity.id));
  telegram.state.messages=Array.from({length:8},(_,index)=>photo(index+1,{message:'private-source-caption',entities:[
    new Api.MessageEntityCustomEmoji({offset:0,length:1,documentId:{toString:()=>'-9007199254740993123'}}),
    new Api.MessageEntityCustomEmoji({offset:1,length:1,documentId:{toString:()=>'9223372036854775807'}}),
    new Api.MessageEntityCustomEmoji({offset:2,length:1,documentId:{toString:()=>'0'}}),
  ]}));
  const beforeCursors=db().prepare('SELECT chat_id,last_message_id FROM telegram_personal_sources ORDER BY chat_id').all();
  const beforeState={...stored()};
  const callsAt=telegram.state.calls.length;
  const result=await account.sampleSelectedSourceEmoji();
  assert.deepEqual(result,{state:'ok',sourcesSampled:3,messagesSampled:15,customEmojiEntities:45,negativeCustomEmojiEntities:15,unrepresentableCustomEmojiEntities:15});
  assert.deepEqual(db().prepare('SELECT chat_id,last_message_id FROM telegram_personal_sources ORDER BY chat_id').all(),beforeCursors);
  assert.deepEqual({...stored()},beforeState);
  assert.equal(db().prepare('SELECT COUNT(*) AS n FROM telegram_relay_outbox').get().n,0);
  assert.equal(telegram.state.queue.length,0);
  const auditCalls=telegram.state.calls.slice(callsAt);
  assert.equal(auditCalls.filter(call=>call.method==='history').length,3);
  assert.ok(auditCalls.filter(call=>call.method==='history').every(call=>call.params.limit===5&&call.params.minId===undefined));
  assert.ok(auditCalls.every(call=>!['sendCode','SignIn','password','download'].includes(call.method)));
  assert.doesNotMatch(JSON.stringify(result),/private-source-caption|9007199254740993123|9223372036854775807|session|secret|channel/i);
});

test('source emoji audit observes disconnected, busy and backoff states before any Telegram call',async()=>{
  assert.equal((await account.sampleSelectedSourceEmoji()).state,'disconnected');
  assert.equal(telegram.state.calls.length,0);
  await login();await select();
  const calls=telegram.state.calls.length;
  db().prepare('UPDATE telegram_personal_account SET lease_until=?').run(Date.now()+60000);
  assert.equal((await account.sampleSelectedSourceEmoji()).state,'busy');
  db().prepare('UPDATE telegram_personal_account SET lease_until=0,next_attempt_at=?').run(Date.now()+60000);
  assert.equal((await account.sampleSelectedSourceEmoji()).state,'backoff');
  assert.equal(telegram.state.calls.length,calls);
});

test('source emoji audit retains Telegram flood wait but never consumes source messages',async()=>{
  await login();await select();
  telegram.state.error={method:'history',errorMessage:'FLOOD_WAIT_120',seconds:120};
  const beforeCursor=cursor();
  const before=Date.now();
  const result=await account.sampleSelectedSourceEmoji();
  assert.equal(result.state,'backoff');
  assert.ok(stored().next_attempt_at>=before+120000);
  assert.equal(cursor(),beforeCursor);
  assert.equal(telegram.state.queue.length,0);
});

test('source emoji audit failures do not clear saved authorization or modify queued media',async()=>{
  await login();await select();
  db().prepare(`INSERT INTO telegram_relay_outbox(source_chat_id,source_message_id,fingerprint,queued_at,revision,media_kind,file_id,file_unique_id,caption)
    VALUES(?,1,'fixture-audit',1,'fixture-revision','photo','fixture-file','fixture-unique','fixture-caption')`).run(source);
  const beforeJob={...db().prepare('SELECT * FROM telegram_relay_outbox').get()};
  const before={...stored()};
  telegram.state.error={method:'history',errorMessage:'SESSION_REVOKED'};
  const result=await account.sampleSelectedSourceEmoji();
  assert.equal(result.state,'unavailable');
  assert.deepEqual({...stored()},before);
  assert.deepEqual({...db().prepare('SELECT * FROM telegram_relay_outbox').get()},beforeJob);
  assert.equal(cursor(),40);
  assert.equal(telegram.state.queue.length,0);
});

test('relay delivery audit reads only five recent sent references in the verified destination and returns private aggregates',async()=>{
  await readyDelivery();
  telegram.state.messages=[];
  db().prepare('DELETE FROM telegram_relay_outbox').run();
  const sentBase=Date.now()-1000;
  for(let index=0;index<8;index++) {
    const value=delivery(701+index,{custom:index!==7});
    telegram.state.messages.push(value.message);sentReference(value,{sentAt:sentBase-index});
  }
  sentReference(delivery(801),{sentAt:Date.now()-25*3600000});
  sentReference(delivery(802),{revision:'other-revision'});
  sentReference(delivery(803),{status:'pending'});
  sentReference(delivery(804),{sentAt:Date.now()+60000});
  const before={...stored()},beforeQueue=db().prepare('SELECT * FROM telegram_relay_outbox').all(),beforeCursor=cursor();
  const at=telegram.state.calls.length;
  const result=await account.inspectRecentRelayDeliveries();
  assert.deepEqual(result,{state:'ok',sampledPosts:5,matchingCaptions:5,customEmojiPosts:5,preservedCustomEmojiPosts:5,
    safeLinkPosts:5,matchingButtonPosts:5,invalidReferences:0,personalEditQualification:'unknown'});
  const calls=telegram.state.calls.slice(at);
  assert.deepEqual(calls.filter(call=>call.method==='entity').map(call=>call.peer),['@join365freebonusgroup']);
  const reads=calls.filter(call=>call.method==='getMessages');
  assert.equal(reads.length,1);assert.equal(reads[0].peer,telegram.state.resolvedTarget);
  assert.deepEqual(reads[0].params,{ids:[701,702,703,704,705],limit:5});
  assert.ok(calls.every(call=>['construct','connect','entity','getMessages','destroy'].includes(call.method)));
  assert.deepEqual({...stored()},before);assert.equal(cursor(),beforeCursor);
  assert.deepEqual(db().prepare('SELECT * FROM telegram_relay_outbox').all(),beforeQueue);
  assert.equal(telegram.state.queue.length,0);
  assert.doesNotMatch(JSON.stringify(result),/Offer|9007199254740993123|join365|fixture|session|token|caption_entities|peer|username/i);
});

test('relay delivery audit separates plain posts from custom emoji, unsafe links and changed buttons',async()=>{
  const value=await readyDelivery(delivery(701,{custom:false}));
  const emoji=delivery(702);sentReference(emoji);emoji.message.entities=emoji.message.entities.filter(entity=>!(entity instanceof Api.MessageEntityCustomEmoji));
  const link=delivery(703);sentReference(link);link.message.entities.push(new Api.MessageEntityTextUrl({offset:2,length:5,url:'https://foreign.example/private'}));
  const buttons=delivery(704);sentReference(buttons);buttons.message.replyMarkup.rows[0].buttons[0].type.url='https://foreign.example/private';
  telegram.state.messages=[value.message,emoji.message,link.message,buttons.message];
  const result=await account.inspectRecentRelayDeliveries();
  assert.equal(result.state,'ok');assert.equal(result.sampledPosts,4);assert.equal(result.matchingCaptions,4);
  assert.equal(result.customEmojiPosts,3);assert.equal(result.preservedCustomEmojiPosts,2);
  assert.equal(result.safeLinkPosts,3);assert.equal(result.matchingButtonPosts,3);
});

test('relay delivery audit rejects malformed stored references before reading and counts missing or wrong-peer messages',async()=>{
  const first=await readyDelivery();
  sentReference(delivery(702),{messageId:0});
  sentReference(delivery(703),{captionEntities:'malformed-json'});
  const wrong=delivery(704,{peerId:new Api.PeerChannel({channelId:'1001'})});sentReference(wrong);
  const missing=delivery(705);sentReference(missing);
  telegram.state.messages=[first.message,wrong.message];
  const result=await account.inspectRecentRelayDeliveries();
  assert.equal(result.state,'ok');assert.equal(result.sampledPosts,1);assert.equal(result.invalidReferences,4);
  const read=telegram.state.calls.find(call=>call.method==='getMessages');
  assert.deepEqual(new Set(read.params.ids),new Set([701,704,705]));
});

test('relay delivery audit respects disconnected, lease and backoff states without Telegram calls',async()=>{
  assert.equal((await account.inspectRecentRelayDeliveries()).state,'disconnected');
  await readyDelivery();const at=telegram.state.calls.length;
  db().prepare('UPDATE telegram_personal_account SET lease_until=?').run(Date.now()+60000);
  assert.equal((await account.inspectRecentRelayDeliveries()).state,'busy');
  db().prepare('UPDATE telegram_personal_account SET lease_until=0,next_attempt_at=?').run(Date.now()+60000);
  assert.equal((await account.inspectRecentRelayDeliveries()).state,'backoff');
  assert.equal(telegram.state.calls.length,at);
});

for(const destination of ['-1009999','https://example.test/join365freebonusgroup','http://t.me/join365freebonusgroup',
  'https://t.me/+private-invite','https://t.me/join365freebonusgroup/123','@join365freebonusgroup/','https://t.me/join365freebonusgroup?x=1'])
test('relay delivery audit refuses arbitrary or private destination '+destination,async()=>{
  await readyDelivery();db().prepare('UPDATE telegram_promotion_settings SET relay_chat_id=?').run(destination);
  const at=telegram.state.calls.length;
  assert.equal((await account.inspectRecentRelayDeliveries()).state,'unavailable');
  assert.equal(telegram.state.calls.length,at);
});

test('relay delivery audit accepts only an HTTPS public link that resolves to the exact verified peer',async()=>{
  await readyDelivery();db().prepare("UPDATE telegram_promotion_settings SET relay_chat_id='https://t.me/join365freebonusgroup/'").run();
  telegram.state.resolvedTarget=channel(1001).entity;
  const at=telegram.state.calls.length;
  assert.equal((await account.inspectRecentRelayDeliveries()).state,'unavailable');
  assert.equal(telegram.state.calls.slice(at).filter(call=>call.method==='getMessages').length,0);
  telegram.state.resolvedTarget=channel(9999,{broadcast:false}).entity;
  assert.equal((await account.inspectRecentRelayDeliveries()).sampledPosts,1);
});

for(const change of ['target','settings','account','bot','readiness'])test('relay delivery audit stops before history after '+change+' changes during resolution',async()=>{
  await readyDelivery();
  telegram.state.onEntity=()=>{
    if(change==='target')db().prepare('UPDATE telegram_relay_state SET target_chat_id=-1001001').run();
    if(change==='settings')db().prepare("UPDATE telegram_promotion_settings SET relay_chat_id='@different_target'").run();
    if(change==='account')db().prepare("UPDATE telegram_personal_account SET generation='replacement-owner'").run();
    if(change==='bot')db().prepare('UPDATE telegram_relay_state SET bot_id=88').run();
    if(change==='readiness')db().prepare('UPDATE telegram_relay_state SET ready_until=0').run();
  };
  assert.equal((await account.inspectRecentRelayDeliveries()).state,'unavailable');
  assert.equal(telegram.state.calls.filter(call=>call.method==='getMessages').length,0);
});

test('relay delivery audit honors real FloodWait but never revokes authorization, saves sessions or mutates outbox',async()=>{
  await readyDelivery();const before={...stored()},beforeQueue=db().prepare('SELECT * FROM telegram_relay_outbox').all(),beforeCursor=cursor();
  telegram.state.error={method:'getMessages',errorMessage:'FLOOD_WAIT_120',seconds:120};
  const at=Date.now();assert.equal((await account.inspectRecentRelayDeliveries()).state,'backoff');
  assert.ok(stored().next_attempt_at>=at+120000);assert.equal(stored().session_ciphertext,before.session_ciphertext);
  assert.equal(stored().config_ciphertext,before.config_ciphertext);assert.equal(cursor(),beforeCursor);
  assert.deepEqual(db().prepare('SELECT * FROM telegram_relay_outbox').all(),beforeQueue);
  db().prepare("UPDATE telegram_personal_account SET next_attempt_at=0,last_error=''").run();
  telegram.state.error={method:'getMessages',errorMessage:'SESSION_REVOKED'};
  const beforeRevoked={...stored()};assert.equal((await account.inspectRecentRelayDeliveries()).state,'unavailable');
  assert.deepEqual({...stored()},beforeRevoked);
});

for(const scenario of [
  {name:'channel creator with Premium',creator:true,premium:true,expected:'qualified'},
  {name:'channel edit admin with Premium',editMessages:true,premium:true,expected:'qualified'},
  {name:'channel admin without Premium',editMessages:true,premium:false,expected:'not_premium'},
  {name:'channel member with Premium',premium:true,expected:'not_channel_admin'},
  {name:'incomplete account evidence',creator:true,premium:true,min:true,expected:'unknown'},
])test('relay delivery audit classifies personal edit prerequisite for '+scenario.name+' without editing',async()=>{
  await readyDelivery();
  telegram.state.resolvedTarget=new Api.Channel({id:'9999',broadcast:true,creator:scenario.creator,adminRights:{editMessages:scenario.editMessages}});
  telegram.state.me=new Api.User({id:'private-owner',premium:scenario.premium,min:scenario.min});
  const result=await account.inspectRecentRelayDeliveries();
  assert.equal(result.state,'ok');assert.equal(result.personalEditQualification,scenario.expected);
  assert.equal(result.sampledPosts,1);
  assert.equal(telegram.state.queue.length,0);
});

test('qualified personal account performs one caption-only MTProto edit and verifies actual emoji, media and fixed buttons',async()=>{
  const input=await readyAccountEdit();
  const before={...stored()},queue=db().prepare('SELECT * FROM telegram_relay_outbox').all(),beforeCursor=cursor();
  const at=telegram.state.calls.length;
  const result=await account.editVerifiedRelayCaptionWithAccount(input);
  assert.deepEqual(result,{state:'ok',attempted:true,outcome:'preserved'});
  const calls=telegram.state.calls.slice(at),edits=calls.filter(call=>call.method==='EditMessage');
  assert.equal(edits.length,1);
  assert.deepEqual(Object.keys(edits[0].request).sort(),['className','entities','id','message','peer']);
  assert.equal(edits[0].request.id,input.messageId);assert.equal(edits[0].request.message,input.caption);
  assert.equal(edits[0].request.entities.find(entity=>entity instanceof Api.MessageEntityCustomEmoji).documentId.toString(),'-9007199254740993123');
  assert.equal(edits[0].options.maxRetryCount,0);assert.equal(edits[0].options.floodSleepThreshold,0);assert.ok(edits[0].options.timeout>0&&edits[0].options.timeout<=25000);
  assert.equal(calls.filter(call=>call.method==='getMessages').length,2);
  assert.ok(calls.filter(call=>call.method==='getMessages').every(call=>call.peer===telegram.state.resolvedTarget&&call.params.ids.length===1&&call.params.ids[0]===input.messageId));
  assert.ok(calls.every(call=>['construct','connect','entity','getMe','getMessages','EditMessage','destroy'].includes(call.method)));
  assert.deepEqual({...stored()},before);assert.equal(cursor(),beforeCursor);
  assert.deepEqual(db().prepare('SELECT * FROM telegram_relay_outbox').all(),queue);
  assert.doesNotMatch(JSON.stringify(result),/private|555555|900719|join365|token|session|caption|id/i);
});

test('personal caption edit supports all existing safe formatting, signed custom IDs, dates and website link entity types',async()=>{
  const types=['bold','italic','underline','strikethrough','spoiler','code','pre','blockquote','expandable_blockquote','hashtag','cashtag','bot_command','date_time','text_link'];
  const caption='⭐ '+types.map(()=> 'example').join(' ')+' https://365freebonus.com/';
  const value=delivery(701,{caption});
  let offset=2;
  value.entities.push(...types.map(type=>{const entity={type,offset,length:7};offset+=8;
    if(type==='pre')entity.language='typescript';
    if(type==='date_time'){entity.unix_time=1900000000;entity.date_time_format='wDT';}
    if(type==='text_link')entity.url='https://365freebonus.com/';
    return entity;}));
  const input=await readyAccountEdit(value);
  value.message.entities=wireEntities(value.entities).filter(entity=>!(entity instanceof Api.MessageEntityCustomEmoji));
  const result=await account.editVerifiedRelayCaptionWithAccount(input);
  assert.deepEqual(result,{state:'ok',attempted:true,outcome:'preserved'});
  const edit=telegram.state.calls.find(call=>call.method==='EditMessage').request;
  assert.equal(edit.entities.length,value.entities.length);
  assert.ok(edit.entities.some(entity=>entity instanceof Api.MessageEntityBlockquote&&entity.collapsed===true));
  assert.ok(edit.entities.some(entity=>entity instanceof Api.MessageEntityFormattedDate&&entity.dayOfWeek&&entity.longDate&&entity.longTime&&entity.date===1900000000));
  assert.ok(edit.entities.some(entity=>entity instanceof Api.MessageEntityPre&&entity.language==='typescript'));
  assert.ok(edit.entities.some(entity=>entity instanceof Api.MessageEntityTextUrl&&entity.url==='https://365freebonus.com/'));
});

for(const change of ['not-premium','not-admin','not-broadcast','min-channel','bot-account','min-account','wrong-target','wrong-revision','unleased','expired-relay-lease','expired-row-lease','row-caption','unsupported-entity','overflow-date'])
test('personal caption edit refuses unsafe or unverified prerequisite '+change,async()=>{
  const input=await readyAccountEdit();
  if(change==='not-premium')telegram.state.me.premium=false;
  if(change==='not-admin')telegram.state.resolvedTarget.creator=false;
  if(change==='not-broadcast')telegram.state.resolvedTarget.broadcast=false;
  if(change==='min-channel')telegram.state.resolvedTarget.min=true;
  if(change==='bot-account')telegram.state.me.bot=true;
  if(change==='min-account')telegram.state.me.min=true;
  if(change==='wrong-target')input.targetChatId=source;
  if(change==='wrong-revision')input.relayRevision='other-revision';
  if(change==='unleased')db().prepare("UPDATE telegram_relay_outbox SET caption_edit_outcome='changed'").run();
  if(change==='expired-relay-lease')db().prepare('UPDATE telegram_relay_state SET send_lease_until=0').run();
  if(change==='expired-row-lease')db().prepare('UPDATE telegram_relay_outbox SET lease_until=0').run();
  if(change==='row-caption')input.caption+=' changed';
  if(change==='unsupported-entity')input.captionEntities.push({type:'text_mention',offset:2,length:5});
  if(change==='overflow-date')input.captionEntities.push({type:'date_time',offset:2,length:5,unix_time:2147483648});
  const result=await account.editVerifiedRelayCaptionWithAccount(input);
  assert.equal(result.attempted,false);assert.notEqual(result.outcome,'preserved');
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,0);
});

for(const change of ['not-post','forwarded','via-bot','via-business','wrong-peer','wrong-id','caption','buttons','foreign-link','missing-media'])
test('personal caption edit rejects an original post with '+change+' before invocation',async()=>{
  const input=await readyAccountEdit(),message=telegram.state.messages[0];
  if(change==='not-post')message.post=false;
  if(change==='forwarded')message.fwdFrom={};
  if(change==='via-bot')message.viaBotId='77';
  if(change==='via-business')message.viaBusinessBotId='77';
  if(change==='wrong-peer')message.peerId=new Api.PeerChannel({channelId:'1001'});
  if(change==='wrong-id')message.id=999;
  if(change==='caption')message.message+=' changed';
  if(change==='buttons')message.replyMarkup.rows[0].buttons[0].text='Other';
  if(change==='foreign-link')message.entities.push(new Api.MessageEntityTextUrl({offset:2,length:5,url:'https://foreign.example'}));
  if(change==='missing-media')message.media=undefined;
  const result=await account.editVerifiedRelayCaptionWithAccount(input);
  const reason=['not-post','forwarded','via-bot','via-business'].includes(change)?'message_not_direct_post'
    :change==='wrong-peer'?'message_identity_invalid':change==='wrong-id'?'message_not_found':change==='caption'?'caption_mismatch'
    :change==='buttons'?'buttons_mismatch':change==='foreign-link'?'actual_links_unsafe':'media_invalid';
  assert.deepEqual(result,{state:'ok',attempted:false,outcome:'invalid',reason});
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,0);
});

for(const phase of ['entity','me','before-read','invoke'])test('personal caption edit does not outlive changed worker ownership at '+phase,async()=>{
  const input=await readyAccountEdit();
  const mutate=()=>db().prepare("UPDATE telegram_relay_outbox SET lease_id='new-owner'").run();
  if(phase==='entity')telegram.state.onEntity=mutate;
  if(phase==='me')telegram.state.onGetMe=mutate;
  if(phase==='before-read')telegram.state.onGetMessages=mutate;
  if(phase==='invoke')telegram.state.onEdit=mutate;
  const result=await account.editVerifiedRelayCaptionWithAccount(input);
  assert.equal(result.state,'unavailable');assert.equal(result.attempted,phase==='invoke');
  assert.equal(result.outcome,phase==='invoke'?'uncertain':'unavailable');
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,phase==='invoke'?1:0);
});

for(const change of ['missing-emoji','media','caption','buttons','foreign-link','read-error'])test('personal caption edit requires actual post-read proof after '+change,async()=>{
  const input=await readyAccountEdit();
  telegram.state.applyEdit=change!=='missing-emoji';
  telegram.state.onEdit=()=>{
    if(change==='read-error')telegram.state.error={method:'getMessages',code:400,errorMessage:'CHANNEL_PRIVATE'};
    else telegram.state.onGetMessages=()=>{
      const message=telegram.state.messages[0];
      if(change==='media')message.media=new Api.MessageMediaPhoto({photo:new Api.Photo({id:{toString:()=>'7777777'}})});
      if(change==='caption')message.message+=' changed';
      if(change==='buttons')message.replyMarkup=undefined;
      if(change==='foreign-link')message.entities.push(new Api.MessageEntityTextUrl({offset:2,length:5,url:'https://foreign.example'}));
    };
  };
  const result=await account.editVerifiedRelayCaptionWithAccount(input);
  assert.equal(result.attempted,true);assert.equal(result.outcome,change==='read-error'?'uncertain':'changed');
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,1);
  assert.equal(telegram.state.calls.filter(call=>call.method==='getMessages').length,
    ['media','read-error'].includes(change)?2:4,'only read-only confirmation may repeat');
});

for(const temporary of ['old-emoji','empty'])test('personal caption edit rereads a temporary '+temporary+' result without editing twice',async()=>{
  const input=await readyAccountEdit(),original=telegram.state.messages[0];
  let reads=0;
  telegram.state.onEdit=request=>{
    const edited=new Api.Message({...original,message:request.message,entities:request.entities});
    telegram.state.onGetMessages=()=>{
      reads++;
      telegram.state.messages=reads===1?(temporary==='empty'?[]:[original]):[edited];
    };
  };
  assert.deepEqual(await account.editVerifiedRelayCaptionWithAccount(input),{state:'ok',attempted:true,outcome:'preserved'});
  assert.equal(reads,2);
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,1);
  assert.equal(telegram.state.messages[0].media,original.media);
  assert.equal(telegram.state.messages[0].replyMarkup,original.replyMarkup);
});

for(const phase of ['entity','me','messages'])test('personal caption edit reconnects and requalifies after a transient read '+phase+' error',async()=>{
  const input=await readyAccountEdit();
  const before=telegram.state.calls.length;
  let reads=0;
  telegram.state.onEdit=()=>{
    const hook=phase==='entity'?'onEntity':phase==='me'?'onGetMe':'onGetMessages';
    telegram.state[hook]=()=>{if(++reads===1)throw Object.assign(new Error('temporary connection failure'),{code:'ECONNRESET'});};
  };
  assert.deepEqual(await account.editVerifiedRelayCaptionWithAccount(input),{state:'ok',attempted:true,outcome:'preserved'});
  assert.equal(reads,2);
  const calls=telegram.state.calls.slice(before),editAt=calls.findIndex(call=>call.method==='EditMessage');
  assert.equal(calls.filter(call=>call.method==='EditMessage').length,1);
  assert.equal(calls.filter(call=>call.method==='connect').length,2,'read retry reconnects after the original edit');
  const reconnected=calls.findIndex((call,index)=>index>editAt&&call.method==='connect');
  assert.deepEqual(calls.slice(reconnected,reconnected+4).map(call=>call.method),['connect','entity','getMe','getMessages']);
});

for(const temporary of ['network','empty'])test('personal caption edit bounds a persistently unavailable '+temporary+' read without resubmitting',async()=>{
  const input=await readyAccountEdit();let reads=0;
  telegram.state.onEdit=()=>{
    telegram.state.onGetMessages=()=>{
      reads++;
      if(temporary==='empty')telegram.state.messages=[];
      else throw Object.assign(new Error('temporary connection failure'),{code:'ETIMEDOUT'});
    };
  };
  assert.deepEqual(await account.editVerifiedRelayCaptionWithAccount(input),{state:'unavailable',attempted:true,outcome:'uncertain'});
  assert.equal(reads,3);assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,1);
});

for(const authority of ['premium','channel-admin','source','worker-lease','settings','target'])
test('personal caption confirmation stops before rereading after '+authority+' changes',async()=>{
  const input=await readyAccountEdit();
  if(authority==='source')db().prepare("UPDATE telegram_relay_outbox SET origin='account',account_generation=?,queued_at=?").run(stored().generation,Date.now());
  let reads=0,checks=0;
  telegram.state.onEdit=()=>{
    telegram.state.applyEdit=false;
    telegram.state.onGetMessages=()=>{reads++;};
    telegram.state.onEntity=()=>{
      if(++checks!==2)return;
      if(authority==='premium')telegram.state.me.premium=false;
      if(authority==='channel-admin')telegram.state.resolvedTarget.creator=false;
      if(authority==='source')db().prepare('UPDATE telegram_personal_sources SET selected=0 WHERE chat_id=?').run(source);
      if(authority==='worker-lease')db().prepare("UPDATE telegram_relay_outbox SET lease_id='replacement-worker'").run();
      if(authority==='settings')db().prepare("UPDATE telegram_promotion_settings SET relay_revision='replacement-settings'").run();
      if(authority==='target')telegram.state.resolvedTarget.id='1001';
    };
  };
  const result=await account.editVerifiedRelayCaptionWithAccount(input);
  assert.equal(result.attempted,true);assert.equal(result.outcome,'uncertain');
  assert.equal(reads,1);assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,1);
});

test('personal caption confirmation preserves a genuine FloodWait and stops without another read or edit',async()=>{
  const input=await readyAccountEdit(),session=stored().session_ciphertext,before=Date.now();let reads=0;
  telegram.state.onEdit=()=>{telegram.state.onGetMessages=()=>{
    reads++;throw Object.assign(new Error(),{code:420,errorMessage:'FLOOD_WAIT_120',seconds:120});
  };};
  assert.deepEqual(await account.editVerifiedRelayCaptionWithAccount(input),{state:'backoff',attempted:true,outcome:'uncertain'});
  assert.equal(reads,1);assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,1);
  assert.ok(stored().next_attempt_at>=before+120000);assert.equal(stored().session_ciphertext,session);
});

test('personal caption confirmation shares the original absolute deadline instead of extending it for rereads',async t=>{
  const input=await readyAccountEdit(),started=Date.now();let clock=started,reads=0;
  t.mock.method(Date,'now',()=>clock);
  telegram.state.onEdit=()=>{telegram.state.onGetMessages=()=>{reads++;clock=started+40001;};};
  assert.deepEqual(await account.editVerifiedRelayCaptionWithAccount(input),{state:'unavailable',attempted:true,outcome:'uncertain'});
  assert.equal(reads,1);assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,1);
});

test('personal caption edit reports explicit rejection, uncertain timeout and real FloodWait without retry or credential revocation',async()=>{
  const input=await readyAccountEdit(),session=stored().session_ciphertext;
  telegram.state.error={method:'EditMessage',code:400,errorMessage:'MESSAGE_AUTHOR_REQUIRED'};
  assert.deepEqual(await account.editVerifiedRelayCaptionWithAccount(input),{state:'ok',attempted:true,outcome:'rejected'});
  telegram.state.error={method:'EditMessage',code:'ETIMEDOUT'};
  assert.deepEqual(await account.editVerifiedRelayCaptionWithAccount(input),{state:'unavailable',attempted:true,outcome:'uncertain'});
  const at=Date.now();telegram.state.error={method:'EditMessage',code:420,errorMessage:'FLOOD_WAIT_120',seconds:120};
  const limited=await account.editVerifiedRelayCaptionWithAccount(input);
  assert.deepEqual({...limited,retryAt:undefined},{state:'backoff',attempted:true,outcome:'rejected',retryAt:undefined});
  assert.ok(limited.retryAt>=at+120000);
  assert.ok(stored().next_attempt_at>=at+120000);assert.equal(stored().session_ciphertext,session);
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,3);
});

test('personal caption edit returns retryable preflight busy/backoff and skips already preserved artwork',async()=>{
  const input=await readyAccountEdit();
  const retryAt=Date.now()+60000;
  db().prepare('UPDATE telegram_personal_account SET lease_until=?').run(retryAt);
  assert.deepEqual(await account.editVerifiedRelayCaptionWithAccount(input),{state:'busy',attempted:false,outcome:'unavailable',retryAt});
  db().prepare('UPDATE telegram_personal_account SET lease_until=0,next_attempt_at=?').run(retryAt);
  assert.deepEqual(await account.editVerifiedRelayCaptionWithAccount(input),{state:'backoff',attempted:false,outcome:'unavailable',retryAt});
  db().prepare('UPDATE telegram_personal_account SET next_attempt_at=0').run();
  telegram.state.messages[0].entities=delivery().message.entities;
  assert.deepEqual(await account.editVerifiedRelayCaptionWithAccount(input),{state:'ok',attempted:false,outcome:'preserved'});
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,0);
});

test('personal caption edit exposes the actual Telegram wait deadline when read-only preflight is limited',async()=>{
  const input=await readyAccountEdit(),before=Date.now();
  telegram.state.error={method:'getMe',code:420,errorMessage:'FLOOD_WAIT_120',seconds:120};
  const result=await account.editVerifiedRelayCaptionWithAccount(input);
  assert.equal(result.state,'backoff');assert.equal(result.attempted,false);assert.equal(result.outcome,'unavailable');
  assert.equal(result.retryAt,stored().next_attempt_at);assert.ok(result.retryAt>=before+120000);
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,0);
});

for(const outcome of ['changed','account_waiting_1','account_waiting_2','account_waiting_3','account_unavailable','rejected',
  'account_revalidated','account_invalid','account_recheck_waiting_1','account_recheck_waiting_2','account_recheck_waiting_3'])
test('personal receive yields its lease to a due current-revision caption repair '+outcome,async()=>{
  await readyDelivery();
  db().prepare('UPDATE telegram_relay_outbox SET caption_edit_attempted_at=?,caption_edit_outcome=?,last_error=?,next_attempt_at=?')
    .run(Date.now()-1000,outcome,outcome==='account_unavailable'
      ?'个人账号备用补正当前不可用，请检查本人账号连接和编辑权限；原媒体不会重复发送。'
      :outcome==='rejected'?'Telegram 拒绝补正文案或按钮，请检查机器人权限及原消息格式；不会重复发送媒体。'
      :'Telegram 未保留部分原始自定义 Emoji，请检查机器人的自定义 Emoji 使用权限。该消息不会自动重发。',Date.now()-1);
  if(outcome.startsWith('account_recheck_waiting_'))db().prepare('UPDATE telegram_relay_outbox SET caption_edit_recheck_count=1').run();
  telegram.state.messages=[photo()];
  const at=telegram.state.calls.length,before={...stored()},beforeCursor=cursor();
  await account.pollTelegramAccountOnce();
  assert.equal(telegram.state.calls.length,at);assert.deepEqual({...stored()},before);assert.equal(cursor(),beforeCursor);
});

for(const reason of ['future-due','terminal','preserved','old-revision','old-post','not-ready','no-custom-error',
  'bot-rejected-without-custom','bot-rejected-future-due','account-rejected','account-changed','account-uncertain',
  'recheck-future-due','recheck-without-custom','invalid-final','invalid-recheck-exhausted','waiting-without-recheck'])
test('personal receive remains available when caption repair is '+reason,async()=>{
  await readyDelivery();
  db().prepare("UPDATE telegram_relay_outbox SET caption_edit_attempted_at=?,caption_edit_outcome='changed',last_error=?,next_attempt_at=?")
    .run(Date.now()-1000,'Telegram 未保留部分原始自定义 Emoji，请检查机器人的自定义 Emoji 使用权限。该消息不会自动重发。',Date.now()-1);
  if(reason==='future-due')db().prepare('UPDATE telegram_relay_outbox SET next_attempt_at=?').run(Date.now()+60000);
  if(reason==='terminal')db().prepare("UPDATE telegram_relay_outbox SET caption_edit_outcome='account_unavailable_final'").run();
  if(reason==='preserved')db().prepare("UPDATE telegram_relay_outbox SET caption_edit_outcome='account_preserved'").run();
  if(reason==='old-revision')db().prepare("UPDATE telegram_relay_outbox SET revision='previous-generation'").run();
  if(reason==='old-post')db().prepare('UPDATE telegram_relay_outbox SET sent_at=?').run(Date.now()-25*3600000);
  if(reason==='not-ready')db().prepare('UPDATE telegram_relay_state SET ready_until=0').run();
  if(reason==='no-custom-error')db().prepare("UPDATE telegram_relay_outbox SET last_error='other-error'").run();
  if(reason.startsWith('bot-rejected')) {
    db().prepare("UPDATE telegram_relay_outbox SET caption_edit_outcome='rejected',last_error=?")
      .run('Telegram 拒绝补正文案或按钮，请检查机器人权限及原消息格式；不会重复发送媒体。');
    if(reason==='bot-rejected-without-custom')db().prepare("UPDATE telegram_relay_outbox SET caption_entities='[]'").run();
    if(reason==='bot-rejected-future-due')db().prepare('UPDATE telegram_relay_outbox SET next_attempt_at=?').run(Date.now()+60000);
  }
  if(['account-rejected','account-changed','account-uncertain'].includes(reason)) {
    db().prepare('UPDATE telegram_relay_outbox SET caption_edit_outcome=?,last_error=?')
      .run(reason.replace('-','_'),'Telegram 拒绝补正文案或按钮，请检查机器人权限及原消息格式；不会重复发送媒体。');
  }
  if(reason.startsWith('recheck-')) {
    db().prepare("UPDATE telegram_relay_outbox SET caption_edit_outcome='account_recheck_waiting_1',caption_edit_recheck_count=1").run();
    if(reason==='recheck-future-due')db().prepare('UPDATE telegram_relay_outbox SET next_attempt_at=?').run(Date.now()+61000);
    if(reason==='recheck-without-custom')db().prepare("UPDATE telegram_relay_outbox SET caption_entities='[]'").run();
  }
  if(reason==='invalid-final')db().prepare("UPDATE telegram_relay_outbox SET caption_edit_outcome='account_invalid_final'").run();
  if(reason==='invalid-recheck-exhausted')db().prepare("UPDATE telegram_relay_outbox SET caption_edit_outcome='account_invalid',caption_edit_recheck_count=1").run();
  if(reason==='waiting-without-recheck')db().prepare("UPDATE telegram_relay_outbox SET caption_edit_outcome='account_recheck_waiting_1',caption_edit_recheck_count=0").run();
  telegram.state.messages=[photo()];
  if(reason==='not-ready')db().prepare('UPDATE telegram_personal_account SET synced_at=0').run();
  const at=telegram.state.calls.length;
  await account.pollTelegramAccountOnce();
  assert.ok(telegram.state.calls.length>at,'normal receive/refresh must be allowed to acquire its own lease');
  if(reason!=='not-ready')assert.equal(cursor(),41);
});

for(const phase of ['getMe','pre-read'])test('personal caption edit stops when an account-origin source is deselected during '+phase,async()=>{
  const input=await readyAccountEdit();
  db().prepare("UPDATE telegram_relay_outbox SET origin='account',account_generation=?,queued_at=?").run(stored().generation,Date.now());
  const cancel=()=>db().prepare('UPDATE telegram_personal_sources SET selected=0 WHERE chat_id=?').run(source);
  if(phase==='getMe')telegram.state.onGetMe=cancel;else telegram.state.onGetMessages=cancel;
  assert.deepEqual(await account.editVerifiedRelayCaptionWithAccount(input),{state:'unavailable',attempted:false,outcome:'unavailable'});
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,0);
});

test('personal caption edit accepts an edit-capable admin and preserves the original document attachment',async()=>{
  const input=await readyAccountEdit();
  db().prepare("UPDATE telegram_relay_outbox SET origin='account',account_generation=?,queued_at=?").run(stored().generation,Date.now());
  telegram.state.resolvedTarget.creator=false;telegram.state.resolvedTarget.adminRights={editMessages:true};
  telegram.state.messages[0].media=new Api.MessageMediaDocument({document:new Api.Document({id:{toString:()=>'-555555555555555555'},mimeType:'video/mp4'})});
  assert.deepEqual(await account.editVerifiedRelayCaptionWithAccount(input),{state:'ok',attempted:true,outcome:'preserved'});
});

test('personal caption edit shares one absolute deadline across preflight RPCs',async t=>{
  const input=await readyAccountEdit(),realNow=Date.now();
  let clock=realNow;t.mock.method(Date,'now',()=>clock);
  telegram.state.onGetMessages=()=>{clock=realNow+40001;};
  assert.deepEqual(await account.editVerifiedRelayCaptionWithAccount(input),{state:'unavailable',attempted:false,outcome:'unavailable'});
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,0);
});

for(const mode of ['edit','recheck'])test('strict '+mode+' preflight can reread a transient mismatch but never retry an actual edit',async()=>{
  const input=await readyAccountEdit(),original=input.caption;
  if(mode==='recheck')db().prepare("UPDATE telegram_relay_outbox SET caption_edit_outcome='account_rechecking'").run();
  const before={...stored()},rows=db().prepare('SELECT * FROM telegram_relay_outbox').all();
  let reads=0;
  telegram.state.onGetMessages=()=>{reads++;telegram.state.messages[0].message=reads===1?original+' temporary':original;};
  const result=await account[mode==='edit'?'editVerifiedRelayCaptionWithAccount':'recheckVerifiedRelayCaptionWithAccount'](input);
  assert.equal(result.state,'ok');assert.equal(result.outcome,mode==='edit'?'preserved':'ready');assert.equal(result.attempted,mode==='edit');
  if(mode==='recheck')assert.equal(result.reason,'ready_to_edit');
  assert.equal(reads,mode==='edit'?3:2);
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,mode==='edit'?1:0);
  assert.deepEqual({...stored()},before);assert.deepEqual(db().prepare('SELECT * FROM telegram_relay_outbox').all(),rows);
});

test('strict caption preflight performs at most three reads before a persistent mismatch becomes invalid',async()=>{
  const input=await readyAccountEdit();telegram.state.messages[0].message+=' persistent';
  const result=await account.editVerifiedRelayCaptionWithAccount(input);
  assert.deepEqual(result,{state:'ok',attempted:false,outcome:'invalid',reason:'caption_mismatch'});
  assert.equal(telegram.state.calls.filter(call=>call.method==='getMessages').length,3);
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,0);
});

for(const authority of ['premium','channel-admin','source'])test('strict caption rereads stop when '+authority+' evidence changes',async()=>{
  const input=await readyAccountEdit();telegram.state.messages[0].message+=' temporary';
  if(authority==='source')db().prepare("UPDATE telegram_relay_outbox SET origin='account',account_generation=?,queued_at=?").run(stored().generation,Date.now());
  let checks=0;
  telegram.state.onEntity=()=>{
    checks++;
    if(checks===2) {
      if(authority==='premium')telegram.state.me.premium=false;
      if(authority==='channel-admin')telegram.state.resolvedTarget.creator=false;
      if(authority==='source')db().prepare('UPDATE telegram_personal_sources SET selected=0 WHERE chat_id=?').run(source);
    }
  };
  const result=await account.editVerifiedRelayCaptionWithAccount(input);
  assert.equal(result.attempted,false);assert.equal(result.outcome,authority==='source'?'unavailable':'rejected');
  assert.equal(telegram.state.calls.filter(call=>call.method==='getMessages').length,1);
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,0);
});

test('ordinary editor and read-only recheck cannot accept each other\'s leased phase',async()=>{
  const input=await readyAccountEdit(),at=telegram.state.calls.length;
  assert.deepEqual(await account.recheckVerifiedRelayCaptionWithAccount(input),{state:'unavailable',attempted:false,outcome:'unavailable'});
  assert.equal(telegram.state.calls.length,at);
  db().prepare("UPDATE telegram_relay_outbox SET caption_edit_outcome='account_rechecking'").run();
  assert.deepEqual(await account.editVerifiedRelayCaptionWithAccount(input),{state:'unavailable',attempted:false,outcome:'unavailable'});
  assert.equal(telegram.state.calls.length,at);
  db().prepare("UPDATE telegram_relay_state SET send_lease_id='different-worker'").run();
  assert.deepEqual(await account.recheckVerifiedRelayCaptionWithAccount(input),{state:'unavailable',attempted:false,outcome:'unavailable'});
  assert.equal(telegram.state.calls.length,at);
});

test('read-only leased recheck reports already preserved artwork without invoking the editor',async()=>{
  const input=await readyAccountEdit();
  db().prepare("UPDATE telegram_relay_outbox SET caption_edit_outcome='account_rechecking'").run();
  telegram.state.messages[0].entities=delivery().message.entities;
  const before={...stored()},rows=db().prepare('SELECT * FROM telegram_relay_outbox').all(),beforeCursor=cursor();
  assert.deepEqual(await account.recheckVerifiedRelayCaptionWithAccount(input),{state:'ok',attempted:false,outcome:'preserved'});
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,0);
  assert.deepEqual({...stored()},before);assert.deepEqual(db().prepare('SELECT * FROM telegram_relay_outbox').all(),rows);assert.equal(cursor(),beforeCursor);
});

async function readyBlockedCaption(value=delivery()) {
  const input=await readyAccountEdit(value);
  db().prepare("UPDATE telegram_relay_outbox SET caption_edit_outcome='account_invalid',lease_id='',lease_until=0,last_error='fixture-blocked'").run();
  db().prepare("UPDATE telegram_relay_state SET send_lease_id='',send_lease_until=0").run();
  return input;
}

test('blocked caption diagnostic reads only three exact invalid snapshots and leaves all persisted business data unchanged',async()=>{
  const input=await readyBlockedCaption();
  const sentBase=Date.now()-1000;
  db().prepare('UPDATE telegram_relay_outbox SET sent_at=?').run(sentBase);
  for(let index=1;index<=4;index++) {
    const value=delivery(701+index,{post:true,media:telegram.state.messages[0].media});
    telegram.state.messages.push(value.message);sentReference(value,{sentAt:sentBase-index});
    db().prepare("UPDATE telegram_relay_outbox SET caption_edit_outcome='account_invalid' WHERE message_id=?").run(value.message.id);
  }
  const value=delivery(900,{post:true,media:telegram.state.messages[0].media});sentReference(value,{sentAt:Date.now()-100});
  db().prepare("UPDATE telegram_relay_outbox SET caption_edit_outcome='changed',last_error='fixture-other-terminal' WHERE message_id=900").run();
  const before={...stored()},jobs=db().prepare('SELECT * FROM telegram_relay_outbox ORDER BY id').all(),beforeSources=db().prepare('SELECT * FROM telegram_personal_sources ORDER BY chat_id').all();
  const at=telegram.state.calls.length,result=await account.inspectBlockedRelayCaptionPreflights();
  assert.equal(result.state,'ok');assert.equal(result.personalEditQualification,'qualified');assert.equal(result.posts.length,3);
  assert.ok(result.posts.every(post=>post.snapshotOutcome==='account_invalid'&&post.sourceActive&&post.storedEntitiesValid&&post.mediaValid&&post.isPost));
  assert.equal(result.posts[0].reason,'ready_to_edit');assert.equal(result.posts[0].captionMatches,true);assert.equal(result.posts[0].customEmojiPreserved,false);
  const reads=telegram.state.calls.slice(at).filter(call=>call.method==='getMessages');
  assert.equal(reads.length,1);assert.equal(reads[0].params.limit,3);assert.ok(!reads[0].params.ids.includes(900));assert.ok(reads[0].params.ids.includes(input.messageId));
  assert.ok(telegram.state.calls.slice(at).every(call=>['construct','connect','entity','getMe','getMessages','destroy'].includes(call.method)));
  assert.deepEqual({...stored()},before);assert.deepEqual(db().prepare('SELECT * FROM telegram_relay_outbox ORDER BY id').all(),jobs);
  assert.deepEqual(db().prepare('SELECT * FROM telegram_personal_sources ORDER BY chat_id').all(),beforeSources);assert.equal(telegram.state.queue.length,0);
  assert.doesNotMatch(JSON.stringify(result),/Offer|9007199254740993123|555555555555555555|join365|fixture|secret|session|message_id|username|documentId|caption_entities/i);
  for(const post of result.posts) {
    assert.ok(Object.entries(post).filter(([key])=>key!=='entityCoverage').every(([,value])=>['string','number','boolean'].includes(typeof value)));
    for(const coverage of post.entityCoverage) {
      assert.deepEqual(Object.keys(coverage).sort(),['actualCount','actualCoveredUtf16','expectedCount','expectedCoveredUtf16','type']);
      assert.ok(Object.entries(coverage).every(([key,value])=>key==='type'?typeof value==='string':Number.isSafeInteger(value)&&value>=0));
    }
  }
});

test('blocked caption diagnostic distinguishes exact, trim and line-ending differences without returning characters',async()=>{
  const value=delivery(701,{caption:'⭐ Offer\t\r\nhttps://365freebonus.com/ \uFE0F\u200B\u0001'});
  const input=await readyBlockedCaption(value);
  telegram.state.messages[0].message=input.caption.replace(/\r\n/g,'\n');
  const post=(await account.inspectBlockedRelayCaptionPreflights()).posts[0];
  assert.equal(post.reason,'caption_mismatch');assert.equal(post.captionMatches,false);assert.equal(post.lineEndingNormalizedMatches,true);
  assert.equal(post.expectedCarriageReturns,1);assert.equal(post.actualCarriageReturns,0);assert.equal(post.expectedTabs,1);assert.equal(post.actualTabs,1);
  assert.equal(post.expectedLineFeeds,1);assert.equal(post.actualLineFeeds,1);assert.equal(post.expectedVariationSelectors16,1);assert.equal(post.expectedZeroWidthControls,1);
  assert.equal(post.expectedOtherControls,3);assert.equal(post.firstDifference,input.caption.indexOf('\r'));assert.equal(post.firstDifferenceExpectedKind,'control');
  assert.equal(post.expectedUtf16Length,post.actualUtf16Length+1);
  const expected=delivery(701,{caption:'⭐ Offer https://365freebonus.com/ \r\n'});
  db().prepare('UPDATE telegram_relay_outbox SET caption=?,caption_entities=?').run(expected.caption,JSON.stringify(expected.entities));
  telegram.state.messages[0].message=expected.caption.trim();telegram.state.messages[0].entities=expected.message.entities.filter(entity=>!(entity instanceof Api.MessageEntityCustomEmoji));
  const trimmed=(await account.inspectBlockedRelayCaptionPreflights()).posts[0];
  assert.equal(trimmed.reason,'caption_mismatch');assert.equal(trimmed.trimmedCaptionMatches,true);assert.equal(trimmed.expectedTrailingWhitespace,3);assert.equal(trimmed.actualTrailingWhitespace,0);
});

for(const scenario of [
  {name:'unknown TL entity',reason:'actual_entities_unsupported',change:message=>message.entities.push(new Api.MessageEntityUnknown({offset:2,length:5}))},
  {name:'wrong peer',reason:'message_identity_invalid',change:message=>message.peerId=new Api.PeerChannel({channelId:'1001'})},
  {name:'forwarded post',reason:'message_not_direct_post',change:message=>message.fwdFrom={private:'private-source'}},
  {name:'missing media',reason:'media_invalid',change:message=>message.media=undefined},
  {name:'foreign hidden link',reason:'actual_links_unsafe',change:message=>message.entities.push(new Api.MessageEntityTextUrl({offset:2,length:5,url:'https://private-source.example/'}))},
  {name:'changed buttons',reason:'buttons_mismatch',change:message=>message.replyMarkup.rows[0].buttons[0].text='private-button-label'},
])test('blocked caption diagnostic reports fixed reason for '+scenario.name,async()=>{
  await readyBlockedCaption();scenario.change(telegram.state.messages[0]);
  const result=await account.inspectBlockedRelayCaptionPreflights();assert.equal(result.posts[0].reason,scenario.reason);
  if(scenario.reason==='actual_entities_unsupported')assert.equal(result.posts[0].unsupportedActualEntityCount,1);
  assert.doesNotMatch(JSON.stringify(result),/private-source|private-button|MessageEntityUnknown|555555|900719/);
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,0);
});

test('blocked caption diagnostic reports invalid stored entities, inactive source and current qualification independently',async()=>{
  await readyBlockedCaption();
  db().prepare("UPDATE telegram_relay_outbox SET origin='account',account_generation=?,queued_at=?").run(stored().generation,Date.now());
  db().prepare('UPDATE telegram_personal_sources SET selected=0 WHERE chat_id=?').run(source);
  let result=await account.inspectBlockedRelayCaptionPreflights();assert.equal(result.posts[0].sourceActive,false);assert.equal(result.posts[0].reason,'source_inactive');
  db().prepare("UPDATE telegram_relay_outbox SET caption_entities='[{\"type\":\"future_kind\",\"offset\":0,\"length\":1}]'").run();
  result=await account.inspectBlockedRelayCaptionPreflights();assert.equal(result.posts[0].storedEntitiesValid,false);assert.equal(result.posts[0].unsupportedExpectedEntityCount,1);
  assert.equal(result.posts[0].reason,'stored_entities_invalid');
  db().prepare('UPDATE telegram_relay_outbox SET caption_entities=?').run(JSON.stringify(delivery().entities));
  telegram.state.me.premium=false;
  result=await account.inspectBlockedRelayCaptionPreflights();assert.equal(result.personalEditQualification,'not_premium');assert.equal(result.posts[0].sourceActive,false);
});

test('blocked caption diagnostic falls back only to recent errored custom terminal posts, never active or public unrelated messages',async()=>{
  await readyBlockedCaption();db().prepare("UPDATE telegram_relay_outbox SET caption_edit_outcome='rejected'").run();
  assert.equal((await account.inspectBlockedRelayCaptionPreflights()).posts[0].snapshotOutcome,'rejected');
  db().prepare("UPDATE telegram_relay_outbox SET caption_edit_outcome='account_attempting'").run();
  const at=telegram.state.calls.length;assert.deepEqual((await account.inspectBlockedRelayCaptionPreflights()).posts,[]);assert.equal(telegram.state.calls.length,at);
  db().prepare("UPDATE telegram_relay_outbox SET caption_edit_outcome='rejected',caption_entities='[]'").run();
  assert.deepEqual((await account.inspectBlockedRelayCaptionPreflights()).posts,[]);
  db().prepare("UPDATE telegram_relay_outbox SET caption_edit_outcome='account_invalid',sent_at=?").run(Date.now()-25*3600000);
  assert.deepEqual((await account.inspectBlockedRelayCaptionPreflights()).posts,[]);
});

test('blocked caption diagnostic rechecks destination and source snapshots after network reads and respects real backoff',async()=>{
  await readyBlockedCaption();
  telegram.state.onEntity=()=>db().prepare('UPDATE telegram_relay_state SET target_chat_id=-1001001').run();
  assert.equal((await account.inspectBlockedRelayCaptionPreflights()).state,'unavailable');assert.equal(telegram.state.calls.filter(call=>call.method==='getMessages').length,0);
  telegram.state.onEntity=null;db().prepare('UPDATE telegram_relay_state SET target_chat_id=?').run(target);
  telegram.state.error={method:'getMessages',errorMessage:'FLOOD_WAIT_120',seconds:120};
  const at=Date.now();assert.equal((await account.inspectBlockedRelayCaptionPreflights()).state,'backoff');assert.ok(stored().next_attempt_at>=at+120000);
  const calls=telegram.state.calls.length;assert.equal((await account.inspectBlockedRelayCaptionPreflights()).state,'backoff');assert.equal(telegram.state.calls.length,calls);
  assert.equal(db().prepare('SELECT caption_edit_outcome FROM telegram_relay_outbox').get().caption_edit_outcome,'account_invalid');
});

for (const scenario of [
  {name:'owned Premium bot owner',premium:true,usernames:undefined,expected:'owner_premium'},
  {name:'owned non-Premium owner without a collectible username',premium:false,usernames:[{username:'private_bot_name',editable:true}],expected:'not_qualified'},
  {name:'owned bot with a collectible username',premium:false,usernames:[{username:'private_collectible_name',editable:false}],expected:'fragment_username'},
  {name:'owned bot with an omitted non-editable TL flag',premium:false,usernames:[{username:'private_collectible_name',active:true}],expected:'fragment_username'},
  {name:'collectible qualification takes priority over owner Premium',premium:true,usernames:[{username:'private_collectible_name',editable:false}],expected:'fragment_username'},
]) test(`bot emoji qualification reads ${scenario.name} without exposing profiles or changing application data`,async()=>{
  await login();await select();ready();
  telegram.state.me=new Api.User({id:'private_owner_id',firstName:'private_owner_name',phone:'private_owner_phone',premium:scenario.premium});
  telegram.state.ownedBots=[new Api.User({id:'77',bot:true,username:'private_bot_name',usernames:scenario.usernames?.map(value=>new Api.Username(value))})];
  const before={...stored()};
  const beforeCursor=cursor();
  const beforeQueue=db().prepare('SELECT * FROM telegram_relay_outbox').all();
  const at=telegram.state.calls.length;
  const result=await account.inspectConnectedBotEmojiQualification();
  assert.deepEqual(result,{state:'ok',qualification:scenario.expected});
  assert.doesNotMatch(JSON.stringify(result),/private_owner|private_bot|private_collectible|"(?:id|username|usernames|firstName|phone|premium)"\s*:/i);
  assert.deepEqual({...stored()},before);
  assert.equal(cursor(),beforeCursor);
  assert.deepEqual(db().prepare('SELECT * FROM telegram_relay_outbox').all(),beforeQueue);
  assert.equal(telegram.state.queue.length,0);
  assert.deepEqual(telegram.state.calls.slice(at).filter(call=>['getMe','GetAdminedBots','history','download','sendCode','SignIn','password'].includes(call.method)).map(call=>call.method),['getMe','GetAdminedBots']);
});

test('bot emoji qualification never treats a non-owner Premium account as the bot owner',async()=>{
  await login();ready();
  telegram.state.me=new Api.User({id:'private_other_owner',premium:true});
  telegram.state.ownedBots=[new Api.User({id:'999',bot:true,usernames:[new Api.Username({username:'private_other_collectible',editable:false})]})];
  assert.deepEqual(await account.inspectConnectedBotEmojiQualification(),{state:'ok',qualification:'owner_not_verified'});
});

test('bot emoji qualification leaves minimal or ambiguous bot responses unknown',async()=>{
  await login();ready();
  telegram.state.me=new Api.User({id:'private_owner',premium:true});
  for (const bots of [
    [new Api.User({id:'77',bot:true,min:true})],
    [new Api.User({id:'77',bot:true,deleted:true})],
    [new Api.User({id:'77',bot:true,usernames:[{username:'private_untyped_name',editable:false}]})],
    {users:[new Api.User({id:'77',bot:true})]},
    [{}],
  ]) {
    telegram.state.ownedBots=bots;
    assert.deepEqual(await account.inspectConnectedBotEmojiQualification(),{state:'ok',qualification:'unknown'});
  }
});

test('bot emoji qualification refuses disconnected, busy and backoff reads before any network calls',async()=>{
  assert.deepEqual(await account.inspectConnectedBotEmojiQualification(),{state:'disconnected',qualification:'unknown'});
  assert.equal(telegram.state.calls.length,0);
  await login();ready();
  const at=telegram.state.calls.length;
  db().prepare('UPDATE telegram_personal_account SET lease_until=?').run(Date.now()+60000);
  assert.deepEqual(await account.inspectConnectedBotEmojiQualification(),{state:'busy',qualification:'unknown'});
  db().prepare('UPDATE telegram_personal_account SET lease_until=0,next_attempt_at=?').run(Date.now()+60000);
  assert.deepEqual(await account.inspectConnectedBotEmojiQualification(),{state:'backoff',qualification:'unknown'});
  assert.equal(telegram.state.calls.length,at);
});

test('bot emoji qualification revalidates bot identity after asynchronous Telegram reads',async()=>{
  await login();ready();
  telegram.state.me=new Api.User({id:'private_owner',premium:true});
  telegram.state.ownedBots=[new Api.User({id:'77',bot:true})];
  telegram.state.onOwnedBots=async()=>db().prepare('UPDATE telegram_relay_state SET bot_id=78').run();
  assert.deepEqual(await account.inspectConnectedBotEmojiQualification(),{state:'unavailable',qualification:'unknown'});
});

test('bot emoji qualification retains a genuine FloodWait without clearing source authorization',async()=>{
  await login();await select();ready();
  telegram.state.error={method:'GetAdminedBots',errorMessage:'FLOOD_WAIT_120',seconds:120};
  const before=Date.now();
  const session=stored().session_ciphertext;
  const beforeCursor=cursor();
  assert.deepEqual(await account.inspectConnectedBotEmojiQualification(),{state:'backoff',qualification:'unknown'});
  assert.ok(stored().next_attempt_at>=before+120000);
  assert.equal(stored().stage,'connected');
  assert.equal(stored().session_ciphertext,session);
  assert.equal(cursor(),beforeCursor);
  assert.equal(telegram.state.queue.length,0);
});

test('bot emoji qualification failure does not revoke authorization or alter queued media',async()=>{
  await login();await select();ready();
  db().prepare(`INSERT INTO telegram_relay_outbox(source_chat_id,source_message_id,fingerprint,queued_at,revision,media_kind,file_id,file_unique_id,caption)
    VALUES(?,1,'fixture-qualification',1,'fixture-revision','photo','fixture-file','fixture-unique','fixture-caption')`).run(source);
  const before={...stored()};
  const beforeQueue=db().prepare('SELECT * FROM telegram_relay_outbox').all();
  telegram.state.error={method:'GetAdminedBots',errorMessage:'SESSION_REVOKED'};
  assert.deepEqual(await account.inspectConnectedBotEmojiQualification(),{state:'unavailable',qualification:'unknown'});
  assert.deepEqual({...stored()},before);
  assert.deepEqual(db().prepare('SELECT * FROM telegram_relay_outbox').all(),beforeQueue);
  assert.equal(cursor(),40);
});

test('personal captions preserve formatting, quote expansion, code language and explicit date format',async()=>{
  await login();await select();ready();
  const span={offset:0,length:4};
  const entities=[new Api.MessageEntityBold(span),new Api.MessageEntityItalic(span),new Api.MessageEntityUnderline(span),
    new Api.MessageEntityStrike(span),new Api.MessageEntitySpoiler(span),new Api.MessageEntityCode(span),
    new Api.MessageEntityPre({...span,language:'javascript'}),new Api.MessageEntityBlockquote(span),
    new Api.MessageEntityBlockquote({...span,collapsed:true}),
    new Api.MessageEntityFormattedDate({...span,date:1800000000,dayOfWeek:true,longDate:true,shortTime:true}),
    new Api.MessageEntityFormattedDate({...span,date:1800000001,relative:true}),
    new Api.MessageEntityHashtag(span),new Api.MessageEntityCashtag(span),new Api.MessageEntityBotCommand(span)];
  telegram.state.messages=[video(41,{caption:'Keep exact formatting',entities})];
  await account.pollTelegramAccountOnce();
  assert.deepEqual(telegram.state.queue[0].captionEntities,[
    ...['bold','italic','underline','strikethrough','spoiler','code'].map(type=>({type,...span})),
    {type:'pre',...span,language:'javascript'},{type:'blockquote',...span},{type:'expandable_blockquote',...span},
    {type:'date_time',...span,unix_time:1800000000,date_time_format:'wDt'},
    {type:'date_time',...span,unix_time:1800000001,date_time_format:'r'},
    ...['hashtag','cashtag','bot_command'].map(type=>({type,...span})),
  ]);
});

test('link spans remain available for rewriting without carrying source URLs or private mention records',async()=>{
  await login();await select();ready();
  const entities=[new Api.MessageEntityTextUrl({offset:0,length:4,url:'https://source.example/private'}),
    new Api.MessageEntityMentionName({offset:5,length:4,userId:'private-user-record'})];
  telegram.state.messages=[photo(41,{message:'Link Name',entities})];
  await account.pollTelegramAccountOnce();
  assert.deepEqual(telegram.state.queue[0].captionEntities,[{type:'text_link',offset:0,length:4},{type:'text_mention',offset:5,length:4}]);
  assert.doesNotMatch(JSON.stringify(telegram.state.queue[0].captionEntities),/private-user|source\.example/);
});

test('unknown and malformed custom emoji entities do not discard the original caption or prevent later valid entities',async()=>{
  await login();await select();ready();
  telegram.state.messages=[photo(41,{message:'⭐ Keep',entities:[
    new Api.MessageEntityCustomEmoji({offset:0,length:1,documentId:{toString:()=>{throw new Error('unusable ID');}}}),
    new Api.MessageEntityCustomEmoji({offset:0,length:1,documentId:{toString:()=>'0'}}),
    new Api.MessageEntityUnknown({offset:0,length:1}),new Api.MessageEntityBold({offset:-1,length:3}),
    new Api.MessageEntityItalic({offset:2,length:4}),
  ]})];
  await account.pollTelegramAccountOnce();
  assert.equal(telegram.state.queue[0].caption,'⭐ Keep');
  assert.deepEqual(telegram.state.queue[0].captionEntities,[{type:'italic',offset:2,length:4}]);
});

test('video captions, protection and actual attachments are required; previews and round video notes are skipped',async()=>{
  await login();await select();ready();
  const attached=video().media.document;
  telegram.state.messages=[video(41,{caption:' '}),video(42,{noforwards:true}),video(43,{roundMessage:true}),
    video(44,{media:{className:'MessageMediaWebPage',document:attached}}),
    video(45,{media:{className:'MessageMediaPaidMedia',document:attached}}),video(46,{mimeType:'image/png',videoAttribute:false}),
    video(47,{videoAttribute:false}),video(48,{mimeType:'video/mp4;bad'}),video(49,{mimeType:'video/'+'a'.repeat(100)})];
  await account.pollTelegramAccountOnce();
  assert.equal(cursor(),49);
  assert.equal(telegram.state.calls.filter(call=>call.method==='download').length,0);
  assert.equal(telegram.state.queue.length,0);
});

test('attached MOV, WebM and MKV videos keep their MIME type for document-compatible forwarding',async()=>{
  await login();await select();ready();
  telegram.state.messages=[video(41,{mimeType:'video/quicktime'}),video(42,{mimeType:'video/webm'}),video(43,{mimeType:'video/x-matroska'})];
  await account.pollTelegramAccountOnce();
  assert.equal(cursor(),43);
  assert.deepEqual(telegram.state.queue.map(item=>({kind:item.mediaKind,mime:item.mimeType})),[
    {kind:'video',mime:'video/quicktime'},{kind:'video',mime:'video/webm'},{kind:'video',mime:'video/x-matroska'},
  ]);
});

test('personal videos above 50 MiB are skipped before download while larger-than-20-MiB videos remain eligible',async()=>{
  await login();await select();ready();
  telegram.state.messages=[video(41,{size:50*1024*1024+1}),video(42,{size:30*1024*1024})];
  await account.pollTelegramAccountOnce();
  assert.equal(cursor(),42);
  assert.deepEqual(telegram.state.calls.filter(call=>call.method==='download').map(call=>call.id),[42]);
  assert.equal(telegram.state.queue[0].mediaKind,'video');
});

test('animated MP4 documents remain GIF animations instead of ordinary video',async()=>{
  await login();await select();ready();
  telegram.state.messages=[video(41,{animated:true})];
  await account.pollTelegramAccountOnce();
  assert.equal(telegram.state.queue.length,1);
  assert.equal(telegram.state.queue[0].mediaKind,'animation');
});

test('protected channel or message advances cursor without downloading or queuing',async()=>{
  await login();await select();ready();
  telegram.state.dialogs[0].entity.noforwards=true;
  telegram.state.messages=[photo()];
  await account.pollTelegramAccountOnce();
  assert.equal(cursor(),41);
  assert.equal(telegram.state.calls.filter(call=>call.method==='download').length,0);
  assert.equal(telegram.state.queue.length,0);
});

test('plain text with a photo preview and paid media never qualify as attached photos',async()=>{
  await login();await select();ready();
  telegram.state.messages=[photo(41,{media:{className:'MessageMediaWebPage',photo:new Api.Photo({id:'preview'})}}),
    photo(42,{media:{className:'MessageMediaPaidMedia',photo:new Api.Photo({id:'paid'})}}),photo(43,{noforwards:true}),photo(44,{message:'  '})];
  await account.pollTelegramAccountOnce();
  assert.equal(cursor(),44);
  assert.equal(telegram.state.calls.filter(call=>call.method==='download').length,0);
  assert.equal(telegram.state.queue.length,0);
});

test('new protection state cancels queued source media before later sends',async()=>{
  await login();await select();ready();
  db().prepare(`INSERT INTO telegram_relay_outbox(source_chat_id,source_message_id,fingerprint,queued_at,revision,media_kind,file_id,file_unique_id,caption,origin,status)
    VALUES(?,1,'protected',1,'relay-generation','photo','f','u','caption','account','pending')`).run(source);
  telegram.state.dialogs[0].entity.noforwards=true;
  telegram.state.messages=[photo()];
  await account.pollTelegramAccountOnce();
  assert.equal(db().prepare('SELECT blocked FROM telegram_personal_sources WHERE chat_id=?').get(source).blocked,1);
  assert.equal(db().prepare('SELECT status FROM telegram_relay_outbox').get().status,'cancelled');
});

test('refresh discovers channel protection and cancels its queued media',async()=>{
  await login();await select();
  db().prepare(`INSERT INTO telegram_relay_outbox(source_chat_id,source_message_id,fingerprint,queued_at,revision,media_kind,file_id,file_unique_id,caption,origin,status)
    VALUES(?,1,'protected',1,'relay-generation','photo','f','u','caption','account','pending')`).run(source);
  telegram.state.dialogs[0].entity.noforwards=true;
  await account.handleAccountAction({action:'refresh'});
  assert.equal(db().prepare('SELECT blocked FROM telegram_personal_sources WHERE chat_id=?').get(source).blocked,1);
  assert.equal(db().prepare('SELECT status FROM telegram_relay_outbox').get().status,'cancelled');
});

test('stored session and source cursor resume after reopening database',async()=>{
  await login();await select();ready();
  telegram.state.messages=[photo()];await account.pollTelegramAccountOnce();
  assert.equal(cursor(),41);
  closeDb();
  telegram.state.messages.push(photo(42));await account.pollTelegramAccountOnce();
  assert.equal(cursor(),42);
  assert.deepEqual(telegram.state.queue.map(value=>value.sourceMessageId),[41,42]);
});

test('disconnect during media download prevents stale source enqueue',async()=>{
  await login();await select();ready();
  telegram.state.messages=[photo()];
  telegram.state.onDownload=async()=>{await account.handleAccountAction({action:'disconnect'});};
  await account.pollTelegramAccountOnce();
  assert.equal(account.accountStatus().connected,false);
  assert.equal(telegram.state.queue.length,0);
});

test('download size limit aborts and skips before enqueuing',async()=>{
  await login();await select();ready();
  telegram.state.messages=[photo()];
  telegram.state.onDownload=async(_message,params)=>params.progressCallback({toString:()=>String(11*1024*1024)},{toString:()=>String(11*1024*1024)});
  await account.pollTelegramAccountOnce();
  assert.equal(cursor(),41);
  assert.equal(telegram.state.queue.length,0);
  assert.equal(stored().last_error,'');
});

test('revoked account clears receive authorization and cancels only pending account jobs',async()=>{
  await login();await select();ready();
  db().prepare(`INSERT INTO telegram_relay_outbox(source_chat_id,source_message_id,fingerprint,queued_at,revision,media_kind,file_id,file_unique_id,caption,origin,status)
    VALUES(?,1,'f',1,'relay-generation','photo','f','u','caption','account','pending')`).run(source);
  const old=stored().generation;
  telegram.state.error={method:'connect',errorMessage:'SESSION_REVOKED'};
  await account.pollTelegramAccountOnce();
  assert.equal(account.accountStatus().connected,false);
  assert.equal(stored().session_ciphertext,'');
  assert.notEqual(stored().generation,old);
  assert.equal(db().prepare('SELECT selected FROM telegram_personal_sources WHERE chat_id=?').get(source).selected,0);
  assert.equal(db().prepare('SELECT status FROM telegram_relay_outbox').get().status,'cancelled');
});

test('leaving a source cancels that source pending work but preserves other sources',async()=>{
  await login();
  telegram.state.dialogs.push(channel(1003));await account.handleAccountAction({action:'refresh'});
  await select([String(source),'-1001003']);
  for(const id of [source,-1001003])db().prepare(`INSERT INTO telegram_relay_outbox(source_chat_id,source_message_id,fingerprint,queued_at,revision,media_kind,file_id,file_unique_id,caption,origin,status)
    VALUES(?,1,?,1,'relay-generation','photo','f','u','caption','account','pending')`).run(id,String(id));
  telegram.state.dialogs=telegram.state.dialogs.filter(dialog=>String(dialog.entity.id)!=='1001');
  await account.handleAccountAction({action:'refresh'});
  assert.equal(db().prepare('SELECT status FROM telegram_relay_outbox WHERE source_chat_id=?').get(source).status,'cancelled');
  assert.equal(db().prepare('SELECT status FROM telegram_relay_outbox WHERE source_chat_id=-1001003').get().status,'pending');
});

function dueSourceWatch() { db().prepare('UPDATE telegram_personal_source_posts SET checked_at=0').run(); }
function knownSourcePost(message,{status='sent'}={}) {
  db().prepare(`INSERT INTO telegram_relay_outbox(source_chat_id,source_message_id,fingerprint,queued_at,revision,media_kind,
    file_id,file_unique_id,caption,caption_entities,status,origin,account_generation,message_id,sent_at)
    VALUES(?,?,'source-watch-'||?,?,'relay-generation','photo','f','u',?,'[]',?,'account',?,801,?)`)
    .run(source,message.id,message.id,Date.now(),message.message,status,stored().generation,Date.now());
}

test('captionless attached photos, videos and GIFs are watched and late captions forward without a new post',async()=>{
  await login();await select();ready();
  const messages=[photo(41,{message:''}),video(42,{caption:' '}),video(43,{caption:'',animated:true})];
  telegram.state.messages=messages;
  await account.pollTelegramAccountOnce();
  assert.equal(cursor(),43);assert.equal(telegram.state.queue.length,0);
  assert.equal(db().prepare('SELECT COUNT(*) AS n FROM telegram_personal_source_posts').get().n,3);
  assert.equal(telegram.state.calls.filter(call=>call.method==='download').length,0);
  for(let index=0;index<messages.length;index++) {
    messages[index].message='Late caption '+index;dueSourceWatch();await account.pollTelegramAccountOnce();
  }
  assert.deepEqual(telegram.state.queue.map(post=>post.mediaKind),['photo','video','animation']);
  assert.equal(cursor(),43);
  dueSourceWatch();await account.pollTelegramAccountOnce();assert.equal(telegram.state.queue.length,3);
});

test('source caption and entity changes within the same editDate are observed without downloading sent media again',async()=>{
  await login();await select();ready();
  const message=photo(41,{message:'⭐ Original',editDate:123,entities:[]});telegram.state.messages=[message];
  await account.pollTelegramAccountOnce();knownSourcePost(message);
  message.message='⭐ Revised';message.entities=[new Api.MessageEntityCustomEmoji({offset:0,length:1,documentId:{toString:()=>'-9007199254740993123'}})];
  dueSourceWatch();await account.pollTelegramAccountOnce();
  assert.equal(telegram.state.observations.length,1);assert.equal(telegram.state.observations[0].caption,'⭐ Revised');
  assert.equal(telegram.state.observations[0].captionEntities[0].custom_emoji_id,'-9007199254740993123');
  message.entities.push(new Api.MessageEntityBold({offset:2,length:7}));
  dueSourceWatch();await account.pollTelegramAccountOnce();
  assert.equal(telegram.state.observations.length,2);
  assert.equal(telegram.state.calls.filter(call=>call.method==='download').length,1);
});

test('removing a known source caption is observed instead of accepting the old desired text as consistent',async()=>{
  await login();await select();ready();
  const message=photo(41,{message:'Original caption'});telegram.state.messages=[message];
  await account.pollTelegramAccountOnce();knownSourcePost(message);
  message.message='';message.entities=[];
  dueSourceWatch();await account.pollTelegramAccountOnce();
  assert.equal(telegram.state.observations.length,1);
  assert.equal(telegram.state.observations[0].caption,'');
  assert.equal(telegram.state.calls.filter(call=>call.method==='download').length,1);
});

test('source watches persist across restarts and observe edits on posts older than one day',async()=>{
  await login();await select();ready();
  const message=photo(41,{message:''});telegram.state.messages=[message];await account.pollTelegramAccountOnce();
  const oldDate=message.date-2*86400;message.date=oldDate;
  const oldSelection=(oldDate-60)*1000;
  db().prepare('UPDATE telegram_personal_sources SET selected_at=? WHERE chat_id=?').run(oldSelection,source);
  db().prepare('UPDATE telegram_promotion_settings SET relay_started_at=?').run(oldSelection);
  db().prepare('UPDATE telegram_personal_source_posts SET source_date=?,selected_at=?,checked_at=0').run(oldDate,oldSelection);
  closeDb();message.message='Caption added two days later';await account.pollTelegramAccountOnce();
  assert.equal(telegram.state.queue.length,1);assert.equal(telegram.state.queue[0].sourceDate,oldDate);
});

test('a source caption observation that was not consumed is retried and does not resend known media',async()=>{
  await login();await select();ready();
  const message=photo();telegram.state.messages=[message];await account.pollTelegramAccountOnce();knownSourcePost(message,{status:'unknown'});
  message.message='Updated';telegram.state.consume=false;dueSourceWatch();await account.pollTelegramAccountOnce();
  telegram.state.consume=true;dueSourceWatch();await account.pollTelegramAccountOnce();
  assert.equal(telegram.state.observations.length,2);assert.equal(telegram.state.queue.length,1);
  assert.equal(telegram.state.calls.filter(call=>call.method==='download').length,1);
});

test('watch rotation reads oldest checked IDs in bounded batches and does not require a new post',async()=>{
  await login();await select();ready();
  telegram.state.messages=Array.from({length:40},(_,index)=>photo(41+index,{message:''}));
  await account.pollTelegramAccountOnce();await account.pollTelegramAccountOnce();dueSourceWatch();
  const before=telegram.state.calls.filter(call=>call.method==='getMessages').length;
  await account.pollTelegramAccountOnce();await account.pollTelegramAccountOnce();
  const reads=telegram.state.calls.filter(call=>call.method==='getMessages').slice(before);
  assert.equal(reads.length,2);assert.equal(reads[0].params.ids.length,20);assert.equal(reads[1].params.ids.length,20);
  assert.equal(new Set(reads.flatMap(call=>call.params.ids)).size,40);
});

test('watch invalidation cancels pending media and source edits when source post becomes protected',async()=>{
  await login();await select();ready();
  const message=photo();telegram.state.messages=[message];await account.pollTelegramAccountOnce();knownSourcePost(message,{status:'pending'});
  const outbox=db().prepare('SELECT id FROM telegram_relay_outbox').get();
  db().prepare(`INSERT INTO telegram_relay_source_edits(outbox_id,source_version,caption,caption_entities,baseline_caption,baseline_entities,created_at)
    VALUES(?,1,'new','[]','old','[]',?)`).run(outbox.id,Date.now());
  message.noforwards=true;dueSourceWatch();await account.pollTelegramAccountOnce();
  assert.equal(db().prepare('SELECT COUNT(*) AS n FROM telegram_personal_source_posts').get().n,0);
  assert.equal(db().prepare('SELECT status FROM telegram_relay_outbox').get().status,'cancelled');
  assert.equal(db().prepare('SELECT status FROM telegram_relay_source_edits').get().status,'superseded');
});

test('source watch never forwards plain text and stops watching replaced media or a wrong peer',async()=>{
  await login();await select();ready();
  const first=photo(41,{message:''}),second=video(42,{caption:''});
  telegram.state.messages=[first,second,new Api.Message({id:43,date:first.date,message:'Only text'})];
  await account.pollTelegramAccountOnce();
  first.message='Later';first.media=new Api.MessageMediaPhoto({photo:new Api.Photo({id:'replacement'})});
  second.message='Later';second.peerId=new Api.PeerChannel({channelId:'9999'});
  dueSourceWatch();await account.pollTelegramAccountOnce();
  assert.equal(telegram.state.queue.length,0);
  assert.equal(db().prepare('SELECT COUNT(*) AS n FROM telegram_personal_source_posts').get().n,0);
});

test('source watch keeps only the latest 512 posts per selected source',async()=>{
  await login();await select();ready();
  const generation=stored().generation,selectedAt=db().prepare('SELECT selected_at FROM telegram_personal_sources WHERE chat_id=?').get(source).selected_at;
  const insert=db().prepare(`INSERT INTO telegram_personal_source_posts(source_chat_id,source_message_id,account_generation,
    relay_revision,selected_at,source_date,media_id_hash,checked_at) VALUES(?,?,?,'relay-generation',?,?,?,?)`);
  for(let id=1;id<=513;id++)insert.run(source,id,generation,selectedAt,Math.floor(Date.now()/1000),'hash',Date.now());
  await account.pollTelegramAccountOnce();
  assert.equal(db().prepare('SELECT COUNT(*) AS n FROM telegram_personal_source_posts').get().n,512);
  assert.equal(db().prepare('SELECT MIN(source_message_id) AS first FROM telegram_personal_source_posts').get().first,2);
});

function wireEntities(entities) {
  const names={bold:'MessageEntityBold',italic:'MessageEntityItalic',underline:'MessageEntityUnderline',strikethrough:'MessageEntityStrike',
    spoiler:'MessageEntitySpoiler',code:'MessageEntityCode',pre:'MessageEntityPre',blockquote:'MessageEntityBlockquote',
    expandable_blockquote:'MessageEntityBlockquote',hashtag:'MessageEntityHashtag',cashtag:'MessageEntityCashtag',bot_command:'MessageEntityBotCommand',
    url:'MessageEntityUrl',text_link:'MessageEntityTextUrl',custom_emoji:'MessageEntityCustomEmoji',date_time:'MessageEntityFormattedDate'};
  return entities.map(entity=>new Api[names[entity.type]]({...entity,...(entity.type==='expandable_blockquote'?{collapsed:true}:{}),
    ...(entity.type==='custom_emoji'?{documentId:{toString:()=>entity.custom_emoji_id}}:{}),
    ...(entity.type==='date_time'?{date:entity.unix_time,dayOfWeek:entity.date_time_format.includes('w'),longDate:entity.date_time_format.includes('D'),
      shortDate:entity.date_time_format.includes('d'),longTime:entity.date_time_format.includes('T'),shortTime:entity.date_time_format.includes('t'),relative:entity.date_time_format==='r'}:{})}));
}
async function readySourceCaptionEdit({custom=false,desiredCaption='Updated caption https://365freebonus.com/'}={}) {
  const value=delivery(701,{custom}),oldCaption=value.caption,oldEntities=value.entities;
  const input=await readyAccountEdit(value);
  value.message.entities=wireEntities(oldEntities);
  const outbox=db().prepare('SELECT id,source_message_id FROM telegram_relay_outbox').get();
  const lease='fixture-source-edit',until=Date.now()+60000;
  const desiredEntities=[{type:'url',offset:desiredCaption.indexOf('https://'),length:'https://365freebonus.com/'.length}];
  if(custom)desiredEntities.unshift({type:'custom_emoji',offset:0,length:1,custom_emoji_id:'-9007199254740993123'});
  db().prepare("UPDATE telegram_relay_outbox SET origin='account',account_generation=?,source_version=1,lease_id=?,lease_until=?,queued_at=?").run(stored().generation,lease,until,Date.now());
  db().prepare('UPDATE telegram_relay_state SET send_lease_id=?,send_lease_until=?').run(lease,until);
  db().prepare(`INSERT INTO telegram_personal_source_posts(source_chat_id,source_message_id,account_generation,relay_revision,
    selected_at,source_date,media_id_hash) VALUES(?,?,?,'relay-generation',?,?,?)`).run(source,outbox.source_message_id,stored().generation,
      db().prepare('SELECT selected_at FROM telegram_personal_sources WHERE chat_id=?').get(source).selected_at,Math.floor(Date.now()/1000),'media');
  const edit=db().prepare(`INSERT INTO telegram_relay_source_edits(outbox_id,source_version,status,caption,caption_entities,
    baseline_caption,baseline_entities,attempted_at,outcome,lease_id,lease_until,created_at)
    VALUES(?,1,'attempting',?,?,?,?,?,'account_attempting',?,?,?)`).run(outbox.id,desiredCaption,JSON.stringify(desiredEntities),
      oldCaption,JSON.stringify(oldEntities),Date.now(),lease,until,Date.now());
  return {...input,caption:desiredCaption,captionEntities:desiredEntities,sourceEdit:{id:Number(edit.lastInsertRowid),version:1,leaseId:lease,
    expectedCaption:oldCaption,expectedCaptionEntities:oldEntities}};
}

test('a separately leased source caption version edits ordinary text without requiring Premium and reads back exact formatting',async()=>{
  const input=await readySourceCaptionEdit();telegram.state.me.premium=false;
  const result=await account.editVerifiedRelayCaptionWithAccount(input);
  assert.deepEqual(result,{state:'ok',attempted:true,outcome:'preserved'});
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,1);
  assert.equal(telegram.state.messages[0].message,input.caption);
});

for(const change of ['wrong-version','wrong-lease','wrong-baseline','changed-target-style','source-watch-removed','custom-without-premium','edited-snapshot'])
test('source caption version refuses unsafe change '+change,async()=>{
  const input=await readySourceCaptionEdit({custom:change==='custom-without-premium',desiredCaption:'⭐ Updated https://365freebonus.com/'});
  if(change==='wrong-version')db().prepare('UPDATE telegram_relay_outbox SET source_version=2').run();
  if(change==='wrong-lease')input.sourceEdit.leaseId='other';
  if(change==='wrong-baseline')input.sourceEdit.expectedCaption='Other';
  if(change==='changed-target-style')telegram.state.messages[0].entities.push(new Api.MessageEntityBold({offset:2,length:5}));
  if(change==='source-watch-removed')db().prepare('DELETE FROM telegram_personal_source_posts').run();
  if(change==='custom-without-premium')telegram.state.me.premium=false;
  if(change==='edited-snapshot')telegram.state.onGetMessages=()=>db().prepare("UPDATE telegram_relay_source_edits SET caption='changed' ").run();
  const result=await account.editVerifiedRelayCaptionWithAccount(input);
  assert.equal(result.attempted,false);assert.notEqual(result.outcome,'preserved');
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,0);
});

test('source edit already exactly at the desired caption does not submit another edit',async()=>{
  const input=await readySourceCaptionEdit();
  telegram.state.messages[0].message=input.caption;telegram.state.messages[0].entities=wireEntities(input.captionEntities);
  assert.deepEqual(await account.editVerifiedRelayCaptionWithAccount(input),{state:'ok',attempted:false,outcome:'preserved'});
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,0);
});

test('pausing observation during source-edit preflight prevents a new edit RPC',async()=>{
  const input=await readySourceCaptionEdit();
  telegram.state.onGetMessages=()=>db().exec('UPDATE telegram_promotion_settings SET relay_caption_watch_enabled=0');
  const result=await account.editVerifiedRelayCaptionWithAccount(input);
  assert.equal(result.attempted,false);
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,0);
});

test('pausing observation after source edit submission still permits readback without another RPC',async()=>{
  const input=await readySourceCaptionEdit();
  telegram.state.onEdit=()=>db().exec('UPDATE telegram_promotion_settings SET relay_caption_watch_enabled=0');
  const result=await account.editVerifiedRelayCaptionWithAccount(input);
  assert.equal(result.outcome,'preserved');assert.equal(result.attempted,true);
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,1);
});

test('source version superseded during an actual edit still reads back its immutable submitted caption without retrying',async()=>{
  const input=await readySourceCaptionEdit();
  telegram.state.onEdit=()=>db().prepare('UPDATE telegram_relay_outbox SET source_version=2').run();
  assert.deepEqual(await account.editVerifiedRelayCaptionWithAccount(input),{state:'ok',attempted:true,outcome:'preserved'});
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,1);
});

test('source caption readback with missing styles fails verification and never repeats the submitted edit',async()=>{
  const input=await readySourceCaptionEdit();input.captionEntities.push({type:'bold',offset:0,length:7});
  db().prepare('UPDATE telegram_relay_source_edits SET caption_entities=?').run(JSON.stringify(input.captionEntities));
  telegram.state.onGetMessages=()=>{if(telegram.state.calls.some(call=>call.method==='EditMessage'))telegram.state.messages[0].entities=wireEntities(input.captionEntities.filter(entity=>entity.type!=='bold'));};
  const result=await account.editVerifiedRelayCaptionWithAccount(input);
  assert.equal(result.attempted,true);assert.equal(result.outcome,'changed');
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,1);
});

test('account receive yields its lease only to due current sent source-caption jobs',async()=>{
  await login();await select();ready();
  const message=photo();knownSourcePost(message);
  const outbox=db().prepare('SELECT id FROM telegram_relay_outbox').get();
  db().prepare('UPDATE telegram_relay_outbox SET source_version=1').run();
  db().prepare(`INSERT INTO telegram_relay_source_edits(outbox_id,source_version,caption,caption_entities,baseline_caption,baseline_entities,created_at)
    VALUES(?,1,'new','[]','old','[]',?)`).run(outbox.id,Date.now());
  const before=telegram.state.calls.length;await account.pollTelegramAccountOnce();assert.equal(telegram.state.calls.length,before);
  db().prepare("UPDATE telegram_relay_outbox SET status='unknown'").run();
  await account.pollTelegramAccountOnce();assert.ok(telegram.state.calls.length>before);
});

for(const kind of ['known-delivery-loss','known-bot-rejection','unrecorded-loss','foreign-custom','changed-style'])
test('source caption baseline only allows documented stripped custom emoji '+kind,async()=>{
  const input=await readySourceCaptionEdit({custom:true,desiredCaption:'⭐ Updated https://365freebonus.com/'});
  telegram.state.messages[0].entities=wireEntities(input.sourceEdit.expectedCaptionEntities.filter(entity=>entity.type!=='custom_emoji'));
  if(kind==='known-delivery-loss')db().prepare('UPDATE telegram_relay_outbox SET last_error=?').run('Telegram 未保留部分原始自定义 Emoji，请检查机器人的自定义 Emoji 使用权限。该消息不会自动重发。');
  else if(kind!=='unrecorded-loss')db().prepare('UPDATE telegram_relay_outbox SET caption_edit_attempted_at=?,last_error=?').run(Date.now(),'Telegram 拒绝补正文案或按钮，请检查机器人权限及原消息格式；不会重复发送媒体。');
  if(kind==='foreign-custom')telegram.state.messages[0].entities.push(new Api.MessageEntityCustomEmoji({offset:0,length:1,documentId:{toString:()=>'-777777777777777777'}}));
  if(kind==='changed-style')telegram.state.messages[0].entities.push(new Api.MessageEntityBold({offset:2,length:5}));
  const result=await account.editVerifiedRelayCaptionWithAccount(input);
  assert.equal(result.attempted,kind==='known-delivery-loss'||kind==='known-bot-rejection');
  assert.equal(result.outcome,kind==='known-delivery-loss'||kind==='known-bot-rejection'?'preserved':'invalid');
});

test('watch pruning caps the combined selected-source backlog at 4096 posts',async()=>{
  await login();await select();ready();
  const original=db().prepare('SELECT * FROM telegram_personal_sources WHERE chat_id=?').get(source),generation=stored().generation;
  const insertSource=db().prepare(`INSERT INTO telegram_personal_sources(chat_id,title,peer_ciphertext,selected,joined,selected_at,last_message_id)
    VALUES(?,'fixture',?,1,1,?,40)`);
  const insert=db().prepare(`INSERT INTO telegram_personal_source_posts(source_chat_id,source_message_id,account_generation,
    relay_revision,selected_at,source_date,media_id_hash,checked_at) VALUES(?,?,?,'relay-generation',?,?,?,?)`);
  for(let channelIndex=0;channelIndex<9;channelIndex++) {
    const chat=source-channelIndex;if(channelIndex)insertSource.run(chat,original.peer_ciphertext,original.selected_at);
    for(let id=1;id<=512;id++)insert.run(chat,id,generation,original.selected_at,Math.floor(Date.now()/1000),'hash',Date.now());
  }
  db().prepare('UPDATE telegram_personal_account SET poll_source_id=?').run(source-1);
  await account.pollTelegramAccountOnce();
  assert.equal(db().prepare('SELECT COUNT(*) AS n FROM telegram_personal_source_posts').get().n,4096);
  assert.equal(db().prepare('SELECT MAX(n) AS n FROM(SELECT COUNT(*) AS n FROM telegram_personal_source_posts GROUP BY source_chat_id)').get().n,512);
});

test('deselection deletes watched posts so reselecting never revisits the old selection',async()=>{
  await login();await select();ready();telegram.state.messages=[photo(41,{message:''})];
  await account.pollTelegramAccountOnce();assert.equal(db().prepare('SELECT COUNT(*) AS n FROM telegram_personal_source_posts').get().n,1);
  await select([]);await select();assert.equal(db().prepare('SELECT COUNT(*) AS n FROM telegram_personal_source_posts').get().n,0);
});

async function readyKnownSourceBootstrap() {
  await login();await select();ready();
  const message=photo(41,{message:'Original caption'});knownSourcePost(message);
  db().prepare('UPDATE telegram_relay_outbox SET file_unique_id=?').run(createHash('sha256').update('photo-media-41').digest('hex'));
  db().prepare('UPDATE telegram_personal_sources SET last_message_id=41 WHERE chat_id=?').run(source);
  telegram.state.messages=[message];return message;
}

test('upgrade bootstraps only known sent source IDs and captures edited captions without downloading old media',async()=>{
  const message=await readyKnownSourceBootstrap();message.message='New edited caption';
  await account.pollTelegramAccountOnce();
  assert.equal(telegram.state.observations.length,1);assert.equal(telegram.state.observations[0].caption,message.message);
  assert.equal(telegram.state.queue.length,0);assert.equal(telegram.state.calls.filter(call=>call.method==='download').length,0);
  assert.equal(db().prepare('SELECT source_date FROM telegram_personal_source_posts').get().source_date,message.date);
  assert.deepEqual(telegram.state.calls.find(call=>call.method==='getMessages').params.ids,[41]);
  closeDb();message.message='Edit after restart';dueSourceWatch();await account.pollTelegramAccountOnce();
  assert.equal(telegram.state.observations.length,2);assert.equal(db().prepare('SELECT COUNT(*) AS n FROM telegram_personal_source_scopes').get().n,1);
});

for(const change of ['preselection','wrong-media','protected','wrong-generation','unknown-send','future-date'])
test('known-ID bootstrap excludes unsafe source '+change+' and never rearms an invalidated watch after restart',async()=>{
  const message=await readyKnownSourceBootstrap();
  if(change==='preselection')message.date-=60;
  if(change==='wrong-media')message.media=new Api.MessageMediaPhoto({photo:new Api.Photo({id:'different'})});
  if(change==='protected')message.noforwards=true;
  if(change==='wrong-generation')db().prepare("UPDATE telegram_relay_outbox SET account_generation='old'").run();
  if(change==='unknown-send')db().prepare("UPDATE telegram_relay_outbox SET status='unknown'").run();
  if(change==='future-date')message.date+=60;
  await account.pollTelegramAccountOnce();
  assert.equal(db().prepare('SELECT COUNT(*) AS n FROM telegram_personal_source_posts').get().n,0);
  assert.equal(telegram.state.observations.length,0);assert.equal(telegram.state.queue.length,0);
  const reads=telegram.state.calls.filter(call=>call.method==='getMessages').length;
  closeDb();message.noforwards=false;await account.pollTelegramAccountOnce();
  assert.equal(telegram.state.calls.filter(call=>call.method==='getMessages').length,reads);
  assert.equal(telegram.state.observations.length,0);assert.equal(telegram.state.queue.length,0);
});

for(const scenario of [
  {name:'previously busy retry within lease window',waits:1,delay:30000,blocked:true},
  {name:'previously busy retry exactly at lease boundary',waits:1,delay:60000,blocked:true},
  {name:'retry beyond the next lease window',waits:1,delay:60001,blocked:false},
  {name:'initial future version without a busy wait',waits:0,delay:30000,blocked:false},
  {name:'unknown media send',waits:1,delay:30000,status:'unknown',blocked:false},
  {name:'superseded source version',waits:1,delay:30000,version:2,blocked:false},
  {name:'old relay configuration',waits:1,delay:30000,revision:'old-relay',blocked:false},
])test('account lease reservation respects '+scenario.name,async t=>{
  await login();await select();ready();knownSourcePost(photo());
  const outbox=db().prepare('SELECT id FROM telegram_relay_outbox').get(),now=Date.now();
  db().prepare('UPDATE telegram_relay_outbox SET source_version=?,status=?,revision=?').run(scenario.version||1,scenario.status||'sent',scenario.revision||'relay-generation');
  db().prepare(`INSERT INTO telegram_relay_source_edits(outbox_id,source_version,caption,caption_entities,baseline_caption,baseline_entities,
    next_attempt_at,preflight_waits,created_at) VALUES(?,1,'new','[]','old','[]',?,?,?)`).run(outbox.id,now+scenario.delay,scenario.waits,now);
  t.mock.method(Date,'now',()=>now);
  const before=telegram.state.calls.length,job=db().prepare('SELECT * FROM telegram_relay_source_edits').get(),accountBefore=stored();
  await account.pollTelegramAccountOnce();
  assert.equal(telegram.state.calls.length===before,scenario.blocked);
  assert.deepEqual(db().prepare('SELECT * FROM telegram_relay_source_edits').get(),job);
  if(scenario.blocked)assert.deepEqual(stored(),accountBefore);
});

test('initial Emoji restoration repairs a missing bold style with one verified edit',async()=>{
  const value=delivery();value.entities.push({type:'bold',offset:2,length:5});
  const input=await readyAccountEdit(value);
  assert.deepEqual(await account.editVerifiedRelayCaptionWithAccount(input),{state:'ok',attempted:true,outcome:'preserved'});
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,1);
  assert.ok(telegram.state.messages[0].entities.some(entity=>entity instanceof Api.MessageEntityBold));
});

test('initial restoration refuses custom metadata belonging to another Emoji even when caption text is unchanged',async()=>{
  const input=await readyAccountEdit();
  telegram.state.messages[0].entities.push(new Api.MessageEntityCustomEmoji({offset:0,length:1,documentId:{toString:()=>'-777777777777777777'}}));
  assert.deepEqual(await account.editVerifiedRelayCaptionWithAccount(input),{state:'ok',attempted:false,outcome:'invalid',reason:'stored_entities_mismatch'});
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,0);
});

test('a source revision still refuses the same missing bold style in its immutable baseline',async()=>{
  const input=await readySourceCaptionEdit();
  input.sourceEdit.expectedCaptionEntities.push({type:'bold',offset:2,length:5});
  const baseline=JSON.stringify(input.sourceEdit.expectedCaptionEntities);
  db().prepare('UPDATE telegram_relay_outbox SET caption_entities=?').run(baseline);
  db().prepare('UPDATE telegram_relay_source_edits SET baseline_entities=?').run(baseline);
  assert.deepEqual(await account.editVerifiedRelayCaptionWithAccount(input),{state:'ok',attempted:false,outcome:'invalid',reason:'stored_entities_mismatch'});
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,0);
});

test('initial Emoji restoration does not report success when readback still loses expected styles',async()=>{
  const value=delivery();value.entities.push({type:'bold',offset:2,length:5});
  const input=await readyAccountEdit(value);
  telegram.state.onGetMessages=()=>{if(telegram.state.calls.some(call=>call.method==='EditMessage'))telegram.state.messages[0].entities=
    telegram.state.messages[0].entities.filter(entity=>!(entity instanceof Api.MessageEntityBold));};
  assert.deepEqual(await account.editVerifiedRelayCaptionWithAccount(input),{state:'ok',attempted:true,outcome:'changed'});
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,1);
});

test('initial Emoji restoration accepts Telegram merging adjacent equal-style spans in the verified readback',async()=>{
  const value=delivery();value.entities.push({type:'bold',offset:2,length:2},{type:'bold',offset:4,length:3});
  const input=await readyAccountEdit(value);
  telegram.state.onGetMessages=()=>{if(telegram.state.calls.some(call=>call.method==='EditMessage'))telegram.state.messages[0].entities=[
    ...telegram.state.messages[0].entities.filter(entity=>!(entity instanceof Api.MessageEntityBold)),new Api.MessageEntityBold({offset:2,length:5})];};
  assert.deepEqual(await account.editVerifiedRelayCaptionWithAccount(input),{state:'ok',attempted:true,outcome:'preserved'});
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,1);
});

for(const scenario of [
  {name:'initial busy retry within the next lease',outcome:'account_waiting_1',delay:30000,blocked:true},
  {name:'initial busy retry exactly at the lease boundary',outcome:'account_waiting_3',delay:60000,blocked:true},
  {name:'initial retry outside the lease boundary',outcome:'account_waiting_1',delay:60001,blocked:false},
  {name:'readonly recheck busy retry before its due time',outcome:'account_recheck_waiting_1',rechecks:1,delay:30000,blocked:true},
  {name:'future initial work that has not waited',outcome:'changed',delay:30000,blocked:false},
  {name:'invalidated source content',outcome:'account_invalid',hash:'invalid:source',blocked:false},
  {name:'obsolete repair with a source revision row',outcome:'account_invalid',sourceEdit:true,blocked:false},
  {name:'metadata recovery not yet used',outcome:'account_invalid_final',rechecks:1,recoveries:0,blocked:true},
  {name:'metadata recovery already used',outcome:'account_invalid_final',rechecks:1,recoveries:1,blocked:false},
])test('initial repair account reservation respects '+scenario.name,async t=>{
  await readyAccountEdit();const now=Date.now(),id=db().prepare('SELECT id FROM telegram_relay_outbox').get().id;
  db().prepare(`UPDATE telegram_relay_outbox SET caption_edit_attempted_at=${now},caption_edit_outcome=?,next_attempt_at=?,caption_edit_recheck_count=?,
    caption_metadata_recovery_count=?,source_content_hash=?,lease_id='',lease_until=0,last_error=?`).run(scenario.outcome,now+(scenario.delay||0),
      scenario.rechecks||0,scenario.recoveries||0,scenario.hash||'',
      'Telegram 未保留部分原始自定义 Emoji，请检查机器人的自定义 Emoji 使用权限。该消息不会自动重发。');
  db().prepare("UPDATE telegram_relay_state SET send_lease_id='',send_lease_until=0").run();
  if(scenario.sourceEdit)db().prepare(`INSERT INTO telegram_relay_source_edits(outbox_id,source_version,status,outcome,caption,caption_entities,
    baseline_caption,baseline_entities,created_at) VALUES(?,1,'failed','account_invalid','new','[]','old','[]',?)`).run(id,now);
  t.mock.method(Date,'now',()=>now);
  const before=telegram.state.calls.length,job=db().prepare('SELECT * FROM telegram_relay_outbox').get();
  await account.pollTelegramAccountOnce();
  assert.equal(telegram.state.calls.length===before,scenario.blocked);
  assert.deepEqual(db().prepare('SELECT * FROM telegram_relay_outbox').get(),job);
});

test('a source revision accepts an equivalent server-merged baseline style before applying one new caption version',async()=>{
  const input=await readySourceCaptionEdit();
  input.sourceEdit.expectedCaptionEntities.push({type:'bold',offset:2,length:2},{type:'bold',offset:4,length:3});
  const baseline=JSON.stringify(input.sourceEdit.expectedCaptionEntities);
  db().prepare('UPDATE telegram_relay_outbox SET caption_entities=?').run(baseline);
  db().prepare('UPDATE telegram_relay_source_edits SET baseline_entities=?').run(baseline);
  telegram.state.messages[0].entities.push(new Api.MessageEntityBold({offset:2,length:5}));
  assert.deepEqual(await account.editVerifiedRelayCaptionWithAccount(input),{state:'ok',attempted:true,outcome:'preserved'});
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,1);
});

for(const change of ['added-hidden-link','removed-hidden-link'])
test('a source revision refuses an actual baseline with '+change+' even when every URL points to the owner website',async()=>{
  const input=await readySourceCaptionEdit();
  if(change==='added-hidden-link')telegram.state.messages[0].entities.push(new Api.MessageEntityTextUrl({offset:2,length:5,url:'https://365freebonus.com/'}));
  else {
    input.sourceEdit.expectedCaptionEntities.push({type:'text_link',offset:2,length:5,url:'https://365freebonus.com/'});
    const baseline=JSON.stringify(input.sourceEdit.expectedCaptionEntities);
    db().prepare('UPDATE telegram_relay_outbox SET caption_entities=?').run(baseline);
    db().prepare('UPDATE telegram_relay_source_edits SET baseline_entities=?').run(baseline);
  }
  assert.deepEqual(await account.editVerifiedRelayCaptionWithAccount(input),{state:'ok',attempted:false,outcome:'invalid',reason:'stored_entities_mismatch'});
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,0);
});

test('readonly caption metadata audit includes the current final preflight row without rearming it',async()=>{
  const value=delivery();value.entities.push({type:'bold',offset:2,length:5});
  await readyBlockedCaption(value);
  db().prepare("UPDATE telegram_relay_outbox SET caption_edit_outcome='account_invalid_final',caption_edit_recheck_count=1").run();
  const before=db().prepare('SELECT * FROM telegram_relay_outbox').get();
  const result=await account.inspectBlockedRelayCaptionPreflights();
  assert.equal(result.posts.length,1);const post=result.posts[0];
  assert.equal(post.snapshotOutcome,'account_invalid_final');assert.equal(post.reason,'ready_to_edit');
  assert.equal(post.actualCustomSubset,true);assert.equal(post.semanticFormattingMatches,false);
  assert.deepEqual(post.entityCoverage.find(coverage=>coverage.type==='bold'),{type:'bold',expectedCount:1,actualCount:0,expectedCoveredUtf16:5,actualCoveredUtf16:0});
  assert.deepEqual(db().prepare('SELECT * FROM telegram_relay_outbox').get(),before);
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,0);
});

function hotSource(revision='hot-source-revision'){
 db().exec(`CREATE TABLE IF NOT EXISTS telegram_hot_video_sources(chat_id INTEGER PRIMARY KEY,title TEXT NOT NULL DEFAULT '',username TEXT NOT NULL DEFAULT '',selected INTEGER NOT NULL DEFAULT 1,revision TEXT NOT NULL,backfill_before_id INTEGER NOT NULL DEFAULT 0,last_message_id INTEGER NOT NULL DEFAULT 0,backfill_done INTEGER NOT NULL DEFAULT 0,last_synced_at INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '',next_attempt_at INTEGER NOT NULL DEFAULT 0)`);
 db().prepare("INSERT INTO telegram_hot_video_sources(chat_id,title,selected,revision) VALUES(?,'Hot library source',1,?)").run(source,revision);
 return {chatId:source,revision,beforeId:0,afterId:0,backfillDone:false,limit:2};
}
function hotSourceVideo(id,extra={}){const message=video(id,{caption:'',size:1702*1024*1024,...extra});message.media.document.id={toString:()=>String(700000+id)};return message;}
test('Hot history imports captionless large-video metadata without downloading or changing relay source selection/cursor',async()=>{
 await login();const input=hotSource();const before=db().prepare('SELECT selected,last_message_id FROM telegram_personal_sources WHERE chat_id=?').get(source);
 telegram.state.messages=[hotSourceVideo(11),hotSourceVideo(12)];telegram.state.calls=[];
 const result=await account.readHotVideoSourcePages(db(),input);
 assert.equal(result.state,'ok');assert.deepEqual(result.videos.map(v=>[v.sourceMessageId,v.documentId,v.bytes]),[[12,'700012',1702*1024*1024],[11,'700011',1702*1024*1024]]);
 assert.equal(result.lastMessageId,12);assert.equal(result.backfillBeforeId,11);assert.equal(result.backfillDone,false);
 assert.deepEqual(db().prepare('SELECT selected,last_message_id FROM telegram_personal_sources WHERE chat_id=?').get(source),before);
 assert.equal(telegram.state.calls.some(c=>['download','EditMessage','sendMessage','sendVideo'].includes(c.method)),false);
 assert.equal(JSON.stringify(result).includes('Caption'),false);assert.equal(JSON.stringify(result).includes('secret-access-hash'),false);assert.equal(JSON.stringify(result).includes('fixture-session'),false);assert.equal(stored().lease_id,'');
});
test('Hot history uses independent ascending fresh and descending backwards cursors until history is exhausted',async()=>{
 await login();const input=hotSource();telegram.state.messages=[hotSourceVideo(40),hotSourceVideo(41),hotSourceVideo(42)];
 const first=await account.readHotVideoSourcePages(db(),input);assert.equal(first.lastMessageId,42);assert.equal(first.backfillBeforeId,41);
 telegram.state.messages=[photo(39),hotSourceVideo(40),hotSourceVideo(43),hotSourceVideo(44)];telegram.state.calls=[];
 const next=await account.readHotVideoSourcePages(db(),{...input,beforeId:first.backfillBeforeId,afterId:first.lastMessageId});
 assert.equal(next.state,'ok');assert.equal(next.lastMessageId,44);assert.equal(next.backfillBeforeId,39);assert.equal(next.backfillDone,false);assert.deepEqual(next.videos.map(v=>v.sourceMessageId),[43,44,40]);
 assert.deepEqual(telegram.state.calls.filter(c=>c.method==='history').map(c=>c.params),[{limit:2,minId:42,reverse:true},{limit:2,maxId:41}]);
 telegram.state.messages=[];const last=await account.readHotVideoSourcePages(db(),{...input,beforeId:39,afterId:44});assert.equal(last.backfillDone,true);assert.equal(last.lastMessageId,44);
});
test('Hot history skips GIF, round video, text, photo and individually protected posts while advancing the source cursors',async()=>{
 await login();const input=hotSource();telegram.state.messages=[hotSourceVideo(10),hotSourceVideo(11,{roundMessage:true}),hotSourceVideo(12,{animated:true}),photo(13),hotSourceVideo(14,{noforwards:true}),new Api.Message({id:15,date:Math.floor(Date.now()/1000),peerId:new Api.PeerChannel({channelId:'1001'}),message:'marker text'})];
 const r=await account.readHotVideoSourcePages(db(),{...input,limit:50});assert.equal(r.state,'ok');assert.deepEqual(r.videos.map(v=>v.sourceMessageId),[10]);assert.equal(r.lastMessageId,15);assert.equal(r.backfillBeforeId,10);assert.equal(r.backfillDone,true);
});
test('Hot history refuses a protected source before any history/media request',async()=>{
 await login();const input=hotSource();telegram.state.dialogs=[channel(1001,{protectedChannel:true})];telegram.state.calls=[];
 const r=await account.readHotVideoSourcePages(db(),input);assert.equal(r.state,'protected');assert.deepEqual(r.videos,[]);assert.equal(telegram.state.calls.some(c=>c.method==='history'||c.method==='download'),false);
});
test('Hot source deselection during recipient lookup discards the snapshot and never requests history',async()=>{
 await login();const input=hotSource();telegram.state.onEntity=()=>db().prepare('UPDATE telegram_hot_video_sources SET selected=0').run();telegram.state.calls=[];
 const r=await account.readHotVideoSourcePages(db(),input);assert.equal(r.state,'changed');assert.deepEqual(r.videos,[]);assert.equal(telegram.state.calls.some(c=>c.method==='history'),false);assert.equal(stored().lease_id,'');
});
test('Hot history respects the existing personal-account lease and connection backoff',async()=>{
 await login();const input=hotSource();db().prepare("UPDATE telegram_personal_account SET lease_id='other-work',lease_until=?").run(Date.now()+60000);telegram.state.calls=[];
 let r=await account.readHotVideoSourcePages(db(),input);assert.equal(r.state,'busy');assert.equal(stored().lease_id,'other-work');assert.equal(telegram.state.calls.length,0);
 db().prepare("UPDATE telegram_personal_account SET lease_id='',lease_until=0,next_attempt_at=?").run(Date.now()+90000);r=await account.readHotVideoSourcePages(db(),input);assert.equal(r.state,'backoff');assert.ok(r.retryAfterMs>80000);assert.equal(telegram.state.calls.length,0);
});

test('Hot history accepts only regular non-ephemeral MP4 videos and skips other video containers',async()=>{
 await login();const input=hotSource();const ephemeral=hotSourceVideo(14);ephemeral.media.ttlSeconds=30;
 telegram.state.messages=[hotSourceVideo(10),hotSourceVideo(11,{mimeType:'video/webm'}),hotSourceVideo(12,{mimeType:'video/x-matroska'}),hotSourceVideo(13,{mimeType:'video/quicktime'}),ephemeral];
 const r=await account.readHotVideoSourcePages(db(),{...input,limit:50});assert.equal(r.state,'ok');assert.deepEqual(r.videos.map(v=>v.sourceMessageId),[10]);assert.equal(r.lastMessageId,14);assert.equal(r.backfillBeforeId,10);assert.equal(r.backfillDone,true);
});
test('Hot history reports changed when the saved personal account no longer has a joined source peer',async()=>{
 await login();const input=hotSource();db().prepare('UPDATE telegram_personal_sources SET joined=0 WHERE chat_id=?').run(source);telegram.state.calls=[];
 const r=await account.readHotVideoSourcePages(db(),input);assert.equal(r.state,'changed');assert.deepEqual(r.videos,[]);assert.equal(telegram.state.calls.length,0);
});

async function readyCaptionObservation({custom=true}={}) {
  const input=await readyAccountEdit(delivery(701,{custom}));
  const lease='fixture-watch-lease',until=Date.now()+60000;
  db().prepare(`UPDATE telegram_relay_outbox SET caption_edit_outcome='account_invalid_final',
    caption_watch_outcome='checking',caption_watch_source_version=source_version,lease_id=?,lease_until=?`).run(lease,until);
  db().prepare('UPDATE telegram_relay_state SET send_lease_id=?,send_lease_until=?').run(lease,until);
  return {...input,watch:{leaseId:lease,sourceVersion:0,allowRepair:true}};
}

function attachCaptionWindow(input, remainingMs = 1000) {
  const reference=db().prepare('SELECT id,source_version FROM telegram_relay_outbox WHERE message_id=?').get(input.messageId);
  db().exec('UPDATE telegram_promotion_settings SET relay_caption_serial_enabled=1');
  assert.equal(cycle.registerCaptionWatchWindow(db(),reference.id,Date.now()-20*60000+remainingMs),true);
  const focus=cycle.captionWatchFocus(db(),Date.now());
  assert.equal(focus.outboxId,reference.id);
  input.window={outboxId:reference.id,sourceVersion:reference.source_version,startedAt:focus.currentStartedAt};
  return focus;
}

for(const mode of ['edit','watch'])test('caption '+mode+' stops if its observation window expires during preflight',async t=>{
  let at=Date.now();t.mock.method(Date,'now',()=>at);
  const input=mode==='watch'?await readyCaptionObservation():await readyAccountEdit();
  const focus=attachCaptionWindow(input);
  telegram.state.onEntity=()=>{at=focus.windowEndsAt;};
  const result=await account[mode==='watch'?'observeVerifiedRelayCaptionWithAccount':'editVerifiedRelayCaptionWithAccount'](input);
  assert.deepEqual(result,{state:'unavailable',attempted:false,outcome:'unavailable'});
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,0);
  assert.equal(stored().lease_until,0);
});

for(const mode of ['edit','watch'])test('caption '+mode+' completes readback after an accepted edit crosses its window expiry',async t=>{
  let at=Date.now();t.mock.method(Date,'now',()=>at);
  const input=mode==='watch'?await readyCaptionObservation():await readyAccountEdit();
  const focus=attachCaptionWindow(input);
  telegram.state.onEdit=()=>{at=focus.windowEndsAt+1;};
  const result=await account[mode==='watch'?'observeVerifiedRelayCaptionWithAccount':'editVerifiedRelayCaptionWithAccount'](input);
  assert.deepEqual(result,{state:'ok',attempted:true,outcome:'preserved'});
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,1);
  assert.ok(telegram.state.calls.filter(call=>call.method==='getMessages').length>=2);
  if(mode==='watch')assert.ok(db().prepare('SELECT caption_watch_edit_attempted_at AS at FROM telegram_relay_outbox').get().at>0);
  assert.equal(stored().lease_until,0);
});

test('caption window identity cannot authorize an unrelated target reference',async()=>{
  const input=await readyCaptionObservation();attachCaptionWindow(input);
  input.window.outboxId++;
  const before=telegram.state.calls.length;
  assert.deepEqual(await account.observeVerifiedRelayCaptionWithAccount(input),{state:'unavailable',attempted:false,outcome:'unavailable'});
  assert.equal(telegram.state.calls.length,before);
});

test('recurring observation repairs original custom artwork and leaves one-shot terminals intact',async()=>{
  const input=await readyCaptionObservation();
  const result=await account.observeVerifiedRelayCaptionWithAccount(input);
  assert.deepEqual(result,{state:'ok',attempted:true,outcome:'preserved'});
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,1);
  const row=db().prepare('SELECT * FROM telegram_relay_outbox').get();
  assert.equal(row.caption_edit_outcome,'account_invalid_final');assert.ok(row.caption_watch_edit_attempted_at>0);
  assert.match(row.caption_watch_media_id,/Photo:/);
});

test('recurring ordinary caption repair does not require Premium and uses the pinned media identity',async()=>{
  const input=await readyCaptionObservation({custom:false});telegram.state.me.premium=false;
  db().prepare("UPDATE telegram_relay_outbox SET caption_watch_media_id='Photo:555555555555555555'").run();
  telegram.state.messages[0].message='Changed locally';telegram.state.messages[0].entities=[];
  assert.deepEqual(await account.observeVerifiedRelayCaptionWithAccount(input),{state:'ok',attempted:true,outcome:'preserved'});
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,1);
});

test('recurring observation reads exact custom artwork without requiring Premium or a second edit',async()=>{
  const input=await readyCaptionObservation();telegram.state.me.premium=false;
  telegram.state.messages[0].entities=wireEntities(input.captionEntities);
  db().prepare('UPDATE telegram_relay_outbox SET caption_watch_edit_attempted_at=?').run(Date.now()-5000);
  assert.deepEqual(await account.observeVerifiedRelayCaptionWithAccount(input),{state:'ok',attempted:false,outcome:'preserved'});
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,0);
});

for(const reason of ['uncertain','readonly','version','source-disabled','media-replaced','missing-source'])
test('recurring observation refuses unsafe mutation '+reason,async()=>{
  const input=await readyCaptionObservation();
  if(reason==='uncertain')db().prepare('UPDATE telegram_relay_outbox SET caption_watch_edit_attempted_at=1').run();
  if(reason==='readonly')input.watch.allowRepair=false;
  if(reason==='version')db().prepare('UPDATE telegram_relay_outbox SET source_version=1').run();
  if(reason==='source-disabled')db().prepare('UPDATE telegram_promotion_settings SET relay_caption_watch_enabled=0').run();
  if(reason==='media-replaced')db().prepare("UPDATE telegram_relay_outbox SET caption_watch_media_id='Photo:other'").run();
  if(reason==='missing-source')db().prepare("UPDATE telegram_relay_outbox SET origin='account',account_generation=?").run(stored().generation);
  const result=await account.observeVerifiedRelayCaptionWithAccount(input);
  assert.equal(result.attempted,false);assert.notEqual(result.outcome,'preserved');
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,0);
});

test('recurring observation commits a durable marker before its only RPC and never retries a timed-out edit',async()=>{
  const input=await readyCaptionObservation();
  telegram.state.onEdit=()=>{assert.ok(db().prepare('SELECT caption_watch_edit_attempted_at AS at FROM telegram_relay_outbox').get().at>0);throw Object.assign(new Error(),{errorMessage:'TIMEOUT'});};
  const first=await account.observeVerifiedRelayCaptionWithAccount(input);assert.equal(first.attempted,true);
  const second=await account.observeVerifiedRelayCaptionWithAccount(input);assert.equal(second.attempted,false);
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,1);
});

test('a definite Telegram flood rejection reports its recovery deadline separately from unknown edits',async()=>{
  const input=await readyCaptionObservation();
  telegram.state.onEdit=()=>{throw Object.assign(new Error(),{code:420,errorMessage:'FLOOD_WAIT',seconds:90});};
  const result=await account.observeVerifiedRelayCaptionWithAccount(input);
  assert.equal(result.state,'backoff');assert.equal(result.outcome,'rejected');assert.equal(result.attempted,true);
  assert.ok(result.retryAt>Date.now()+80000);
});

test('disabled source observation keeps old snapshot hashes until reenabled and applies configured recheck interval',async()=>{
  await login();await select();ready();const message=photo(41,{message:''});telegram.state.messages=[message];
  await account.pollTelegramAccountOnce();const before=db().prepare('SELECT revision_hash FROM telegram_personal_source_posts').get().revision_hash;
  message.message='Later source caption';dueSourceWatch();db().prepare('UPDATE telegram_promotion_settings SET relay_caption_watch_enabled=0').run();
  await account.pollTelegramAccountOnce();assert.equal(db().prepare('SELECT revision_hash FROM telegram_personal_source_posts').get().revision_hash,before);
  assert.equal(telegram.state.queue.length,0);
  db().prepare('UPDATE telegram_promotion_settings SET relay_caption_watch_enabled=1,relay_caption_watch_interval_seconds=300').run();
  db().prepare('UPDATE telegram_personal_source_posts SET checked_at=?').run(Date.now()-60000);
  await account.pollTelegramAccountOnce();assert.equal(telegram.state.queue.length,0);
  dueSourceWatch();await account.pollTelegramAccountOnce();assert.equal(telegram.state.queue.length,1);
});

test('confirmed forwarded source watches survive the candidate 512-post pruning limit',async()=>{
  await login();await select();ready();const message=photo(1);knownSourcePost(message);
  const sourceRow=db().prepare('SELECT * FROM telegram_personal_sources WHERE chat_id=?').get(source);
  const insert=db().prepare(`INSERT INTO telegram_personal_source_posts(source_chat_id,source_message_id,account_generation,relay_revision,
    selected_at,source_date,media_id_hash,checked_at) VALUES(?,?,?,'relay-generation',?,?,?,?)`);
  for(let id=1;id<=514;id++)insert.run(source,id,stored().generation,sourceRow.selected_at,Math.floor(Date.now()/1000),'hash',Date.now());
  await account.pollTelegramAccountOnce();
  assert.equal(db().prepare('SELECT COUNT(*) AS n FROM telegram_personal_source_posts WHERE source_message_id=1').get().n,1);
  assert.equal(db().prepare('SELECT COUNT(*) AS n FROM telegram_personal_source_posts').get().n,513);
});

async function readyFocusedSourceRefresh() {
  await login();await select();ready();
  const message=photo(41),hash=createHash('sha256').update('photo-'+message.media.photo.id).digest('hex');
  telegram.state.messages=[message];knownSourcePost(message);
  db().prepare("UPDATE telegram_relay_outbox SET file_unique_id=?,source_version=1").run(hash);
  const outbox=db().prepare('SELECT * FROM telegram_relay_outbox').get();
  const selectedAt=db().prepare('SELECT selected_at FROM telegram_personal_sources WHERE chat_id=?').get(source).selected_at;
  db().prepare(`INSERT INTO telegram_personal_source_posts(source_chat_id,source_message_id,account_generation,relay_revision,
    selected_at,source_date,media_id_hash,revision_hash,checked_at) VALUES(?,?,?,'relay-generation',?,?,?,'previous-snapshot',0)`)
    .run(source,message.id,stored().generation,selectedAt,message.date,hash);
  return {message,input:{outboxId:outbox.id,relayRevision:'relay-generation',targetChatId:target}};
}

test('focused source refresh captures the exact latest version without downloading media or advancing a cursor',async()=>{
  const {message,input}=await readyFocusedSourceRefresh();const beforeCursor=cursor();
  message.message='Latest source edit https://example.test';
  telegram.state.onObserve=()=>db().prepare("UPDATE telegram_relay_outbox SET source_version=2,source_content_hash='fresh'").run();
  const result=await account.refreshRelayCaptionSourceWithAccount(input);
  assert.equal(result.state,'ok');assert.equal(result.sourceVersion,2);assert.ok(result.verifiedAt<=Date.now());
  assert.equal(telegram.state.observations.length,1);assert.equal(telegram.state.observations[0].caption,message.message);
  assert.equal(cursor(),beforeCursor);assert.equal(telegram.state.queue.length,0);
  assert.equal(telegram.state.calls.filter(call=>call.method==='download'||call.method==='EditMessage').length,0);
  const read=telegram.state.calls.filter(call=>call.method==='getMessages').at(-1);assert.deepEqual(read.params.ids,[message.id]);
  assert.equal(stored().lease_until,0);assert.ok(telegram.state.calls.some(call=>call.method==='destroy'));
  assert.equal(db().prepare('SELECT source_date FROM telegram_personal_source_posts').get().source_date,message.date);
});

test('focused source refresh does not capture a snapshot after its observation expires',async t=>{
  let at=Date.now();t.mock.method(Date,'now',()=>at);
  const {input}=await readyFocusedSourceRefresh();
  db().exec('UPDATE telegram_promotion_settings SET relay_caption_serial_enabled=1');
  cycle.registerCaptionWatchWindow(db(),input.outboxId,at-20*60000+1000);
  const focus=cycle.captionWatchFocus(db(),at);
  input.window={outboxId:input.outboxId,sourceVersion:focus.sourceVersion,startedAt:focus.currentStartedAt};
  telegram.state.onGetMessages=()=>{at=focus.windowEndsAt;};
  const result=await account.refreshRelayCaptionSourceWithAccount(input);
  assert.equal(result.state,'waiting');assert.equal(result.verifiedAt,undefined);
  assert.equal(telegram.state.observations.length,0);assert.equal(stored().lease_until,0);
});

test('focused source capture returns a new version for its own window when it supersedes the previous version',async t=>{
  const {input}=await readyFocusedSourceRefresh();
  db().exec('UPDATE telegram_promotion_settings SET relay_caption_serial_enabled=1');
  cycle.registerCaptionWatchWindow(db(),input.outboxId,Date.now());
  const focus=cycle.captionWatchFocus(db(),Date.now());
  input.window={outboxId:input.outboxId,sourceVersion:focus.sourceVersion,startedAt:focus.currentStartedAt};
  telegram.state.onObserve=()=>{
    db().prepare("UPDATE telegram_relay_outbox SET source_version=2,source_content_hash='fresh'").run();
    cycle.registerCaptionWatchWindow(db(),input.outboxId,Date.now());
  };
  const result=await account.refreshRelayCaptionSourceWithAccount(input);
  assert.equal(result.state,'ok');assert.equal(result.sourceVersion,2);
  assert.equal(cycle.isCaptionWatchFocusCurrent(db(),focus.outboxId,focus.sourceVersion,focus.currentStartedAt,Date.now()),false);
  assert.equal(cycle.captionWatchFocus(db(),Date.now()).sourceVersion,2);
});

for(const kind of ['empty','media','peer','date','selection','unknown'])test('focused source refresh waits safely for '+kind,async()=>{
  const {message,input}=await readyFocusedSourceRefresh();const beforeCursor=cursor();
  if(kind==='empty')message.message=' ';
  if(kind==='media')message.media=new Api.MessageMediaPhoto({photo:new Api.Photo({id:'replacement'})});
  if(kind==='peer')message.peerId=new Api.PeerChannel({channelId:'9999'});
  if(kind==='date')message.date-=60;
  if(kind==='selection')telegram.state.onGetMessages=()=>db().prepare('UPDATE telegram_personal_sources SET selected=0').run();
  if(kind==='unknown')db().prepare("UPDATE telegram_relay_outbox SET status='unknown'").run();
  const result=await account.refreshRelayCaptionSourceWithAccount(input);
  assert.equal(result.state,'waiting');assert.ok(result.reason.startsWith('source_'));assert.equal(result.verifiedAt,undefined);
  assert.equal(telegram.state.observations.length,0);assert.equal(cursor(),beforeCursor);
  assert.equal(telegram.state.calls.filter(call=>call.method==='download'||call.method==='EditMessage').length,0);
  assert.equal(stored().lease_until,0);
});

for(const kind of ['busy','backoff'])test('focused source refresh respects account '+kind+' deadlines without network',async()=>{
  const {input}=await readyFocusedSourceRefresh(),until=Date.now()+90000;
  db().prepare(`UPDATE telegram_personal_account SET ${kind==='busy'?'lease_until':'next_attempt_at'}=?`).run(until);
  telegram.state.calls=[];const result=await account.refreshRelayCaptionSourceWithAccount(input);
  assert.equal(result.state,kind);assert.equal(result.retryAt,until);assert.equal(telegram.state.calls.length,0);
});

test('focused source refresh cannot claim consistency when capture rejects or marks source content invalid',async()=>{
  const {input}=await readyFocusedSourceRefresh();telegram.state.consume=false;
  let result=await account.refreshRelayCaptionSourceWithAccount(input);assert.equal(result.reason,'source_capture_waiting');
  telegram.state.consume=true;telegram.state.onObserve=()=>db().prepare("UPDATE telegram_relay_outbox SET source_content_hash='invalid:fixture'").run();
  result=await account.refreshRelayCaptionSourceWithAccount(input);assert.equal(result.reason,'source_capture_waiting');assert.equal(result.verifiedAt,undefined);
  assert.equal(stored().lease_until,0);
});

test('focused source refresh releases its lease and returns bounded retry after a connection failure',async()=>{
  const {input}=await readyFocusedSourceRefresh();telegram.state.error={method:'connect',errorMessage:'ETIMEDOUT'};
  const result=await account.refreshRelayCaptionSourceWithAccount(input);
  assert.equal(result.state,'unavailable');assert.equal(result.reason,'source_unavailable');assert.ok(result.retryAt>Date.now());
  assert.equal(stored().lease_until,0);assert.ok(telegram.state.calls.some(call=>call.method==='destroy'));
});

test('focused source observation never resets credentials, selection or jobs on a revoked-session reply',async()=>{
  const {input}=await readyFocusedSourceRefresh(),before=stored();
  telegram.state.error={method:'connect',errorMessage:'AUTH_KEY_UNREGISTERED'};
  const result=await account.refreshRelayCaptionSourceWithAccount(input);
  assert.equal(result.state,'disconnected');assert.equal(stored().generation,before.generation);
  assert.equal(stored().session_ciphertext,before.session_ciphertext);assert.equal(stored().config_ciphertext,before.config_ciphertext);
  assert.equal(db().prepare('SELECT selected FROM telegram_personal_sources WHERE chat_id=?').get(source).selected,1);
  assert.equal(db().prepare('SELECT status FROM telegram_relay_outbox').get().status,'sent');
  assert.equal(stored().lease_until,0);
});

for(const focused of [true,false])test('serial receive reserves only '+(focused?'the current focus':'no unrelated source edit'),async()=>{
  const {input}=await readyFocusedSourceRefresh();db().prepare('UPDATE telegram_promotion_settings SET relay_caption_serial_enabled=1').run();
  let outboxId=input.outboxId;
  if(!focused){
    const second=photo(42);knownSourcePost(second);outboxId=db().prepare('SELECT MAX(id) AS id FROM telegram_relay_outbox').get().id;
    db().prepare('UPDATE telegram_relay_outbox SET source_version=1 WHERE id=?').run(outboxId);
    const current=cycle.captionWatchFocus(db(),Date.now());cycle.deferCaptionWatchFocus(db(),current.outboxId,Date.now()+10000,'waiting');
  }
  db().prepare(`INSERT INTO telegram_relay_source_edits(outbox_id,source_version,caption,caption_entities,baseline_caption,baseline_entities,created_at)
    VALUES(?,1,'updated','[]','old','[]',?)`).run(outboxId,Date.now());
  telegram.state.calls=[];await account.pollTelegramAccountOnce();
  assert.equal(telegram.state.calls.some(call=>call.method==='connect'),!focused);
});

test('serial observation lets receive continue despite an unrelated initial caption restoration',async()=>{
  await readyFocusedSourceRefresh();db().prepare('UPDATE telegram_promotion_settings SET relay_caption_serial_enabled=1').run();
  const current=cycle.captionWatchFocus(db(),Date.now());cycle.deferCaptionWatchFocus(db(),current.outboxId,Date.now()+10000,'waiting');
  db().prepare(`UPDATE telegram_relay_outbox SET caption_edit_attempted_at=?,caption_edit_outcome='account_waiting_1',
    next_attempt_at=0,last_error='Telegram 未保留部分原始自定义 Emoji，请检查机器人的自定义 Emoji 使用权限。该消息不会自动重发。'`).run(Date.now());
  telegram.state.calls=[];await account.pollTelegramAccountOnce();
  assert.ok(telegram.state.calls.some(call=>call.method==='connect'));
});

test('a deferred serial focus cannot reserve receive while its source edit is already due',async()=>{
  const {input}=await readyFocusedSourceRefresh();
  db().prepare('UPDATE telegram_promotion_settings SET relay_caption_serial_enabled=1').run();
  const focus=cycle.captionWatchFocus(db(),Date.now());
  assert.equal(focus.outboxId,input.outboxId);
  assert.equal(cycle.deferCaptionWatchFocus(db(),focus.outboxId,Date.now()+60000,'connection'),true);
  db().prepare(`INSERT INTO telegram_relay_source_edits(outbox_id,source_version,caption,caption_entities,baseline_caption,baseline_entities,created_at)
    VALUES(?,1,'updated','[]','old','[]',?)`).run(input.outboxId,Date.now());
  telegram.state.calls=[];await account.pollTelegramAccountOnce();
  assert.ok(telegram.state.calls.some(call=>call.method==='connect'));
  assert.equal(db().prepare('SELECT status FROM telegram_relay_source_edits').get().status,'pending');
  assert.equal(cycle.captionWatchFocus(db(),Date.now()).outboxId,input.outboxId);
});

test('an overdue caption edit cannot reserve receive beyond the bounded account priority slot',async t=>{
  let at=Date.now();t.mock.method(Date,'now',()=>at);
  const {input}=await readyFocusedSourceRefresh();
  db().exec('UPDATE telegram_promotion_settings SET relay_caption_serial_enabled=1');
  const focus=cycle.captionWatchFocus(db(),at);
  assert.equal(focus.outboxId,input.outboxId);
  db().prepare(`INSERT INTO telegram_relay_source_edits(outbox_id,source_version,caption,caption_entities,baseline_caption,baseline_entities,created_at)
    VALUES(?,1,'updated','[]','old','[]',?)`).run(input.outboxId,at);
  telegram.state.calls=[];await account.pollTelegramAccountOnce();
  assert.equal(telegram.state.calls.some(call=>call.method==='connect'),false);
  at+=15000;telegram.state.calls=[];
  await account.pollTelegramAccountOnce();
  assert.ok(telegram.state.calls.some(call=>call.method==='connect'));
  assert.equal(db().prepare('SELECT status FROM telegram_relay_source_edits').get().status,'pending');
});

test('due caption priority makes receive, Hot scanning and all startup audits yield without changing business state',async()=>{
  const {input}=await readyFocusedSourceRefresh();const hot=hotSource();
  db().prepare('UPDATE telegram_promotion_settings SET relay_caption_serial_enabled=1').run();
  db().exec("UPDATE telegram_relay_outbox SET caption_edit_outcome='account_invalid'");
  const beforeCursor=cursor(),beforeJobs=db().prepare('SELECT * FROM telegram_relay_outbox').all();
  telegram.state.calls=[];
  await assert.rejects(account.pollTelegramAccountOnce(),error=>error.message.includes('正在处理'));
  for(const operation of [()=>account.readHotVideoSourcePages(db(),hot),()=>account.inspectBlockedRelayCaptionPreflights(),
    ()=>account.inspectRecentRelayDeliveries(),()=>account.inspectConnectedBotEmojiQualification(),()=>account.sampleSelectedSourceEmoji()]){
    assert.equal((await operation()).state,'busy');
  }
  assert.equal(telegram.state.calls.length,0);assert.equal(cursor(),beforeCursor);
  assert.deepEqual(db().prepare('SELECT * FROM telegram_relay_outbox').all(),beforeJobs);
  assert.equal((await account.refreshRelayCaptionSourceWithAccount(input)).state,'ok');
  assert.ok(telegram.state.calls.some(call=>call.method==='connect'));
});

test('owner refresh bypasses caption priority and expired priority lets Hot scanning resume',async t=>{
  let at=Date.now();t.mock.method(Date,'now',()=>at);
  await readyFocusedSourceRefresh();const hot=hotSource();db().prepare('UPDATE telegram_promotion_settings SET relay_caption_serial_enabled=1').run();
  assert.equal(cycle.captionWatchAccountPriority(db(),at),true);
  telegram.state.calls=[];await account.handleAccountAction({action:'refresh'});
  assert.ok(telegram.state.calls.some(call=>call.method==='connect'));
  at+=15000;telegram.state.calls=[];
  assert.equal(cycle.captionWatchAccountPriority(db(),at),false);
  await account.readHotVideoSourcePages(db(),hot);assert.ok(telegram.state.calls.some(call=>call.method==='connect'));
});

test('released busy leases give the waiting caption the next bounded slot without clearing real leases or backoff',async t=>{
  let at=Date.now();t.mock.method(Date,'now',()=>at);
  const {input}=await readyFocusedSourceRefresh();const hot=hotSource();
  db().prepare('UPDATE telegram_promotion_settings SET relay_caption_serial_enabled=1').run();
  const current=cycle.captionWatchFocus(db(),Date.now()),until=Date.now()+60000;
  db().prepare("UPDATE telegram_personal_account SET lease_id='other-work',lease_until=?").run(until);
  cycle.deferCaptionWatchFocus(db(),current.outboxId,until,'busy');
  telegram.state.calls=[];assert.equal((await account.refreshRelayCaptionSourceWithAccount(input)).state,'busy');
  assert.equal(stored().lease_id,'other-work');assert.equal(stored().lease_until,until);
  db().exec("UPDATE telegram_personal_account SET lease_id='',lease_until=0");
  assert.equal((await account.readHotVideoSourcePages(db(),hot)).state,'busy');
  assert.equal(telegram.state.calls.length,0);
  assert.equal(db().prepare('SELECT retry_at FROM telegram_relay_caption_watch_cycle').get().retry_at,at);
  at+=14999;assert.equal((await account.readHotVideoSourcePages(db(),hot)).state,'busy');
  at+=1;assert.equal((await account.readHotVideoSourcePages(db(),hot)).state,'ok');
  assert.equal((await account.refreshRelayCaptionSourceWithAccount(input)).state,'ok');
});

test('legacy caption text mismatch is repairable only after positive exact media identity and stable readback',async()=>{
  const input=await readyCaptionObservation({custom:false});
  telegram.state.messages[0].message='Wrong stale text';telegram.state.messages[0].entities=[];
  db().prepare('UPDATE telegram_relay_outbox SET content_hash=?').run(createHash('sha256').update(telegram.state.media).digest('hex'));
  const result=await account.observeVerifiedRelayCaptionWithAccount(input);
  assert.deepEqual(result,{state:'ok',attempted:true,outcome:'preserved'});
  assert.equal(telegram.state.calls.filter(call=>call.method==='download').length,1);
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,1);
  assert.match(db().prepare('SELECT caption_watch_media_id FROM telegram_relay_outbox').get().caption_watch_media_id,/Photo:/);
});

test('legacy target identity can use a positively matching exact normalized visual hash',async()=>{
  const input=await readyCaptionObservation({custom:false});
  telegram.state.messages[0].message='Wrong stale text';telegram.state.messages[0].entities=[];
  telegram.state.targetVisualHash='a'.repeat(64);
  db().prepare('UPDATE telegram_relay_outbox SET content_hash=?,visual_hash=?').run('b'.repeat(64),telegram.state.targetVisualHash);
  assert.deepEqual(await account.observeVerifiedRelayCaptionWithAccount(input),{state:'ok',attempted:true,outcome:'preserved'});
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,1);
});

for(const kind of ['missing-hash','wrong-hash','changed-media','wrong-date'])test('legacy target text mismatch stays read-only when identity is '+kind,async()=>{
  const input=await readyCaptionObservation({custom:false});
  telegram.state.messages[0].message='Wrong stale text';telegram.state.messages[0].entities=[];
  if(kind==='wrong-hash')db().prepare('UPDATE telegram_relay_outbox SET content_hash=?').run('b'.repeat(64));
  if(kind==='wrong-date')telegram.state.messages[0].date-=120;
  if(kind==='changed-media'){
    db().prepare('UPDATE telegram_relay_outbox SET content_hash=?').run(createHash('sha256').update(telegram.state.media).digest('hex'));
    let reads=0;telegram.state.onGetMessages=()=>{if(++reads===2)telegram.state.messages[0]=new Api.Message({...telegram.state.messages[0],media:new Api.MessageMediaPhoto({photo:new Api.Photo({id:'555555555555555556'})})});};
  }
  const result=await account.observeVerifiedRelayCaptionWithAccount(input);
  assert.deepEqual(result,{state:'ok',attempted:false,outcome:'invalid',reason:'identity_unverified'});
  assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,0);
  assert.equal(db().prepare('SELECT caption_watch_media_id FROM telegram_relay_outbox').get().caption_watch_media_id,'');
});

for(const evidence of ['fresh-and-matching-media','fresh-no-media-proof','no-fresh-version','fresh-but-unknown-edit'])test('invalid legacy caption metadata requires '+evidence+' before repair',async()=>{
  const input=await readyCaptionObservation({custom:false});
  const corrupt='[{"type":"bold","offset":999999,"length":1}]';
  db().prepare('UPDATE telegram_relay_outbox SET caption_entities=?').run(corrupt);
  telegram.state.messages[0].message='Wrong old caption';telegram.state.messages[0].entities=[];
  if(evidence!=='no-fresh-version'){
    db().exec('UPDATE telegram_relay_outbox SET source_version=1,caption_watch_source_version=1');
    const job=db().prepare('SELECT id FROM telegram_relay_outbox').get();
    const edit=db().prepare(`INSERT INTO telegram_relay_source_edits(outbox_id,source_version,caption,caption_entities,
      baseline_caption,baseline_entities,created_at,status) VALUES(?,1,?,?,?, ?,?,'failed')`)
      .run(job.id,input.caption,JSON.stringify(input.captionEntities),input.caption,corrupt,Date.now());
    input.watch.sourceVersion=1;input.watch.sourceEditId=Number(edit.lastInsertRowid);
  }
  if(evidence==='fresh-and-matching-media'||evidence==='fresh-but-unknown-edit')db().prepare('UPDATE telegram_relay_outbox SET content_hash=?')
    .run(createHash('sha256').update(telegram.state.media).digest('hex'));
  if(evidence==='fresh-but-unknown-edit'){
    input.watch.allowRepair=false;
    db().prepare('UPDATE telegram_relay_outbox SET caption_watch_edit_attempted_at=?').run(Date.now());
  }
  const result=await account.observeVerifiedRelayCaptionWithAccount(input);
  if(evidence==='fresh-and-matching-media'){
    assert.deepEqual(result,{state:'ok',attempted:true,outcome:'preserved'});
    assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,1);
  }else{
    if(evidence==='no-fresh-version')assert.equal(result.state,'unavailable');
    else assert.equal(result.reason,evidence==='fresh-but-unknown-edit'?'watch_readonly':'identity_unverified');
    assert.equal(telegram.state.calls.filter(call=>call.method==='EditMessage').length,0);
    if(evidence!=='fresh-but-unknown-edit')assert.equal(db().prepare('SELECT caption_watch_media_id FROM telegram_relay_outbox').get().caption_watch_media_id,'');
    else assert.ok(db().prepare('SELECT caption_watch_edit_attempted_at FROM telegram_relay_outbox').get().caption_watch_edit_attempted_at>0);
  }
});
