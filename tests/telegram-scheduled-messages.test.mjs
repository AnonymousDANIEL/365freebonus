import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import ts from 'typescript';

// Run the production migration and queue against disposable SQLite databases.
// Only Telegram transport is mocked; no live channel messages or credentials.
const fixture = mkdtempSync(path.join(tmpdir(), 'telegram-scheduled-text-'));
writeFileSync(path.join(fixture, 'package.json'), '{"type":"commonjs"}');
symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(fixture, 'node_modules'), 'dir');
for (const name of ['sqlite', 'telegram-game-tips', 'telegram-game-tips-types', 'telegram-game-tips-captions', 'telegram-scheduled-messages-types', 'telegram-scheduled-messages']) writeFileSync(path.join(fixture, name + '.js'), ts.transpileModule(
  readFileSync(new URL('../app/lib/' + name + '.ts', import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } },
).outputText);
writeFileSync(path.join(fixture, 'telegram-bot.js'), `
exports.calls=[];exports.onRequest=null;exports.onSend=null;exports.results={};exports.botName='FreeBonus365ChatBot';exports.roles={};
exports.ids={official:-1001111111111,group:-1002222222222,hot:-1003333333333};
exports.telegramRequest=async(token,method,p={},upload)=>{
 exports.calls.push({token,method,p,upload});
 if(exports.onRequest){const value=await exports.onRequest(method,p);if(value!==undefined)return value;}
 if(method==='getMe')return {ok:true,result:{id:12345678,is_bot:true,username:exports.botName}};
 if(method==='getChat'){
  const key=p.chat_id==='@join365freebonus'?'official':p.chat_id==='@join365freebonusgroup'?'group':'hot';
  return {ok:true,result:{id:exports.ids[key],type:'channel',title:key,username:key==='official'?'join365freebonus':key==='group'?'join365freebonusgroup':undefined}};
 }
 if(method==='getChatMember')return {ok:true,result:exports.roles[p.chat_id]||{status:'administrator',can_post_messages:true}};
 if(['sendMessage','sendPhoto','sendVideo','sendAnimation'].includes(method)){
  if(exports.onSend){const value=await exports.onSend(p,method);if(value!==undefined)return value;}
  const list=exports.results[p.chat_id];if(list?.length)return list.shift();
  return {ok:true,result:{message_id:100+exports.calls.length,chat:{id:p.chat_id,type:'channel'},text:p.text}};
 }
 throw new Error('Unexpected Telegram method '+method);
};
`);
writeFileSync(path.join(fixture, 'telegram-scheduled-media.js'), `
const {telegramRequest}=require('./telegram-bot');
exports.readScheduledMessageMedia=(db,id)=>db.prepare('SELECT id,kind,name,bytes FROM telegram_scheduled_message_media WHERE id=?').get(id)||null;
exports.sendScheduledMessageMedia=(db,token,chatId,caption,id)=>{
 const media=exports.readScheduledMessageMedia(db,id);
 return media ? telegramRequest(token,{photo:'sendPhoto',video:'sendVideo',animation:'sendAnimation'}[media.kind],{chat_id:chatId,caption,mediaId:id}) : Promise.resolve({ok:false,code:400,retryAfter:0});
};
`);
const require = createRequire(import.meta.url), scheduler = require(path.join(fixture, 'telegram-scheduled-messages.js'));
const telegram = require(path.join(fixture, 'telegram-bot.js')), { getSqlite } = require(path.join(fixture, 'sqlite.js'));
const gameTips = require(path.join(fixture, 'telegram-game-tips.js'));
const { DEFAULT_GAME_TIPS_CAPTION_PRESET_ID, GAME_TIPS_CAPTION_BODIES, gameTipsCaption } =
 require(path.join(fixture, 'telegram-game-tips-captions.js'));
const oldData = process.env.DATA_DIR, start = Date.parse('2026-11-15T00:59:00Z'), MINUTE = 60_000, DAY = 86_400_000;
const cipher = 'fixture-saved-ciphertext', token = '12345678:fixture-saved-token';
let now = start;
const clock = () => now, decrypt = value => value === cipher ? token : '';
const db = () => getSqlite();
const status = () => scheduler.scheduledMessageStatus(db(), clock);
const tick = () => scheduler.deliverScheduledMessagesOnce(decrypt, clock);
const sends = () => telegram.calls.filter(c => c.method === 'sendMessage');
const sendsMedia = () => telegram.calls.filter(c => ['sendPhoto','sendVideo','sendAnimation'].includes(c.method));
const jobs = () => db().prepare('SELECT * FROM telegram_scheduled_message_deliveries ORDER BY run_at,target_key').all();
const onlyPlan = () => status().plans[0];
function close() { const filename = path.join(process.env.DATA_DIR, 'directory.sqlite'); globalThis.__directorySqlite?.get(filename)?.close(); globalThis.__directorySqlite?.delete(filename); }
function input(extra={}) {
 return { requestId: randomUUID(), name: 'Daily news', text: 'First line\n\nExact text 🔥', times: ['09:00'], enabled: true,
  targetKeys: ['official','group','hot'], ...extra };
}
async function create(extra={}) { return scheduler.saveScheduledMessagePlan(db(), input(extra), decrypt, clock); }
async function update(extra={}) { const p = onlyPlan(); return scheduler.saveScheduledMessagePlan(db(), { id:p.id, revision:p.revision, name:p.name, text:p.text, times:p.times, enabled:p.enabled, ...extra }, decrypt, clock); }
function storeMedia(kind) {
 const id=randomUUID();
 db().prepare('INSERT INTO telegram_scheduled_message_media(id,kind,name,bytes,mime,created_at) VALUES(?,?,?,?,?,?)').run(id,kind,kind,64,'fixture',now);
 return id;
}
async function addGame(game, provider = 'MEGA888') {
 const id = randomUUID();
 const bytes = await sharp({create:{width:120,height:80,channels:3,background:'#214b7d'}}).png().toBuffer();
 const url = 'https://example.com/upload?' + new URLSearchParams({id,provider,game});
 const response = await gameTips.uploadGameTipsAsset(db(), new Request(url, {method:'POST',headers:{'content-type':'image/png'},body:bytes}), clock);
 return response.assets.find(asset => asset.id === id);
}
async function uploadLogo(provider, background, previousId = '') {
 const id = randomUUID();
 const bytes = await sharp({create:{width:200,height:100,channels:4,background}}).png().toBuffer();
 const url = 'https://example.com/logo?' + new URLSearchParams({id,provider,previousId});
 await gameTips.uploadGameTipsLogo(db(), new Request(url, {method:'POST',headers:{'content-type':'image/png'},body:bytes}));
 return id;
}
async function uploadBackground(provider, background, previousId = '') {
 const id = randomUUID();
 const bytes = await sharp({create:{width:240,height:144,channels:3,background}}).png().toBuffer();
 const url = 'https://example.com/background?' + new URLSearchParams({id,provider,previousId});
 await gameTips.uploadGameTipsBackground(db(), new Request(url, {method:'POST',headers:{'content-type':'image/png'},body:bytes}));
 return id;
}
const gamePlan = (extra = {}) => ({name:'Game Tips',text:'',gameTipsProvider:'MEGA888',targetKeys:['official'],...extra});
const gameSlot = at => JSON.parse(db().prepare('SELECT selection_json FROM telegram_game_tip_slots WHERE run_at=?').get(at).selection_json);

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
 assert.equal(db().prepare('PRAGMA user_version').get().user_version, 39);
});

test('Game Tips sends one generated photo with the selected caption and buttons to all chosen channels and rotates across daily slots', async () => {
 for (const game of ['Dolphin Reef','Iceland','Great Blue','Great Stars','Dragon Maiden','Razor Shark']) await addGame(game);
 await addGame('Other Platform Game','Other Platform');
 await create(gamePlan({times:['09:00','09:30'], targetKeys:['official','group'], gameTipsCaptionPresetId:'featured-selection'}));
 assert.deepEqual(status().gameTipsProviders.map(provider=>({...provider})),[{name:'MEGA888',count:6},{name:'Other Platform',count:1}]);
 assert.equal(onlyPlan().gameTipsProvider,'MEGA888');
 assert.equal(onlyPlan().gameTipsCaptionPresetId,'featured-selection');
 const first = onlyPlan().nextRunAt;
 now=first; await tick();
 const selection=gameSlot(first);
 const body=GAME_TIPS_CAPTION_BODIES.find(item=>item.id===selection.captionBodyId);
 assert.ok(body);
 const caption=gameTipsCaption(selection.provider,'featured-selection',body);
 assert.equal(selection.provider,'MEGA888');
 assert.equal(selection.captionPresetId,'featured-selection');
 assert.equal(selection.caption,caption);
 assert.match(caption,/^Featured Game Picks🔥\n\n365FreeBonus X MEGA888\n\n/);
 assert.ok(caption.includes(body.copy));
 assert.ok(caption.endsWith('🔥Free Credit Trusted Wallet🔥\nFind Free Bonus Offers\n🌐 EXPLORE BONUS OFFERS:\nhttps://365freebonus.com'));
 assert.ok(selection.games.every(({game})=>!caption.includes(game)));
 assert.equal(sends().length,0);
 assert.equal(sendsMedia().length,2);
 for (const { method,p,upload } of sendsMedia()) {
  assert.equal(method,'sendPhoto'); assert.equal(p.caption,caption); assert.equal(upload.field,'photo');
  assert.equal(upload.mime,'image/jpeg');
  assert.deepEqual(p.reply_markup.inline_keyboard, [[{text:'Visit website',url:'https://365freebonus.com/'},{text:'NEED HELP?',url:'https://t.me/FreeBonus365ChatBot'}]]);
 }
 const image=sendsMedia()[0].upload.bytes;
 assert.deepEqual(image,sendsMedia()[1].upload.bytes);
 const {width,height}=await sharp(image).metadata();
 assert.deepEqual({width,height},{width:1500,height:900});
 assert.ok(jobs().every(job=>job.text===''));
 now=onlyPlan().nextRunAt; await tick();
 const firstGames=new Set(selection.games.map(game=>game.game));
 assert.equal(new Set(gameSlot(now).games.map(game=>game.game)).size,3);
 assert.ok(gameSlot(now).games.every(game=>!firstGames.has(game.game)));
 assert.equal(onlyPlan().nextRunAt,first+DAY);
 assert.equal(status().gameTipsSummary.counts.sent,4);
 assert.equal(status().gameTipsSummary.nextRunAt,first+DAY);
 assert.equal(status().messageSummary.counts.sent,0);
 assert.equal(status().messageSummary.nextRunAt,null);
});

test('Game Tips rotates all ten caption bodies per platform across plans, days and a database reopen', async () => {
 const names=['Dolphin Reef','Iceland','Great Blue'];
 for (const name of names) {
   await addGame(name);
   await addGame(name,'918KISS');
 }
 await create(gamePlan({name:'Primary Mega',times:['09:00']}));
 await create(gamePlan({name:'Other platform',times:['09:01'],gameTipsProvider:'918KISS'}));
 await create(gamePlan({name:'Second Mega',times:['09:02'],gameTipsProvider:'mega888'}));
 const catalog=GAME_TIPS_CAPTION_BODIES.map(body=>body.id);
 assert.equal(new Set(catalog).size,10);
 const mega=[], kiss=[];
 for (let day=0;day<6;day++) {
   if (day===2) close();
   for (let minute=0;minute<3;minute++) {
     now=start+day*DAY+(minute+1)*MINUTE;
     await tick();
     const slot=gameSlot(now);
     const history=minute===1 ? kiss : mega;
     history.push(slot.captionBodyId);
     assert.equal(slot.caption,sendsMedia().at(-1).p.caption);
     assert.match(slot.caption,/^News Update Game Tips🔥\n\n365FreeBonus X (MEGA888|918KISS)\n\n/);
     assert.ok(names.every(name=>!slot.caption.includes(name)));
     assert.equal(slot.captionCycle.length,((history.length-1)%catalog.length)+1);
   }
 }
 assert.equal(sendsMedia().length,18);
 assert.deepEqual(new Set(mega.slice(0,10)),new Set(catalog));
 assert.notEqual(mega[9],mega[10]);
 assert.equal(new Set(mega.slice(10)).size,2);
 assert.equal(new Set(kiss).size,6);
});

test('Game Tips reports a depleted pool and skips the old day at MYT rollover', async () => {
 const first=await addGame('Dolphin Reef');
 await addGame('Iceland');
 await assert.rejects(create(gamePlan()), error=>error.status===400 && /至少需要 3/.test(error.message));
 await addGame('Great Blue');
 await create(gamePlan({times:['23:59','00:00','01:00']}));
 gameTips.updateGameTipsAsset(db(), {...first,enabled:false}, clock);
 assert.match(onlyPlan().gameTipsIssue,/至少需要 3/);
 assert.match(status().gameTipsSummary.lastError,/至少需要 3/);
 assert.equal(status().messageSummary.lastError,'');
 const skippedAt=onlyPlan().nextRunAt;
 now=Date.parse('2026-11-16T00:00:00+08:00'); await tick();
 assert.equal(sendsMedia().length,0);
 assert.deepEqual(jobs().map(job=>job.status),['skipped','skipped']);
 assert.equal(jobs()[0].run_at,skippedAt);
 assert.match(jobs()[0].last_error,/日期已结束/);
 assert.match(jobs()[1].last_error,/至少需要 3/);
 await addGame('Great Stars');
 now=onlyPlan().nextRunAt; await tick();
 assert.equal(sendsMedia().length,1); assert.equal(jobs().at(-1).status,'sent');
});

test('Game Tips platforms keep separate times and select their own canonical logo name and games', async () => {
 const megaLogo = await uploadLogo('MEGA888', '#e12047');
 const kissLogo = await uploadLogo('918KISS', '#34e658');
 for (const name of ['Dolphin Reef','Iceland','Great Blue']) await addGame(name, 'Mega888');
 for (const name of ['Great Stars','Dragon Maiden','Razor Shark']) await addGame(name, '918kiss');
 await create(gamePlan({name:'First platform',gameTipsProvider:'mega888',times:['09:00']}));
 await create(gamePlan({name:'Second platform',gameTipsProvider:'918KISS',times:['09:02']}));
 now = start + MINUTE; await tick();
 assert.equal(sendsMedia().length,1);
 assert.equal(gameSlot(now).logoId,megaLogo);
 assert.equal(gameSlot(now).provider,'MEGA888');
 assert.ok(sendsMedia()[0].p.caption.includes('365FreeBonus X MEGA888\n\n'));
 assert.ok(gameSlot(now).games.some(game=>game.game==='Dolphin Reef'));
 assert.ok(!sendsMedia()[0].p.caption.includes('Dolphin Reef'));
 assert.ok(!sendsMedia()[0].p.caption.includes('Great Stars'));
 now += 2 * MINUTE; await tick();
 assert.equal(sendsMedia().length,2);
 assert.equal(gameSlot(now).logoId,kissLogo);
 assert.ok(sendsMedia()[1].p.caption.includes('365FreeBonus X 918KISS\n\n'));
 assert.ok(gameSlot(now).games.some(game=>game.game==='Great Stars'));
 assert.ok(!sendsMedia()[1].p.caption.includes('Great Stars'));
 assert.ok(!sendsMedia()[1].p.caption.includes('Dolphin Reef'));
});

test('Game Tips reuses the same photo and caption for a definitive 429 retry and does not repeat an ambiguous send', async () => {
 const logo = await uploadLogo('MEGA888', '#e12047');
 const background = await uploadBackground('MEGA888', '#291348');
 for (const name of ['Dolphin Reef','Iceland','Great Blue']) await addGame(name);
 await create(gamePlan({targetKeys:['official','group'],times:['09:00','09:05']}));
 telegram.results[telegram.ids.group]=[null];
 telegram.results[telegram.ids.official]=[{ok:false,code:429,retryAfter:30}];
 const first=onlyPlan().nextRunAt;
 now=first; await tick();
 const firstAttempt=sendsMedia().find(call=>call.p.chat_id===telegram.ids.official);
 assert.equal(gameSlot(first).logoId,logo);
 assert.equal(gameSlot(first).backgroundId,background);
 const originalSnapshot=gameSlot(first);
 const id=gameSlot(first).games[0].id;
 const asset=gameTips.listGameTipAssets(db()).find(entry=>entry.id===id);
 gameTips.updateGameTipsAsset(db(), {...asset,game:'Renamed Game'}, clock);
 const newLogo = await uploadLogo('MEGA888', '#42c754', logo);
 const newBackground = await uploadBackground('MEGA888', '#25787b', background);
 now+=30_000; await tick();
 const official=sendsMedia().filter(call=>call.p.chat_id===telegram.ids.official);
 assert.equal(official.length,2);
 assert.equal(official[1].p.caption,firstAttempt.p.caption);
 assert.deepEqual(gameSlot(first),originalSnapshot);
 assert.deepEqual(official[1].upload.bytes,firstAttempt.upload.bytes);
 assert.equal(sendsMedia().filter(call=>call.p.chat_id===telegram.ids.group).length,1);
 assert.equal(jobs().find(job=>job.target_key==='group').status,'unknown');
 assert.equal(jobs().find(job=>job.target_key==='official').status,'sent');
 now = onlyPlan().nextRunAt; await tick();
 assert.equal(gameSlot(now).logoId,newLogo);
 assert.equal(gameSlot(now).backgroundId,newBackground);
 assert.notDeepEqual(sendsMedia().at(-1).upload.bytes,firstAttempt.upload.bytes);
 assert.ok(gameSlot(now).games.some(game=>game.game==='Renamed Game'));
 assert.ok(sendsMedia().slice(-2).every(call=>!call.p.caption.includes('Renamed Game')));
});

test('deleting an enabled Game Tips image preserves its queued retry and excludes it from the next post', async () => {
 const removed = await addGame('Dolphin Reef');
 await addGame('Iceland');
 await addGame('Great Blue');
 await create(gamePlan({times:['09:00','09:05']}));
 now = onlyPlan().nextRunAt;
 telegram.results[telegram.ids.official] = [{ok:false,code:429,retryAfter:30}];
 await tick();
 const firstAttempt = sendsMedia()[0];
 const library = gameTips.deleteGameTipsAsset(db(), removed, clock);
 assert.ok(!library.assets.some(asset => asset.id === removed.id));
 assert.equal(library.providers[0].count,2);
 assert.throws(() => gameTips.gameTipsImagePreview(db(), removed.id), {status:404});
 await addGame('New Game');
 now += 30_000; await tick();
 const retry = sendsMedia()[1];
 assert.deepEqual(retry.upload.bytes, firstAttempt.upload.bytes);
 assert.equal(retry.p.caption, firstAttempt.p.caption);
 assert.equal(jobs()[0].status,'sent');
 assert.equal(db().prepare('SELECT length(image) AS bytes FROM telegram_game_tips_assets WHERE id=?').get(removed.id).bytes,0);
 now = onlyPlan().nextRunAt; await tick();
 assert.equal(sendsMedia().length,3);
 assert.deepEqual(new Set(gameSlot(now).games.map(game=>game.game)),new Set(['Iceland','Great Blue','New Game']));
});

test('a legacy queued retry preserves its saved caption and does not acquire a rotation ID', async () => {
 for (const name of ['Dolphin Reef','Iceland','Great Blue']) await addGame(name);
 await create(gamePlan());
 const first=onlyPlan().nextRunAt;
 telegram.results[telegram.ids.official]=[{ok:false,code:429,retryAfter:30}];
 now=first; await tick();
 const legacyCopy=gameTipsCaption('MEGA888','bonus-roundup');
 db().prepare(`
   UPDATE telegram_game_tip_slots SET selection_json=json_set(
     json_remove(selection_json,'$.captionBodyId','$.captionCycle'),
     '$.captionPresetId','bonus-roundup','$.caption',?)
 `).run(legacyCopy);
 close();
 now+=30_000; await tick();
 assert.equal(sendsMedia().length,2);
 assert.equal(sendsMedia().at(-1).p.caption,legacyCopy);
 assert.equal(gameSlot(first).caption,legacyCopy);
 assert.equal(gameSlot(first).captionBodyId,undefined);
});

test('legacy Game Tips plans and queued retries use the default caption, and migration preserves workspace history across plan edits and deletion', async () => {
 for (const name of ['Dolphin Reef','Iceland','Great Blue']) await addGame(name);
 await create(gamePlan({gameTipsCaptionPresetId:'bonus-roundup'}));
 const gameId=onlyPlan().id, first=onlyPlan().nextRunAt;
 await create({times:['09:02'],targetKeys:['group']});
 telegram.results[telegram.ids.official]=[{ok:false,code:429,retryAfter:30}];
 now=first; await tick();
 db().prepare(`UPDATE telegram_game_tip_slots SET selection_json=json_remove(selection_json,'$.caption','$.captionPresetId','$.captionBodyId','$.captionCycle')`).run();
 db().exec(`DROP INDEX telegram_scheduled_message_game_tips_history;
   DROP INDEX telegram_scheduled_message_regular_history;
   ALTER TABLE telegram_scheduled_message_plans DROP COLUMN game_tips_caption_preset_id;
   ALTER TABLE telegram_scheduled_message_deliveries DROP COLUMN game_tips_provider;`);
 close();
 assert.equal(status().plans.find(plan=>plan.id===gameId).gameTipsCaptionPresetId,DEFAULT_GAME_TIPS_CAPTION_PRESET_ID);
 assert.equal(status().gameTipsSummary.counts.pending,1);
 assert.equal(status().deliveries[0].gameTipsProvider,'MEGA888');
 now+=30_000; await tick();
 const caption=sendsMedia().at(-1).p.caption;
 assert.equal(caption,gameTipsCaption('MEGA888'));
 assert.equal(gameSlot(first).caption,caption);
 assert.ok(gameSlot(first).games.every(({game})=>!caption.includes(game)));
 const game=status().plans.find(plan=>plan.id===gameId);
 await scheduler.saveScheduledMessagePlan(db(), {
   id:game.id,revision:game.revision,name:game.name,text:'Now a normal plan',times:game.times,enabled:false,gameTipsProvider:null,
 },decrypt,clock);
 const changed=status().plans.find(plan=>plan.id===gameId);
 scheduler.deleteScheduledMessagePlan(db(), {id:changed.id,revision:changed.revision},clock);
 now=first+2*MINUTE; await tick();
 assert.equal(sends().length,1);
 assert.equal(status().messageSummary.counts.sent,1);
 assert.equal(status().gameTipsSummary.counts.sent,1);
 assert.deepEqual(status().deliveries.map(d=>d.gameTipsProvider),[undefined,'MEGA888']);
});

test('Game Tips records a broken local image as a failed render without calling Telegram', async () => {
 const broken=await addGame('Dolphin Reef');
 await addGame('Iceland');
 await addGame('Great Blue');
 await create(gamePlan());
 db().prepare('UPDATE telegram_game_tips_assets SET image=? WHERE id=?').run(Buffer.from('broken fixture image'),broken.id);
 now=onlyPlan().nextRunAt; await tick();
 assert.equal(sendsMedia().length,0); assert.equal(sends().length,0);
 const [job]=jobs();
 assert.equal(job.status,'failed'); assert.equal(job.dispatch_started_at,0);
 assert.match(job.last_error,/无法生成 Game Tips 图片/);
});

test('disabled draft can be saved without credentials or outbound calls', async () => {
 db().prepare("UPDATE telegram_promotion_settings SET chat_bot_token_ciphertext='' WHERE id='primary'").run();
 await create({enabled:false}); assert.equal(onlyPlan().enabled,false); assert.equal(onlyPlan().nextRunAt,null); assert.equal(telegram.calls.length,0);
 await tick(); assert.equal(sends().length,0);
});

test('new regular and Game Tips plans require explicit nonempty channel selections', async () => {
 for (const draft of [{}, gamePlan()]) for (const targetKeys of [undefined, []]) {
  await assert.rejects(create({ ...draft, targetKeys }), error => error.status === 400 && /至少一个/.test(error.message));
 }
 assert.deepEqual(status().plans, []);
 assert.deepEqual(telegram.calls, []);
 await create({ targetKeys: ['official'] });
 await update({ text: 'Saved without changing the channel' });
 assert.deepEqual(onlyPlan().targetKeys, ['official']);
 now = onlyPlan().nextRunAt; await tick();
 assert.deepEqual(sends().map(call => call.p.chat_id), [telegram.ids.official]);
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

test('upgrading a v37 database retains fixed legacy targets and dispatched occurrence deduplication', async () => {
 await create(); now=onlyPlan().nextRunAt; await tick();
 const exact = db().prepare("SELECT target_keys_json FROM telegram_scheduled_message_plans").get().target_keys_json;
 assert.deepEqual(JSON.parse(exact), ['group','hot','official']);
 db().exec("UPDATE telegram_scheduled_message_plans SET target_keys_json=''");
 const before=onlyPlan(), ids=jobs().map(job=>job.id);
 db().exec(`DROP TABLE telegram_scheduled_message_media;
   DROP TABLE telegram_scheduled_message_channels;
   ALTER TABLE telegram_scheduled_message_plans DROP COLUMN calendar_date;
   ALTER TABLE telegram_scheduled_message_plans DROP COLUMN target_keys_json;
   ALTER TABLE telegram_scheduled_message_plans DROP COLUMN media_id;
   ALTER TABLE telegram_scheduled_message_deliveries DROP COLUMN media_id;
   PRAGMA user_version=37;`);
 close();
 assert.deepEqual(onlyPlan(),before);
 assert.deepEqual(onlyPlan().targetKeys,['official','group','hot']);
 await tick();assert.equal(sends().length,3);assert.deepEqual(jobs().map(job=>job.id),ids);
});

test('untouched built-in channels are editable and deletable without changing the separate Hot video destination', async () => {
 const target = key => status().targets.find(row => row.key === key);
 const save = (row, fields) => scheduler.saveScheduledMessageTarget(db(), {
  key: row.key, revision: row.revision, title: row.title, address: row.address, ...fields,
 }, decrypt, clock);
 const remove = row => scheduler.deleteScheduledMessageTarget(db(), { key: row.key, revision: row.revision }, clock);
 const official = target('official'), group = target('group'), hot = target('hot');
 assert.ok([official, group, hot].every(row => row.editable && /^[a-f0-9-]{36}$/.test(row.revision)));
 assert.deepEqual(status().targets.map(row => row.revision), [official, group, hot].map(row => row.revision));

 await create({ targetKeys: ['official'] });
 await save(official, { title: 'Renamed official' });
 const renamed = target('official');
 assert.equal(renamed.title, 'Renamed official');
 assert.notEqual(renamed.revision, official.revision);
 await assert.rejects(save(official, { title: 'Stale rename' }), error => error.status === 409);
 await assert.rejects(save(renamed, { address: '-1004444444444' }), /启用的发送计划/);
 assert.throws(() => remove(renamed), /启用的发送计划/);
 remove(group);
 assert.equal(target('group'), undefined);
 await assert.rejects(create({ enabled: false, targetKeys: ['group'] }), /所选频道已不存在/);

 const savedHot = -1004444444444, separateHot = -1005555555555;
 telegram.onRequest = (method, params) => {
  if (method === 'getChat' && params.chat_id === savedHot) return { ok: true, result: { id: savedHot, type: 'channel' } };
 };
 await save(hot, { title: 'Scheduled Hot', address: String(savedHot) });
 assert.equal(target('hot').chatId, String(savedHot));
 assert.equal(db().prepare("SELECT target_chat_id FROM telegram_hot_video_settings").get().target_chat_id, telegram.ids.hot);
 db().prepare("UPDATE telegram_hot_video_settings SET target_chat_id=?").run(separateHot);
 close();
 assert.equal(target('group'), undefined);
 assert.equal(target('official').title, 'Renamed official');
 assert.equal(target('hot').title, 'Scheduled Hot');
 assert.equal(target('hot').chatId, String(savedHot));
 await create({ name: 'Separate Hot schedule', targetKeys: ['hot'] });
 now = onlyPlan().nextRunAt; await tick();
 assert.deepEqual(sends().map(call => call.p.chat_id).sort(), [telegram.ids.official, savedHot].sort());
 assert.equal(db().prepare("SELECT target_chat_id FROM telegram_hot_video_settings").get().target_chat_id, separateHot);
});

test('deselected Game Tips channel is not sent even if a stale retry survives with the current revision', async () => {
 for (const game of ['Dolphin Reef','Iceland','Great Blue']) await addGame(game);
 await create(gamePlan({ targetKeys: ['official','group'] }));
 now = onlyPlan().nextRunAt;
 telegram.results[telegram.ids.group] = [{ ok: false, code: 429, retryAfter: 60 }];
 await tick();
 const pending = jobs().find(job => job.target_key === 'group');
 assert.equal(pending.status, 'pending');
 await update({ targetKeys: ['official'] });
 assert.equal(jobs().find(job => job.id === pending.id).status, 'cancelled');

 // Reproduce a stale, otherwise dispatchable row to exercise the final membership check.
 const revision = onlyPlan().revision;
 db().prepare(`INSERT INTO telegram_game_tip_slots(plan_id,plan_revision,run_at,provider_key,selection_json)
  SELECT plan_id,?,run_at,provider_key,selection_json FROM telegram_game_tip_slots WHERE plan_id=? AND plan_revision=? AND run_at=?`)
  .run(revision, pending.plan_id, pending.plan_revision, pending.run_at);
 db().prepare("UPDATE telegram_scheduled_message_deliveries SET plan_revision=?,status='pending' WHERE id=?").run(revision, pending.id);
 now += MINUTE; await tick();
 assert.deepEqual(sendsMedia().map(call => call.p.chat_id).sort(), [telegram.ids.official, telegram.ids.group].sort());
 const stale = jobs().find(job => job.id === pending.id);
 assert.equal(stale.status, 'cancelled');
 assert.equal(stale.attempts, pending.attempts);
 now = onlyPlan().nextRunAt; await tick();
 assert.equal(sendsMedia().length, 3);
 assert.equal(sendsMedia().at(-1).p.chat_id, telegram.ids.official);
});

test('custom channel management verifies publishing access, guards revisions and prevents changing an active target', async () => {
 const channelId=-1004444444444, nextId=-1005555555555;
 telegram.onRequest=(method,p)=>{
  if(method==='getChat'&&(p.chat_id==='@freshchannel'||p.chat_id===nextId)) return {ok:true,result:{id:p.chat_id===nextId?nextId:channelId,type:'channel',username:'freshchannel'}};
  if(method==='getChat'&&p.chat_id==='@existingalias')return {ok:true,result:{id:telegram.ids.official,type:'channel',username:'existingalias'}};
 };
 const save = fields => scheduler.saveScheduledMessageTarget(db(),fields,decrypt,clock);
 const remove = target => scheduler.deleteScheduledMessageTarget(db(),{key:target.key,revision:target.revision},clock);
 const requestId=randomUUID(), initial={requestId,title:' New channel ',address:'https://t.me/FreshChannel/'};
 await save(initial); const target=status().targets.find(row=>row.key===`custom:${requestId}`);
 assert.equal(target.address,'@freshchannel'); assert.equal(target.title,'New channel'); assert.equal(target.ready,true); assert.equal(target.chatId,String(channelId));
 assert.deepEqual((await save(initial)).targets.find(row=>row.key===target.key),target);
 await assert.rejects(save({...initial, title:'Different'}),e=>e.status===409);
 await assert.rejects(save({requestId:randomUUID(),title:'Duplicate',address:String(channelId)}),/已在发送目标/);
 await save({requestId:randomUUID(),title:'Alias',address:'@existingalias'});
 assert.equal(status().targets.find(row=>row.address==='@existingalias').ready,false);
 await create({calendarDate:'2026-11-15',targetKeys:[target.key]});
 await assert.rejects(save({key:target.key,revision:target.revision,title:target.title,address:String(nextId)}),/启用的发送计划/);
 assert.throws(()=>remove(target),/启用的发送计划/);
 await save({key:target.key,revision:target.revision,title:'Renamed label',address:target.address});
 const renamed=status().targets.find(row=>row.key===target.key);
 await assert.rejects(save({key:target.key,revision:target.revision,title:'Stale',address:target.address}),e=>e.status===409);
 now=onlyPlan().nextRunAt;await tick();
 assert.deepEqual(sends().map(call=>call.p.chat_id),[channelId]);assert.equal(status().deliveries[0].targetTitle,'Renamed label');
 await save({key:target.key,revision:renamed.revision,title:'New address',address:String(nextId)});
 remove(status().targets.find(row=>row.key===target.key));
 assert.equal(status().targets.some(row=>row.key===target.key),false);
 assert.equal(status().deliveries[0].targetTitle,'Renamed label');
});

test('dated photo and GIF use distinct captions at MYT midnight, without any old-day retry', async () => {
 now=Date.parse('2026-11-15T15:57:00Z');
 const photo=storeMedia('photo'), gif=storeMedia('animation');
 await create({calendarDate:'2026-11-15',targetKeys:['official'],mediaId:photo,text:'今日照片',times:['23:59']});
 await create({calendarDate:'2026-11-16',targetKeys:['official'],mediaId:gif,text:'明日 GIF',times:['00:00']});
 const today=status().plans.find(plan=>plan.calendarDate==='2026-11-15');
 const tomorrow=status().plans.find(plan=>plan.calendarDate==='2026-11-16');
 assert.equal(today.media.id,photo);assert.equal(tomorrow.media.id,gif);
 assert.equal(tomorrow.nextRunAt-today.nextRunAt,MINUTE);
 telegram.results[telegram.ids.official]=[{ok:false,code:429,retryAfter:70}];
 now=today.nextRunAt;await tick();
 assert.equal(jobs()[0].media_id,photo);assert.equal(jobs()[0].status,'pending');
 close();now=tomorrow.nextRunAt;await tick();now+=MINUTE;await tick();
 assert.deepEqual(sendsMedia().map(call=>[call.method,call.p.caption,call.p.mediaId]),[
  ['sendPhoto','今日照片',photo],['sendAnimation','明日 GIF',gif],
 ]);
 assert.deepEqual(jobs().map(job=>[job.status,job.media_id]),[['skipped',''],['sent','']]);
 assert.ok(status().plans.every(plan=>plan.nextRunAt===null));
 now+=DAY;await tick();assert.equal(sendsMedia().length,2);assert.equal(sends().length,0);
});

test('completed date still allows a safe same-day attachment retry and never retries an uncertain video', async () => {
 const mediaId=storeMedia('video');
 await create({calendarDate:'2026-11-15',targetKeys:['official','group'],mediaId,text:'Scheduled video'});
 now=onlyPlan().nextRunAt;
 telegram.results[telegram.ids.official]=[{ok:false,code:429,retryAfter:60}];
 telegram.results[telegram.ids.group]=[null];
 await tick();assert.equal(onlyPlan().nextRunAt,null);assert.deepEqual(jobs().map(row=>[row.target_key,row.status,row.media_id]),[
  ['group','unknown',mediaId],['official','pending',mediaId],
 ]);
 now+=MINUTE;await tick();assert.equal(sendsMedia().length,3);
 assert.equal(sendsMedia().at(-1).p.chat_id,telegram.ids.official);assert.equal(sendsMedia().at(-1).p.caption,'Scheduled video');
 assert.deepEqual(jobs().map(row=>[row.target_key,row.status,row.media_id]),[['group','unknown',mediaId],['official','sent','']]);
 now+=MINUTE;await tick();assert.equal(sendsMedia().length,3);
});

test('dated plans reject expired dates and leave newly scheduled dates available after historical plans accumulate', async () => {
 await assert.rejects(create({calendarDate:'2026-02-30'}),/有效的马来西亚日期/);
 await assert.rejects(create({calendarDate:'2026-11-14'}),/发送时间已过/);
 await assert.rejects(create({enabled:false,mediaId:randomUUID()}),/附件已失效/);
 await assert.rejects(create({mediaId:storeMedia('photo'),text:'x'.repeat(1025)}),/1,024/);
 for(let index=0;index<101;index++)await create({calendarDate:'2026-11-14',enabled:false});
 await create({calendarDate:'2026-11-15',targetKeys:['group']});
 now=Date.parse('2026-11-15T16:00:00Z');await tick();
 assert.equal(sends().length,0);assert.equal(status().counts.skipped,1);
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
