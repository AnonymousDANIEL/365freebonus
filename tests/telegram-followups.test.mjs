import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

const fixture = mkdtempSync(path.join(tmpdir(), 'telegram-followups-'));
writeFileSync(path.join(fixture, 'package.json'), '{"type":"commonjs"}');
for (const name of ['auth-core', 'brand-links', 'directory', 'image-url', 'image-media', 'telegram-background', 'telegram-brand-card', 'telegram-brand-search', 'sqlite','telegram-bot','telegram-keywords','telegram-followups','telegram-welcome']) {
  writeFileSync(path.join(fixture, `${name}.js`), ts.transpileModule(readFileSync(new URL(`../app/lib/${name}.ts`, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop:true } }).outputText);
}
const require = createRequire(import.meta.url);
const transport = require(path.join(fixture,'telegram-bot.js'));
const followups = require(path.join(fixture,'telegram-followups.js'));
const { pollTelegramWelcomeOnce } = require(path.join(fixture,'telegram-welcome.js'));
const { getSqlite } = require(path.join(fixture,'sqlite.js'));
const previousDataDir = process.env.DATA_DIR;
const now=1_800_000_000_000, hour=3_600_000, chatId=701;
const ok=result=>({ok:true,result});
const message='Please tell us what you need help with.';
function close() { const filename=path.join(process.env.DATA_DIR,'directory.sqlite');globalThis.__directorySqlite?.get(filename)?.close();globalThis.__directorySqlite?.delete(filename); }
test.beforeEach(()=>{process.env.DATA_DIR=mkdtempSync(path.join(fixture,'case-'));});
test.afterEach(close);
test.after(()=>{if(previousDataDir===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previousDataDir;rmSync(fixture,{recursive:true,force:true});});
function configure({enabled=true,privateEnabled=true,startedAt=now/1000-10}={}) {
  getSqlite().prepare(`INSERT INTO telegram_promotion_settings(id,enabled,chat_id,token_ciphertext,chat_bot_token_ciphertext,welcome_enabled,welcome_chat_id,welcome_message,welcome_started_at,welcome_revision,private_enabled,private_started_at,private_followup_enabled,private_followup_message,private_followup_started_at,private_followup_revision)
    VALUES('primary',0,'','','fixture-cipher',0,'','',0,'fixture-revision',?,?,?,?,?,'followup-revision')`)
    .run(Number(privateEnabled),now/1000-100,Number(enabled),message,startedAt);
}
function settings(){return getSqlite().prepare("SELECT * FROM telegram_promotion_settings WHERE id='primary'").get();}
function record(id=chatId){return getSqlite().prepare('SELECT * FROM telegram_private_followups WHERE chat_id=?').get(id);}
function input(updateId,{text='unrecognized',id=chatId,messageId=updateId+1000,at=now,type='private',bot=false}={}) {
  return {update_id:updateId,message:{message_id:messageId,date:Math.floor(at/1000),text,chat:{id,type},from:{id,is_bot:bot}}};
}
function harness(t) {
  let time=now;const polls=[],sends=[],calls=[];let messageId=10000;
  t.mock.method(transport,'telegramUpdates',async()=>{assert.ok(polls.length,'unexpected poll');return polls.shift();});
  t.mock.method(transport,'telegramRequest',async(token,method,parameters)=>{assert.equal(token,'fixture-token');assert.equal(method,'sendMessage');calls.push(parameters);assert.ok(sends.length,'unexpected send');const next=sends.shift();return typeof next==='function'?await next(parameters):next;});
  t.mock.method(transport,'answerTelegramCallback',async()=>true);
  return {calls,run:async(at,updates=ok([]),replies=[])=>{time=at;polls.push(updates);sends.push(...replies);await pollTelegramWelcomeOnce(()=> 'fixture-token',()=>time);},success:()=>ok({message_id:messageId++,date:Math.floor(time/1000)})};
}

test('unmatched private input sends exactly once after one hour and pending state survives SQLite reopening',async t=>{
  configure();const h=harness(t);
  await h.run(now,ok([input(1)]));assert.equal(record().status,'pending');assert.equal(record().due_at,now+hour);
  close();await h.run(now+hour-1);assert.equal(h.calls.length,0);
  await h.run(now+hour,ok([]),[h.success()]);assert.equal(h.calls.length,1);assert.equal(h.calls[0].chat_id,chatId);assert.equal(h.calls[0].text,message);assert.equal(h.calls[0].reply_markup,undefined);assert.equal(record().status,'sent');
  await h.run(now+2*hour);assert.equal(h.calls.length,1);
});

test('latest unmatched input resets the hour and a recognized reply cancels the previous fallback',async t=>{
  configure();const h=harness(t);
  await h.run(now,ok([input(1)]));
  await h.run(now+30*60000,ok([input(2,{at:now+30*60000})]));assert.equal(record().due_at,now+90*60000);
  await h.run(now+hour);assert.equal(h.calls.length,0);
  getSqlite().prepare("INSERT INTO telegram_keyword_rules(keyword,keyword_key,match_mode,response,show_button) VALUES('help','help','exact','A real reply',0)").run();
  await h.run(now+65*60000,ok([input(3,{text:'help',at:now+65*60000})]),[h.success()]);assert.equal(record().status,'cancelled');
  await h.run(now+3*hour);assert.equal(h.calls.length,1);assert.equal(h.calls[0].text,'A real reply');
});

test('failed polls and update backlogs never release due followups; a later successful empty poll does',async t=>{
  configure();const h=harness(t);await h.run(now,ok([input(1)]));
  await h.run(now+hour,{ok:false,code:500,retryAfter:0});assert.equal(h.calls.length,0);
  await h.run(now+hour+16000,ok([{update_id:2,message:{date:now/1000,text:'group noise',message_id:2002,chat:{id:-1001,type:'supergroup'},from:{id:900,is_bot:false}}}]));assert.equal(h.calls.length,0);
  await h.run(now+hour+20000,ok([]),[h.success()]);assert.equal(h.calls.length,1);
});

test('disabled, pre-enable, non-private and bot-origin input does not create scheduled followups',async t=>{
  configure({enabled:false});const h=harness(t);await h.run(now,ok([input(1)]));assert.equal(record(),undefined);
  getSqlite().prepare("UPDATE telegram_promotion_settings SET private_followup_enabled=1,private_followup_started_at=?").run(now/1000+10);
  await h.run(now+1000,ok([input(2),input(3,{id:-1001,type:'supergroup'}),input(4,{id:702,bot:true})]));
  assert.notEqual(record()?.status,'pending');assert.equal(record(-1001),undefined);assert.equal(record(702),undefined);
  await h.run(now+2*hour);assert.equal(h.calls.length,0);
});

test('/stop cancels followups until /start and each new user input can create at most one new episode',async t=>{
  configure();const h=harness(t);await h.run(now,ok([input(1)]));
  await h.run(now+1000,ok([input(2,{text:'/stop',at:now+1000})]),[h.success()]);assert.equal(record().opted_out,1);assert.equal(record().status,'cancelled');
  await h.run(now+2000,ok([input(3,{at:now+2000})]));assert.equal(record().status,'cancelled');
  await h.run(now+3000,ok([input(4,{text:'/start',at:now+3000})]),[ok({message_id:10004,date:(now+3000)/1000})]);assert.equal(record().opted_out,0);
  await h.run(now+4000,ok([input(5,{messageId:10005,at:now+4000})]));assert.equal(record().status,'pending');
  await h.run(now+hour+4000,ok([]),[ok({message_id:10006,date:(now+hour+4000)/1000})]);assert.equal(h.calls.length,3);
});

test('actual outgoing message IDs distinguish old backlog and newer incoming messages in the same second',()=>{
  configure();const db=getSqlite();
  followups.recordPrivateFollowupOutbound(db,chatId,200,now);
  followups.observePrivateFollowupInput(db,settings(),{chatId,updateId:10,messageId:199,at:now,unmatched:true});assert.equal(record().status,'cancelled');
  followups.observePrivateFollowupInput(db,settings(),{chatId,updateId:11,messageId:201,at:now,unmatched:true});assert.equal(record().status,'pending');
  followups.recordPrivateFollowupOutbound(db,chatId,200,now+999);assert.equal(record().status,'pending');
  followups.observePrivateFollowupInput(db,settings(),{chatId,updateId:11,messageId:201,at:now,unmatched:true});assert.equal(record().due_at,now+hour);
  followups.observePrivateFollowupInput(db,settings(),{chatId,updateId:1,messageId:202,at:now+8*86400000,unmatched:true});assert.equal(record().status,'pending');assert.equal(record().customer_update_id,1);
});

test('ambiguous sends and interrupted sending leases become unknown and are never resent automatically',async t=>{
  configure();const h=harness(t);await h.run(now,ok([input(1)]));await h.run(now+hour,ok([]),[null]);assert.equal(record().status,'unknown');
  close();await h.run(now+2*hour);assert.equal(h.calls.length,1);
  followups.observePrivateFollowupInput(getSqlite(),settings(),{chatId,updateId:2,messageId:10002,at:now+2*hour,unmatched:true});
  getSqlite().prepare("UPDATE telegram_private_followups SET status='sending',lease_id='interrupted',lease_until=?").run(now+3*hour-1);
  await h.run(now+3*hour);assert.equal(record().status,'unknown');assert.equal(h.calls.length,1);
});

test('explicit rate limits retry boundedly while forbidden recipients fail permanently',async t=>{
  configure();const h=harness(t);await h.run(now,ok([input(1)]));
  await h.run(now+hour,ok([]),[{ok:false,code:429,retryAfter:20}]);assert.equal(record().status,'pending');
  await h.run(now+hour+19999);assert.equal(h.calls.length,1);
  await h.run(now+hour+20000,ok([]),[{ok:false,code:429,retryAfter:20}]);
  await h.run(now+hour+40000,ok([]),[{ok:false,code:429,retryAfter:20}]);assert.equal(record().status,'failed');assert.equal(record().attempts,3);
  await h.run(now+2*hour);assert.equal(h.calls.length,3);
  followups.observePrivateFollowupInput(getSqlite(),settings(),{chatId,updateId:2,messageId:10002,at:now+2*hour,unmatched:true});
  await h.run(now+3*hour,ok([]),[{ok:false,code:403,retryAfter:0}]);assert.equal(record().status,'failed');assert.equal(getSqlite().prepare('SELECT * FROM telegram_private_contacts WHERE user_id=?').get(chatId),undefined);
});

test('settings revisions cancel queued work and concurrent due processors claim a customer only once',async t=>{
  configure();const h=harness(t);await h.run(now,ok([input(1)]));
  getSqlite().prepare("UPDATE telegram_promotion_settings SET private_followup_revision='changed'").run();await h.run(now+hour);assert.equal(record().status,'cancelled');assert.equal(h.calls.length,0);
  followups.observePrivateFollowupInput(getSqlite(),settings(),{chatId,updateId:2,messageId:10002,at:now+hour,unmatched:true});
  const db=getSqlite();db.prepare("UPDATE telegram_welcome_state SET lease_id='fixture-lease',lease_until=?").run(now+3*hour);
  let count=0,resolve;const pending=new Promise(done=>{resolve=done;});
  t.mock.method(transport,'telegramRequest',async()=>{count++;await pending;return ok({message_id:10003,date:(now+2*hour)/1000});});
  const claim={revision:'fixture-revision',leaseId:'fixture-lease'};
  const first=followups.sendDuePrivateFollowups(db,claim,'fixture-token',()=>now+2*hour,1);
  await followups.sendDuePrivateFollowups(db,claim,'fixture-token',()=>now+2*hour,1);assert.equal(count,1);
  resolve();await first;assert.equal(record().status,'sent');
});

test('a newer customer message arriving during followup HTTP remains pending after the older send completes',async t=>{
  configure();const h=harness(t);await h.run(now,ok([input(1)]));
  await h.run(now+hour,ok([]),[()=>{
    followups.observePrivateFollowupInput(getSqlite(),settings(),{chatId,updateId:20,messageId:20001,at:now+hour,unmatched:true});
    return ok({message_id:20000,date:(now+hour)/1000});
  }]);
  assert.equal(record().status,'pending');assert.equal(record().customer_message_id,20001);assert.equal(record().due_at,now+2*hour);
  await h.run(now+2*hour-1);assert.equal(h.calls.length,1);
  await h.run(now+2*hour,ok([]),[ok({message_id:20002,date:(now+2*hour)/1000})]);assert.equal(record().status,'sent');assert.equal(h.calls.length,2);
});

test('a private welcome records outbound metadata before an older unmatched backlog is received',async t=>{
  configure();const h=harness(t),db=getSqlite();
  db.prepare("UPDATE telegram_promotion_settings SET welcome_enabled=1,welcome_chat_id='-1001',welcome_message='Welcome',welcome_started_at=?").run(now/1000-10);
  db.prepare('INSERT INTO telegram_private_contacts(user_id) VALUES(?)').run(chatId);
  const member={update_id:1,chat_member:{date:now/1000,chat:{id:-1001,type:'supergroup'},old_chat_member:{status:'left'},new_chat_member:{status:'member',user:{id:chatId,is_bot:false,first_name:'Fixture'}}}};
  await h.run(now,ok([member]),[ok({message_id:10000,date:now/1000})]);assert.equal(record().last_outbound_message_id,10000);
  await h.run(now+1000,ok([input(2,{messageId:9999,at:now})]));assert.equal(record().status,'cancelled');
  await h.run(now+2000,ok([input(3,{messageId:10001,at:now})]));assert.equal(record().status,'pending');
});

test('ignored old button acknowledgments preserve pending fallback while a real button answer cancels it',async t=>{
  configure();const h=harness(t);await h.run(now,ok([input(1)]));
  const callback=(updateId,data)=>({update_id:updateId,callback_query:{id:'fixture-callback-'+updateId,data,from:{id:chatId,is_bot:false},message:{message_id:2000,chat:{id:chatId,type:'private'}}}});
  await h.run(now+1000,ok([callback(2,'dm:rule:999')]));assert.equal(record().status,'pending');assert.equal(record().due_at,now+hour);
  getSqlite().prepare("INSERT INTO telegram_keyword_rules(id,keyword,keyword_key,match_mode,response,show_button) VALUES(1,'help','help','exact','Button answer',1)").run();
  await h.run(now+2000,ok([callback(3,'dm:rule:1')]),[ok({message_id:10000,date:(now+2000)/1000})]);assert.equal(record().status,'cancelled');assert.equal(h.calls.length,1);
  await h.run(now+2*hour);assert.equal(h.calls.length,1);
});
