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
exports.calls = []; exports.polls = []; exports.updates = []; exports.sends = [];
exports.webhook = ''; exports.targetAllowed = true; exports.targetExists = true;
exports.targetType = 'supergroup'; exports.onRequest = null; exports.onPoll = null; exports.now = 0;
exports.telegramRequest = async (token, method, parameters = {}, upload) => {
  exports.calls.push({token,method,parameters,upload});
  if (exports.onRequest) { const overridden = await exports.onRequest(method,parameters); if (overridden !== undefined) return overridden; }
  if (method === 'getMe') return {ok:true,result:{id:12345678,is_bot:true,username:'FreeBonus365Bot',can_read_all_group_messages:true}};
  if (method === 'getWebhookInfo') return {ok:true,result:{url:exports.webhook}};
  if (method === 'getChat') return exports.targetExists ? {ok:true,result:{id:-1001239999,type:exports.targetType,username:'join365freebonusgroup'}} : {ok:false,code:400,retryAfter:0};
  if (method === 'getChatMember') return {ok:true,result:exports.targetAllowed ? {status:'administrator',can_post_messages:true,can_send_messages:true,can_send_photos:true,can_send_other_messages:true} : {status:'left'}};
  if (method === 'sendPhoto' || method === 'sendAnimation') {
    if (exports.sends.length) { const next=exports.sends.shift(); return typeof next === 'function' ? await next(parameters) : next; }
    return {ok:true,result:{message_id:9000+exports.calls.length,date:Math.floor(exports.now/1000)}};
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
exports.relayMediaMaxBytes = kind => kind==='photo'?10*1024*1024:20*1024*1024;
exports.downloadBotRelayMedia = async (token,fileId,kind) => {
  if(exports.onDownload) return await exports.onDownload(token,fileId,kind);
  return exports.files.has(fileId)?exports.files.get(fileId):Buffer.from(fileId);
};
exports.relayMediaIdentity = async (bytes,kind) => {
  if(exports.onIdentity) await exports.onIdentity(bytes,kind);
  return {contentHash:createHash('sha256').update(bytes).digest('hex'),visualHash:''};
};
`);

const require = createRequire(import.meta.url);
const relay = require(path.join(fixture, 'telegram-relay.js'));
const telegram = require(path.join(fixture, 'telegram-bot.js'));
const media = require(path.join(fixture, 'telegram-relay-media.js'));
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

function closeDatabase() {
  const filename = path.join(process.env.DATA_DIR, 'directory.sqlite');
  globalThis.__directorySqlite?.get(filename)?.close();
  globalThis.__directorySqlite?.delete(filename);
}
test.beforeEach(t => {
  process.env.DATA_DIR = mkdtempSync(path.join(fixture, 'case-'));
  media.files.clear(); media.onDownload=null; media.onIdentity=null;
  telegram.calls.length=0; telegram.polls.length=0; telegram.updates.length=0; telegram.sends.length=0;
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
function state(){return getSqlite().prepare("SELECT * FROM telegram_relay_state WHERE id='primary'").get();}
function jobs(){return getSqlite().prepare('SELECT * FROM telegram_relay_outbox ORDER BY id').all();}
function sends(){return telegram.calls.filter(call=>call.method==='sendPhoto'||call.method==='sendAnimation');}
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
  assert.equal(call.parameters.caption_entities,undefined);
  assert.equal(call.parameters.parse_mode,undefined);
  assert.equal(jobs()[0].status,'sent');
  assert.ok(telegram.calls.every(call=>call.token===token));
  assert.ok(telegram.polls.every(call=>call.token===token));
  assert.equal(getSqlite().prepare("SELECT enabled FROM telegram_promotion_settings WHERE id='primary'").get().enabled,0);
});

test('only captioned group/channel photos or animations enter the queue, including received third-party bot posts',async()=>{
  configure();
  const inputs=[
    photo(1,{photo:undefined,text:'Text alone',caption:undefined}),
    photo(2,{caption:'   '}),
    photo(3,{chat:{id:123,type:'private'}}),
    photo(4,{chat:{id:source,type:'channel'},has_protected_content:true}),
    photo(5,{has_protected_content:true}),
    photo(6,{chat:{id:target,type:'supergroup'}}),
    photo(7,{from:{id:botId,is_bot:true}}),
    photo(8,{photo:undefined,video:{file_id:'video',file_unique_id:'video-unique'}}),
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

test('album parts and repeated canonical photo/caption echoes are deduplicated across source groups',async()=>{
  configure();const first=photo(1,{media_group_id:'album-1'});
  const albumOther=photo(2,{media_group_id:'album-1'});
  const echo=photo(3,{chat:{id:source-1,type:'supergroup'},caption:'Offer 1\nhttps://another.example/signup',photo:first.message.photo});
  await poll(now,[first,albumOther,echo]);
  assert.equal(jobs().length,1);
  await deliver();assert.equal(sends().length,1);
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
  assert.equal(migrated.prepare('PRAGMA user_version').get().user_version,19);
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

test('captioned source channel_post updates use the same fixed links and destination channel support',async()=>{
  configure();telegram.targetType='channel';
  const input=photo();const message={...input.message,chat:{id:source,type:'channel'}};
  await poll(now,[{update_id:input.update_id,channel_post:message}]);
  assert.equal(jobs().length,1);await deliver();
  assert.equal(sends().length,1);assert.equal(sends()[0].parameters.chat_id,target);
  assert.deepEqual(sends()[0].parameters.reply_markup,{inline_keyboard:relayKeyboard()});
  assert.equal(sends()[0].parameters.caption.includes('source.example'),false);
});

test('identical file identity is not resent after caption changes, a new day, or settings generation change',async()=>{
  configure();const first=photo();await poll(now,[first]);await deliver();
  const later=now+2*86_400_000;
  getSqlite().prepare("UPDATE telegram_promotion_settings SET relay_revision='second-generation',relay_started_at=? WHERE id='primary'").run(later);
  await poll(later,[photo(2,{date:later/1000,caption:'Different caption and source link https://changed.example',photo:first.message.photo})]);
  await deliver(later);
  assert.equal(jobs().length,1);assert.equal(sends().length,1);
  assert.equal(jobs()[0].status,'sent');assert.ok(state().skipped_count>=1);
});

test('same downloaded image under different Telegram file IDs and captions sends only once',async()=>{
  configure();media.files.set('photo-1',Buffer.from('shared-image'));media.files.set('photo-2',Buffer.from('shared-image'));
  await poll(now,[photo(1),photo(2,{caption:'Completely different caption'})]);
  await deliver(now);await deliver(now+3000);
  assert.equal(sends().length,1);assert.deepEqual(jobs().map(job=>job.status),['sent','cancelled']);
  assert.ok(state().skipped_count>=1);
});

test('an uncertain image transmission permanently reserves its image identity across database reopening',async()=>{
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
  db.exec('DROP TABLE telegram_relay_media_keys');
  for(const column of ['origin','account_generation','media_bytes','content_hash','visual_hash','media_prepared']) {
    db.exec(`ALTER TABLE telegram_relay_outbox DROP COLUMN ${column}`);
  }
  db.exec('PRAGMA user_version=18');closeDatabase();
  const migrated=getSqlite();
  assert.equal(migrated.prepare('PRAGMA user_version').get().user_version,19);
  assert.deepEqual({...migrated.prepare("SELECT * FROM telegram_promotion_settings WHERE id='primary'").get()},settingsBefore);
  assert.deepEqual({...migrated.prepare("SELECT * FROM notes_vault_settings WHERE id='primary'").get()},vaultBefore);
  assert.deepEqual({...migrated.prepare("SELECT * FROM telegram_relay_state WHERE id='primary'").get()},stateBefore);
  assert.equal(migrated.prepare("SELECT outbox_id FROM telegram_relay_media_keys WHERE media_key='file:photo:photo-unique-1'").get().outbox_id,sentId);
  assert.deepEqual(jobs().map(job=>job.status),['sent','cancelled']);
  await poll(now+4000,[photo(3,{caption:'New caption from another group',photo:original.message.photo,chat:{id:source-2,type:'supergroup'}})]);
  await deliver(now+4000);assert.equal(sends().length,1);assert.equal(jobs().length,2);
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
