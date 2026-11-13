import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

// The real additive SQLite schema, encryption and durable cursors are exercised.
// Telegram is entirely replaced: no credentials or network traffic are used.
const fixture = mkdtempSync(path.join(tmpdir(), 'telegram-personal-account-'));
writeFileSync(path.join(fixture, 'package.json'), '{"type":"commonjs"}');
for (const name of ['sqlite', 'telegram-relay-content', 'telegram-account']) writeFileSync(path.join(fixture, `${name}.js`), ts.transpileModule(
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
class Authorization extends Box {} class SignIn extends Box {} class LogOut extends Box {} class GetAdminedBots extends Box {}
exports.Api={User,Username,Channel,Photo,Document,MessageMediaPhoto,MessageMediaDocument,DocumentAttributeAnimated,DocumentAttributeVideo,Message,InputPeerChannel,PeerChannel,ReplyInlineMarkup,InlineButtonTypeUrl,KeyboardInlineButton,KeyboardInlineButtonRow,InlineButtonTypeCallback,
MessageEntityCustomEmoji,MessageEntityBold,MessageEntityItalic,MessageEntityUnderline,MessageEntityStrike,MessageEntitySpoiler,MessageEntityCode,MessageEntityPre,MessageEntityBlockquote,MessageEntityFormattedDate,MessageEntityTextUrl,MessageEntityUrl,MessageEntityMentionName,MessageEntityHashtag,MessageEntityCashtag,MessageEntityBotCommand,MessageEntityUnknown,auth:{Authorization,SignIn,LogOut},bots:{GetAdminedBots}};
exports.utils={getPeerId:entity=>'-100'+(entity.channelId||entity.id)};
exports.Logger=class {setLevel(){};};
exports.state={};
exports.reset=()=>Object.assign(exports.state,{calls:[],dialogs:[],messages:[],error:null,passwordNeeded:false,media:Buffer.from('fixture-image'),consume:true,queue:[],onDownload:null,onEnqueue:null,me:null,ownedBots:[],onOwnedBots:null,resolvedTarget:null,onEntity:null,onGetMessages:null,onGetMe:null});
exports.reset();
function fail(method){const e=exports.state.error;if(e&&e.method===method)throw Object.assign(new Error('PRIVATE RAW DETAIL'),e);}
exports.TelegramClient=class {
  constructor(session,apiId,apiHash,options){this.session=session;exports.state.calls.push({method:'construct',options});}
  setLogLevel(){}
  async connect(){exports.state.calls.push({method:'connect'});fail('connect');}
  async disconnect(){exports.state.calls.push({method:'disconnect'});}
  async destroy(){exports.state.calls.push({method:'destroy'});}
  async sendCode(){exports.state.calls.push({method:'sendCode'});fail('sendCode');return {phoneCodeHash:'private-code-hash',isCodeViaApp:true};}
  async invoke(request){exports.state.calls.push({method:request.className});fail(request.className);
    if(request instanceof SignIn){if(exports.state.passwordNeeded)throw Object.assign(new Error(),{errorMessage:'SESSION_PASSWORD_NEEDED'});return new Authorization({user:new User()});}
    if(request instanceof GetAdminedBots){if(exports.state.onOwnedBots)await exports.state.onOwnedBots();return exports.state.ownedBots;}
    return {};}
  async signInWithPassword(_creds,params){exports.state.calls.push({method:'password'});await params.password();fail('password');return new User();}
  async getMe(){exports.state.calls.push({method:'getMe'});fail('getMe');if(exports.state.onGetMe)await exports.state.onGetMe();return exports.state.me||new User();}
  iterDialogs(){fail('dialogs');return (async function*(){for(const dialog of exports.state.dialogs)yield dialog;})();}
  async getEntity(peer){exports.state.calls.push({method:'entity',peer});fail('entity');if(exports.state.onEntity)await exports.state.onEntity();return typeof peer==='string'?exports.state.resolvedTarget:exports.state.dialogs.find(d=>String(d.entity.id)===peer.channelId.toString())?.entity;}
  async getMessages(peer,params){exports.state.calls.push({method:'getMessages',peer,params});fail('getMessages');if(exports.state.onGetMessages)await exports.state.onGetMessages();return exports.state.messages.filter(message=>params.ids.includes(message.id));}
  iterMessages(peer,params){exports.state.calls.push({method:'history',peer:peer.channelId.toString(),params});fail('history');
    return {async *[Symbol.asyncIterator](){let messages=exports.state.messages.filter(m=>m.id>(params.minId||0));
      if(!params.reverse)messages=messages.toSorted((a,b)=>b.id-a.id);
      for(const m of messages.slice(0,params.limit||messages.length))yield m;}};}
  async downloadMedia(message,params){exports.state.calls.push({method:'download',id:message.id});fail('download');if(exports.state.onDownload)await exports.state.onDownload(message,params);return exports.state.media;}
};
`);
writeFileSync(path.join(fixture, 'telegram-relay.js'), `
exports.enqueuePersonalRelayMedia=async value=>{const s=require('teleproto').state;s.queue.push(value);if(s.onEnqueue)await s.onEnqueue(value);return s.consume;};
`);
const require = createRequire(import.meta.url);
const account = require(path.join(fixture, 'telegram-account.js'));
const telegram = require(path.join(fixture, 'node_modules/teleproto'));
const { Api } = telegram;
const relayContent = require(path.join(fixture, 'telegram-relay-content.js'));
const { getSqlite } = require(path.join(fixture, 'sqlite.js'));
const previousData = process.env.DATA_DIR;
const previousSecret = process.env.SESSION_SECRET;
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
    media:new Api.MessageMediaPhoto({photo:new Api.Photo({id:'media-'+id})}),...extra});
}
function video(id=41,{caption='Video caption https://source.example',mimeType='video/mp4',size=1024,roundMessage=false,animated=false,videoAttribute=true,...extra}={}) {
  return new Api.Message({id,date:Math.floor(Date.now()/1000),message:caption,
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
  db().prepare(`INSERT INTO telegram_promotion_settings(id,enabled,chat_id,token_ciphertext,relay_enabled,relay_revision,relay_started_at)
    VALUES('primary',0,'','fixture',1,'relay-generation',?)`).run(Date.now()-10000);
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
function cursor(id=source) { return db().prepare('SELECT last_message_id FROM telegram_personal_sources WHERE chat_id=?').get(id).last_message_id; }
function closeDb() {
  const filename=path.join(process.env.DATA_DIR,'directory.sqlite');
  globalThis.__directorySqlite?.get(filename)?.close();
  globalThis.__directorySqlite?.delete(filename);
}
test.beforeEach(()=>{
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
