import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';

// Real migration, cursor, leases and queue. Telegram transport alone is replaced;
// no user credentials, production data or external network requests are used.
const fixture = mkdtempSync(path.join(tmpdir(), 'telegram-photo-relay-'));
writeFileSync(path.join(fixture, 'package.json'), '{"type":"commonjs"}');
for (const name of ['sqlite', 'telegram-relay-content', 'telegram-relay']) {
  writeFileSync(path.join(fixture, `${name}.js`), ts.transpileModule(
    readFileSync(new URL(`../app/lib/${name}.ts`, import.meta.url), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } },
  ).outputText);
}
writeFileSync(path.join(fixture, 'telegram-bot.js'), `
exports.calls = []; exports.polls = []; exports.updates = []; exports.sends = []; exports.editReplies=[];
exports.webhook = ''; exports.targetAllowed = true; exports.targetExists = true;
exports.targetType = 'supergroup'; exports.onRequest = null; exports.onPoll = null; exports.now = 0;
exports.telegramRequest = async (token, method, parameters = {}, upload) => {
  exports.calls.push({token,method,parameters,upload});
  if (exports.onRequest) { const overridden = await exports.onRequest(method,parameters); if (overridden !== undefined) return overridden; }
  if (method === 'getMe') return {ok:true,result:{id:12345678,is_bot:true,username:'FreeBonus365Bot',can_read_all_group_messages:true}};
  if (method === 'getWebhookInfo') return {ok:true,result:{url:exports.webhook}};
  if (method === 'getChat') return exports.targetExists ? {ok:true,result:{id:-1001239999,type:exports.targetType,username:'join365freebonusgroup'}} : {ok:false,code:400,retryAfter:0};
  if (method === 'getChatMember') return {ok:true,result:exports.targetAllowed ? {status:'administrator',can_post_messages:true,can_send_messages:true,can_send_photos:true,can_send_other_messages:true} : {status:'left'}};
  if (method === 'editMessageCaption') {
    if(exports.editReplies.length){const next=exports.editReplies.shift();return typeof next==='function'?await next(parameters):next;}
    return {ok:true,result:{message_id:parameters.message_id,chat:{id:parameters.chat_id,type:exports.targetType},
      caption:parameters.caption,caption_entities:parameters.caption_entities||[],reply_markup:parameters.reply_markup}};
  }
  if (method === 'sendPhoto' || method === 'sendAnimation' || method === 'sendVideo' || method === 'sendDocument') {
    const envelope=reply=>reply?.ok&&typeof reply.result?.message_id==='number'?{...reply,result:{
      chat:{id:parameters.chat_id,type:exports.targetType},caption:parameters.caption,
      caption_entities:parameters.caption_entities||[],reply_markup:parameters.reply_markup,...reply.result}}:reply;
    if (exports.sends.length) { const next=exports.sends.shift(); return envelope(typeof next === 'function' ? await next(parameters) : next); }
    return envelope({ok:true,result:{message_id:9000+exports.calls.length,date:Math.floor(exports.now/1000)}});
  }
  throw new Error('Unexpected relay transport method: '+method);
};
exports.telegramRelayUpdates = async (token, offset) => {
  exports.polls.push({token,offset});
  if (exports.onPoll) return await exports.onPoll(token,offset);
  return exports.updates.length ? exports.updates.shift() : {ok:true,result:[]};
};
`);

writeFileSync(path.join(fixture, 'telegram-relay-media.js'), `
const {createHash}=require('node:crypto');
exports.files = new Map(); exports.onDownload=null; exports.onIdentity=null;
exports.relayMediaMaxBytes = kind => (kind==='photo'?10:kind==='video'?50:20)*1024*1024;
exports.downloadBotRelayMedia = async (token,fileId,kind) => {
  if(exports.onDownload) return await exports.onDownload(token,fileId,kind);
  return exports.files.has(fileId)?exports.files.get(fileId):Buffer.from(fileId);
};
exports.relayMediaIdentity = async (bytes,kind) => {
  if(exports.onIdentity) await exports.onIdentity(bytes,kind);
  return {contentHash:createHash('sha256').update(bytes).digest('hex'),visualHash:''};
};
`);
writeFileSync(path.join(fixture, 'telegram-account.js'), `
exports.calls=[];exports.results=[];exports.recheckCalls=[];exports.recheckResults=[];exports.blockedCalls=0;exports.blockedResults=[];exports.auditOrder=[];
exports.recheckVerifiedRelayCaptionWithAccount=async input=>{
  exports.recheckCalls.push(input);
  const result=exports.recheckResults.length?exports.recheckResults.shift():{state:'unavailable',attempted:false,outcome:'unavailable'};
  if(result instanceof Error)throw result;
  return typeof result==='function'?await result(input):result;
};
exports.inspectBlockedRelayCaptionPreflights=async()=>{
  exports.blockedCalls++;exports.auditOrder.push('blocked');
  return exports.blockedResults.length?exports.blockedResults.shift():{state:'ok',personalEditQualification:'unknown',posts:[]};
};
exports.sampleSelectedSourceEmoji=async()=>{exports.auditOrder.push('source');return {state:'ok'};};
exports.inspectConnectedBotEmojiQualification=async()=>{exports.auditOrder.push('qualification');return {state:'ok',qualification:'unknown'};};
exports.inspectRecentRelayDeliveries=async()=>{exports.auditOrder.push('readback');return {state:'ok',sampledPosts:0,
  matchingCaptions:0,customEmojiPosts:0,preservedCustomEmojiPosts:0,safeLinkPosts:0,matchingButtonPosts:0,
  invalidReferences:0,personalEditQualification:'unknown'};};
exports.editVerifiedRelayCaptionWithAccount=async input=>{
  exports.calls.push(input);
  const result=exports.results.length?exports.results.shift():{state:'unavailable',attempted:false,outcome:'unavailable'};
  if(result instanceof Error)throw result;
  return typeof result==='function'?await result(input):result;
};
`);

writeFileSync(path.join(fixture, 'telegram-relay-diagnostics.js'), `
exports.relayFormattingDiagnostics=()=>({schemaVersion:25,sampledJobs:0});
`);

const require = createRequire(import.meta.url);
const relay = require(path.join(fixture, 'telegram-relay.js'));
const telegram = require(path.join(fixture, 'telegram-bot.js'));
const media = require(path.join(fixture, 'telegram-relay-media.js'));
const personalEdit = require(path.join(fixture, 'telegram-account.js'));
const { getSqlite } = require(path.join(fixture, 'sqlite.js'));
const { relayKeyboard } = require(path.join(fixture, 'telegram-relay-content.js'));
const previousDataDir = process.env.DATA_DIR;
const now = 1_800_000_000_000;
const source = -1001230001;
const target = -1001239999;
const botId = 12345678;
const token = '12345678:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ciphertext = 'fixture-promotion-ciphertext';
const ok = result => ({ok:true,result});

function restoreLegacyMediaKeys(db) {
  db.exec('ALTER TABLE telegram_relay_outbox DROP COLUMN caption_edit_recheck_count');
  db.exec(`CREATE TABLE telegram_relay_media_keys_legacy(media_key TEXT PRIMARY KEY,outbox_id INTEGER NOT NULL);
    INSERT OR IGNORE INTO telegram_relay_media_keys_legacy(media_key,outbox_id)
      SELECT media_key,outbox_id FROM telegram_relay_media_keys ORDER BY day_key DESC;
    DROP TABLE telegram_relay_media_keys;
    ALTER TABLE telegram_relay_media_keys_legacy RENAME TO telegram_relay_media_keys;
    CREATE INDEX telegram_relay_media_key_job ON telegram_relay_media_keys(outbox_id);`);
}

function closeDatabase() {
  const filename = path.join(process.env.DATA_DIR, 'directory.sqlite');
  globalThis.__directorySqlite?.get(filename)?.close();
  globalThis.__directorySqlite?.delete(filename);
}
test.beforeEach(t => {
  process.env.DATA_DIR = mkdtempSync(path.join(fixture, 'case-'));
  media.files.clear(); media.onDownload=null; media.onIdentity=null;
  personalEdit.calls.length=0;personalEdit.results.length=0;personalEdit.recheckCalls.length=0;personalEdit.recheckResults.length=0;personalEdit.blockedCalls=0;personalEdit.blockedResults.length=0;personalEdit.auditOrder.length=0;
  telegram.calls.length=0; telegram.polls.length=0; telegram.updates.length=0; telegram.sends.length=0; telegram.editReplies.length=0;
  telegram.webhook=''; telegram.targetAllowed=true; telegram.targetExists=true; telegram.targetType='supergroup'; telegram.onRequest=null; telegram.onPoll=null; telegram.now=now;
  t.mock.method(console,'info',()=>{});
  t.mock.method(console,'warn',()=>{});
});
test.afterEach(closeDatabase);
test.after(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR=previousDataDir;
  rmSync(fixture,{recursive:true,force:true});
});

function configure({enabled=true,startedAt=now-10_000,revision='relay-revision',channelEnabled=false}={}) {
  getSqlite().prepare(`INSERT INTO telegram_promotion_settings
    (id,enabled,chat_id,token_ciphertext,chat_bot_token_ciphertext,relay_enabled,relay_chat_id,relay_started_at,relay_revision)
    VALUES ('primary',?,'-1009990000',?,'fixture-chatbot-ciphertext',?,'@join365freebonusgroup',?,?)`)
    .run(Number(channelEnabled),ciphertext,Number(enabled),startedAt,revision);
}
function photo(id=1,extra={}) {
  return {update_id:id,message:{
    message_id:1000+id,date:now/1000,chat:{id:source,type:'supergroup'},from:{id:42,is_bot:false},
    caption:`Offer ${id}\nhttps://source.example/offer`,
    photo:[{file_id:`photo-${id}`,file_unique_id:`photo-unique-${id}`,width:800,height:600}],
    reply_markup:{inline_keyboard:[[{text:'Original signup',url:'https://source.example/join'}]]},
    ...extra,
  }};
}
function video(id=1,extra={}) {
  return photo(id,{photo:undefined,video:{file_id:`video-${id}`,file_unique_id:`video-unique-${id}`,
    width:1280,height:720,duration:30,file_size:40*1024*1024},...extra});
}
function state(){return getSqlite().prepare("SELECT * FROM telegram_relay_state WHERE id='primary'").get();}
function jobs(){return getSqlite().prepare('SELECT * FROM telegram_relay_outbox ORDER BY id').all();}
function sends(){return telegram.calls.filter(call=>call.method==='sendPhoto'||call.method==='sendAnimation'||call.method==='sendVideo'||call.method==='sendDocument');}
function edits(){return telegram.calls.filter(call=>call.method==='editMessageCaption');}
function decrypt(value){assert.equal(value,ciphertext,'relay must decrypt the promotion bot, never ChatBot');return token;}
async function poll(at=now,updates=[]) {
  telegram.now=at; telegram.updates.push(Array.isArray(updates)?ok(updates):updates);
  await relay.pollTelegramRelayOnce(decrypt,()=>at);
}
async function deliver(at=now) {telegram.now=at;await relay.deliverTelegramRelayOnce(decrypt,()=>at);}

test('photo relay verifies its target and uses the promotion bot independently of channel posting',async()=>{
  configure();await poll(now,[photo()]);
  assert.equal(jobs().length,1);
  assert.equal(state().target_chat_id,target);
  assert.ok(telegram.calls.some(call=>call.method==='getChat'&&call.parameters.chat_id==='@join365freebonusgroup'));
  await deliver();
  assert.equal(sends().length,1);
  const call=sends()[0];
  assert.equal(call.parameters.chat_id,target);
  assert.equal(call.parameters.photo,'photo-1');
  assert.equal(call.parameters.caption,'Offer 1\nhttps://365freebonus.com/');
  assert.deepEqual(call.parameters.reply_markup,{inline_keyboard:relayKeyboard()});
  assert.deepEqual(call.parameters.caption_entities,[{type:'url',offset:'Offer 1\n'.length,length:'https://365freebonus.com/'.length}]);
  assert.equal(call.parameters.parse_mode,undefined);
  assert.equal(jobs()[0].status,'sent');
  assert.ok(telegram.calls.every(call=>call.token===token));
  assert.ok(telegram.polls.every(call=>call.token===token));
  assert.equal(getSqlite().prepare("SELECT enabled FROM telegram_promotion_settings WHERE id='primary'").get().enabled,0);
});

test('only captioned attached media enter the queue, including received third-party bot posts',async()=>{
  configure();
  const inputs=[
    photo(1,{photo:undefined,text:'Text alone',caption:undefined}),
    photo(2,{caption:'   '}),
    photo(3,{chat:{id:123,type:'private'}}),
    photo(4,{chat:{id:source,type:'channel'},has_protected_content:true}),
    photo(5,{has_protected_content:true}),
    photo(6,{chat:{id:target,type:'supergroup'}}),
    photo(7,{from:{id:botId,is_bot:true}}),
    photo(8,{caption:undefined,photo:undefined,video:{file_id:'video',file_unique_id:'video-unique'}}),
    photo(9,{photo:undefined,animation:{file_id:'gif-9',file_unique_id:'gif-unique-9'},from:{id:77,is_bot:true}}),
    photo(10,{reply_markup:{inline_keyboard:relayKeyboard()}}),
  ];
  await poll(now,inputs);
  assert.equal(jobs().length,1);
  assert.equal(jobs()[0].media_kind,'animation');
  assert.equal(jobs()[0].source_message_id,1009);
  assert.ok(relay.relayStatus(getSqlite()).counts.skipped>=9);
  await deliver();
  assert.equal(sends()[0].method,'sendAnimation');
  assert.equal(sends()[0].parameters.animation,'gif-9');
});

test('updates older than activation are ignored and no prior private or group history is imported',async()=>{
  configure({startedAt:now});
  await poll(now,[photo(1,{date:now/1000-1}),photo(2)]);
  assert.equal(jobs().length,1);
  assert.equal(jobs()[0].source_message_id,1002);
  assert.equal(state().next_offset,3);
});

test('the persisted cursor and per-message key prevent redelivery across polls and SQLite reopening',async()=>{
  configure();const input=photo();await poll(now,[input]);await deliver();
  const offset=state().next_offset;assert.equal(offset,2);
  closeDatabase();await poll(now+4000,[input]);await deliver(now+4000);
  assert.equal(telegram.polls.at(-1).offset,offset);
  assert.equal(jobs().length,1);assert.equal(sends().length,1);
});

test('different captioned photos in one album both send while the same photo echoed in another group is skipped',async()=>{
  configure();const first=photo(1,{media_group_id:'album-1'});
  const albumOther=photo(2,{media_group_id:'album-1',caption:first.message.caption});
  const echo=photo(3,{chat:{id:source-1,type:'supergroup'},caption:'Offer 1\nhttps://another.example/signup',photo:first.message.photo});
  await poll(now,[first,albumOther,echo]);
  assert.equal(jobs().length,2);
  await deliver();await deliver(now+3000);assert.equal(sends().length,2);
  assert.equal(sends()[0].parameters.caption,sends()[1].parameters.caption);
});

for(const kind of ['photo','video','animation'])test(`the same caption on two different Bot ${kind} attachments does not suppress either media`,async()=>{
  configure();const caption='Same offer https://source.example/offer';
  const input=id=>kind==='video'?video(id,{caption}):kind==='animation'
    ?photo(id,{photo:undefined,caption,animation:{file_id:`gif-${id}`,file_unique_id:`gif-unique-${id}`}}):photo(id,{caption});
  await poll(now,[input(1),input(2)]);assert.equal(jobs().length,2);
  await deliver(now);await deliver(now+3000);
  assert.equal(sends().length,2);assert.ok(jobs().every(job=>job.status==='sent'));
  assert.equal(sends()[0].parameters.caption,sends()[1].parameters.caption);
});

test('the same photo repeated inside one album still forwards only once',async()=>{
  configure();const first=photo(1,{media_group_id:'same-photo-album'});
  await poll(now,[first,photo(2,{media_group_id:'same-photo-album',caption:'Changed words',photo:first.message.photo})]);
  await deliver(now);await deliver(now+3000);
  assert.equal(jobs().length,1);assert.equal(sends().length,1);
});

test('global group pacing retains queued notices and sends no faster than every three seconds',async()=>{
  configure();await poll(now,[photo(1),photo(2)]);
  await deliver(now);await deliver(now+2999);assert.equal(sends().length,1);
  await deliver(now+3000);assert.equal(sends().length,2);
  assert.equal(jobs().filter(job=>job.status==='sent').length,2);
});

test('outgoing Webhooks and inaccessible target groups prevent polling without removing integrations',async()=>{
  configure();telegram.webhook='https://webhook.example/receiver';
  await poll(now,[photo()]);
  assert.equal(telegram.polls.length,0);assert.equal(jobs().length,0);
  assert.equal(relay.relayStatus(getSqlite()).ready,false);
  assert.match(relay.relayStatus(getSqlite()).lastError,/Webhook/i);
  assert.equal(telegram.calls.some(call=>call.method==='deleteWebhook'),false);
});

test('missing destination membership keeps the relay paused until access can be verified',async()=>{
  configure();telegram.targetAllowed=false;await poll(now,[photo()]);
  assert.equal(telegram.polls.length,0);assert.equal(jobs().length,0);assert.equal(relay.relayStatus(getSqlite()).ready,false);
  assert.ok(relay.relayStatus(getSqlite()).lastError);
  telegram.targetAllowed=true;await poll(now+60_000,[photo(2,{date:(now+60_000)/1000})]);
  assert.equal(jobs().length,1);assert.equal(relay.relayStatus(getSqlite()).ready,true);
});

test('photo permission is sufficient when the target disallows animations and other media',async()=>{
  configure();
  telegram.onRequest=async method=>{
    if(method==='getChat')return ok({id:target,type:'supergroup',permissions:{can_send_messages:true,can_send_photos:true,can_send_other_messages:false}});
    if(method==='getChatMember')return ok({status:'member'});
    return undefined;
  };
  await poll(now,[photo()]);
  assert.equal(jobs().length,1);assert.equal(relay.relayStatus(getSqlite()).ready,true);
  await deliver();
  assert.equal(sends().length,1);assert.equal(sends()[0].method,'sendPhoto');assert.equal(jobs()[0].status,'sent');
});

test('removal from one source cancels only that source queue while other groups remain eligible',async()=>{
  configure();const otherSource=source-1,remainingSource=source-2;
  await poll(now,[photo(1),photo(2,{chat:{id:otherSource,type:'supergroup'}}),photo(3,{chat:{id:remainingSource,type:'supergroup'}})]);
  assert.equal(jobs().length,3);
  const membership=(id,chatId,status,userId=botId)=>({update_id:id,my_chat_member:{
    chat:{id:chatId,type:'supergroup'},date:(now+1000)/1000,from:{id:42,is_bot:false},
    old_chat_member:{status:'member',user:{id:userId,is_bot:true}},
    new_chat_member:{status,user:{id:userId,is_bot:true}},
  }});
  await poll(now+1000,[membership(4,source,'left'),membership(5,otherSource,'kicked'),membership(6,remainingSource,'kicked',99999)]);
  assert.deepEqual(jobs().map(job=>({source:job.source_chat_id,status:job.status})),[
    {source,status:'cancelled'},{source:otherSource,status:'cancelled'},{source:remainingSource,status:'pending'},
  ]);
  await deliver(now+1000);
  assert.equal(sends().length,1);assert.equal(sends()[0].parameters.photo,'photo-3');
});

test('a different bot identity cannot consume source updates',async()=>{
  configure();telegram.onRequest=async method=>method==='getMe'?ok({id:999,is_bot:true,username:'OtherBot'}):undefined;
  await poll(now,[photo()]);
  assert.equal(telegram.polls.length,0);assert.equal(jobs().length,0);assert.equal(relay.relayStatus(getSqlite()).ready,false);
});

test('disabled relay settings cancel queued work and do not affect channel or ChatBot preferences',async()=>{
  configure({channelEnabled:true});await poll(now,[photo()]);
  getSqlite().prepare("UPDATE telegram_promotion_settings SET relay_enabled=0 WHERE id='primary'").run();
  await deliver();
  assert.equal(sends().length,0);assert.equal(jobs()[0].status,'cancelled');
  const current=getSqlite().prepare("SELECT enabled,token_ciphertext,chat_bot_token_ciphertext FROM telegram_promotion_settings WHERE id='primary'").get();
  assert.deepEqual({...current},{enabled:1,token_ciphertext:ciphertext,chat_bot_token_ciphertext:'fixture-chatbot-ciphertext'});
});

test('rate limits pause all queued jobs and retry only the definitively rejected request',async()=>{
  configure();await poll(now,[photo(1),photo(2)]);
  telegram.sends.push({ok:false,code:429,retryAfter:20});
  await deliver(now);assert.equal(jobs()[0].status,'pending');
  await deliver(now+19_999);assert.equal(sends().length,1);
  await deliver(now+20_000);assert.equal(sends().length,2);
  assert.equal(jobs().filter(job=>job.status==='sent').length,1);
  await deliver(now+23_000);assert.equal(sends().length,3);
  assert.deepEqual(jobs().map(job=>job.status),['sent','sent']);
  assert.deepEqual(jobs().map(job=>job.attempts),[2,1]);
});

test('unknown send results and server failures are terminal to prevent duplicate group posts',async()=>{
  configure();await poll(now,[photo(1),photo(2)]);
  telegram.sends.push(null,{ok:false,code:500,retryAfter:0});
  await deliver(now);await deliver(now+3000);
  assert.deepEqual(jobs().map(job=>job.status),['unknown','unknown']);
  await deliver(now+120_000);assert.equal(sends().length,2);
});

test('rejected photos are never replaced with standalone text',async()=>{
  configure();await poll(now,[photo()]);telegram.sends.push({ok:false,code:400,retryAfter:0});
  await deliver();assert.equal(jobs()[0].status,'failed');
  assert.equal(telegram.calls.some(call=>call.method==='sendMessage'),false);
});

test('an interrupted sending lease becomes unknown rather than being automatically resent',async()=>{
  configure();await poll(now,[photo()]);
  getSqlite().prepare("UPDATE telegram_relay_outbox SET status='sending',lease_id='interrupted',lease_until=?,attempts=1").run(now-1);
  getSqlite().prepare("UPDATE telegram_relay_state SET send_lease_id='interrupted',send_lease_until=? WHERE id='primary'").run(now-1);
  await deliver();assert.equal(jobs()[0].status,'unknown');assert.equal(sends().length,0);
});

test('poll conflicts are reported without acknowledging or deleting pending source updates',async()=>{
  configure();await poll(now,{ok:false,code:409,retryAfter:0});
  assert.equal(state().next_offset,0);assert.equal(jobs().length,0);
  assert.match(relay.relayStatus(getSqlite()).lastError,/轮询|Webhook|其他/);
  assert.equal(telegram.calls.some(call=>call.method==='deleteWebhook'),false);
});

test('same-bot credential rotation keeps cursor and queued work while using only the new credential',async()=>{
  configure();await poll(now,[photo()]);const offset=state().next_offset;
  const rotatedToken='12345678:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  getSqlite().prepare("UPDATE telegram_promotion_settings SET token_ciphertext='rotated-ciphertext' WHERE id='primary'").run();
  await relay.deliverTelegramRelayOnce(value=>{assert.equal(value,'rotated-ciphertext');return rotatedToken;},()=>now);
  assert.equal(sends().length,1);assert.equal(sends()[0].token,rotatedToken);
  assert.equal(state().next_offset,offset);assert.equal(jobs()[0].status,'sent');
});

test('changing settings while target verification awaits prevents polling or queueing with stale permissions',async()=>{
  configure();telegram.onRequest=async method=>{
    if(method==='getChatMember')getSqlite().prepare("UPDATE telegram_promotion_settings SET relay_chat_id='@replacement_group',relay_revision='replacement-revision' WHERE id='primary'").run();
    return undefined;
  };
  await poll(now,[photo()]);
  assert.equal(telegram.polls.length,0);assert.equal(jobs().length,0);assert.equal(state().next_offset,0);
});

test('a configured username cannot silently redirect the pinned destination, including after reopening SQLite',async()=>{
  configure();await poll(now,[photo()]);
  assert.equal(state().target_chat_id,target);assert.equal(jobs().length,1);
  const replacement=-1001240000;
  telegram.onRequest=async method=>method==='getChat'
    ? ok({id:replacement,type:'supergroup',username:'join365freebonusgroup'}) : undefined;

  await relay.pollTelegramRelayOnce(decrypt,()=>now+60_000);
  assert.equal(state().target_chat_id,target,'the original canonical group ID must remain pinned');
  assert.equal(relay.relayStatus(getSqlite()).ready,false);
  assert.ok(relay.relayStatus(getSqlite()).lastError);
  assert.equal(telegram.polls.length,1,'source messages must not be consumed for an unapproved replacement target');
  await deliver(now+60_000);assert.equal(sends().length,0);

  closeDatabase();
  await relay.pollTelegramRelayOnce(decrypt,()=>now+120_000);
  assert.equal(state().target_chat_id,target,'the pin must survive a process/database reconnect');
  assert.equal(relay.relayStatus(getSqlite()).ready,false);
  assert.equal(jobs().length,1);assert.equal(telegram.polls.length,1);
  await deliver(now+120_000);assert.equal(sends().length,0);

  // An authenticated owner choosing a new destination creates a new settings
  // revision; only that explicit change authorizes a fresh numeric binding.
  const reboundAt=now+180_000;
  getSqlite().prepare(`UPDATE telegram_promotion_settings SET relay_chat_id=?,relay_revision='owner-chosen-target',relay_started_at=? WHERE id='primary'`)
    .run(String(replacement),reboundAt);
  await poll(reboundAt,[photo(2,{date:reboundAt/1000})]);
  assert.equal(state().target_chat_id,replacement);assert.equal(relay.relayStatus(getSqlite()).ready,true);
  await deliver(reboundAt);
  assert.equal(sends().length,1);assert.equal(sends()[0].parameters.chat_id,replacement);
  assert.equal(jobs().filter(job=>job.status==='sent').length,1);
  assert.equal(jobs()[0].status,'cancelled','the old destination job must not be silently retargeted');
});

test('a disabled setting during an in-flight poll cannot consume or persist source content',async()=>{
  configure();telegram.onPoll=async()=>{
    getSqlite().prepare("UPDATE telegram_promotion_settings SET relay_enabled=0 WHERE id='primary'").run();
    return ok([photo()]);
  };
  await poll(now);
  assert.equal(jobs().length,0);assert.equal(state().next_offset,0);assert.equal(sends().length,0);
});

test('explicit repeated rate-limit rejections stop after five attempts',async()=>{
  configure();await poll(now,[photo()]);
  telegram.sends.push(...Array.from({length:5},()=>({ok:false,code:429,retryAfter:1})));
  let at=now;
  for(let attempt=0;attempt<5;attempt++){
    await deliver(at);
    assert.equal(jobs()[0].attempts,attempt+1);
    at=state().next_send_at;
  }
  assert.equal(jobs()[0].status,'failed');
  await deliver(at);assert.equal(sends().length,5);
});

test('forbidden target access pauses delivery and re-verifies membership before a safe retry',async()=>{
  configure();await poll(now,[photo()]);telegram.sends.push({ok:false,code:403,retryAfter:0});
  await deliver(now);
  assert.equal(jobs()[0].status,'pending');assert.equal(state().ready_until,0);
  await deliver(now+59_999);assert.equal(sends().length,1);
  await poll(now+60_000,[]);await deliver(now+60_000);
  assert.equal(sends().length,2);assert.equal(jobs()[0].status,'sent');assert.equal(jobs()[0].attempts,2);
});

test('relay status exposes only aggregate state and canned errors, not content or stored credentials',async()=>{
  configure();await poll(now,[photo()]);
  const status=relay.relayStatus(getSqlite());
  assert.deepEqual(Object.keys(status).sort(),['counts','lastError','lastPolledAt','ready']);
  const output=JSON.stringify(status);
  for(const secret of [ciphertext,'fixture-chatbot-ciphertext','Offer 1','photo-1',String(source)])assert.equal(output.includes(secret),false);
});

test('v17 migration preserves notes, credentials and existing queues while activating only future relays',t=>{
  t.mock.method(Date,'now',()=>now);
  configure({enabled:false});const db=getSqlite();
  db.prepare("INSERT INTO notes_vault_settings(id,pin_hash,revision,created_at,updated_at) VALUES('primary','fixture-pin','vault-revision',1,1)").run();
  db.prepare("INSERT INTO secure_notes(title_ciphertext,body_ciphertext,revision,created_at,updated_at) VALUES('title-cipher','body-cipher','note-revision',1,1)").run();
  db.prepare("INSERT INTO telegram_private_contacts(user_id,updates_enabled,updates_started_at) VALUES(701,0,123)").run();
  db.prepare("UPDATE telegram_promotion_settings SET private_enabled=1,private_updates_enabled=1,private_updates_started_at=123,private_updates_revision='private-generation' WHERE id='primary'").run();
  db.prepare("INSERT INTO brands(id,name,slug,category,tagline,description,color,icon) VALUES('existing','Existing','existing','Update','Original tagline','Original copy','#aabbcc','sparkles')").run();
  db.prepare("INSERT INTO telegram_promotion_outbox(brand_id,revision,status,attempts,created_at) VALUES('existing','existing-promotion','sent',1,321)").run();
  db.prepare("INSERT INTO telegram_private_brand_updates(brand_id,promotion_revision,user_id,settings_revision,status) VALUES('existing','existing-promotion',701,'private-generation','pending')").run();
  const vault={...db.prepare('SELECT * FROM notes_vault_settings').get()};
  const note={...db.prepare('SELECT * FROM secure_notes').get()};
  const channelJob={...db.prepare('SELECT * FROM telegram_promotion_outbox').get()};
  const privateJob={...db.prepare('SELECT * FROM telegram_private_brand_updates').get()};
  db.exec(`DROP TABLE telegram_relay_media_keys;DROP TABLE telegram_relay_outbox;DROP TABLE telegram_relay_state;
    ALTER TABLE telegram_promotion_settings DROP COLUMN relay_enabled;
    ALTER TABLE telegram_promotion_settings DROP COLUMN relay_chat_id;
    ALTER TABLE telegram_promotion_settings DROP COLUMN relay_started_at;
    ALTER TABLE telegram_promotion_settings DROP COLUMN relay_revision;
    PRAGMA user_version=17;`);
  closeDatabase();const migrated=getSqlite();
  assert.equal(migrated.prepare('PRAGMA user_version').get().user_version,25);
  const current=migrated.prepare("SELECT * FROM telegram_promotion_settings WHERE id='primary'").get();
  assert.equal(current.relay_enabled,1);assert.equal(current.relay_started_at,now);assert.ok(current.relay_revision);
  assert.equal(current.relay_chat_id,'@join365freebonusgroup');
  assert.equal(current.token_ciphertext,ciphertext);assert.equal(current.chat_bot_token_ciphertext,'fixture-chatbot-ciphertext');
  assert.equal(current.private_updates_revision,'private-generation');
  assert.deepEqual({...migrated.prepare('SELECT * FROM notes_vault_settings').get()},vault);
  assert.deepEqual({...migrated.prepare('SELECT * FROM secure_notes').get()},note);
  assert.deepEqual({...migrated.prepare('SELECT * FROM telegram_promotion_outbox').get()},channelJob);
  assert.deepEqual({...migrated.prepare('SELECT * FROM telegram_private_brand_updates').get()},privateJob);
  assert.deepEqual({...migrated.prepare('SELECT * FROM telegram_private_contacts WHERE user_id=701').get()},{user_id:701,updates_enabled:0,updates_started_at:123});
  assert.equal(migrated.prepare('SELECT COUNT(*) AS count FROM telegram_relay_outbox').get().count,0);
});

function accountSource(chatId=source,{selected=1,joined=1,selectedAt=now-5000}={}) {
  getSqlite().prepare(`INSERT OR REPLACE INTO telegram_personal_sources(chat_id,selected,joined,selected_at)
    VALUES(?,?,?,?)`).run(chatId,selected,joined,selectedAt);
}
async function configureAccount(t) {
  t.mock.method(Date,'now',()=>now);
  configure();
  getSqlite().exec(`CREATE TABLE telegram_personal_account(id TEXT PRIMARY KEY,generation TEXT,stage TEXT);
    CREATE TABLE telegram_personal_sources(chat_id INTEGER PRIMARY KEY,selected INTEGER,joined INTEGER,selected_at INTEGER,blocked INTEGER NOT NULL DEFAULT 0);
    INSERT INTO telegram_personal_account VALUES('primary','account-generation','connected');`);
  accountSource();
  await poll(now,[]);
}
function accountPhoto(overrides={}) {
  return {sourceChatId:source,sourceMessageId:2001,sourceDate:now/1000,mediaGroupId:'',
    caption:'New photo https://other.example/signup',captionEntities:[],mediaKind:'photo',
    bytes:Buffer.from('personal-photo-one'),hasSpoiler:false,sourceMediaId:'personal-photo-one',
    accountGeneration:'account-generation',relayRevision:'relay-revision',...overrides};
}

function originalEmojiCaption() {
  const originalUrl='https://old.example/join';
  const caption=`Friday plans? 😹\n⭐⭐\n➡️ FREE RM20 ${originalUrl}\n🔗 JOIN NOW⬇️`;
  const urlOffset=caption.indexOf(originalUrl);
  const custom=(text,id,offset=caption.indexOf(text))=>({type:'custom_emoji',offset,length:text.length,custom_emoji_id:id});
  const entities=[
    custom('😹','100000000000000001'),
    custom('⭐','100000000000000002'),
    custom('⭐','100000000000000003',caption.indexOf('⭐')+1),
    custom('➡️','100000000000000004'),
    {type:'bold',offset:caption.indexOf('FREE RM20'),length:'FREE RM20'.length},
    {type:'url',offset:urlOffset,length:originalUrl.length},
    custom('🔗','100000000000000005'),
    custom('⬇️','100000000000000006'),
  ];
  const rewritten=caption.replace(originalUrl,'https://365freebonus.com/');
  const shift='https://365freebonus.com/'.length-originalUrl.length;
  const expectedEntities=entities.map(entity=>({...entity,
    ...(entity.type==='url'?{length:'https://365freebonus.com/'.length}:{}),
    offset:entity.offset>urlOffset?entity.offset+shift:entity.offset}));
  return {caption,entities,rewritten,expectedEntities};
}

test('bot custom emoji and formatting survive queued storage and reopening with only authorized URLs changed',async()=>{
  configure();const original=originalEmojiCaption();
  await poll(now,[photo(1,{caption:original.caption,caption_entities:original.entities})]);
  assert.equal(jobs().length,1);
  assert.equal(jobs()[0].caption,original.rewritten);
  assert.deepEqual(JSON.parse(jobs()[0].caption_entities),original.expectedEntities);
  closeDatabase();await deliver(now);
  const call=sends()[0];assert.equal(sends().length,1);
  assert.equal(call.parameters.caption,original.rewritten);
  assert.deepEqual(call.parameters.caption_entities,original.expectedEntities);
  assert.equal(call.parameters.parse_mode,undefined);
  assert.deepEqual(call.parameters.reply_markup,{inline_keyboard:relayKeyboard()});
});

test('signed negative Bot custom emoji IDs remain exact strings through persistence and delivery',async()=>{
  configure();const entities=[{type:'custom_emoji',offset:0,length:1,custom_emoji_id:'-9223372036854775808'}];
  await poll(now,[photo(1,{caption:'⭐ Original logo',caption_entities:entities})]);
  assert.equal(jobs().length,1);assert.equal(jobs()[0].status,'pending');
  assert.deepEqual(JSON.parse(jobs()[0].caption_entities),entities);
  closeDatabase();await deliver(now);
  assert.equal(sends().length,1);assert.equal(sends()[0].parameters.caption,'⭐ Original logo');
  assert.deepEqual(sends()[0].parameters.caption_entities,entities);
  assert.equal(jobs()[0].status,'sent');assert.equal(jobs()[0].last_error,'');
});

test('signed negative personal custom emoji IDs survive conversion expectations and multipart sending',async t=>{
  await configureAccount(t);
  const entities=[{type:'custom_emoji',offset:0,length:2,custom_emoji_id:'-100000000000000001'}];
  assert.equal(await relay.enqueuePersonalRelayMedia(accountPhoto({caption:'😹 Original character',captionEntities:entities,
    expectedCustomEmojiCount:1})),true);
  assert.deepEqual(JSON.parse(jobs()[0].caption_entities),entities);
  await deliver(now);
  assert.equal(sends().length,1);assert.equal(sends()[0].upload.field,'photo');
  assert.equal(sends()[0].parameters.caption,'😹 Original character');
  assert.deepEqual(sends()[0].parameters.caption_entities,entities);
  assert.equal(jobs()[0].status,'sent');assert.equal(jobs()[0].last_error,'');
});

for(const invalid of ['0','9223372036854775808','-9223372036854775809'])test(`invalid source custom emoji ID ${invalid} fails instead of sending its fallback`,async()=>{
  configure();
  await poll(now,[photo(1,{caption:'⭐ Original custom logo',caption_entities:[
    {type:'custom_emoji',offset:0,length:1,custom_emoji_id:invalid},
  ]})]);
  assert.equal(jobs().length,1);assert.equal(jobs()[0].status,'failed');
  assert.match(jobs()[0].last_error,/自定义|Emoji|表情/i);
  await deliver(now);assert.equal(sends().length,0);
  assert.equal(telegram.calls.some(call=>call.method==='sendMessage'),false);
});

test('personal source reports lost custom emoji metadata before conversion and cannot send a plain fallback',async t=>{
  await configureAccount(t);
  assert.equal(await relay.enqueuePersonalRelayMedia(accountPhoto({caption:'⭐ Original custom logo',captionEntities:[],
    expectedCustomEmojiCount:1})),true);
  assert.equal(jobs().length,1);assert.equal(jobs()[0].status,'failed');
  assert.match(jobs()[0].last_error,/自定义|Emoji|表情/i);
  assert.equal(jobs()[0].media_bytes,null);
  await deliver(now);assert.equal(sends().length,0);
  assert.equal(telegram.calls.some(call=>call.method==='sendMessage'),false);
});

test('all personal photo, GIF, MP4 and original-video file uploads retain custom emoji IDs and formatting',async t=>{
  await configureAccount(t);const original=originalEmojiCaption();
  const variants=[
    {mediaKind:'photo',method:'sendPhoto',field:'photo'},
    {mediaKind:'animation',method:'sendAnimation',field:'animation'},
    {mediaKind:'video',mimeType:'video/mp4',method:'sendVideo',field:'video'},
    {mediaKind:'video',mimeType:'video/webm',method:'sendDocument',field:'document'},
  ];
  for(let i=0;i<variants.length;i++){
    const {method,field,...variant}=variants[i];
    assert.equal(await relay.enqueuePersonalRelayMedia(accountPhoto({...variant,sourceMessageId:3000+i,
      sourceMediaId:`original-emoji-media-${i}`,bytes:Buffer.from(`original-emoji-bytes-${i}`),
      caption:original.caption,captionEntities:original.entities})),true);
    assert.deepEqual(JSON.parse(jobs()[i].caption_entities),original.expectedEntities);
  }
  closeDatabase();
  for(let i=0;i<variants.length;i++){
    await deliver(now+i*4000);
    const call=sends()[i];assert.equal(call.method,variants[i].method);assert.equal(call.upload.field,variants[i].field);
    assert.equal(call.parameters.caption,original.rewritten);
    assert.deepEqual(call.parameters.caption_entities,original.expectedEntities);
    assert.equal(call.parameters.parse_mode,undefined);
    assert.deepEqual(call.parameters.reply_markup,{inline_keyboard:relayKeyboard()});
    assert.equal(jobs()[i].status,'sent');
  }
  assert.equal(sends().length,4);
});

test('Telegram rejection of custom emoji never falls back to changed plain emoji or text',async()=>{
  configure();const original=originalEmojiCaption();
  await poll(now,[photo(1,{caption:original.caption,caption_entities:original.entities})]);
  telegram.sends.push({ok:false,code:400,retryAfter:0});await deliver(now);
  assert.equal(sends().length,1);assert.equal(jobs()[0].status,'failed');
  assert.deepEqual(sends()[0].parameters.caption_entities,original.expectedEntities);
  assert.match(jobs()[0].last_error,/自定义|emoji|表情|原样/i);
  assert.match(relay.relayStatus(getSqlite()).lastError,/自定义|emoji|表情|原样/i);
  await deliver(now+4000);assert.equal(sends().length,1);
  assert.equal(telegram.calls.some(call=>call.method==='sendMessage'),false);
});

test('a successful Telegram reply that strips custom emoji records a warning without resending the delivered media',async()=>{
  configure();const original=originalEmojiCaption();
  await poll(now,[photo(1,{caption:original.caption,caption_entities:original.entities})]);
  telegram.sends.push(ok({message_id:87654,date:now/1000,caption:original.rewritten,caption_entities:[]}));
  await deliver(now);
  assert.equal(sends().length,1);assert.equal(jobs()[0].status,'sent');
  assert.ok(jobs()[0].last_error);assert.match(jobs()[0].last_error,/自定义|emoji|表情|原样/i);
  assert.match(relay.relayStatus(getSqlite()).lastError,/自定义|emoji|表情|原样/i);
  await poll(now+4000,[photo(2,{caption:original.caption,caption_entities:original.entities,photo:photo(1).message.photo})]);
  await deliver(now+4000);
  assert.equal(sends().length,1);assert.equal(jobs().length,1);
  assert.equal(telegram.calls.some(call=>call.method==='sendMessage'),false);
});

test('a successful reply with changed caption text warns even when custom emoji IDs remain intact and never resends',async()=>{
  configure();const original=originalEmojiCaption();
  await poll(now,[photo(1,{caption:original.caption,caption_entities:original.entities})]);
  telegram.sends.push(ok({message_id:87655,date:now/1000,caption:original.rewritten+' changed',
    caption_entities:original.expectedEntities}));
  await deliver(now);
  assert.equal(sends().length,1);assert.equal(jobs()[0].status,'sent');
  assert.deepEqual(sends()[0].parameters.caption_entities,original.expectedEntities);
  assert.match(jobs()[0].last_error,/返回的文案|原文不一致|文案.*不一致/);
  assert.match(relay.relayStatus(getSqlite()).lastError,/返回的文案|原文不一致|文案.*不一致/);
  await poll(now+4000,[photo(2,{caption:original.caption,caption_entities:original.entities,photo:photo(1).message.photo})]);
  await deliver(now+4000);
  assert.equal(sends().length,1);assert.equal(jobs().length,1);
  assert.equal(telegram.calls.some(call=>call.method==='sendMessage'),false);
});

test('overlength Bot captions fail with a clear error instead of forwarding shortened text or emoji',async()=>{
  configure();const caption='😹'.repeat(1100);
  await poll(now,[photo(1,{caption,caption_entities:[{type:'custom_emoji',offset:0,length:2,custom_emoji_id:'100000000000000001'}]})]);
  assert.equal(jobs().length,1);assert.equal(jobs()[0].status,'failed');
  assert.match(jobs()[0].last_error,/超过|长度限制/);
  await deliver(now);assert.equal(sends().length,0);
  assert.equal(telegram.calls.some(call=>call.method==='sendMessage'),false);
});

test('overlength personal captions are consumed with a failed record and never silently truncated or sent as text',async t=>{
  await configureAccount(t);
  const input=accountPhoto({caption:'Original words\n'+'⭐'.repeat(1100),captionEntities:[
    {type:'custom_emoji',offset:'Original words\n'.length,length:1,custom_emoji_id:'100000000000000001'},
  ]});
  assert.equal(await relay.enqueuePersonalRelayMedia(input),true);
  assert.equal(jobs().length,1);assert.equal(jobs()[0].status,'failed');
  assert.match(jobs()[0].last_error,/超过|长度限制/);
  assert.equal(jobs()[0].media_bytes,null);
  await deliver(now);assert.equal(sends().length,0);
  assert.equal(telegram.calls.some(call=>call.method==='sendMessage'),false);
});

for(const invalid of ['not-json','{"type":"custom_emoji"}'])test(`corrupt stored caption entities fail closed without plain-text fallback (${invalid[0]})`,async()=>{
  configure();await poll(now,[photo()]);
  getSqlite().prepare('UPDATE telegram_relay_outbox SET caption_entities=?').run(invalid);
  await deliver(now);
  assert.equal(sends().length,0);assert.equal(jobs()[0].status,'failed');
  assert.ok(jobs()[0].last_error);
  assert.equal(telegram.calls.some(call=>call.method==='sendMessage'),false);
});

async function sentEmojiMismatch({personal=false,t}={}) {
  if(personal) await configureAccount(t); else configure();
  const original=originalEmojiCaption();
  if(personal) await relay.enqueuePersonalRelayMedia(accountPhoto({caption:original.caption,captionEntities:original.entities}));
  else await poll(now,[photo(1,{caption:original.caption,caption_entities:original.entities})]);
  telegram.sends.push(ok({message_id:88770,caption:original.rewritten,caption_entities:[]}));
  await deliver(now);
  assert.equal(jobs()[0].status,'sent');assert.ok(jobs()[0].last_error);
  assert.equal(jobs()[0].caption_edit_attempted_at,0);
  return original;
}

test('a known delivered emoji mismatch is edited once with its own target message ID and fixed caption/buttons',async()=>{
  const original=await sentEmojiMismatch();closeDatabase();
  await deliver(now+4000);
  assert.equal(sends().length,1);assert.equal(edits().length,1);
  const parameters=edits()[0].parameters;
  assert.equal(parameters.chat_id,target);assert.equal(parameters.message_id,88770);
  assert.notEqual(parameters.message_id,jobs()[0].source_message_id);
  assert.equal(parameters.caption,original.rewritten);assert.deepEqual(parameters.caption_entities,original.expectedEntities);
  assert.deepEqual(parameters.reply_markup,{inline_keyboard:relayKeyboard()});
  assert.equal(parameters.parse_mode,undefined);
  assert.equal(jobs()[0].status,'sent');assert.equal(jobs()[0].caption_edit_outcome,'preserved');
  assert.equal(jobs()[0].caption_edit_attempted_at,now+4000);assert.equal(jobs()[0].last_error,'');
  closeDatabase();await deliver(now+8000);
  assert.equal(sends().length,1);assert.equal(edits().length,1);
});

test('a foreign returned hidden link triggers one caption edit that contains only owner links',async()=>{
  configure();const original=originalEmojiCaption();
  await poll(now,[photo(1,{caption:original.caption,caption_entities:original.entities})]);
  telegram.sends.push(ok({message_id:88771,caption:original.rewritten,caption_entities:[...original.expectedEntities,
    {type:'text_link',offset:0,length:6,url:'https://foreign.example/join'}]}));
  await deliver(now);assert.match(jobs()[0].last_error,/链接/);
  await deliver(now+4000);
  assert.equal(edits().length,1);assert.equal(sends().length,1);
  for(const entity of edits()[0].parameters.caption_entities)if(entity.type==='text_link')assert.equal(entity.url,'https://365freebonus.com/');
  assert.equal(edits()[0].parameters.caption,original.rewritten);assert.equal(jobs()[0].caption_edit_outcome,'preserved');
});

test('a missing or foreign returned button is corrected by editing the same media message only',async()=>{
  configure();await poll(now,[photo()]);
  telegram.sends.push(ok({message_id:88772,reply_markup:{inline_keyboard:[[{text:'Original join',url:'https://foreign.example'}]]}}));
  await deliver(now);assert.match(jobs()[0].last_error,/按钮/);
  await deliver(now+4000);
  assert.equal(edits().length,1);assert.deepEqual(edits()[0].parameters.reply_markup,{inline_keyboard:relayKeyboard()});
  assert.equal(jobs()[0].caption_edit_outcome,'preserved');assert.equal(sends().length,1);
});

test('a missing returned caption is unverified and repaired once instead of being accepted as unchanged',async()=>{
  configure();await poll(now,[photo()]);telegram.sends.push(ok({message_id:88773,caption:null}));
  await deliver(now);assert.match(jobs()[0].last_error,/文案/);
  await deliver(now+4000);assert.equal(edits().length,1);assert.equal(jobs()[0].caption_edit_outcome,'preserved');
  assert.equal(sends().length,1);
});

for(const badReply of [{message_id:88771},{chat:{id:target-1,type:'supergroup'}}])test(`edit response with a mismatched ${badReply.message_id?'message':'chat'} identity is never trusted or retried`,async()=>{
  const original=await sentEmojiMismatch();
  telegram.editReplies.push(ok({message_id:88770,chat:{id:target,type:'supergroup'},caption:original.rewritten,
    caption_entities:original.expectedEntities,reply_markup:{inline_keyboard:relayKeyboard()},...badReply}));
  await deliver(now+4000);
  assert.equal(jobs()[0].caption_edit_outcome,'invalid');assert.equal(jobs()[0].status,'sent');
  assert.ok(jobs()[0].last_error);assert.equal(edits().length,1);assert.equal(sends().length,1);
  await deliver(now+8000);assert.equal(edits().length,1);assert.equal(sends().length,1);
});

for(const response of [null,{ok:false,code:500,retryAfter:0}])test(`an uncertain caption edit (${response?'server error':'timeout'}) stays delivered and is never resent after restart`,async()=>{
  await sentEmojiMismatch();telegram.editReplies.push(response);await deliver(now+4000);
  assert.equal(jobs()[0].caption_edit_outcome,'uncertain');assert.equal(jobs()[0].status,'sent');
  assert.ok(jobs()[0].last_error);closeDatabase();await deliver(now+8000);
  assert.equal(edits().length,1);assert.equal(sends().length,1);assert.equal(personalEdit.calls.length,0);
});

test('an edit that still changes custom emoji records the result once without another edit or media fallback',async()=>{
  const original=await sentEmojiMismatch();telegram.editReplies.push(ok({message_id:88770,chat:{id:target,type:'supergroup'},
    caption:original.rewritten,caption_entities:[],reply_markup:{inline_keyboard:relayKeyboard()}}));
  await deliver(now+4000);assert.equal(jobs()[0].caption_edit_outcome,'changed');assert.ok(jobs()[0].last_error);
  await deliver(now+8000);assert.equal(edits().length,1);assert.equal(sends().length,1);
  assert.equal(telegram.calls.some(call=>call.method==='sendMessage'),false);
});

test('an edit rate limit delays other sends but never repeats the same caption edit',async()=>{
  await sentEmojiMismatch();await poll(now+1000,[photo(2)]);
  telegram.editReplies.push({ok:false,code:429,retryAfter:120});await deliver(now+4000);
  assert.equal(jobs()[0].caption_edit_outcome,'rejected');assert.equal(edits().length,1);
  assert.ok(state().next_send_at>=now+124000);
  await deliver(now+123999);assert.equal(sends().length,1);assert.equal(edits().length,1);
  assert.equal(personalEdit.calls.length,0);
  await poll(now+124000,[]);await deliver(now+124000);
  assert.equal(personalEdit.calls.length,1);assert.equal(sends().length,1);
  await deliver(now+127000);assert.equal(personalEdit.recheckCalls.length,1);assert.equal(sends().length,1);
  await deliver(now+130000);assert.equal(sends().length,2);assert.equal(edits().length,1);
});

for(const code of [401,403])test(`caption edit permission failure ${code} invalidates readiness without retrying its edit`,async()=>{
  await sentEmojiMismatch();telegram.editReplies.push({ok:false,code,retryAfter:0});await deliver(now+4000);
  assert.equal(jobs()[0].caption_edit_outcome,'rejected');assert.equal(state().ready_until,0);
  assert.match(state().last_error,code===401?/Token|凭据/:/目标|允许|权限/);
  await deliver(now+8000);assert.equal(personalEdit.calls.length,0);
  telegram.targetAllowed=false;await poll(now+64000,[]);await deliver(now+64000);
  assert.equal(personalEdit.calls.length,0);assert.equal(state().ready_until,0);
  telegram.targetAllowed=true;await poll(now+124000,[]);await deliver(now+124000);
  assert.equal(personalEdit.calls.length,1);assert.equal(edits().length,1);assert.equal(sends().length,1);
});

test('concurrent delivery ticks share the caption edit lease and cannot edit or send twice',async()=>{
  await sentEmojiMismatch();await poll(now+1000,[photo(2)]);
  telegram.editReplies.push(async parameters=>{
    await relay.deliverTelegramRelayOnce(decrypt,()=>now+4001);
    return ok({message_id:parameters.message_id,chat:{id:parameters.chat_id,type:'supergroup'},caption:parameters.caption,
      caption_entities:parameters.caption_entities,reply_markup:parameters.reply_markup});
  });
  await deliver(now+4000);
  assert.equal(edits().length,1);assert.equal(sends().length,1);assert.equal(jobs()[0].caption_edit_outcome,'preserved');
});

test('an expired in-flight edit lease becomes uncertain and is not reissued after process restart',async()=>{
  await sentEmojiMismatch();let clock=now+4000;
  telegram.editReplies.push(async parameters=>{clock+=61000;return ok({message_id:parameters.message_id,
    chat:{id:parameters.chat_id,type:'supergroup'},caption:parameters.caption,caption_entities:parameters.caption_entities,reply_markup:parameters.reply_markup});});
  await relay.deliverTelegramRelayOnce(decrypt,()=>clock);
  closeDatabase();await relay.deliverTelegramRelayOnce(decrypt,()=>clock);
  assert.equal(jobs()[0].caption_edit_outcome,'uncertain');assert.equal(jobs()[0].status,'sent');
  assert.equal(edits().length,1);assert.equal(sends().length,1);
});

test('settings changed during an edit keep the result unconfirmed and cannot trigger an old-target retry',async()=>{
  await sentEmojiMismatch();
  telegram.editReplies.push(async parameters=>{
    getSqlite().prepare("UPDATE telegram_promotion_settings SET relay_revision='changed-during-edit',relay_chat_id='@new_target'").run();
    return ok({message_id:parameters.message_id,chat:{id:parameters.chat_id,type:'supergroup'},caption:parameters.caption,
      caption_entities:parameters.caption_entities,reply_markup:parameters.reply_markup});
  });
  await deliver(now+4000);
  assert.equal(edits().length,1);assert.equal(edits()[0].parameters.chat_id,target);
  assert.equal(jobs()[0].status,'sent');assert.equal(jobs()[0].caption_edit_outcome,'uncertain');
  await deliver(now+8000);assert.equal(edits().length,1);assert.equal(sends().length,1);
});

test('caption edit diagnostics contain only aggregate counts, flags and enum outcomes',async t=>{
  const output=[];t.mock.method(console,'info',(...values)=>output.push(values));
  const original=await sentEmojiMismatch();await deliver(now+4000);
  const entry=output.find(values=>values[0]==='Telegram relay caption edit check.');
  assert.ok(entry);const details=JSON.parse(entry[1]);
  assert.deepEqual(Object.keys(details).sort(),['buttonsMatch','captionMatches','customEmojiPreserved','expectedCustomEmoji','linksSafe','outcome','returnedCustomEmoji']);
  assert.equal(details.outcome,'preserved');assert.equal(details.captionMatches,true);
  assert.equal(details.customEmojiPreserved,true);assert.equal(details.linksSafe,true);assert.equal(details.buttonsMatch,true);
  const encoded=JSON.stringify(entry);
  for(const sensitive of [original.caption,original.rewritten,token,ciphertext,String(source),'88770','100000000000000001'])assert.equal(encoded.includes(sensitive),false);
});

for(const change of ['deselect','disconnect','blocked'])test(`a personal source ${change} stops a queued caption edit`,async t=>{
  await sentEmojiMismatch({personal:true,t});
  if(change==='disconnect')getSqlite().prepare("UPDATE telegram_personal_account SET generation='revoked',stage='disconnected'").run();
  else getSqlite().prepare(`UPDATE telegram_personal_sources SET ${change==='blocked'?'blocked=1':'selected=0'} WHERE chat_id=?`).run(source);
  await deliver(now+4000);
  assert.equal(edits().length,0);assert.equal(sends().length,1);assert.equal(jobs()[0].caption_edit_outcome,'invalid');
});

for(const change of ['revision','token','target'])test(`a changed ${change} never edits an earlier destination message`,async()=>{
  await sentEmojiMismatch();
  if(change==='revision')getSqlite().prepare("UPDATE telegram_promotion_settings SET relay_revision='new-revision'").run();
  if(change==='token')getSqlite().prepare("UPDATE telegram_promotion_settings SET token_ciphertext='replaced-token'").run();
  if(change==='target')getSqlite().prepare("UPDATE telegram_promotion_settings SET relay_revision='new-target',relay_chat_id='@another_target'").run();
  await deliver(now+4000);assert.equal(edits().length,0);assert.equal(sends().length,1);
});

test('corrupt, unavailable or unsafe stored caption metadata cannot be used for a caption edit',async()=>{
  await sentEmojiMismatch();getSqlite().prepare("UPDATE telegram_relay_outbox SET caption_entities=''").run();
  await deliver(now+4000);assert.equal(edits().length,0);assert.equal(jobs()[0].caption_edit_outcome,'invalid');
  assert.match(jobs()[0].last_error,/旧|格式|Emoji/);
});

test('a stored bare foreign link is blocked before a new send or an edit',async()=>{
  configure();await poll(now,[photo()]);
  getSqlite().prepare("UPDATE telegram_relay_outbox SET caption='Visit foreign.example now',caption_entities='[]'").run();
  await deliver(now);assert.equal(sends().length,0);assert.equal(jobs()[0].status,'failed');
  assert.match(jobs()[0].last_error,/链接|入口/);
  getSqlite().prepare("UPDATE telegram_relay_outbox SET status='sent',message_id=88770,sent_at=?,last_error=?").run(now,
    'Telegram 返回的文案与提交原文不一致，请检查原消息格式。该消息不会自动重发。');
  await deliver(now+4000);assert.equal(edits().length,0);assert.equal(jobs()[0].caption_edit_outcome,'invalid');
});

test('unknown initial sends and malformed message references never guess a target message ID to edit',async()=>{
  configure();await poll(now,[photo()]);telegram.sends.push(null);await deliver(now);
  await deliver(now+4000);assert.equal(edits().length,0);assert.equal(jobs()[0].status,'unknown');
  getSqlite().prepare("UPDATE telegram_relay_outbox SET status='sent',message_id=1.5,sent_at=?,last_error=?").run(now,
    'Telegram 返回的文案与提交原文不一致，请检查原消息格式。该消息不会自动重发。');
  await deliver(now+8000);assert.equal(edits().length,0);assert.equal(jobs()[0].caption_edit_outcome,'invalid');
});

test('delivered anomalies older than 24 hours are not automatically edited',async()=>{
  await sentEmojiMismatch();getSqlite().prepare('UPDATE telegram_relay_outbox SET sent_at=?').run(now-86400001);
  await deliver(now+4000);assert.equal(edits().length,0);assert.equal(jobs()[0].caption_edit_attempted_at,0);
});

async function botEditStillChanged(options) {
  const original=await sentEmojiMismatch(options);
  telegram.editReplies.push(ok({message_id:88770,chat:{id:target,type:'supergroup'},caption:original.rewritten,
    caption_entities:[],reply_markup:{inline_keyboard:relayKeyboard()}}));
  await deliver(now+4000);assert.equal(jobs()[0].caption_edit_outcome,'changed');
  assert.match(jobs()[0].last_error,/未保留.*自定义 Emoji/);
  return original;
}

async function botEditRejected(options) {
  const original=await sentEmojiMismatch(options);
  telegram.editReplies.push({ok:false,code:400,retryAfter:0});
  await deliver(now+4000);assert.equal(jobs()[0].caption_edit_outcome,'rejected');
  assert.match(jobs()[0].last_error,/拒绝补正/);
  return original;
}

async function legacyBlockedCaption(options) {
  const original=await botEditRejected(options);
  getSqlite().prepare("UPDATE telegram_relay_outbox SET caption_edit_outcome='account_invalid',last_error=?").run(
    '原消息身份、设置或来源已改变，已停止自动补正文案；不会重复发送媒体。');
  return original;
}

test('a legacy blocked caption requires a leased read-only recheck before one strict personal edit',async()=>{
  const original=await legacyBlockedCaption();
  personalEdit.recheckResults.push(async input=>{
    assert.deepEqual(input,{targetChatId:target,relayRevision:'relay-revision',messageId:88770,
      caption:original.rewritten,captionEntities:original.expectedEntities});
    const job=jobs()[0];assert.equal(job.caption_edit_outcome,'account_rechecking');
    assert.ok(job.lease_until>now+8000);assert.equal(state().send_lease_id,job.lease_id);assert.equal(job.caption_edit_recheck_count,1);
    await relay.deliverTelegramRelayOnce(decrypt,()=>now+8001);
    assert.equal(personalEdit.calls.length,0);
    return {state:'ok',attempted:false,outcome:'ready',reason:'ready_to_edit'};
  });
  personalEdit.results.push({state:'ok',attempted:true,outcome:'preserved'});
  await deliver(now+8000);
  assert.equal(jobs()[0].caption_edit_outcome,'account_revalidated');assert.equal(personalEdit.calls.length,0);
  assert.equal(personalEdit.recheckCalls.length,1);assert.equal(sends().length,1);assert.equal(edits().length,1);
  await deliver(now+11000);assert.equal(jobs()[0].caption_edit_outcome,'account_preserved');assert.equal(personalEdit.calls.length,1);
  closeDatabase();await deliver(now+15000);await deliver(now+19000);
  assert.equal(personalEdit.recheckCalls.length,1);assert.equal(personalEdit.calls.length,1);assert.equal(sends().length,1);assert.equal(edits().length,1);
  assert.equal(jobs()[0].caption_edit_recheck_count,1);
});

test('a read-only recheck finding the original artwork already preserved needs no personal edit',async()=>{
  await legacyBlockedCaption();personalEdit.recheckResults.push({state:'ok',attempted:false,outcome:'preserved',reason:'already_preserved'});
  await deliver(now+8000);assert.equal(jobs()[0].caption_edit_outcome,'account_preserved');assert.equal(jobs()[0].last_error,'');
  closeDatabase();await deliver(now+12000);
  assert.equal(personalEdit.recheckCalls.length,1);assert.equal(personalEdit.calls.length,0);assert.equal(sends().length,1);
});

for(const outcome of ['invalid','rejected','unavailable'])test(`a legacy read-only recheck ending ${outcome} is final and cannot rearm another recheck or edit`,async()=>{
  await legacyBlockedCaption();personalEdit.recheckResults.push({state:outcome==='unavailable'?'unavailable':'ok',attempted:false,outcome,reason:'caption_mismatch'});
  await deliver(now+8000);
  assert.equal(jobs()[0].caption_edit_outcome,outcome==='unavailable'?'account_unavailable_final':'account_invalid_final');
  closeDatabase();await deliver(now+12000);await deliver(now+16000);
  assert.equal(personalEdit.recheckCalls.length,1);assert.equal(personalEdit.calls.length,0);assert.equal(sends().length,1);assert.equal(edits().length,1);
});

test('legacy recheck busy waits follow the account deadline and leave unrelated media free to send',async()=>{
  await legacyBlockedCaption();personalEdit.recheckResults.push(
    {state:'busy',attempted:false,outcome:'unavailable',retryAt:now+68000},
    {state:'ok',attempted:false,outcome:'ready',reason:'ready_to_edit'});
  personalEdit.results.push({state:'ok',attempted:true,outcome:'preserved'});
  await deliver(now+8000);assert.equal(jobs()[0].caption_edit_outcome,'account_recheck_waiting_1');
  assert.equal(jobs()[0].next_attempt_at,now+68000);assert.equal(state().next_send_at,now+11000);assert.equal(jobs()[0].caption_edit_recheck_count,1);
  await poll(now+9000,[photo(2)]);await deliver(now+11000);assert.equal(sends().length,2);
  closeDatabase();for(let at=now+16000;at<now+68000;at+=5000)await deliver(at);
  assert.equal(personalEdit.recheckCalls.length,1);assert.equal(personalEdit.calls.length,0);assert.equal(jobs()[0].caption_edit_recheck_count,1);
  await poll(now+68000,[]);await deliver(now+68000);assert.equal(jobs()[0].caption_edit_outcome,'account_revalidated');
  await deliver(now+71000);assert.equal(jobs()[0].caption_edit_outcome,'account_preserved');
  assert.equal(personalEdit.recheckCalls.length,2);assert.equal(personalEdit.calls.length,1);assert.equal(sends().length,2);
});

test('a continually busy legacy recheck stops after three independent bounded waits',async()=>{
  await legacyBlockedCaption();personalEdit.recheckResults.push(...Array.from({length:4},()=>({state:'backoff',attempted:false,outcome:'unavailable'})));
  for(let index=0;index<3;index++){
    await deliver(now+8000+index*5000);assert.equal(jobs()[0].caption_edit_outcome,`account_recheck_waiting_${index+1}`);
  }
  await deliver(now+23000);assert.equal(jobs()[0].caption_edit_outcome,'account_unavailable_final');
  closeDatabase();await deliver(now+28000);
  assert.equal(personalEdit.recheckCalls.length,4);assert.equal(personalEdit.calls.length,0);assert.equal(sends().length,1);
});

test('a lease-expired read-only recheck cannot promote the blocked post to an editor candidate',async()=>{
  await legacyBlockedCaption();let clock=now+8000;
  personalEdit.recheckResults.push(async()=>{clock+=61000;return {state:'ok',attempted:false,outcome:'ready',reason:'ready_to_edit'};});
  await relay.deliverTelegramRelayOnce(decrypt,()=>clock);closeDatabase();await relay.deliverTelegramRelayOnce(decrypt,()=>clock);
  assert.equal(jobs()[0].caption_edit_outcome,'account_invalid_final');assert.equal(personalEdit.recheckCalls.length,1);
  assert.equal(personalEdit.calls.length,0);assert.equal(sends().length,1);assert.equal(edits().length,1);
});

for(const when of ['before-recheck','during-recheck','after-recheck'])test(`source cancellation ${when} prevents legacy caption recovery from editing`,async t=>{
  await legacyBlockedCaption({personal:true,t});
  if(when==='before-recheck')getSqlite().prepare('UPDATE telegram_personal_sources SET selected=0 WHERE chat_id=?').run(source);
  personalEdit.recheckResults.push(async()=>{
    if(when==='during-recheck')getSqlite().prepare('UPDATE telegram_personal_sources SET selected=0 WHERE chat_id=?').run(source);
    return {state:'ok',attempted:false,outcome:'ready',reason:'ready_to_edit'};
  });
  await deliver(now+8000);
  if(when==='after-recheck')getSqlite().prepare('UPDATE telegram_personal_sources SET selected=0 WHERE chat_id=?').run(source);
  await deliver(now+12000);
  assert.equal(jobs()[0].caption_edit_outcome,'account_invalid_final');assert.equal(personalEdit.calls.length,0);
  assert.equal(personalEdit.recheckCalls.length,when==='before-recheck'?0:1);assert.equal(sends().length,1);
});

test('configuration changed during a legacy recheck cannot promote its old destination message',async()=>{
  await legacyBlockedCaption();personalEdit.recheckResults.push(async()=>{
    getSqlite().prepare("UPDATE telegram_promotion_settings SET relay_revision='changed-during-recheck'").run();
    return {state:'ok',attempted:false,outcome:'ready',reason:'ready_to_edit'};
  });
  await deliver(now+8000);assert.equal(jobs()[0].caption_edit_outcome,'account_invalid_final');
  await deliver(now+12000);assert.equal(personalEdit.recheckCalls.length,1);assert.equal(personalEdit.calls.length,0);
});

test('old-revision, old-date and uncertain media never become legacy recheck candidates',async()=>{
  await legacyBlockedCaption();const job=jobs()[0];
  for(const patch of ["revision='old-revision'",`sent_at=${now-86400001}`,"status='unknown'","caption_edit_outcome='account_uncertain'"]){
    getSqlite().prepare("UPDATE telegram_relay_outbox SET revision='relay-revision',sent_at=?,status='sent',caption_edit_outcome='account_invalid'").run(now);
    getSqlite().exec('UPDATE telegram_relay_outbox SET '+patch);
    await deliver(now+8000);
    assert.equal(personalEdit.recheckCalls.length,0);assert.equal(personalEdit.calls.length,0);
  }
  assert.equal(sends().length,1);assert.equal(edits().length,1);assert.equal(jobs()[0].id,job.id);
});

test('legacy recovery diagnostics are fixed aggregates and never expose unexpected helper text',async t=>{
  const output=[];t.mock.method(console,'info',(...values)=>output.push(values));const original=await legacyBlockedCaption();
  personalEdit.recheckResults.push({state:'ok',attempted:false,outcome:'invalid',reason:token+' '+original.caption});
  await deliver(now+8000);
  const entry=output.find(values=>values[0]==='Telegram relay blocked caption recovery.');const details=JSON.parse(entry[1]);
  assert.deepEqual(Object.keys(details).sort(),['attempted','expectedCustomEmoji','outcome','persisted','reason','verified','waitingCount']);
  assert.equal(details.outcome,'account_invalid_final');assert.equal(details.attempted,false);assert.equal(details.persisted,true);assert.equal(details.reason,'helper_preflight');
  const encoded=JSON.stringify(entry);for(const secret of [token,ciphertext,original.caption,String(source),'88770'])assert.equal(encoded.includes(secret),false);
});

test('a future first preflight invalid may revalidate once, and a second invalid stays final across restart',async()=>{
  await botEditRejected();personalEdit.results.push(
    {state:'ok',attempted:false,outcome:'invalid',reason:'caption_mismatch'},
    {state:'ok',attempted:false,outcome:'invalid',reason:'caption_mismatch'});
  personalEdit.recheckResults.push({state:'ok',attempted:false,outcome:'ready',reason:'ready_to_edit'});
  await deliver(now+8000);assert.equal(jobs()[0].caption_edit_outcome,'account_invalid');assert.equal(jobs()[0].caption_edit_recheck_count,0);
  closeDatabase();await deliver(now+12000);
  assert.equal(jobs()[0].caption_edit_outcome,'account_revalidated');assert.equal(jobs()[0].caption_edit_recheck_count,1);
  await deliver(now+15000);assert.equal(jobs()[0].caption_edit_outcome,'account_invalid_final');
  closeDatabase();await deliver(now+19000);await deliver(now+23000);
  assert.equal(jobs()[0].caption_edit_recheck_count,1);assert.equal(personalEdit.recheckCalls.length,1);assert.equal(personalEdit.calls.length,2);
  assert.equal(sends().length,1);assert.equal(edits().length,1);
});

test('a temporary preflight network failure can recover through one read-only validation without repeating an actual edit',async()=>{
  await botEditRejected();personalEdit.results.push(
    {state:'unavailable',attempted:false,outcome:'unavailable'},
    {state:'ok',attempted:true,outcome:'preserved'});
  personalEdit.recheckResults.push({state:'ok',attempted:false,outcome:'ready',reason:'ready_to_edit'});
  await deliver(now+8000);assert.equal(jobs()[0].caption_edit_outcome,'account_invalid');
  await deliver(now+12000);await deliver(now+15000);
  assert.equal(jobs()[0].caption_edit_outcome,'account_preserved');assert.equal(jobs()[0].caption_edit_recheck_count,1);
  closeDatabase();await deliver(now+19000);
  assert.equal(personalEdit.calls.length,2);assert.equal(personalEdit.recheckCalls.length,1);assert.equal(sends().length,1);assert.equal(edits().length,1);
});

test('an exhausted legacy-invalid counter cannot start another read-only recovery sequence',async()=>{
  await legacyBlockedCaption();getSqlite().prepare('UPDATE telegram_relay_outbox SET caption_edit_recheck_count=1').run();
  await deliver(now+8000);closeDatabase();await deliver(now+12000);
  assert.equal(personalEdit.recheckCalls.length,0);assert.equal(personalEdit.calls.length,0);assert.equal(jobs()[0].caption_edit_recheck_count,1);
});

test('a qualified personal account may repair custom emoji once after the Bot edit is confirmed changed',async()=>{
  const original=await botEditStillChanged();
  personalEdit.results.push({state:'ok',attempted:true,outcome:'preserved'});
  await deliver(now+8000);
  assert.equal(personalEdit.calls.length,1);
  assert.deepEqual(personalEdit.calls[0],{targetChatId:target,relayRevision:'relay-revision',messageId:88770,
    caption:original.rewritten,captionEntities:original.expectedEntities});
  assert.equal(jobs()[0].caption_edit_outcome,'account_preserved');assert.equal(jobs()[0].status,'sent');
  assert.equal(jobs()[0].last_error,'');assert.equal(sends().length,1);assert.equal(edits().length,1);
  closeDatabase();await deliver(now+12000);
  assert.equal(personalEdit.calls.length,1);assert.equal(sends().length,1);assert.equal(edits().length,1);
});

for(const outcome of ['changed','rejected','uncertain','invalid'])test(`an attempted personal caption edit with ${outcome} is terminal across restart`,async()=>{
  await botEditStillChanged();personalEdit.results.push({state:'ok',attempted:true,outcome});
  await deliver(now+8000);
  assert.equal(jobs()[0].caption_edit_outcome,outcome==='invalid'?'account_uncertain':`account_${outcome}`);assert.equal(jobs()[0].status,'sent');assert.ok(jobs()[0].last_error);
  closeDatabase();await deliver(now+12000);await deliver(now+16000);
  assert.equal(personalEdit.calls.length,1);assert.equal(sends().length,1);assert.equal(edits().length,1);
});

test('an exception after entering personal editing remains uncertain and never attempts it again',async()=>{
  await botEditStillChanged();personalEdit.results.push(new Error('private transport detail'));
  await deliver(now+8000);assert.equal(jobs()[0].caption_edit_outcome,'account_uncertain');
  closeDatabase();await deliver(now+12000);
  assert.equal(personalEdit.calls.length,1);assert.equal(sends().length,1);assert.equal(edits().length,1);
});

test('busy and backoff preflight waits are persisted without duplicate media and can lead to one qualified edit',async()=>{
  await botEditStillChanged();personalEdit.results.push(
    {state:'busy',attempted:false,outcome:'unavailable'},
    {state:'backoff',attempted:false,outcome:'unavailable'},
    {state:'ok',attempted:true,outcome:'preserved'});
  await deliver(now+8000);assert.equal(jobs()[0].caption_edit_outcome,'account_waiting_1');
  assert.equal(state().next_send_at,now+11000);assert.equal(jobs()[0].next_attempt_at,now+13000);
  closeDatabase();await deliver(now+12999);assert.equal(personalEdit.calls.length,1);
  await deliver(now+13000);assert.equal(jobs()[0].caption_edit_outcome,'account_waiting_2');
  await deliver(now+17999);assert.equal(personalEdit.calls.length,2);
  await deliver(now+18000);assert.equal(jobs()[0].caption_edit_outcome,'account_preserved');
  assert.equal(personalEdit.calls.length,3);assert.equal(sends().length,1);assert.equal(edits().length,1);
});

test('a sixty second account lease defers preflight without consuming bounded waits or clearing the lease',async t=>{
  await botEditStillChanged({personal:true,t});
  getSqlite().exec('ALTER TABLE telegram_personal_account ADD COLUMN lease_until INTEGER NOT NULL DEFAULT 0');
  getSqlite().prepare("UPDATE telegram_personal_account SET lease_until=? WHERE id='primary'").run(now+68000);
  personalEdit.results.push(
    {state:'busy',attempted:false,outcome:'unavailable',retryAt:now+68000},
    {state:'ok',attempted:true,outcome:'preserved'});
  await deliver(now+8000);
  assert.equal(jobs()[0].caption_edit_outcome,'account_waiting_1');
  assert.equal(jobs()[0].next_attempt_at,now+68000);assert.equal(state().next_send_at,now+11000);
  closeDatabase();
  for(let at=now+13000;at<now+68000;at+=5000)await deliver(at);
  assert.equal(personalEdit.calls.length,1);assert.equal(jobs()[0].caption_edit_outcome,'account_waiting_1');
  assert.equal(getSqlite().prepare("SELECT lease_until FROM telegram_personal_account WHERE id='primary'").get().lease_until,now+68000);
  await poll(now+68000,[]);await deliver(now+68000);
  assert.equal(jobs()[0].caption_edit_outcome,'account_preserved');assert.equal(personalEdit.calls.length,2);
  assert.equal(sends().length,1);assert.equal(edits().length,1);
  assert.equal(getSqlite().prepare("SELECT lease_until FROM telegram_personal_account WHERE id='primary'").get().lease_until,now+68000);
  closeDatabase();await deliver(now+72000);assert.equal(personalEdit.calls.length,2);
});

test('a deferred account repair leaves the ordinary media queue free after the global send interval',async()=>{
  await botEditStillChanged();
  personalEdit.results.push({state:'backoff',attempted:false,outcome:'unavailable',retryAt:now+68000});
  await deliver(now+8000);await poll(now+9000,[photo(2)]);
  assert.equal(jobs()[0].next_attempt_at,now+68000);assert.equal(state().next_send_at,now+11000);
  await deliver(now+11000);
  assert.equal(sends().length,2);assert.equal(sends()[1].parameters.photo,'photo-2');
  assert.equal(personalEdit.calls.length,1);assert.equal(edits().length,1);
  assert.equal(jobs()[0].caption_edit_outcome,'account_waiting_1');assert.equal(jobs()[1].status,'sent');
});

test('a known legacy unattempted unavailable repair reopens once and its new final outcome never reopens',async()=>{
  await botEditStillChanged();
  const unavailable='个人账号备用补正当前不可用，请检查本人账号连接和编辑权限；原媒体不会重复发送。';
  getSqlite().prepare("UPDATE telegram_relay_outbox SET caption_edit_outcome='account_unavailable',last_error=?").run(unavailable);
  personalEdit.results.push(
    {state:'busy',attempted:false,outcome:'unavailable',retryAt:now+18000},
    {state:'unavailable',attempted:false,outcome:'unavailable'});
  await deliver(now+8000);
  assert.equal(personalEdit.calls.length,1);assert.equal(jobs()[0].caption_edit_outcome,'account_waiting_1');
  assert.equal(jobs()[0].next_attempt_at,now+18000);
  closeDatabase();await deliver(now+13000);assert.equal(personalEdit.calls.length,1);
  await deliver(now+18000);
  assert.equal(personalEdit.calls.length,2);assert.equal(jobs()[0].caption_edit_outcome,'account_invalid');
  assert.equal(jobs()[0].last_error,unavailable);
  closeDatabase();await deliver(now+23000);await deliver(now+28000);
  assert.equal(jobs()[0].caption_edit_outcome,'account_unavailable_final');assert.equal(personalEdit.recheckCalls.length,1);
  assert.equal(personalEdit.calls.length,2);assert.equal(sends().length,1);assert.equal(edits().length,1);
});

test('a continually busy personal preflight stops after three bounded waits and never retries after restart',async()=>{
  await botEditStillChanged();personalEdit.results.push(...Array.from({length:4},()=>({state:'busy',attempted:false,outcome:'unavailable'})));
  for(let i=0;i<3;i++){
    await deliver(now+8000+i*5000);assert.equal(jobs()[0].caption_edit_outcome,`account_waiting_${i+1}`);
  }
  await deliver(now+23000);assert.equal(jobs()[0].caption_edit_outcome,'account_unavailable_final');
  closeDatabase();await deliver(now+28000);await deliver(now+33000);
  assert.equal(personalEdit.calls.length,4);assert.equal(sends().length,1);assert.equal(edits().length,1);
});

for(const state of ['disconnected','unavailable'])test(`an unavailable personal account (${state}) never retries actual editing and only a transient preflight permits one recheck`,async()=>{
  await botEditStillChanged();personalEdit.results.push({state,attempted:false,outcome:'unavailable'});
  await deliver(now+8000);assert.equal(jobs()[0].caption_edit_outcome,state==='unavailable'?'account_invalid':'account_unavailable_final');
  await deliver(now+12000);assert.equal(personalEdit.calls.length,1);assert.equal(sends().length,1);
  assert.equal(personalEdit.recheckCalls.length,state==='unavailable'?1:0);
  assert.equal(jobs()[0].caption_edit_outcome,'account_unavailable_final');
});

test('a personal preflight invalid result allows only its strict read-only recheck and never bypasses editing checks',async()=>{
  await botEditStillChanged();personalEdit.results.push({state:'unavailable',attempted:false,outcome:'invalid'});
  await deliver(now+8000);assert.equal(jobs()[0].caption_edit_outcome,'account_invalid');
  await deliver(now+12000);assert.equal(personalEdit.calls.length,1);assert.equal(sends().length,1);
});

test('a Bot edit rejection with expected custom emoji permits one qualified personal correction of the existing message',async()=>{
  const original=await botEditRejected();personalEdit.results.push({state:'ok',attempted:true,outcome:'preserved'});
  await deliver(now+8000);
  assert.equal(jobs()[0].caption_edit_outcome,'account_preserved');assert.equal(jobs()[0].last_error,'');
  assert.equal(personalEdit.calls.length,1);
  assert.deepEqual(personalEdit.calls[0],{targetChatId:target,relayRevision:'relay-revision',messageId:88770,
    caption:original.rewritten,captionEntities:original.expectedEntities});
  closeDatabase();await deliver(now+12000);await deliver(now+16000);
  assert.equal(personalEdit.calls.length,1);assert.equal(sends().length,1);assert.equal(edits().length,1);
});

test('a Bot edit rejection without expected custom emoji never invokes personal editing',async()=>{
  configure();await poll(now,[photo(1,{caption:'Plain original message'})]);
  telegram.sends.push(ok({message_id:88770,caption:'Changed original message'}));await deliver(now);
  telegram.editReplies.push({ok:false,code:400,retryAfter:0});await deliver(now+4000);
  await deliver(now+8000);
  assert.equal(jobs()[0].caption_edit_outcome,'rejected');assert.equal(personalEdit.calls.length,0);
  assert.equal(sends().length,1);assert.equal(edits().length,1);
});

test('personal terminal outcomes never reopen even when their stored error matches a Bot rejection',async()=>{
  await botEditRejected();
  for(const [index,outcome] of ['account_preserved','account_rejected','account_uncertain','account_changed','account_invalid_final','account_unavailable_final'].entries()){
    getSqlite().prepare('UPDATE telegram_relay_outbox SET caption_edit_outcome=?').run(outcome);
    await deliver(now+8000+index*4000);
    assert.equal(jobs()[0].caption_edit_outcome,outcome);assert.equal(personalEdit.calls.length,0);assert.equal(personalEdit.recheckCalls.length,0);
  }
  assert.equal(sends().length,1);assert.equal(edits().length,1);
});

test('a changed personal source blocks fallback after a rejected Bot edit',async t=>{
  await botEditRejected({personal:true,t});
  getSqlite().prepare('UPDATE telegram_personal_sources SET selected=0 WHERE chat_id=?').run(source);
  await deliver(now+8000);
  assert.equal(jobs()[0].caption_edit_outcome,'account_invalid');assert.equal(personalEdit.calls.length,0);
  assert.equal(sends().length,1);assert.equal(edits().length,1);
});

test('a rejected Bot edit still obeys personal preflight refusal without repeating its media or edit',async()=>{
  await botEditRejected();personalEdit.results.push({state:'unavailable',attempted:false,outcome:'invalid'});
  await deliver(now+8000);assert.equal(jobs()[0].caption_edit_outcome,'account_invalid');
  closeDatabase();await deliver(now+12000);
  assert.equal(personalEdit.calls.length,1);assert.equal(sends().length,1);assert.equal(edits().length,1);
});

test('non-emoji Bot edit mismatches do not qualify for the personal account fallback',async()=>{
  await botEditStillChanged();getSqlite().prepare('UPDATE telegram_relay_outbox SET last_error=?').run(
    'Telegram 返回的文案与提交原文不一致，请检查原消息格式。该消息不会自动重发。');
  await deliver(now+8000);assert.equal(personalEdit.calls.length,0);assert.equal(sends().length,1);
});

test('a fallback candidate without expected custom emoji is invalid and cannot start personal editing',async()=>{
  await botEditStillChanged();getSqlite().prepare("UPDATE telegram_relay_outbox SET caption='Plain words',caption_entities='[]'").run();
  await deliver(now+8000);assert.equal(jobs()[0].caption_edit_outcome,'account_invalid');
  assert.equal(personalEdit.calls.length,0);assert.equal(sends().length,1);
});

for(const change of ['revision','token','target'])test(`a ${change} change prevents personal fallback on an earlier target message`,async()=>{
  await botEditStillChanged();
  if(change==='revision')getSqlite().prepare("UPDATE telegram_promotion_settings SET relay_revision='new-revision'").run();
  if(change==='token')getSqlite().prepare("UPDATE telegram_promotion_settings SET token_ciphertext='replaced-token'").run();
  if(change==='target')getSqlite().prepare("UPDATE telegram_promotion_settings SET relay_revision='new-target',relay_chat_id='@new_target'").run();
  await deliver(now+8000);assert.equal(personalEdit.calls.length,0);assert.equal(sends().length,1);
});

for(const change of ['deselect','disconnect','blocked'])test(`a ${change} of the personal source stops the secondary account edit`,async t=>{
  await botEditStillChanged({personal:true,t});
  if(change==='disconnect')getSqlite().prepare("UPDATE telegram_personal_account SET generation='revoked',stage='disconnected'").run();
  else getSqlite().prepare(`UPDATE telegram_personal_sources SET ${change==='blocked'?'blocked=1':'selected=0'} WHERE chat_id=?`).run(source);
  await deliver(now+8000);assert.equal(personalEdit.calls.length,0);assert.equal(sends().length,1);
  assert.equal(jobs()[0].caption_edit_outcome,'account_invalid');
});

test('configuration changed during an attempted account edit leaves an uncertain terminal result',async()=>{
  await botEditStillChanged();personalEdit.results.push(async()=>{
    getSqlite().prepare("UPDATE telegram_promotion_settings SET relay_revision='changed-during-account-edit'").run();
    return {state:'ok',attempted:true,outcome:'preserved'};
  });
  await deliver(now+8000);assert.equal(jobs()[0].caption_edit_outcome,'account_uncertain');
  await deliver(now+12000);assert.equal(personalEdit.calls.length,1);assert.equal(sends().length,1);
});

test('the personal fallback owns the global delivery lease and prevents overlapping edits or sends',async()=>{
  await botEditStillChanged();await poll(now+5000,[photo(2)]);
  personalEdit.results.push(async()=>{
    await relay.deliverTelegramRelayOnce(decrypt,()=>now+8001);
    return {state:'ok',attempted:true,outcome:'preserved'};
  });
  await deliver(now+8000);assert.equal(personalEdit.calls.length,1);assert.equal(sends().length,1);assert.equal(edits().length,1);
  assert.equal(jobs()[0].caption_edit_outcome,'account_preserved');
});

test('an account attempt that outlives its lease becomes uncertain and is never attempted again after restart',async()=>{
  await botEditStillChanged();let clock=now+8000;
  personalEdit.results.push(async()=>{clock+=61000;return {state:'ok',attempted:true,outcome:'uncertain'};});
  await relay.deliverTelegramRelayOnce(decrypt,()=>clock);closeDatabase();
  await relay.deliverTelegramRelayOnce(decrypt,()=>clock);
  assert.equal(jobs()[0].caption_edit_outcome,'account_uncertain');assert.equal(personalEdit.calls.length,1);
  assert.equal(sends().length,1);assert.equal(edits().length,1);
});

test('personal fallback diagnostics contain only outcomes, flags and aggregate counts',async t=>{
  const output=[];t.mock.method(console,'info',(...values)=>output.push(values));
  const original=await botEditStillChanged();personalEdit.results.push({state:'ok',attempted:true,outcome:'preserved'});
  await deliver(now+8000);
  const entry=output.find(values=>values[0]==='Telegram relay account caption edit check.');assert.ok(entry);
  const details=JSON.parse(entry[1]);
  assert.deepEqual(Object.keys(details).sort(),['attempted','expectedCustomEmoji','outcome','persisted','reason','verified','waitingCount']);
  assert.equal(details.outcome,'account_preserved');assert.equal(details.attempted,true);assert.equal(details.verified,true);
  assert.equal(details.reason,'helper_result');assert.equal(details.persisted,true);
  const encoded=JSON.stringify(entry);
  for(const sensitive of [original.caption,original.rewritten,token,ciphertext,String(source),'88770','100000000000000001'])assert.equal(encoded.includes(sensitive),false);
});

test('local invalid relay metadata logs a fixed worker reason and a confirmed persistence result without invoking personal editing',async t=>{
  const output=[];t.mock.method(console,'info',(...values)=>output.push(values));
  await botEditStillChanged();getSqlite().prepare("UPDATE telegram_relay_outbox SET caption='Plain words',caption_entities='[]'").run();
  await deliver(now+8000);
  const entry=output.find(values=>values[0]==='Telegram relay account caption edit check.');
  const details=JSON.parse(entry[1]);
  assert.equal(details.reason,'worker_job_invalid');assert.equal(details.persisted,true);assert.equal(details.attempted,false);
  assert.equal(jobs()[0].caption_edit_outcome,'account_invalid');assert.equal(personalEdit.calls.length,0);
});

for(const afterImport of [false,true])test(`worker guard invalidation ${afterImport?'after':'before'} module import is distinct from helper preflight refusal`,async t=>{
  const output=[];t.mock.method(console,'info',(...values)=>output.push(values));
  await botEditStillChanged();getSqlite().prepare('UPDATE telegram_relay_state SET ready_until=?').run(now+8500);
  let reads=0;await relay.deliverTelegramRelayOnce(decrypt,()=>now+(jobs()[0].caption_edit_outcome==='account_attempting'&&++reads>=(afterImport?2:1)?9000:8000));
  const entry=output.find(values=>values[0]==='Telegram relay account caption edit check.');
  const details=JSON.parse(entry[1]);
  assert.equal(details.reason,'worker_guard_changed');assert.equal(details.persisted,true);assert.equal(details.attempted,false);
  assert.equal(jobs()[0].caption_edit_outcome,'account_invalid');assert.equal(personalEdit.calls.length,0);
});

test('a lost worker lease logs no persisted invalid transition and never invokes personal editing',async t=>{
  const output=[];t.mock.method(console,'info',(...values)=>output.push(values));
  await botEditStillChanged();
  await relay.deliverTelegramRelayOnce(decrypt,()=>now+(jobs()[0].caption_edit_outcome==='account_attempting'?69000:8000));
  const entry=output.find(values=>values[0]==='Telegram relay account caption edit check.');
  const details=JSON.parse(entry[1]);
  assert.equal(details.reason,'worker_lease_lost');assert.equal(details.persisted,false);assert.equal(details.attempted,false);
  assert.equal(jobs()[0].caption_edit_outcome,'account_attempting');assert.equal(personalEdit.calls.length,0);
});

for(const helperReason of ['caption_mismatch','private text token '+token])test(`helper diagnosis ${helperReason==='caption_mismatch'?'uses a fixed reason':'discards an unknown raw reason'}`,async t=>{
  const output=[];t.mock.method(console,'info',(...values)=>output.push(values));
  await botEditRejected();personalEdit.results.push({state:'ok',attempted:false,outcome:'invalid',reason:helperReason});
  await deliver(now+8000);
  const entry=output.find(values=>values[0]==='Telegram relay account caption edit check.');
  const details=JSON.parse(entry[1]);
  assert.equal(details.reason,helperReason==='caption_mismatch'?'caption_mismatch':'helper_preflight');
  assert.equal(details.persisted,true);assert.equal(details.attempted,false);assert.equal(jobs()[0].caption_edit_outcome,'account_invalid');
  assert.equal(JSON.stringify(entry).includes(token),false);
  await deliver(now+12000);assert.equal(personalEdit.calls.length,1);assert.equal(sends().length,1);assert.equal(edits().length,1);
});

test('a changed guard after helper execution logs the worker result boundary without changing the uncertain terminal rule',async t=>{
  const output=[];t.mock.method(console,'info',(...values)=>output.push(values));
  await botEditRejected();personalEdit.results.push(async()=>{
    getSqlite().prepare("UPDATE telegram_promotion_settings SET relay_revision='changed-after-helper'").run();
    return {state:'ok',attempted:true,outcome:'preserved',reason:'already_preserved'};
  });
  await deliver(now+8000);
  const details=JSON.parse(output.find(values=>values[0]==='Telegram relay account caption edit check.')[1]);
  assert.equal(details.reason,'worker_result_guard_changed');assert.equal(details.persisted,true);assert.equal(details.attempted,true);
  assert.equal(jobs()[0].caption_edit_outcome,'account_uncertain');assert.equal(sends().length,1);assert.equal(edits().length,1);
});

for(const busy of [false,true])test(`startup runs the independent blocked-post audit first${busy?' and bounds busy retries':''} without sending media`,async t=>{
  configure();const output=[],delays=[];t.mock.method(console,'info',(...values)=>output.push(values));
  const payload={state:busy?'busy':'ok',personalEditQualification:'qualified',posts:busy?[]:[{reason:'caption_mismatch',
    captionMatches:false,buttonsMatch:true,linksSafe:true,expectedCustomEmoji:26,expectedUtf16Length:123,actualUtf16Length:124}]};
  personalEdit.blockedResults.push(...Array.from({length:busy?18:1},()=>payload));
  const originalTimeout=globalThis.setTimeout;
  t.mock.method(globalThis,'setTimeout',(callback,delay,...args)=>{
    if(delay===5000||delay===20000){delays.push(delay);queueMicrotask(()=>callback(...args));return {unref(){return this;}};}
    return originalTimeout(callback,delay,...args);
  });
  t.mock.method(globalThis,'setInterval',()=>({unref(){return this;}}));
  delete globalThis.telegramRelayWorkerStarted;t.after(()=>delete globalThis.telegramRelayWorkerStarted);
  relay.startTelegramRelayWorker(decrypt);
  for(let tick=0;tick<10&&!personalEdit.auditOrder.includes('readback');tick++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(personalEdit.blockedCalls,busy?18:1);assert.equal(personalEdit.auditOrder[0],'blocked');
  assert.equal(delays.filter(delay=>delay===5000).length,busy?17:0);
  const blockedIndex=output.findIndex(values=>values[0]==='Telegram relay blocked caption audit.');
  const sourceIndex=output.findIndex(values=>values[0]==='Telegram relay source emoji audit.');
  assert.ok(blockedIndex>=0&&sourceIndex>blockedIndex);assert.deepEqual(JSON.parse(output[blockedIndex][1]),payload);
  assert.ok(personalEdit.auditOrder.includes('qualification'));assert.ok(personalEdit.auditOrder.includes('readback'));
  assert.equal(sends().length,0);assert.equal(edits().length,0);assert.equal(personalEdit.calls.length,0);
  const encoded=JSON.stringify(output[blockedIndex]);for(const secret of [token,ciphertext,String(source),String(target)])assert.equal(encoded.includes(secret),false);
});

test('captioned source channel_post updates use the same fixed links and destination channel support',async()=>{
  configure();telegram.targetType='channel';
  const input=photo();const message={...input.message,chat:{id:source,type:'channel'}};
  await poll(now,[{update_id:input.update_id,channel_post:message}]);
  assert.equal(jobs().length,1);await deliver();
  assert.equal(sends().length,1);assert.equal(sends()[0].parameters.chat_id,target);
  assert.deepEqual(sends()[0].parameters.reply_markup,{inline_keyboard:relayKeyboard()});
  assert.equal(sends()[0].parameters.caption.includes('source.example'),false);
});

test('captioned bot videos use sendVideo with the existing file ID without requiring a download',async()=>{
  configure();
  media.onDownload=async()=>{throw new Error('Bot video forwarding must not require getFile or a media download');};
  const input=video(1,{caption:'Video offer https://original.example/register',
    caption_entities:[{type:'url',offset:12,length:33}]});
  await poll(now,[input]);
  assert.equal(jobs().length,1);assert.equal(jobs()[0].media_kind,'video');
  await deliver(now);
  assert.equal(sends().length,1);const call=sends()[0];
  assert.equal(call.method,'sendVideo');assert.equal(call.parameters.video,'video-1');
  assert.equal(call.parameters.supports_streaming,true);
  assert.equal(call.upload,undefined);assert.equal(call.parameters.caption,'Video offer https://365freebonus.com/');
  assert.deepEqual(call.parameters.reply_markup,{inline_keyboard:relayKeyboard()});
  assert.equal(call.parameters.parse_mode,undefined);assert.equal(jobs()[0].status,'sent');
});

test('captioned videos in source channel posts retain the same owner destinations',async()=>{
  configure();telegram.targetType='channel';
  const input=video(3,{chat:{id:source,type:'channel'},caption:'Watch https://other.example/offer'});
  await poll(now,[{update_id:3,channel_post:input.message}]);await deliver(now);
  assert.equal(sends().length,1);assert.equal(sends()[0].method,'sendVideo');
  assert.equal(sends()[0].parameters.chat_id,target);
  assert.equal(sends()[0].parameters.caption,'Watch https://365freebonus.com/');
  assert.deepEqual(sends()[0].parameters.reply_markup,{inline_keyboard:relayKeyboard()});
});

test('text-only and captionless photo, video and animation posts are not forwarded',async()=>{
  configure();
  await poll(now,[photo(1,{caption:undefined}),video(2,{caption:undefined}),
    photo(3,{photo:undefined,animation:{file_id:'gif-3',file_unique_id:'gif-unique-3'},caption:'  '}),
    photo(4,{photo:undefined,caption:undefined,text:'Only words https://other.example/signup'})]);
  await deliver(now);
  assert.equal(jobs().length,0);assert.equal(sends().length,0);
  assert.equal(telegram.calls.some(call=>call.method==='sendMessage'),false);
});

test('same bot video identity is not resent with another caption',async()=>{
  configure();const first=video(1);
  await poll(now,[first]);await deliver(now);
  await poll(now+4000,[video(2,{caption:'A changed caption',video:first.message.video})]);
  await deliver(now+4000);
  assert.equal(jobs().length,1);assert.equal(sends().length,1);
});

test('identical file identity is not resent after caption changes or settings generation changes within the same MYT day',async()=>{
  configure();const first=photo();await poll(now,[first]);await deliver();
  const later=now+10000;
  getSqlite().prepare("UPDATE telegram_promotion_settings SET relay_revision='second-generation',relay_started_at=? WHERE id='primary'").run(later);
  await poll(later,[photo(2,{date:later/1000,caption:'Different caption and source link https://changed.example',photo:first.message.photo})]);
  await deliver(later);
  assert.equal(jobs().length,1);assert.equal(sends().length,1);
  assert.equal(jobs()[0].status,'sent');assert.ok(state().skipped_count>=1);
});

test('MYT date keys change at UTC 16:00 rather than UTC midnight',()=>{
  assert.equal(relay.relayDayKey(Date.parse('2027-01-16T15:59:59.999Z')),'2027-01-16');
  assert.equal(relay.relayDayKey(Date.parse('2027-01-16T16:00:00.000Z')),'2027-01-17');
  assert.equal(relay.relayDayKey(Date.parse('2027-01-17T00:00:00.000Z')),'2027-01-17');
});

const mytMidnight=Date.parse('2027-01-16T16:00:00.000Z');
for(const kind of ['photo','video','animation'])test(`a new Bot ${kind} post may reuse yesterday's media once while old source messages stay consumed`,async()=>{
  const before=mytMidnight-120000,after=mytMidnight+1000;
  configure({startedAt:before-10000});
  const input=(id,at,extra={})=>kind==='video'?video(id,{date:at/1000,...extra}):kind==='animation'
    ?photo(id,{date:at/1000,photo:undefined,animation:{file_id:'daily-gif',file_unique_id:'daily-gif-unique'},...extra}):photo(id,{date:at/1000,...extra});
  const first=input(1,before);await poll(before,[first]);await deliver(before);
  const attached=kind==='video'?{video:first.message.video}:kind==='photo'?{photo:first.message.photo}:{};
  await poll(after,[input(2,after,attached)]);await deliver(after);
  await poll(after+4000,[input(3,after+4000,attached),{...input(4,after+4000,attached),message:{...first.message,date:(after+4000)/1000}}]);
  await deliver(after+4000);
  assert.equal(sends().length,2);assert.deepEqual(jobs().map(job=>job.status),['sent','sent']);
  assert.equal(jobs()[0].source_message_id,1001);assert.equal(jobs()[1].source_message_id,1002);
  assert.equal(new Set(getSqlite().prepare('SELECT day_key FROM telegram_relay_media_keys').all().map(row=>row.day_key)).size,2);
});

test('daily photo content identity spans Bot and personal sources without making caption text a duplicate key',async t=>{
  await configureAccount(t);let clock=mytMidnight-120000;t.mock.method(Date,'now',()=>clock);
  await poll(clock,[]);
  const first=accountPhoto({sourceDate:clock/1000});await relay.enqueuePersonalRelayMedia(first);await deliver(clock);
  media.files.set('photo-1',first.bytes);media.files.set('photo-2',first.bytes);
  await poll(clock+4000,[photo(1,{date:(clock+4000)/1000,caption:'New words'})]);await deliver(clock+4000);
  assert.equal(sends().length,1);
  clock=mytMidnight+1000;await poll(clock,[photo(2,{date:clock/1000,caption:first.caption})]);await deliver(clock);
  assert.equal(sends().length,2);
  await relay.enqueuePersonalRelayMedia({...first,sourceMessageId:2002,sourceDate:clock/1000});
  assert.equal(jobs().filter(job=>job.status==='sent').length,2);
  clock+=4000;
  await relay.enqueuePersonalRelayMedia({...first,sourceMessageId:2003,sourceDate:clock/1000,
    sourceMediaId:'new-day-different-photo',bytes:Buffer.from('different-photo-same-caption')});await deliver(clock);
  assert.equal(sends().length,3);assert.equal(sends()[1].parameters.caption,sends()[2].parameters.caption);
});

test('a new personal post may reuse the prior day photo once but never replays the earlier source message',async t=>{
  await configureAccount(t);let clock=mytMidnight-120000;t.mock.method(Date,'now',()=>clock);
  await poll(clock,[]);const first=accountPhoto({sourceDate:clock/1000});
  await relay.enqueuePersonalRelayMedia(first);await deliver(clock);
  clock=mytMidnight+1000;await poll(clock,[]);
  await relay.enqueuePersonalRelayMedia({...first,sourceMessageId:2002,sourceDate:clock/1000});await deliver(clock);
  await relay.enqueuePersonalRelayMedia({...first,sourceDate:clock/1000});
  await relay.enqueuePersonalRelayMedia({...first,sourceMessageId:2003,sourceDate:clock/1000});
  assert.equal(sends().length,2);assert.deepEqual(jobs().map(job=>job.status),['sent','sent']);
});

for(const kind of ['photo','video'])test(`a retried prepared Bot ${kind} must reclaim the dispatch day instead of duplicating a newly reserved post`,async()=>{
  const before=mytMidnight-120000,after=mytMidnight+1000;configure({startedAt:before-10000});
  const first=kind==='photo'?photo(1,{date:before/1000}):video(1,{date:before/1000});
  await poll(before,[first]);telegram.sends.push({ok:false,code:429,retryAfter:1});await deliver(before);
  assert.equal(jobs()[0].status,'pending');
  const second={...first,update_id:2,message:{...first.message,message_id:1002,date:after/1000}};
  await poll(after,[second]);await deliver(after);await deliver(after+4000);
  assert.deepEqual(jobs().map(job=>job.status),['cancelled','sent']);assert.equal(sends().length,2);
});

test('a prepared personal job crossing midnight cannot send over a new-day reservation for the same photo',async t=>{
  await configureAccount(t);let clock=mytMidnight-120000;t.mock.method(Date,'now',()=>clock);
  await poll(clock,[]);const first=accountPhoto({sourceDate:clock/1000});await relay.enqueuePersonalRelayMedia(first);
  assert.equal(jobs()[0].media_prepared,1);
  clock=mytMidnight+1000;await poll(clock,[]);
  await relay.enqueuePersonalRelayMedia({...first,sourceMessageId:2002,sourceDate:clock/1000});
  await deliver(clock);await deliver(clock+4000);
  assert.deepEqual(jobs().map(job=>job.status),['cancelled','sent']);assert.equal(sends().length,1);
});

for(const uncertain of [false,true])test(`an in-flight midnight ${uncertain?'unconfirmed':'successful'} request blocks a new-day copy without repeating its media`,async()=>{
  let clock=mytMidnight-1000;configure({startedAt:clock-10000});
  const first=photo(1,{date:Math.floor(clock/1000)});await poll(clock,[first]);
  telegram.sends.push(async()=>{
    clock=mytMidnight+1000;
    await poll(clock,[photo(2,{date:clock/1000,photo:first.message.photo})]);
    return uncertain?null:ok({message_id:88770});
  });
  await relay.deliverTelegramRelayOnce(decrypt,()=>clock);
  await poll(clock+4000,[photo(3,{date:(clock+4000)/1000,photo:first.message.photo})]);await deliver(clock+4000);
  assert.equal(sends().length,1);assert.equal(jobs().length,1);assert.equal(jobs()[0].status,uncertain?'unknown':'sent');
  assert.ok(getSqlite().prepare('SELECT 1 FROM telegram_relay_media_keys WHERE day_key=? AND outbox_id=?').get(relay.relayDayKey(clock),jobs()[0].id));
  const tomorrow=mytMidnight+86400000+1000;
  await poll(tomorrow,[photo(4,{date:tomorrow/1000,photo:first.message.photo})]);await deliver(tomorrow);
  assert.equal(sends().length,2);assert.equal(jobs()[0].status,uncertain?'unknown':'sent');
});

test('a trusted completion before midnight releases its provisional next-day keys so new posts may send tomorrow',async()=>{
  const before=mytMidnight-1000,after=mytMidnight+4000;configure({startedAt:before-10000});
  const first=photo(1,{date:Math.floor(before/1000)});await poll(before,[first]);await deliver(before);
  assert.equal(getSqlite().prepare('SELECT COUNT(*) AS count FROM telegram_relay_media_keys WHERE day_key=?').get(relay.relayDayKey(after)).count,0);
  await poll(after,[photo(2,{date:after/1000,photo:first.message.photo})]);await deliver(after);
  assert.equal(sends().length,2);assert.ok(jobs().every(job=>job.status==='sent'));
});

test('an explicit Telegram rejection before midnight releases provisional future-day reservations',async()=>{
  const before=mytMidnight-1000,after=mytMidnight+4000;configure({startedAt:before-10000});
  const first=photo(1,{date:Math.floor(before/1000)});await poll(before,[first]);
  telegram.sends.push({ok:false,code:400,retryAfter:0});await deliver(before);
  assert.equal(jobs()[0].status,'failed');
  assert.equal(getSqlite().prepare('SELECT COUNT(*) AS count FROM telegram_relay_media_keys WHERE day_key=?').get(relay.relayDayKey(after)).count,0);
  await poll(after,[photo(2,{date:after/1000,photo:first.message.photo})]);await deliver(after);
  assert.equal(sends().length,2);assert.equal(jobs()[1].status,'sent');
});

for(const existingStatus of ['sent','unknown'])test(`late-request day protection never cancels or resets another ${existingStatus} post`,async()=>{
  let clock=mytMidnight-120000;configure({startedAt:clock-10000});
  const first=photo(1,{date:clock/1000});await poll(clock,[first]);
  telegram.sends.push(async()=>{
    clock=mytMidnight+1000;await poll(clock,[photo(2,{date:clock/1000,photo:first.message.photo})]);
    getSqlite().prepare('UPDATE telegram_relay_outbox SET status=?,message_id=?,sent_at=? WHERE id=?')
      .run(existingStatus,existingStatus==='sent'?88771:null,existingStatus==='sent'?clock:null,jobs()[1].id);
    return null;
  });
  await relay.deliverTelegramRelayOnce(decrypt,()=>clock);await deliver(clock+4000);
  assert.equal(jobs()[0].status,'unknown');assert.equal(jobs()[1].status,existingStatus);
  assert.equal(getSqlite().prepare('SELECT outbox_id FROM telegram_relay_media_keys WHERE day_key=? AND media_key=?')
    .get(relay.relayDayKey(clock),'file:photo:photo-unique-1').outbox_id,jobs()[1].id);
  assert.equal(sends().length,1);
});

for(const cancelled of [false,true])test(`a late response after ${cancelled?'settings cancellation':'lease expiry'} protects the current day and cancels only a competing pending copy`,async()=>{
  let clock=mytMidnight-120000;configure({startedAt:clock-10000});
  const first=photo(1,{date:clock/1000});await poll(clock,[first]);
  telegram.sends.push(async()=>{
    clock=mytMidnight+1000;await poll(clock,[photo(2,{date:clock/1000,photo:first.message.photo})]);
    assert.equal(jobs()[1].status,'pending');
    getSqlite().prepare('INSERT INTO telegram_relay_media_keys(day_key,media_key,outbox_id) VALUES(?,?,?)')
      .run(relay.relayDayKey(clock),'visual:photo:competing-copy-extra-alias',jobs()[1].id);
    if(cancelled)relay.cancelRelayPending(getSqlite(),clock);
    return ok({message_id:88770});
  });
  await relay.deliverTelegramRelayOnce(decrypt,()=>clock);await deliver(clock+4000);
  assert.equal(jobs()[0].status,'unknown');assert.equal(jobs()[1].status,'cancelled');assert.equal(sends().length,1);
  assert.equal(getSqlite().prepare('SELECT outbox_id FROM telegram_relay_media_keys WHERE day_key=? AND media_key=?')
    .get(relay.relayDayKey(clock),'file:photo:photo-unique-1').outbox_id,jobs()[0].id);
  assert.equal(getSqlite().prepare('SELECT outbox_id FROM telegram_relay_media_keys WHERE day_key=? AND media_key=?')
    .get(relay.relayDayKey(clock),'visual:photo:competing-copy-extra-alias').outbox_id,jobs()[0].id);
  await poll(clock+8000,[photo(3,{date:(clock+8000)/1000,photo:first.message.photo})]);await deliver(clock+8000);
  assert.equal(sends().length,1);
});

test('same downloaded image under different Telegram file IDs and captions sends only once',async()=>{
  configure();media.files.set('photo-1',Buffer.from('shared-image'));media.files.set('photo-2',Buffer.from('shared-image'));
  await poll(now,[photo(1),photo(2,{caption:'Completely different caption'})]);
  await deliver(now);await deliver(now+3000);
  assert.equal(sends().length,1);assert.deepEqual(jobs().map(job=>job.status),['sent','cancelled']);
  assert.ok(state().skipped_count>=1);
});

test('an uncertain image transmission reserves its image identity for the same MYT day across database reopening',async()=>{
  configure();media.files.set('photo-1',Buffer.from('shared-image'));media.files.set('photo-2',Buffer.from('shared-image'));
  await poll(now,[photo(1)]);telegram.sends.push(null);await deliver(now);
  assert.equal(jobs()[0].status,'unknown');closeDatabase();
  await poll(now+4000,[photo(2,{caption:'Retry via another caption'})]);await deliver(now+4000);
  assert.equal(sends().length,1);assert.deepEqual(jobs().map(job=>job.status),['unknown','cancelled']);
});

test('personal-account photos are multipart uploaded by the bot with rewritten links and original keyboards removed',async t=>{
  await configureAccount(t);const input=accountPhoto({hasSpoiler:true});
  assert.equal(await relay.enqueuePersonalRelayMedia(input),true);
  assert.equal(jobs().length,1);assert.equal(jobs()[0].origin,'account');
  assert.ok(jobs()[0].media_bytes.length>0);assert.equal(jobs()[0].file_id,'');
  await deliver(now);
  assert.equal(sends().length,1);const call=sends()[0];
  assert.equal(call.method,'sendPhoto');assert.equal(call.parameters.photo,undefined);
  assert.equal(call.parameters.has_spoiler,true);
  assert.equal(call.parameters.caption,'New photo https://365freebonus.com/');
  assert.deepEqual(call.parameters.reply_markup,{inline_keyboard:relayKeyboard()});
  assert.equal(call.upload.field,'photo');assert.deepEqual(call.upload.bytes,input.bytes);
  assert.equal(jobs()[0].status,'sent');assert.equal(jobs()[0].media_bytes,null);
});

test('personal-account animations are uploaded as animation bytes instead of personal media IDs',async t=>{
  await configureAccount(t);const input=accountPhoto({mediaKind:'animation',bytes:Buffer.from('animation-file'),sourceMediaId:'animation-file'});
  assert.equal(await relay.enqueuePersonalRelayMedia(input),true);await deliver(now);
  assert.equal(sends()[0].method,'sendAnimation');assert.equal(sends()[0].parameters.animation,undefined);
  assert.equal(sends()[0].upload.field,'animation');assert.deepEqual(sends()[0].upload.bytes,input.bytes);
  assert.equal(jobs()[0].media_bytes,null);
});

test('personal-account videos upload MP4 bytes with rewritten links and the fixed owner buttons',async t=>{
  await configureAccount(t);
  const input=accountPhoto({mediaKind:'video',bytes:Buffer.from('personal-mp4-video'),sourceMediaId:'personal-video-one',
    caption:'Watch this https://original.example/register',hasSpoiler:true});
  assert.equal(await relay.enqueuePersonalRelayMedia(input),true);
  assert.equal(jobs()[0].media_kind,'video');assert.equal(jobs()[0].origin,'account');
  await deliver(now);
  assert.equal(sends().length,1);const call=sends()[0];
  assert.equal(call.method,'sendVideo');assert.equal(call.parameters.video,undefined);
  assert.equal(call.parameters.supports_streaming,true);
  assert.equal(call.parameters.caption,'Watch this https://365freebonus.com/');
  assert.deepEqual(call.parameters.reply_markup,{inline_keyboard:relayKeyboard()});
  assert.equal(call.parameters.has_spoiler,true);assert.equal(call.upload.field,'video');
  assert.equal(call.upload.fileName,'video.mp4');assert.equal(call.upload.mime,'video/mp4');
  assert.deepEqual(call.upload.bytes,input.bytes);assert.equal(jobs()[0].status,'sent');
  assert.equal(jobs()[0].media_bytes,null);
});

test('personal-account videos above the upload size limit are consumed without queueing or sending',async t=>{
  await configureAccount(t);
  assert.equal(await relay.enqueuePersonalRelayMedia(accountPhoto({mediaKind:'video',
    bytes:Buffer.alloc(50*1024*1024+1),sourceMediaId:'oversized-video'})),true);
  assert.equal(jobs().length,0);await deliver(now);assert.equal(sends().length,0);
});

test('personal non-MP4 videos retain their media through a document upload with the same caption and buttons',async t=>{
  await configureAccount(t);
  const input=accountPhoto({mediaKind:'video',mimeType:'video/webm',sourceMediaId:'personal-webm-one',
    bytes:Buffer.from('personal-webm-video'),caption:'Video details https://other.example/video'});
  assert.equal(await relay.enqueuePersonalRelayMedia(input),true);
  assert.equal(jobs()[0].media_kind,'video');assert.equal(jobs()[0].mime_type,'video/webm');
  await deliver(now);
  assert.equal(sends().length,1);const call=sends()[0];
  assert.equal(call.method,'sendDocument');assert.equal(call.upload.field,'document');
  assert.equal(call.upload.mime,'video/webm');assert.match(call.upload.fileName,/\.webm$/);
  assert.equal(call.parameters.caption,'Video details https://365freebonus.com/');
  assert.deepEqual(call.parameters.reply_markup,{inline_keyboard:relayKeyboard()});
  assert.deepEqual(call.upload.bytes,input.bytes);assert.equal(jobs()[0].status,'sent');
  assert.equal(jobs()[0].media_bytes,null);
  assert.equal(telegram.calls.some(call=>call.method==='sendMessage'),false);
});

test('a definitively rejected video is never replaced with a text-only forward',async()=>{
  configure();await poll(now,[video(1)]);
  telegram.sends.push({ok:false,code:400,retryAfter:0});await deliver(now);
  assert.equal(sends().length,1);assert.equal(sends()[0].method,'sendVideo');
  assert.equal(jobs()[0].status,'failed');
  assert.equal(telegram.calls.some(call=>call.method==='sendMessage'),false);
});

test('personal-account enqueue rejects unselected, departed, stale-account and stale-relay sources',async t=>{
  await configureAccount(t);
  assert.equal(await relay.enqueuePersonalRelayMedia(accountPhoto({accountGeneration:'old-account'})),false);
  assert.equal(await relay.enqueuePersonalRelayMedia(accountPhoto({relayRevision:'old-relay'})),false);
  accountSource(source,{selected:0});assert.equal(await relay.enqueuePersonalRelayMedia(accountPhoto()),false);
  accountSource(source,{joined:0});assert.equal(await relay.enqueuePersonalRelayMedia(accountPhoto()),false);
  assert.equal(await relay.enqueuePersonalRelayMedia(accountPhoto({sourceChatId:source-1})),false);
  assert.equal(jobs().length,0);
});

test('personal-account selection and activation boundaries consume old media without importing history',async t=>{
  await configureAccount(t);accountSource(source,{selectedAt:now});
  assert.equal(await relay.enqueuePersonalRelayMedia(accountPhoto({sourceDate:now/1000-1})),true);
  assert.equal(jobs().length,0);
  accountSource(source,{selectedAt:now-60_000});
  assert.equal(await relay.enqueuePersonalRelayMedia(accountPhoto({sourceDate:now/1000-20})),true);
  assert.equal(jobs().length,0,'relay activation boundary also excludes historical media');
  assert.equal(await relay.enqueuePersonalRelayMedia(accountPhoto({sourceDate:now/1000})),true);
  assert.equal(jobs().length,1);
});

test('personal-account text only, empty media, captionless media and destination echo are consumed without sending',async t=>{
  await configureAccount(t);
  for(const overrides of [{caption:'  '},{bytes:Buffer.alloc(0)},{sourceChatId:target}]) {
    if(overrides.sourceChatId)accountSource(target);
    assert.equal(await relay.enqueuePersonalRelayMedia(accountPhoto(overrides)),true);
  }
  assert.equal(jobs().length,0);await deliver(now);assert.equal(sends().length,0);
});

test('deselecting a queued personal source cancels its job and releases stored media without affecting bot jobs',async t=>{
  await configureAccount(t);assert.equal(await relay.enqueuePersonalRelayMedia(accountPhoto()),true);
  await poll(now+1000,[photo()]);accountSource(source,{selected:0});
  await deliver(now+1000);
  assert.deepEqual(jobs().map(job=>job.status),['cancelled','sent']);
  assert.equal(jobs()[0].media_bytes,null);assert.equal(sends().length,1);
  assert.equal(sends()[0].parameters.photo,'photo-1');
});

test('disconnecting a queued personal account cancels its media before the bot can send',async t=>{
  await configureAccount(t);assert.equal(await relay.enqueuePersonalRelayMedia(accountPhoto()),true);
  getSqlite().prepare("UPDATE telegram_personal_account SET stage='disconnected' WHERE id='primary'").run();
  await deliver(now);assert.equal(sends().length,0);assert.equal(jobs()[0].status,'cancelled');assert.equal(jobs()[0].media_bytes,null);
});

test('different personal photos sharing one caption and album both forward while replaying a source message does not',async t=>{
  await configureAccount(t);const first=accountPhoto({mediaGroupId:'personal-album'});
  assert.equal(await relay.enqueuePersonalRelayMedia(first),true);
  assert.equal(await relay.enqueuePersonalRelayMedia(accountPhoto({mediaGroupId:'personal-album',sourceMessageId:2002,
    sourceMediaId:'different-personal-photo',bytes:Buffer.from('different-personal-photo')})),true);
  assert.equal(await relay.enqueuePersonalRelayMedia({...first,sourceMediaId:'changed-source-id',bytes:Buffer.from('changed-source-bytes')}),true);
  assert.equal(jobs().length,2);
  await deliver(now);await deliver(now+3000);
  assert.equal(sends().length,2);assert.ok(jobs().every(job=>job.status==='sent'));
  assert.equal(sends()[0].parameters.caption,sends()[1].parameters.caption);
});

test('a personal album still skips repeated photo content even under a different media ID and caption',async t=>{
  await configureAccount(t);
  assert.equal(await relay.enqueuePersonalRelayMedia(accountPhoto({mediaGroupId:'personal-repeated-photo'})),true);
  assert.equal(await relay.enqueuePersonalRelayMedia(accountPhoto({mediaGroupId:'personal-repeated-photo',sourceMessageId:2002,
    sourceMediaId:'reuploaded-personal-photo',caption:'A different caption'})),true);
  await deliver(now);await deliver(now+3000);
  assert.equal(jobs().length,1);assert.equal(sends().length,1);
});

test('the same caption from Bot and personal sources permits different photo content from both sources',async t=>{
  await configureAccount(t);const caption='Same caption https://source.example/offer';
  assert.equal(await relay.enqueuePersonalRelayMedia(accountPhoto({caption})),true);
  await poll(now+1000,[photo(1,{caption})]);assert.equal(jobs().length,2);
  await deliver(now+1000);await deliver(now+4000);
  assert.equal(sends().length,2);assert.ok(jobs().every(job=>job.status==='sent'));
  assert.equal(sends()[0].parameters.caption,sends()[1].parameters.caption);
});

test('same personal photo across selected channels is deduplicated independently of caption or media ID',async t=>{
  await configureAccount(t);accountSource(source-1);
  assert.equal(await relay.enqueuePersonalRelayMedia(accountPhoto()),true);
  assert.equal(await relay.enqueuePersonalRelayMedia(accountPhoto({sourceChatId:source-1,sourceMessageId:2002,sourceMediaId:'new-file-id',caption:'Different wording'})),true);
  assert.equal(jobs().length,1);await deliver(now);assert.equal(sends().length,1);
});

test('bot and personal account sources share the same persistent media-content deduplication ledger',async t=>{
  await configureAccount(t);media.files.set('photo-1',accountPhoto().bytes);
  await poll(now+1000,[photo()]);await deliver(now+1000);
  assert.equal(await relay.enqueuePersonalRelayMedia(accountPhoto()),true);
  assert.equal(jobs().length,1);assert.equal(sends().length,1);
  accountSource(source-1);
  assert.equal(await relay.enqueuePersonalRelayMedia(accountPhoto({sourceChatId:source-1,sourceMediaId:'different-id',caption:'New text'})),true);
  assert.equal(jobs().length,1);
});

test('queued personal media also prevents a duplicate bot upload before the personal job sends',async t=>{
  await configureAccount(t);assert.equal(await relay.enqueuePersonalRelayMedia(accountPhoto()),true);
  media.files.set('photo-1',accountPhoto().bytes);await poll(now+1000,[photo()]);
  await deliver(now+1000);await deliver(now+4000);
  assert.equal(sends().length,1);assert.deepEqual(jobs().map(job=>job.status),['sent','cancelled']);
});

test('personal media queue capacity applies backpressure instead of acknowledging media that cannot be stored',async t=>{
  await configureAccount(t);
  getSqlite().exec(`INSERT INTO telegram_relay_outbox(source_chat_id,source_message_id,fingerprint,queued_at,revision,media_kind,file_id,file_unique_id,caption,next_attempt_at,media_bytes)
    VALUES(-1007654321,1,'capacity-fixture',${now},'relay-revision','photo','','capacity','x',${now},zeroblob(67108864));`);
  assert.equal(await relay.enqueuePersonalRelayMedia(accountPhoto()),false);
  assert.equal(jobs().length,1);assert.equal(sends().length,0);
});

test('personal enqueue revalidates source and settings after asynchronous media identity work',async t=>{
  await configureAccount(t);
  media.onIdentity=async()=>getSqlite().prepare("UPDATE telegram_personal_sources SET selected=0 WHERE chat_id=?").run(source);
  assert.equal(await relay.enqueuePersonalRelayMedia(accountPhoto()),false);assert.equal(jobs().length,0);
  accountSource();media.onIdentity=async()=>getSqlite().prepare("UPDATE telegram_promotion_settings SET relay_revision='changed-during-hash' WHERE id='primary'").run();
  assert.equal(await relay.enqueuePersonalRelayMedia(accountPhoto()),false);assert.equal(jobs().length,0);
});

test('bot delivery rechecks settings after downloading media and never sends to a stale target',async()=>{
  configure();await poll(now,[photo()]);
  media.onDownload=async()=>{getSqlite().prepare("UPDATE telegram_promotion_settings SET relay_revision='new-destination' WHERE id='primary'").run();return Buffer.from('downloaded');};
  await deliver(now);assert.equal(sends().length,0);assert.equal(jobs()[0].status,'cancelled');
  assert.equal(state().send_lease_until,0);
});

test('personal uncertain delivery removes stored bytes but preserves deduplication after restart',async t=>{
  await configureAccount(t);assert.equal(await relay.enqueuePersonalRelayMedia(accountPhoto()),true);
  telegram.sends.push(null);await deliver(now);assert.equal(jobs()[0].status,'unknown');assert.equal(jobs()[0].media_bytes,null);
  closeDatabase();accountSource(source-1);
  assert.equal(await relay.enqueuePersonalRelayMedia(accountPhoto({sourceChatId:source-1,sourceMediaId:'reuploaded-image',caption:'Another text'})),true);
  await deliver(now+4000);assert.equal(sends().length,1);assert.equal(jobs().length,1);
});

test('a source reselected during asynchronous photo hashing cannot enqueue the previous selection message',async t=>{
  await configureAccount(t);
  media.onIdentity=async()=>accountSource(source,{selectedAt:now});
  assert.equal(await relay.enqueuePersonalRelayMedia(accountPhoto()),false);
  assert.equal(jobs().length,0);assert.equal(sends().length,0);
});

test('a queued personal photo from an earlier selection is cancelled and purged after reselecting its channel',async t=>{
  await configureAccount(t);assert.equal(await relay.enqueuePersonalRelayMedia(accountPhoto()),true);
  accountSource(source,{selectedAt:now+1});
  await deliver(now+1000);
  assert.equal(sends().length,0);assert.equal(jobs()[0].status,'cancelled');assert.equal(jobs()[0].media_bytes,null);
});

test('configuration cancellation during an in-flight send preserves uncertain image deduplication',async()=>{
  configure();const original=photo();await poll(now,[original]);
  telegram.sends.push(async()=>{
    getSqlite().prepare("UPDATE telegram_promotion_settings SET relay_enabled=0 WHERE id='primary'").run();
    relay.cancelRelayPending(getSqlite());
    return ok({message_id:654321,date:now/1000});
  });
  await deliver(now);
  assert.equal(sends().length,1);assert.equal(jobs()[0].status,'unknown');
  assert.ok(jobs()[0].last_error);assert.equal(jobs()[0].media_bytes,null);
  const resumed=now+4000;
  getSqlite().prepare("UPDATE telegram_promotion_settings SET relay_enabled=1,relay_revision='re-enabled',relay_started_at=? WHERE id='primary'").run(resumed);
  await poll(resumed,[photo(2,{date:resumed/1000,caption:'Different caption',photo:original.message.photo})]);
  await deliver(resumed);
  assert.equal(sends().length,1);assert.equal(jobs().length,1,'uncertain transmission must keep its media key reservation');
});

test('v18 upgrade preserves settings and PIN while seeding permanent image identities from existing sent jobs',async()=>{
  configure();const original=photo();await poll(now,[original]);await deliver(now);
  const db=getSqlite();
  db.prepare("INSERT INTO notes_vault_settings(id,pin_hash,revision,created_at,updated_at) VALUES('primary','persistent-pin-hash','persistent-vault',11,12)").run();
  db.prepare(`INSERT INTO telegram_relay_outbox(source_chat_id,source_message_id,fingerprint,queued_at,revision,media_kind,file_id,file_unique_id,caption,next_attempt_at)
    VALUES(? ,2222,'old-caption-fingerprint',?,'relay-revision','photo','old-duplicate-file','photo-unique-1','Old repeated caption',?)`).run(source-1,now,now);
  const settingsBefore={...db.prepare("SELECT * FROM telegram_promotion_settings WHERE id='primary'").get()};
  const vaultBefore={...db.prepare("SELECT * FROM notes_vault_settings WHERE id='primary'").get()};
  const stateBefore={...db.prepare("SELECT * FROM telegram_relay_state WHERE id='primary'").get()};
  const sentId=jobs()[0].id;
  db.exec('DROP INDEX telegram_relay_caption_edits; DROP TABLE telegram_relay_media_keys');
  for(const column of ['origin','account_generation','media_bytes','content_hash','visual_hash','media_prepared','mime_type','caption_entities','caption_edit_attempted_at','caption_edit_outcome','caption_edit_recheck_count']) {
    db.exec(`ALTER TABLE telegram_relay_outbox DROP COLUMN ${column}`);
  }
  db.exec('PRAGMA user_version=18');closeDatabase();
  const migrated=getSqlite();
  assert.equal(migrated.prepare('PRAGMA user_version').get().user_version,25);
  assert.deepEqual({...migrated.prepare("SELECT * FROM telegram_promotion_settings WHERE id='primary'").get()},settingsBefore);
  assert.deepEqual({...migrated.prepare("SELECT * FROM notes_vault_settings WHERE id='primary'").get()},vaultBefore);
  assert.deepEqual({...migrated.prepare("SELECT * FROM telegram_relay_state WHERE id='primary'").get()},stateBefore);
  assert.equal(migrated.prepare("SELECT outbox_id FROM telegram_relay_media_keys WHERE media_key='file:photo:photo-unique-1'").get().outbox_id,sentId);
  assert.deepEqual(jobs().map(job=>job.status),['sent','cancelled']);
  await poll(now+4000,[photo(3,{caption:'New caption from another group',photo:original.message.photo,chat:{id:source-2,type:'supergroup'}})]);
  await deliver(now+4000);assert.equal(sends().length,1);assert.equal(jobs().length,2);
});

test('v19 upgrade preserves queued media bytes, permanent identities, settings and PIN while permitting videos',async t=>{
  await configureAccount(t);
  await relay.enqueuePersonalRelayMedia(accountPhoto());await deliver(now);
  await relay.enqueuePersonalRelayMedia(accountPhoto({sourceMessageId:2002,mediaGroupId:'pending-album',
    sourceMediaId:'pending-personal-photo',bytes:Buffer.from('pending-personal-photo')}));
  await poll(now+1000,[photo(1)]);
  const db=getSqlite();
  db.prepare("INSERT INTO notes_vault_settings(id,pin_hash,revision,created_at,updated_at) VALUES('primary','retained-pin-hash','retained-vault',21,22)").run();
  const rowsBefore=jobs().map(({caption_entities,...row})=>({...row}));
  const keysBefore=db.prepare('SELECT * FROM telegram_relay_media_keys ORDER BY media_key').all().map(row=>({...row}));
  const settingsBefore={...db.prepare("SELECT * FROM telegram_promotion_settings WHERE id='primary'").get()};
  const stateBefore={...db.prepare("SELECT * FROM telegram_relay_state WHERE id='primary'").get()};
  const vaultBefore={...db.prepare("SELECT * FROM notes_vault_settings WHERE id='primary'").get()};
  const columns=db.prepare('PRAGMA table_info(telegram_relay_outbox)').all().map(row=>row.name).filter(name=>!['mime_type','caption_entities','caption_edit_attempted_at','caption_edit_outcome','caption_edit_recheck_count'].includes(name));
  restoreLegacyMediaKeys(db);
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE telegram_relay_outbox_v19 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,source_chat_id INTEGER NOT NULL,source_message_id INTEGER NOT NULL,
      media_group_id TEXT NOT NULL DEFAULT '',fingerprint TEXT NOT NULL,queued_at INTEGER NOT NULL,revision TEXT NOT NULL,
      media_kind TEXT NOT NULL CHECK(media_kind IN ('photo','animation')),file_id TEXT NOT NULL,file_unique_id TEXT NOT NULL,
      caption TEXT NOT NULL,has_spoiler INTEGER NOT NULL DEFAULT 0 CHECK(has_spoiler IN (0,1)),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','unknown','cancelled')),
      attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL DEFAULT 0,lease_id TEXT NOT NULL DEFAULT '',
      lease_until INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '',sent_at INTEGER,message_id INTEGER,
      origin TEXT NOT NULL DEFAULT 'bot',account_generation TEXT NOT NULL DEFAULT '',media_bytes BLOB,
      content_hash TEXT NOT NULL DEFAULT '',visual_hash TEXT NOT NULL DEFAULT '',media_prepared INTEGER NOT NULL DEFAULT 0,
      UNIQUE(source_chat_id,source_message_id));
    INSERT INTO telegram_relay_outbox_v19 (${columns.join(',')}) SELECT ${columns.join(',')} FROM telegram_relay_outbox;
    DROP TABLE telegram_relay_outbox;
    ALTER TABLE telegram_relay_outbox_v19 RENAME TO telegram_relay_outbox;
    CREATE UNIQUE INDEX telegram_relay_album ON telegram_relay_outbox(source_chat_id,media_group_id) WHERE media_group_id<>'';
    CREATE INDEX telegram_relay_due ON telegram_relay_outbox(status,next_attempt_at);
    CREATE INDEX telegram_relay_fingerprint ON telegram_relay_outbox(fingerprint,queued_at);
    PRAGMA user_version=19;COMMIT;`);
  assert.throws(()=>db.prepare(`INSERT INTO telegram_relay_outbox(source_chat_id,source_message_id,fingerprint,
    queued_at,revision,media_kind,file_id,file_unique_id,caption) VALUES(? ,9999,'before-video',?,'relay-revision','video','v','vu','Video')`).run(source,now),/CHECK/);
  closeDatabase();const migrated=getSqlite();
  assert.equal(migrated.prepare('PRAGMA user_version').get().user_version,25);
  assert.deepEqual(jobs().map(({caption_entities,...row})=>({...row})),rowsBefore);
  assert.ok(jobs().every(row=>row.caption_entities===''));
  assert.deepEqual(migrated.prepare('SELECT * FROM telegram_relay_media_keys ORDER BY media_key').all().map(row=>({...row})),keysBefore);
  assert.deepEqual({...migrated.prepare("SELECT * FROM telegram_promotion_settings WHERE id='primary'").get()},settingsBefore);
  assert.deepEqual({...migrated.prepare("SELECT * FROM telegram_relay_state WHERE id='primary'").get()},stateBefore);
  assert.deepEqual({...migrated.prepare("SELECT * FROM notes_vault_settings WHERE id='primary'").get()},vaultBefore);
  const inserted=migrated.prepare(`INSERT INTO telegram_relay_outbox(source_chat_id,source_message_id,fingerprint,
    queued_at,revision,media_kind,file_id,file_unique_id,caption) VALUES(? ,9999,'after-video',?,'relay-revision','video','v','vu','Video')`).run(source,now);
  assert.ok(Number(inserted.lastInsertRowid)>Math.max(...rowsBefore.map(row=>row.id)));
  assert.equal(jobs().at(-1).media_kind,'video');
  assert.doesNotThrow(()=>migrated.prepare(`INSERT INTO telegram_relay_outbox(source_chat_id,source_message_id,media_group_id,
    fingerprint,queued_at,revision,media_kind,file_id,file_unique_id,caption) VALUES(? ,9998,'pending-album','album-copy',?,'relay-revision','photo','p','pu','Photo')`).run(source,now));
  assert.throws(()=>migrated.prepare(`INSERT INTO telegram_relay_outbox(source_chat_id,source_message_id,media_group_id,
    fingerprint,queued_at,revision,media_kind,file_id,file_unique_id,caption) VALUES(? ,9998,'another-album','same-source-event',?,'relay-revision','photo','p2','pu2','Photo')`).run(source,now),/UNIQUE/);
});

test('v20 upgrade marks unavailable legacy caption entities without changing jobs, media keys, settings or PIN',async t=>{
  await configureAccount(t);
  await relay.enqueuePersonalRelayMedia(accountPhoto());
  await relay.enqueuePersonalRelayMedia(accountPhoto({mediaKind:'video',mimeType:'video/webm',sourceMessageId:3002,
    sourceMediaId:'v20-pending-video',bytes:Buffer.from('v20-video-bytes')}));
  const db=getSqlite();
  db.prepare("INSERT INTO notes_vault_settings(id,pin_hash,revision,created_at,updated_at) VALUES('primary','v20-pin','v20-vault',31,32)").run();
  const beforeJobs=jobs().map(({caption_entities,...row})=>({...row}));
  const beforeKeys=db.prepare('SELECT * FROM telegram_relay_media_keys ORDER BY media_key').all().map(row=>({...row}));
  const beforeSettings={...db.prepare("SELECT * FROM telegram_promotion_settings WHERE id='primary'").get()};
  const beforeState={...db.prepare("SELECT * FROM telegram_relay_state WHERE id='primary'").get()};
  const beforePin={...db.prepare("SELECT * FROM notes_vault_settings WHERE id='primary'").get()};
  restoreLegacyMediaKeys(db);
  db.exec('DROP INDEX telegram_relay_caption_edits; ALTER TABLE telegram_relay_outbox DROP COLUMN caption_edit_attempted_at; ALTER TABLE telegram_relay_outbox DROP COLUMN caption_edit_outcome; ALTER TABLE telegram_relay_outbox DROP COLUMN caption_entities; PRAGMA user_version=20');
  closeDatabase();const migrated=getSqlite();
  assert.equal(migrated.prepare('PRAGMA user_version').get().user_version,25);
  assert.deepEqual(jobs().map(({caption_entities,...row})=>({...row})),beforeJobs);
  assert.ok(jobs().every(row=>row.caption_entities===''),'old queues mark unavailable original custom emoji metadata instead of fabricating an empty entity list');
  assert.deepEqual(migrated.prepare('SELECT * FROM telegram_relay_media_keys ORDER BY media_key').all().map(row=>({...row})),beforeKeys);
  assert.deepEqual({...migrated.prepare("SELECT * FROM telegram_promotion_settings WHERE id='primary'").get()},beforeSettings);
  assert.deepEqual({...migrated.prepare("SELECT * FROM telegram_relay_state WHERE id='primary'").get()},beforeState);
  assert.deepEqual({...migrated.prepare("SELECT * FROM notes_vault_settings WHERE id='primary'").get()},beforePin);
  await deliver(now);await deliver(now+4000);
  assert.equal(sends().length,0,'legacy jobs without original emoji metadata must never be re-created as plain text');
  assert.ok(jobs().every(row=>row.status==='failed'&&row.last_error));
});

test('v21 upgrade preserves sent messages, pending media, identities, settings and sequence while adding one-time caption edit state',async t=>{
  await configureAccount(t);const original=originalEmojiCaption();
  await relay.enqueuePersonalRelayMedia(accountPhoto({caption:original.caption,captionEntities:original.entities}));
  telegram.sends.push(ok({message_id:87690,caption:original.rewritten+' changed',caption_entities:original.expectedEntities}));
  await deliver(now);
  await relay.enqueuePersonalRelayMedia(accountPhoto({sourceMessageId:3002,sourceMediaId:'v21-pending',bytes:Buffer.from('v21-pending-bytes')}));
  const db=getSqlite();
  db.prepare("INSERT INTO notes_vault_settings(id,pin_hash,revision,created_at,updated_at) VALUES('primary','v21-pin','v21-vault',41,42)").run();
  db.prepare("UPDATE sqlite_sequence SET seq=9000 WHERE name='telegram_relay_outbox'").run();
  const beforeJobs=jobs().map(({caption_edit_attempted_at,caption_edit_outcome,...row})=>({...row}));
  const beforeKeys=db.prepare('SELECT * FROM telegram_relay_media_keys ORDER BY media_key').all().map(row=>({...row}));
  const beforeSettings={...db.prepare("SELECT * FROM telegram_promotion_settings WHERE id='primary'").get()};
  const beforeState={...db.prepare("SELECT * FROM telegram_relay_state WHERE id='primary'").get()};
  const beforePin={...db.prepare("SELECT * FROM notes_vault_settings WHERE id='primary'").get()};
  restoreLegacyMediaKeys(db);
  db.exec('DROP INDEX telegram_relay_caption_edits; ALTER TABLE telegram_relay_outbox DROP COLUMN caption_edit_attempted_at; ALTER TABLE telegram_relay_outbox DROP COLUMN caption_edit_outcome; PRAGMA user_version=21');
  closeDatabase();const migrated=getSqlite();
  assert.equal(migrated.prepare('PRAGMA user_version').get().user_version,25);
  assert.deepEqual(jobs().map(({caption_edit_attempted_at,caption_edit_outcome,...row})=>({...row})),beforeJobs);
  assert.ok(jobs().every(row=>row.caption_edit_attempted_at===0&&row.caption_edit_outcome===''));
  assert.deepEqual(migrated.prepare('SELECT * FROM telegram_relay_media_keys ORDER BY media_key').all().map(row=>({...row})),beforeKeys);
  assert.deepEqual({...migrated.prepare("SELECT * FROM telegram_promotion_settings WHERE id='primary'").get()},beforeSettings);
  assert.deepEqual({...migrated.prepare("SELECT * FROM telegram_relay_state WHERE id='primary'").get()},beforeState);
  assert.deepEqual({...migrated.prepare("SELECT * FROM notes_vault_settings WHERE id='primary'").get()},beforePin);
  assert.equal(migrated.prepare("SELECT seq FROM sqlite_sequence WHERE name='telegram_relay_outbox'").get().seq,9000);
  assert.ok(migrated.prepare("PRAGMA index_list(telegram_relay_outbox)").all().some(row=>row.name==='telegram_relay_caption_edits'));
});

test('v22 upgrade removes only album uniqueness and preserves messages, media keys, PIN, settings and sequence',async t=>{
  await configureAccount(t);
  await relay.enqueuePersonalRelayMedia(accountPhoto({mediaGroupId:'sent-album'}));await deliver(now);
  await relay.enqueuePersonalRelayMedia(accountPhoto({sourceMessageId:2002,mediaGroupId:'pending-album',
    sourceMediaId:'v22-pending-photo',bytes:Buffer.from('v22-pending-photo')}));
  const db=getSqlite();
  db.prepare("INSERT INTO notes_vault_settings(id,pin_hash,revision,created_at,updated_at) VALUES('primary','v22-pin','v22-vault',51,52)").run();
  db.prepare("UPDATE sqlite_sequence SET seq=9100 WHERE name='telegram_relay_outbox'").run();
  const beforeJobs=jobs().map(row=>({...row}));
  const beforeKeys=db.prepare('SELECT * FROM telegram_relay_media_keys ORDER BY media_key').all().map(row=>({...row}));
  const beforeSettings={...db.prepare("SELECT * FROM telegram_promotion_settings WHERE id='primary'").get()};
  const beforeState={...db.prepare("SELECT * FROM telegram_relay_state WHERE id='primary'").get()};
  const beforePin={...db.prepare("SELECT * FROM notes_vault_settings WHERE id='primary'").get()};
  restoreLegacyMediaKeys(db);
  db.exec("DROP INDEX telegram_relay_album; CREATE UNIQUE INDEX telegram_relay_album ON telegram_relay_outbox(source_chat_id,media_group_id) WHERE media_group_id<>''; PRAGMA user_version=22");
  closeDatabase();const migrated=getSqlite();
  assert.equal(migrated.prepare('PRAGMA user_version').get().user_version,25);
  assert.deepEqual(jobs().map(row=>({...row})),beforeJobs);
  assert.deepEqual(migrated.prepare('SELECT * FROM telegram_relay_media_keys ORDER BY media_key').all().map(row=>({...row})),beforeKeys);
  assert.deepEqual({...migrated.prepare("SELECT * FROM telegram_promotion_settings WHERE id='primary'").get()},beforeSettings);
  assert.deepEqual({...migrated.prepare("SELECT * FROM telegram_relay_state WHERE id='primary'").get()},beforeState);
  assert.deepEqual({...migrated.prepare("SELECT * FROM notes_vault_settings WHERE id='primary'").get()},beforePin);
  assert.equal(migrated.prepare("SELECT seq FROM sqlite_sequence WHERE name='telegram_relay_outbox'").get().seq,9100);
  assert.equal(migrated.prepare('PRAGMA index_list(telegram_relay_outbox)').all().find(row=>row.name==='telegram_relay_album').unique,0);
  assert.equal(await relay.enqueuePersonalRelayMedia(accountPhoto({sourceMessageId:2003,mediaGroupId:'pending-album',
    sourceMediaId:'v23-new-photo',bytes:Buffer.from('v23-new-photo')})),true);
  assert.equal(jobs().length,3);assert.ok(jobs()[2].id>9100);
  assert.equal(await relay.enqueuePersonalRelayMedia(accountPhoto({sourceChatId:source,sourceMessageId:2004,
    sourceMediaId:'v23-reuploaded-original',caption:'Changed caption'})),true);
  assert.equal(jobs().length,3,'permanent media identities still prevent an already sent photo from being requeued');
});

test('v23 upgrade dates every legacy key without changing outbox data, cursors, media bytes, PIN or sequence',async t=>{
  await configureAccount(t);const db=getSqlite(),before=mytMidnight-2000,after=mytMidnight+2000;
  const insert=db.prepare(`INSERT INTO telegram_relay_outbox(id,source_chat_id,source_message_id,fingerprint,queued_at,revision,
    media_kind,file_id,file_unique_id,caption,caption_entities,status,sent_at,message_id,media_bytes,origin,account_generation,lease_until)
    VALUES(?,?,?,?,?,'relay-revision','photo',?,?,'Legacy caption','[]',?,?,?,?, 'account','account-generation',?)`);
  insert.run(101,source,2101,'sent-fingerprint',before,'legacy-file-1','legacy-unique-1','sent',after,88770,null,0);
  insert.run(102,source,2102,'pending-fingerprint',before,'legacy-file-2','legacy-unique-2','pending',null,null,Buffer.from('pending-media-bytes'),0);
  insert.run(103,source,2103,'unknown-fingerprint',after,'legacy-file-3','legacy-unique-3','unknown',null,null,null,0);
  insert.run(104,source,2104,'sending-fingerprint',before,'legacy-file-4','legacy-unique-4','sending',null,null,Buffer.from('in-flight-media-bytes'),after);
  db.prepare("INSERT INTO notes_vault_settings(id,pin_hash,revision,created_at,updated_at) VALUES('primary','v23-pin','v23-vault',61,62)").run();
  db.prepare("UPDATE sqlite_sequence SET seq=9200 WHERE name='telegram_relay_outbox'").run();
  const beforeJobs=jobs().map(row=>({...row}));
  const beforeSettings={...db.prepare("SELECT * FROM telegram_promotion_settings WHERE id='primary'").get()};
  const beforeState={...db.prepare("SELECT * FROM telegram_relay_state WHERE id='primary'").get()};
  const beforePin={...db.prepare("SELECT * FROM notes_vault_settings WHERE id='primary'").get()};
  const beforeAccount={...db.prepare("SELECT * FROM telegram_personal_account WHERE id='primary'").get()};
  const beforeSources=db.prepare('SELECT * FROM telegram_personal_sources ORDER BY chat_id').all().map(row=>({...row}));
  restoreLegacyMediaKeys(db);
  const legacy=[['legacy-sent-key',101],['legacy-pending-key',102],['legacy-unknown-key',103],['legacy-sending-key',104],['orphan-legacy-key',99999]];
  for(const [key,id] of legacy)db.prepare('INSERT INTO telegram_relay_media_keys(media_key,outbox_id) VALUES(?,?)').run(key,id);
  db.exec('PRAGMA user_version=23');closeDatabase();const migrated=getSqlite();
  assert.equal(migrated.prepare('PRAGMA user_version').get().user_version,25);
  assert.deepEqual(jobs().map(row=>({...row})),beforeJobs);
  assert.deepEqual({...migrated.prepare("SELECT * FROM telegram_promotion_settings WHERE id='primary'").get()},beforeSettings);
  assert.deepEqual({...migrated.prepare("SELECT * FROM telegram_relay_state WHERE id='primary'").get()},beforeState);
  assert.deepEqual({...migrated.prepare("SELECT * FROM notes_vault_settings WHERE id='primary'").get()},beforePin);
  assert.deepEqual({...migrated.prepare("SELECT * FROM telegram_personal_account WHERE id='primary'").get()},beforeAccount);
  assert.deepEqual(migrated.prepare('SELECT * FROM telegram_personal_sources ORDER BY chat_id').all().map(row=>({...row})),beforeSources);
  assert.equal(migrated.prepare("SELECT seq FROM sqlite_sequence WHERE name='telegram_relay_outbox'").get().seq,9200);
  const expected=[
    {day_key:relay.relayDayKey(after),media_key:'legacy-sent-key',outbox_id:101},
    {day_key:relay.relayDayKey(before),media_key:'legacy-pending-key',outbox_id:102},
    {day_key:relay.relayDayKey(after),media_key:'legacy-unknown-key',outbox_id:103},
    {day_key:relay.relayDayKey(before),media_key:'legacy-sending-key',outbox_id:104},
    {day_key:relay.relayDayKey(after),media_key:'legacy-sending-key',outbox_id:104},
    {day_key:'1970-01-01',media_key:'orphan-legacy-key',outbox_id:99999},
  ].sort((a,b)=>a.day_key.localeCompare(b.day_key)||a.media_key.localeCompare(b.media_key));
  assert.deepEqual(migrated.prepare('SELECT * FROM telegram_relay_media_keys ORDER BY day_key,media_key').all().map(row=>({...row})),expected);
  assert.ok(migrated.prepare('PRAGMA index_list(telegram_relay_media_keys)').all().some(row=>row.name==='telegram_relay_media_key_job'));
  assert.throws(()=>migrated.prepare('INSERT INTO telegram_relay_media_keys(day_key,media_key,outbox_id) VALUES(?,?,?)')
    .run(relay.relayDayKey(before),'legacy-pending-key',102),/UNIQUE/);
  assert.doesNotThrow(()=>migrated.prepare('INSERT INTO telegram_relay_media_keys(day_key,media_key,outbox_id) VALUES(?,?,?)')
    .run(relay.relayDayKey(after),'legacy-pending-key',102));
  assert.throws(()=>migrated.prepare(`INSERT INTO telegram_relay_outbox(source_chat_id,source_message_id,fingerprint,queued_at,
    revision,media_kind,file_id,file_unique_id,caption) VALUES(?,2101,'replayed-source',?,'relay-revision','photo','new-file','new-unique','Caption')`)
    .run(source,after),/UNIQUE/);
  assert.equal(sends().length,0);
});

test('v24 upgrade adds a zero recovery counter without changing existing media, statuses or daily keys',async t=>{
  await configureAccount(t);await relay.enqueuePersonalRelayMedia(accountPhoto());await deliver(now);
  await relay.enqueuePersonalRelayMedia(accountPhoto({sourceMessageId:2002,sourceMediaId:'v24-pending',bytes:Buffer.from('v24-pending')}));
  const db=getSqlite(),before=jobs().map(({caption_edit_recheck_count,...row})=>({...row}));
  const keys=db.prepare('SELECT * FROM telegram_relay_media_keys ORDER BY day_key,media_key').all().map(row=>({...row}));
  const runtime={...state()};db.exec('ALTER TABLE telegram_relay_outbox DROP COLUMN caption_edit_recheck_count; PRAGMA user_version=24');
  closeDatabase();const migrated=getSqlite();assert.equal(migrated.prepare('PRAGMA user_version').get().user_version,25);
  assert.deepEqual(jobs().map(({caption_edit_recheck_count,...row})=>({...row})),before);
  assert.ok(jobs().every(job=>job.caption_edit_recheck_count===0));assert.deepEqual({...state()},runtime);
  assert.deepEqual(migrated.prepare('SELECT * FROM telegram_relay_media_keys ORDER BY day_key,media_key').all().map(row=>({...row})),keys);
});

test('a full bot queue retains the source update until capacity is available and then queues it exactly once',async()=>{
  configure();await poll(now,[]);
  getSqlite().exec(`WITH RECURSIVE numbers(n) AS (
      VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<128
    ) INSERT INTO telegram_relay_outbox(source_chat_id,source_message_id,fingerprint,queued_at,revision,
      media_kind,file_id,file_unique_id,caption,next_attempt_at)
    SELECT -1009876543,n,'capacity-'||n,${now},'relay-revision','photo','capacity-file-'||n,
      'capacity-identity-'||n,'Existing queued photo',${now} FROM numbers;`);
  const incoming=photo(900);
  await poll(now+1000,[incoming]);
  assert.equal(jobs().length,128);assert.equal(state().next_offset,incoming.update_id,
    'the full queue must not acknowledge the unqueued update');
  assert.equal(jobs().some(job=>job.source_message_id===incoming.message.message_id),false);
  getSqlite().prepare("UPDATE telegram_relay_outbox SET status='cancelled' WHERE id=(SELECT MIN(id) FROM telegram_relay_outbox)").run();
  await poll(now+2000,[incoming]);
  assert.equal(telegram.polls.at(-1).offset,incoming.update_id);
  assert.equal(jobs().length,129);assert.equal(state().next_offset,incoming.update_id+1);
  assert.equal(jobs().filter(job=>job.source_message_id===incoming.message.message_id).length,1);
  assert.equal(jobs().filter(job=>job.status==='pending').length,128);
  await poll(now+3000,[incoming]);
  assert.equal(jobs().length,129);assert.equal(sends().length,0);
});


test('a source newly observed as protected cancels queued personal media and blocks further enqueue',async t=>{
  await configureAccount(t);assert.equal(await relay.enqueuePersonalRelayMedia(accountPhoto()),true);
  getSqlite().prepare('UPDATE telegram_personal_sources SET blocked=1 WHERE chat_id=?').run(source);
  assert.equal(await relay.enqueuePersonalRelayMedia(accountPhoto({sourceMessageId:2002,sourceMediaId:'another-image',bytes:Buffer.from('another-image')})),false);
  await deliver(now);
  assert.equal(sends().length,0);assert.equal(jobs().length,1);
  assert.equal(jobs()[0].status,'cancelled');assert.equal(jobs()[0].media_bytes,null);
});
