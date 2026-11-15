import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

// Run the production migration and queue against disposable SQLite databases.
// Only Telegram transport is mocked; no live channel messages or credentials.
const fixture = mkdtempSync(path.join(tmpdir(), 'telegram-scheduled-text-'));
writeFileSync(path.join(fixture, 'package.json'), '{"type":"commonjs"}');
for (const name of ['sqlite', 'telegram-scheduled-messages-types', 'telegram-scheduled-messages']) writeFileSync(path.join(fixture, name + '.js'), ts.transpileModule(
  readFileSync(new URL('../app/lib/' + name + '.ts', import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } },
).outputText);
writeFileSync(path.join(fixture, 'telegram-bot.js'), `
exports.calls=[];exports.onRequest=null;exports.onSend=null;exports.results={};exports.botName='FreeBonus365ChatBot';exports.roles={};
exports.ids={official:-1001111111111,group:-1002222222222,hot:-1003333333333};
exports.telegramRequest=async(token,method,p={})=>{
 exports.calls.push({token,method,p});
 if(exports.onRequest){const value=await exports.onRequest(method,p);if(value!==undefined)return value;}
 if(method==='getMe')return {ok:true,result:{id:12345678,is_bot:true,username:exports.botName}};
 if(method==='getChat'){
  const key=p.chat_id==='@join365freebonus'?'official':p.chat_id==='@join365freebonusgroup'?'group':'hot';
  return {ok:true,result:{id:exports.ids[key],type:'channel',title:key,username:key==='official'?'join365freebonus':key==='group'?'join365freebonusgroup':undefined}};
 }
 if(method==='getChatMember')return {ok:true,result:exports.roles[p.chat_id]||{status:'administrator',can_post_messages:true}};
 if(method==='sendMessage'){
  if(exports.onSend){const value=await exports.onSend(p);if(value!==undefined)return value;}
  const list=exports.results[p.chat_id];if(list?.length)return list.shift();
  return {ok:true,result:{message_id:100+exports.calls.length,chat:{id:p.chat_id,type:'channel'},text:p.text}};
 }
 throw new Error('Unexpected Telegram method '+method);
};
`);
const require = createRequire(import.meta.url), scheduler = require(path.join(fixture, 'telegram-scheduled-messages.js'));
const telegram = require(path.join(fixture, 'telegram-bot.js')), { getSqlite } = require(path.join(fixture, 'sqlite.js'));
const oldData = process.env.DATA_DIR, start = Date.parse('2026-11-15T00:59:00Z'), MINUTE = 60_000, DAY = 86_400_000;
const cipher = 'fixture-saved-ciphertext', token = '12345678:fixture-saved-token';
let now = start;
const clock = () => now, decrypt = value => value === cipher ? token : '';
const db = () => getSqlite();
const status = () => scheduler.scheduledMessageStatus(db(), clock);
const tick = () => scheduler.deliverScheduledMessagesOnce(decrypt, clock);
const sends = () => telegram.calls.filter(c => c.method === 'sendMessage');
const jobs = () => db().prepare('SELECT * FROM telegram_scheduled_message_deliveries ORDER BY run_at,target_key').all();
const onlyPlan = () => status().plans[0];
function close() { const filename = path.join(process.env.DATA_DIR, 'directory.sqlite'); globalThis.__directorySqlite?.get(filename)?.close(); globalThis.__directorySqlite?.delete(filename); }
function input(extra={}) { return { requestId: randomUUID(), name: 'Daily news', text: 'First line\n\nExact text 🔥', times: ['09:00'], enabled: true, ...extra }; }
async function create(extra={}) { return scheduler.saveScheduledMessagePlan(db(), input(extra), decrypt, clock); }
async function update(extra={}) { const p = onlyPlan(); return scheduler.saveScheduledMessagePlan(db(), { id:p.id, revision:p.revision, name:p.name, text:p.text, times:p.times, enabled:p.enabled, ...extra }, decrypt, clock); }

test.beforeEach(() => {
 process.env.DATA_DIR = mkdtempSync(path.join(fixture, 'case-')); now = start;
 telegram.calls.length = 0; telegram.onRequest = null; telegram.onSend = null; telegram.results = {}; telegram.roles = {}; telegram.botName = 'FreeBonus365ChatBot';
 telegram.ids = { official:-1001111111111, group:-1002222222222, hot:-1003333333333 };
 db().prepare("INSERT INTO telegram_promotion_settings(id,enabled,chat_id,token_ciphertext,chat_bot_token_ciphertext) VALUES('primary',0,'','',?)").run(cipher);
 db().prepare("INSERT INTO telegram_hot_video_settings(id,target_chat_id,target_title) VALUES('primary',?,'Hot')").run(telegram.ids.hot);
});
test.afterEach(close);
test.after(() => { if(oldData===undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR=oldData; rmSync(fixture,{recursive:true,force:true}); });

test('empty scheduler starts healthy and verifies all three destinations without sending', async () => {
 assert.deepEqual(status().plans, []); assert.equal(status().scheduler.workerHealthy, false);
 await tick(); assert.equal(status().scheduler.workerHealthy, true); assert.equal(sends().length, 0); assert.equal(status().targets.filter(t=>t.ready).length,3);
 assert.equal(db().prepare('PRAGMA user_version').get().user_version,34);
});

test('disabled draft can be saved without credentials or outbound calls', async () => {
 db().prepare("UPDATE telegram_promotion_settings SET chat_bot_token_ciphertext='' WHERE id='primary'").run();
 await create({enabled:false}); assert.equal(onlyPlan().enabled,false); assert.equal(onlyPlan().nextRunAt,null); assert.equal(telegram.calls.length,0);
 await tick(); assert.equal(sends().length,0);
});

test('enable resolves fixed public usernames and checks permissions on every channel', async () => {
 await create(); assert.deepEqual(status().targets.map(t=>t.chatId), Object.values(telegram.ids).map(String));
 assert.equal(telegram.calls.filter(c=>c.method==='getChatMember').length,3); assert.equal(sends().length,0);
});

test('wrong bot identity or missing one channel permission prevents enabled plan', async () => {
 telegram.botName='UnexpectedBot'; await assert.rejects(create(),e=>e.status===400); assert.equal(status().plans.length,0);
 telegram.botName='FreeBonus365ChatBot'; telegram.roles[telegram.ids.group]={status:'member'};
 await assert.rejects(create(),e=>e.status===400); assert.equal(status().targets.find(t=>t.key==='group').ready,false); assert.equal(status().targets.find(t=>t.key==='official').ready,true);
 assert.equal(sends().length,0);
});

test('duplicate destinations are rejected and do not create a plan', async () => {
 telegram.ids.hot=telegram.ids.official; db().prepare("UPDATE telegram_hot_video_settings SET target_chat_id=?").run(telegram.ids.hot);
 await assert.rejects(create(),e=>e.status===400); assert.equal(status().plans.length,0);
});

test('time validation, exact text and UTC+8 midnight handling are deterministic', async () => {
 for(const bad of [['9:00'],['24:00'],['23:60'],['09:00','09:00'],[]]) await assert.rejects(create({times:bad}),e=>e.status===400);
 await assert.rejects(create({text:' '.repeat(2)}),e=>e.status===400); await assert.rejects(create({text:'x'.repeat(4097)}),e=>e.status===400);
 assert.equal(scheduler.nextScheduledMessageTime(['00:00'],Date.parse('2026-11-15T15:59:59Z')),Date.parse('2026-11-15T16:00:00Z'));
 assert.equal(scheduler.nextScheduledMessageTime(['00:00'],Date.parse('2026-11-15T16:00:00Z')),Date.parse('2026-11-16T16:00:00Z'));
 await create({text:'  Exact\n\ntext\n',times:['20:00','09:00']}); assert.equal(onlyPlan().text,'  Exact\n\ntext\n'); assert.deepEqual(onlyPlan().times,['09:00','20:00']);
});

test('due slot sends matching text to all three channels and rolls to tomorrow', async () => {
 const text='  Message\n\n🔥 Exact\n'; await create({text}); const due=onlyPlan().nextRunAt;
 now=due; await tick(); assert.equal(sends().length,3); assert.deepEqual(new Set(sends().map(c=>c.p.chat_id)),new Set(Object.values(telegram.ids)));
 assert.ok(sends().every(c=>c.p.text===text && c.p.parse_mode===undefined && c.p.reply_markup===undefined));
 assert.ok(jobs().every(j=>j.status==='sent')); assert.equal(onlyPlan().nextRunAt,due+DAY);
 now+=DAY; await tick(); assert.equal(sends().length,6); assert.equal(onlyPlan().nextRunAt,due+2*DAY);
});

test('multiple daily times advance by wall clock and survive database reopen', async () => {
 await create({times:['09:00','12:30']}); const due=onlyPlan().nextRunAt; now=due; await tick(); close();
 assert.equal(onlyPlan().nextRunAt,Date.parse('2026-11-15T04:30:00Z')); await tick(); assert.equal(sends().length,3);
 now=onlyPlan().nextRunAt; await tick(); assert.equal(sends().length,6); assert.equal(onlyPlan().nextRunAt,due+DAY);
});

test('no-op save never rotates revision, resets next time or rearms an existing slot', async () => {
 await create(); now=onlyPlan().nextRunAt; await tick(); const before=onlyPlan(); await update(); assert.deepEqual(onlyPlan(),before); await tick(); assert.equal(sends().length,3);
});

test('edits apply to future occurrences and disable/re-enable cannot repeat a used slot', async () => {
 await create(); const due=onlyPlan().nextRunAt; await update({text:'Edited copy'}); now=due; await tick(); assert.ok(sends().every(c=>c.p.text==='Edited copy'));
 await update({enabled:false}); await update({enabled:true}); await tick(); assert.equal(sends().length,3); assert.equal(onlyPlan().nextRunAt,due+DAY);
});

test('partial result retries only a definitive 429 channel and never unknown/success', async () => {
 await create(); telegram.results[telegram.ids.group]=[{ok:false,code:429,retryAfter:60}]; telegram.results[telegram.ids.hot]=[null];
 now=onlyPlan().nextRunAt; await tick(); assert.equal(sends().length,3); assert.equal(status().counts.sent,1); assert.equal(status().counts.pending,1); assert.equal(status().counts.unknown,1);
 now+=60_000; await tick(); assert.equal(sends().length,4); assert.equal(sends().at(-1).p.chat_id,telegram.ids.group); assert.equal(status().counts.sent,2); assert.equal(status().counts.unknown,1);
 now+=60_000; await tick(); assert.equal(sends().length,4);
});

test('terminal payloads are released while pending unknown and unique deduplication metadata remain', async () => {
 const text='Private scheduled body'; await create({text});
 telegram.results[telegram.ids.official]=[{ok:false,code:400,retryAfter:0}]; telegram.results[telegram.ids.group]=[{ok:false,code:429,retryAfter:60}]; telegram.results[telegram.ids.hot]=[null];
 const due=onlyPlan().nextRunAt;now=due;await tick();
 let records=jobs();assert.equal(records.find(j=>j.status==='failed').text,'');assert.equal(records.find(j=>j.status==='pending').text,text);assert.equal(records.find(j=>j.status==='unknown').text,text);
 const ids=records.map(j=>j.id);now+=60_000;await tick();records=jobs();assert.equal(records.find(j=>j.status==='sent').text,'');assert.deepEqual(records.map(j=>j.id),ids);assert.equal(records.length,3);
 assert.equal(onlyPlan().text,text);assert.equal(records.find(j=>j.status==='unknown').text,text);
 await update({enabled:false});now=due;await update({enabled:true});await tick();assert.equal(sends().length,4);assert.equal(jobs().length,3);
});

test('one channel403 never blocks another channel429 retry from the same slot', async () => {
 await create(); telegram.results[telegram.ids.official]=[{ok:false,code:429,retryAfter:60}]; telegram.results[telegram.ids.group]=[{ok:false,code:403,retryAfter:0}];
 now=onlyPlan().nextRunAt; await tick(); assert.equal(status().counts.sent,1); assert.equal(status().counts.failed,1); assert.equal(status().counts.pending,1);
 telegram.roles[telegram.ids.group]={status:'member'}; now+=60_000; await tick();
 assert.equal(sends().length,4); assert.equal(sends().at(-1).p.chat_id,telegram.ids.official); assert.equal(status().counts.sent,2); assert.equal(status().counts.failed,1);
 assert.equal(status().targets.find(t=>t.key==='group').ready,false); now+=60_000;await tick();assert.equal(sends().length,4);
});

test('a missing or mismatched successful message result is uncertain and is never resent', async () => {
 await create(); telegram.results[telegram.ids.group]=[{ok:true,result:{message_id:99,chat:{id:telegram.ids.hot}}}]; now=onlyPlan().nextRunAt; await tick(); assert.equal(status().counts.unknown,1);
 now+=90_000; await tick(); assert.equal(sends().length,3);
});

test('403 blocks only the affected readiness and permission checks back off', async () => {
 await create(); telegram.results[telegram.ids.group]=[{ok:false,code:403,retryAfter:0}]; now=onlyPlan().nextRunAt; await tick();
 assert.equal(status().counts.failed,1); assert.equal(status().targets.find(t=>t.key==='group').ready,false); assert.equal(status().targets.find(t=>t.key==='official').ready,true);
 const calls=telegram.calls.length; now+=5000; await tick(); assert.equal(telegram.calls.length,calls);
 now+=55_000; await tick(); assert.equal(status().targets.filter(t=>t.ready).length,3); assert.equal(sends().length,3);
});

test('overlapping workers cannot claim a slot or publish twice', async () => {
 await create(); const waiting=[]; telegram.onSend=()=>new Promise(resolve=>waiting.push(resolve)); now=onlyPlan().nextRunAt;
 const first=tick(); for(let i=0;i<10 && waiting.length<3;i++) await new Promise(resolve=>setImmediate(resolve));
 assert.equal(waiting.length,3); const second=tick(); await second; assert.equal(sends().length,3);
 for(let i=0;i<waiting.length;i++) waiting[i]({ok:true,result:{message_id:200+i,chat:{id:sends()[i].p.chat_id}}}); await first; assert.equal(status().counts.sent,3);
});

test('expired dispatched leases become unknown while undispatched leases recover safely', async () => {
 await create(); now=onlyPlan().nextRunAt; telegram.results[telegram.ids.group]=[{ok:false,code:429,retryAfter:60}]; await tick();
 const pending=jobs().find(j=>j.status==='pending'); db().prepare("UPDATE telegram_scheduled_message_deliveries SET status='sending',dispatch_started_at=?,lease_until=?,lease_id='old' WHERE id=?").run(now,now-1,pending.id);
 await tick(); assert.equal(status().counts.unknown,1); assert.equal(sends().length,3);
});

test('long downtime skips old slots but allows the recent due slot without backlog', async () => {
 await create({times:['09:00','12:30']}); const first=onlyPlan().nextRunAt; now=first+3*DAY+2*MINUTE; await tick();
 assert.equal(sends().length,3); assert.equal(status().counts.skipped,3); assert.equal(status().counts.sent,3);
 assert.equal(onlyPlan().nextRunAt,Date.parse('2026-11-18T04:30:00Z')); assert.equal(new Set(sends().map(c=>c.p.text)).size,1);
});

test('token or target changes during verification cannot authorize stale settings', async () => {
 let changed=false; telegram.onRequest=async method=>{if(method==='getChatMember'&&!changed){changed=true;db().prepare("UPDATE telegram_hot_video_settings SET target_chat_id=-1004444444444").run();}};
 await assert.rejects(create(),e=>e.status===409); assert.equal(status().plans.length,0); assert.equal(sends().length,0);
});

test('changed Hot destination is reverified immediately instead of waiting an old hourly deadline', async () => {
 await create(); const calls=telegram.calls.length; now+=5000; telegram.ids.hot=-1005555555555;
 db().prepare("UPDATE telegram_hot_video_settings SET target_chat_id=?").run(telegram.ids.hot);
 await tick(); assert.ok(telegram.calls.length>calls); assert.equal(status().targets.find(t=>t.key==='hot').chatId,String(telegram.ids.hot));
 assert.equal(status().targets.filter(t=>t.ready).length,3); assert.equal(sends().length,0);
});

test('stale asynchronous update cannot overwrite a concurrently changed revision', async () => {
 await create(); const before=onlyPlan(); let changed=false; telegram.onRequest=async method=>{if(method==='getChatMember'&&!changed){changed=true;db().prepare("UPDATE telegram_scheduled_message_plans SET revision=? WHERE id=?").run(randomUUID(),before.id);}};
 await assert.rejects(update({text:'Stale replacement'}),e=>e.status===409); assert.equal(onlyPlan().text,before.text);
});

test('delete preserves delivery history and does not resend or resurrect the plan', async () => {
 const request=input(); await scheduler.saveScheduledMessagePlan(db(),request,decrypt,clock); now=onlyPlan().nextRunAt; await tick(); const p=onlyPlan();
 scheduler.deleteScheduledMessagePlan(db(),{id:p.id,revision:p.revision},clock); assert.deepEqual(status().plans,[]); assert.equal(status().deliveries.length,3); await tick(); assert.equal(sends().length,3);
 await assert.rejects(scheduler.saveScheduledMessagePlan(db(),request,decrypt,clock),e=>e.status===409);
});

test('lost create response and concurrent create request are idempotent without rearming', async () => {
 const request=input(); await Promise.all([scheduler.saveScheduledMessagePlan(db(),request,decrypt,clock),scheduler.saveScheduledMessagePlan(db(),request,decrypt,clock)]);
 assert.equal(status().plans.length,1); assert.equal(onlyPlan().id,request.requestId); const before=onlyPlan(),calls=telegram.calls.length;
 await scheduler.saveScheduledMessagePlan(db(),request,decrypt,clock); assert.deepEqual(onlyPlan(),before); assert.equal(telegram.calls.length,calls);
 await assert.rejects(scheduler.saveScheduledMessagePlan(db(),{...request,text:'Different body'},decrypt,clock),e=>e.status===409);
 now=before.nextRunAt; await tick(); await scheduler.saveScheduledMessagePlan(db(),request,decrypt,clock); await tick(); assert.equal(sends().length,3);
});

test('transient tick database failure releases lease and healthy tick clears stale error', async t => {
 await create(); const database=db(),prepare=database.prepare.bind(database); let failed=false;
 t.mock.method(database,'prepare',sql=>{if(!failed&&sql.startsWith('SELECT 1 FROM telegram_scheduled_message_plans')){failed=true;throw new Error('temporary database contention');}return prepare(sql);});
 await assert.rejects(tick()); assert.match(status().scheduler.lastError,/自动重试/); assert.equal(db().prepare("SELECT lease_until FROM telegram_scheduled_message_runtime").get().lease_until,0);
 now+=5000; await tick(); assert.equal(status().scheduler.lastError,''); assert.equal(status().scheduler.workerHealthy,true);
});

test('startup worker polls on the server and recovers its running flag after failure', async t => {
 const intervals=[]; t.mock.method(globalThis,'setInterval',(callback,ms)=>{intervals.push({callback,ms});return{unref(){}};}); t.mock.method(Date,'now',clock);
 const messages=[];t.mock.method(console,'info',(...values)=>messages.push(values)); t.mock.method(console,'error',()=>{});
 delete globalThis.telegramScheduledMessageWorkerStarted;
 scheduler.startTelegramScheduledMessageWorker(decrypt); for(let i=0;i<10&&!status().scheduler.lastCompletedAt;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(intervals.length,1); assert.equal(intervals[0].ms,5000); assert.equal(status().scheduler.workerHealthy,true);
 assert.ok(messages.some(v=>v[0]==='Telegram scheduled text worker started.'));
 assert.ok(messages.some(v=>v[0]==='Telegram scheduled text worker status.'&&JSON.parse(v[1]).targetReadyCount===3));
 now+=5000;intervals[0].callback();for(let i=0;i<10&&status().scheduler.lastCompletedAt!==now;i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(status().scheduler.lastCompletedAt,now);
 scheduler.startTelegramScheduledMessageWorker(decrypt);assert.equal(intervals.length,1); delete globalThis.telegramScheduledMessageWorkerStarted;
});
