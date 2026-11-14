import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

// Exercise the production SQLite migration and gate state machine; only
// Telegram transport is replaced. No actual account, message or network call.
const fixture=mkdtempSync(path.join(tmpdir(),'telegram-join-gate-'));
writeFileSync(path.join(fixture,'package.json'),'{"type":"commonjs"}');
for(const name of ['sqlite','telegram-join-gate','telegram-followups'])writeFileSync(path.join(fixture,`${name}.js`),ts.transpileModule(
  readFileSync(new URL(`../app/lib/${name}.ts`,import.meta.url),'utf8'),
  {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}},
).outputText);
writeFileSync(path.join(fixture,'telegram-bot.js'),`
exports.calls=[];exports.onRequest=null;exports.onBoolean=null;exports.members=new Map();exports.now=0;
exports.chats=new Map();exports.inviteSerial=0;exports.nextMessage=9000;
exports.telegramRequest=async(token,method,p={})=>{
  exports.calls.push({token,method,parameters:p});
  if(exports.onRequest){const result=await exports.onRequest(method,p);if(result!==undefined)return result;}
  if(method==='getMe')return {ok:true,result:{id:12345678,is_bot:true,username:'FreeBonus365ChatBot'}};
  if(method==='getWebhookInfo')return {ok:true,result:{url:''}};
  if(method==='getChat')return exports.chats.has(String(p.chat_id))?{ok:true,result:exports.chats.get(String(p.chat_id))}:{ok:false,code:400,retryAfter:0};
  if(method==='getChatMember')return {ok:true,result:p.user_id===12345678?{status:'administrator',can_invite_users:true,can_restrict_members:true}:exports.members.get(String(p.chat_id)+':'+p.user_id)||{status:'left'}};
  if(method==='createChatInviteLink')return {ok:true,result:{invite_link:'https://t.me/+fixture-approval-'+(++exports.inviteSerial),creates_join_request:true,is_primary:false,is_revoked:false,creator:{id:12345678,is_bot:true}}};
  if(method==='sendMessage')return {ok:true,result:{message_id:exports.nextMessage++,date:Math.floor(exports.now/1000),chat:{id:p.chat_id,type:'private'}}};
  throw new Error('Unexpected gate object method: '+method);
};
exports.telegramBooleanRequest=async(token,method,p={})=>{
  exports.calls.push({token,method,parameters:p});
  if(exports.onBoolean){const result=await exports.onBoolean(method,p);if(result!==undefined)return result;}
  if(method==='approveChatJoinRequest')exports.members.set(String(p.chat_id)+':'+p.user_id,{status:'member'});
  if(method==='banChatMember')exports.members.set(String(p.chat_id)+':'+p.user_id,{status:'kicked',until_date:p.until_date||0});
  if(method==='unbanChatMember')exports.members.set(String(p.chat_id)+':'+p.user_id,{status:'left'});
  return {ok:true,result:true};
};
exports.answerTelegramCallback=async(token,id)=>{exports.calls.push({token,method:'answerCallbackQuery',id});return true;};
`);
const require=createRequire(import.meta.url);
const gate=require(path.join(fixture,'telegram-join-gate.js'));
const transport=require(path.join(fixture,'telegram-bot.js'));
const followups=require(path.join(fixture,'telegram-followups.js'));
const {getSqlite}=require(path.join(fixture,'sqlite.js'));
const previousData=process.env.DATA_DIR;
const now=1_800_000_000_000,minute=60_000;
const botId=12345678,userId=701,hot=-1009000,official=-1001000,group=-1002000;
const token='12345678:fixture-chat-token',cipher='fixture-chat-cipher';
function db(){return getSqlite();}
function close(){const p=path.join(process.env.DATA_DIR,'directory.sqlite');globalThis.__directorySqlite?.get(p)?.close();globalThis.__directorySqlite?.delete(p);}
function configure(){
  db().prepare(`INSERT INTO telegram_promotion_settings(id,enabled,chat_id,token_ciphertext,chat_bot_token_ciphertext,
    private_enabled,private_started_at,welcome_revision) VALUES('primary',0,'','',?,1,?,'fixture-welcome')`).run(cipher,now/1000-100);
}
function decrypt(value){assert.equal(value,cipher,'gate must use the ChatBot credential');return token;}
function input(extra={}){return {enabled:true,targetChatId:String(hot),requiredChats:[
  {chatId:'@join365freebonus',label:'BONUS OFFICIAL',url:'https://t.me/join365freebonus'},
  {chatId:'@join365freebonusgroup',label:'BONUS GROUP',url:'https://t.me/join365freebonusgroup'},
],...extra};}
async function activate(extra={}){return gate.saveJoinGateSettings(db(),input(extra),decrypt,()=>now);}
function membership(chat,id=userId,status='member'){transport.members.set(String(chat)+':'+id,typeof status==='string'?{status}:status);}
function calls(method){return transport.calls.filter(c=>c.method===method);}
function joinedBoth(id=userId){membership(official,id);membership(group,id);}
function joinRequest(updateId=1,id=userId,at=now){return {update_id:updateId,chat_join_request:{chat:{id:hot,type:'channel'},from:{id,is_bot:false},date:Math.floor(at/1000)}};}
function memberUpdate(updateId,chat,id=userId,status='member',at=now){return {update_id:updateId,chat_member:{chat:{id:chat,type:'channel'},from:{id:botId,is_bot:true},date:Math.floor(at/1000),old_chat_member:{user:{id,is_bot:false},status:'member'},new_chat_member:{user:{id,is_bot:false},...(typeof status==='string'?{status}:status)}}};}
function privateMessage(updateId,text='/hot',id=userId,at=now){return {update_id:updateId,message:{message_id:1000+updateId,date:Math.floor(at/1000),chat:{id,type:'private'},from:{id,is_bot:false},text}};}
function observe(update,at=now){return gate.observeJoinGateUpdate(db(),update,update.update_id,at);}

test.beforeEach(()=>{
  process.env.DATA_DIR=mkdtempSync(path.join(fixture,'case-'));transport.calls.length=0;transport.onRequest=null;transport.onBoolean=null;
  transport.members.clear();transport.chats.clear();transport.now=now;transport.inviteSerial=0;transport.nextMessage=9000;
  transport.chats.set(String(hot),{id:hot,type:'channel',title:'Hot'});
  for(const [id,username,title] of [[official,'join365freebonus','Official'],[group,'join365freebonusgroup','Group']]){
    const chat={id,type:'channel',username,title};transport.chats.set(String(id),chat);transport.chats.set('@'+username,chat);
  }
});
test.afterEach(close);
test.after(()=>{if(previousData===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previousData;rmSync(fixture,{recursive:true,force:true});});

test('a fresh database has a disabled gate, no queued actions and no exposed credentials or members',()=>{
  const result=gate.joinGateStatus(db());
  assert.equal(result.enabled,false);assert.equal(result.ready,false);
  assert.deepEqual(result.counts,{pending:0,approved:0,blocked:0,failed:0,unknown:0});
  const encoded=JSON.stringify(result);for(const value of [cipher,token,String(userId)])assert.equal(encoded.includes(value),false);
  assert.equal(transport.calls.length,0);
});

test('enabling verifies the three distinct chats and creates only a request-approval invitation',async()=>{
  configure();const result=await activate();
  assert.equal(result.enabled,true);assert.equal(String(result.targetChatId),String(hot));
  assert.equal(result.requiredChats.length,2);assert.ok(result.revision);
  assert.equal(calls('createChatInviteLink').length,1);
  assert.equal(calls('createChatInviteLink')[0].parameters.creates_join_request,true);
  assert.equal(result.inviteLink,'https://t.me/+fixture-approval-1');
  assert.equal(calls('approveChatJoinRequest').length,0);assert.equal(calls('banChatMember').length,0);
});

test('a public Hot channel cannot enable a private-content gate',async()=>{
  configure();transport.chats.get(String(hot)).username='public_hot';
  await assert.rejects(activate());assert.equal(gate.joinGateStatus(db()).enabled,false);
  assert.equal(calls('createChatInviteLink').length,0);
});

test('missing invitation or ban permission stops enablement without changing data or inviting anyone',async()=>{
  configure();transport.onRequest=(method,p)=>method==='getChatMember'&&Number(p.chat_id)===hot&&p.user_id===botId
    ?{ok:true,result:{status:'administrator',can_invite_users:true,can_restrict_members:false}}:undefined;
  await assert.rejects(activate());assert.equal(gate.joinGateStatus(db()).enabled,false);assert.equal(calls('createChatInviteLink').length,0);
});

test('required join links cannot point at an unrelated website or another public channel',async()=>{
  configure();for(const url of ['https://evil.example/','https://t.me/unrelated_channel']){
    const requiredChats=input().requiredChats;requiredChats[0]={...requiredChats[0],url};
    await assert.rejects(activate({requiredChats}));assert.equal(gate.joinGateStatus(db()).enabled,false);
  }
  assert.equal(calls('createChatInviteLink').length,0);
});

test('the target and required chats must resolve to separate Telegram identities',async()=>{
  configure();const requiredChats=input().requiredChats;requiredChats[1]={...requiredChats[0]};
  await assert.rejects(activate({requiredChats}));assert.equal(gate.joinGateStatus(db()).enabled,false);assert.equal(calls('createChatInviteLink').length,0);
});

async function tick(at=now){transport.now=at;return gate.runJoinGateOnce(decrypt,()=>at);}

for(const entry of ['🔞365 Free Bonus Hot','🔒 Hot 频道'])
test('the renamed Hot entry and existing keyboards both reach the gate: '+entry,async()=>{
  configure();await activate();
  assert.equal(observe(privateMessage(1,entry)),true);
  await tick();
  const message=calls('sendMessage').at(-1).parameters;
  assert.equal(message.text,'Please join all the channels below, then tap Verify:\nBONUS OFFICIAL\nBONUS GROUP');
  assert.deepEqual(message.reply_markup.inline_keyboard,[
    [{text:'BONUS OFFICIAL',url:'https://t.me/join365freebonus'}],
    [{text:'BONUS GROUP',url:'https://t.me/join365freebonusgroup'}],
    [{text:"✅ I've joined — Verify",callback_data:'hot:check'}],
  ]);
  assert.equal(calls('approveChatJoinRequest').length,0);
  assert.equal(calls('banChatMember').length,0);
});

for(const alreadyInside of [false,true])
test('verified Hot customers receive only English access instructions, already inside: '+alreadyInside,async()=>{
  configure();await activate();joinedBoth();
  if(alreadyInside)membership(hot);
  observe(privateMessage(1,'🔞365 Free Bonus Hot'));await tick();
  const message=calls('sendMessage').at(-1).parameters;
  assert.equal(message.text,alreadyInside
    ?'You meet all membership requirements and already have access to 365 Free Bonus Hot.'
    :'All membership requirements are met. Tap below to request access to 365 Free Bonus Hot.');
  assert.deepEqual(message.reply_markup.inline_keyboard,[
    [{text:'🔞 Enter 365 Free Bonus Hot',url:'https://t.me/+fixture-approval-1'}],
    [{text:'✅ Verify again',callback_data:'hot:check'}],
  ]);
  assert.equal(/\p{Script=Han}/u.test(JSON.stringify(message)),false);
  assert.equal(calls('createChatInviteLink')[0].parameters.name,'365 Free Bonus Hot approval');
  assert.equal(calls('approveChatJoinRequest').length,0,'reading the translated instructions does not approve a nonexistent request');
});

test('a new Hot request is approved only after fresh successful checks of both required memberships',async()=>{
  configure();await activate();joinedBoth();observe(joinRequest());await tick();
  assert.equal(calls('approveChatJoinRequest').length,1);
  assert.deepEqual(calls('approveChatJoinRequest')[0].parameters,{chat_id:hot,user_id:userId});
  assert.equal(calls('banChatMember').length,0);
  assert.ok(calls('getChatMember').some(c=>Number(c.parameters.chat_id)===official&&c.parameters.user_id===userId));
  assert.ok(calls('getChatMember').some(c=>Number(c.parameters.chat_id)===group&&c.parameters.user_id===userId));
  assert.equal(gate.joinGateStatus(db()).counts.approved,1);
  observe(joinRequest());await tick(now+minute);
  assert.equal(calls('approveChatJoinRequest').length,1,'the same Telegram request cannot be approved twice');
});

test('one joined requirement never counts as two and a missing member is not approved',async()=>{
  configure();await activate();membership(official);observe(joinRequest());await tick();
  assert.equal(calls('approveChatJoinRequest').length,0);assert.equal(calls('banChatMember').length,0);
  assert.equal(gate.joinGateStatus(db()).counts.approved,0);
});

test('restricted membership counts only when Telegram explicitly confirms is_member',async()=>{
  configure();await activate();membership(official,userId,{status:'restricted',is_member:true});membership(group,userId,{status:'restricted',is_member:false});
  observe(joinRequest());await tick();assert.equal(calls('approveChatJoinRequest').length,0);
  membership(group,userId,{status:'restricted',is_member:true});observe(joinRequest(2,userId,now+minute));await tick(now+minute);
  assert.equal(calls('approveChatJoinRequest').length,1);
});

for(const response of [null,{ok:false,code:500,retryAfter:0},{ok:true,result:{status:'unrecognized-new-status'}}])
test('unknown membership evidence never approves or punishes a customer '+JSON.stringify(response),async()=>{
  configure();await activate();joinedBoth();observe(joinRequest());
  transport.onRequest=(method,p)=>method==='getChatMember'&&Number(p.chat_id)===official&&p.user_id===userId?response:undefined;
  await tick();assert.equal(calls('approveChatJoinRequest').length,0);assert.equal(calls('declineChatJoinRequest').length,0);assert.equal(calls('banChatMember').length,0);
  assert.equal(gate.joinGateStatus(db()).counts.approved,0);
});

test('a genuine Telegram wait is honored before repeating membership reads',async()=>{
  configure();await activate();joinedBoth();observe(joinRequest());let limited=0;
  transport.onRequest=(method,p)=>method==='getChatMember'&&p.user_id===userId?(limited++,{ok:false,code:429,retryAfter:120}):undefined;
  await tick();const before=limited;await tick(now+minute);
  assert.equal(limited,before,'the real retry_after must not be shortened');
  assert.equal(calls('approveChatJoinRequest').length,0);assert.equal(calls('banChatMember').length,0);
});

test('a managed Hot member leaving either required chat is rechecked before removal',async()=>{
  configure();await activate();joinedBoth();observe(joinRequest());await tick();
  membership(group,userId,'left');observe(memberUpdate(2,group,userId,'left',now+minute));await tick(now+minute);
  assert.equal(calls('banChatMember').length,1);assert.equal(Number(calls('banChatMember')[0].parameters.chat_id),hot);
  assert.equal(calls('banChatMember')[0].parameters.user_id,userId);
  assert.equal(gate.joinGateStatus(db()).counts.blocked,1);
});

test('a required-chat leave from an untracked customer cannot remove unrelated Hot users',async()=>{
  configure();await activate();membership(hot);membership(official);observe(memberUpdate(2,group,userId,'left'));
  await tick();assert.equal(calls('banChatMember').length,0);assert.equal(calls('approveChatJoinRequest').length,0);
});

for(const role of ['creator','administrator'])test('Hot '+role+' is exempt from automated removal',async()=>{
  configure();await activate();joinedBoth();observe(joinRequest());await tick();
  membership(hot,userId,role);membership(group,userId,'left');observe(memberUpdate(2,group,userId,'left',now+minute));await tick(now+minute);
  assert.equal(calls('banChatMember').length,0);
});

test('a manual Hot ban is never lifted by satisfying both requirements',async()=>{
  configure();await activate();joinedBoth();observe(joinRequest());await tick();membership(hot,userId,'kicked');
  assert.equal(observe(privateMessage(2,'/hot',userId,now+minute)),true);await tick(now+minute);
  assert.equal(calls('unbanChatMember').length,0);
});

test('private verification sends current join buttons once and never retries an ambiguous send',async()=>{
  configure();await activate();membership(official);assert.equal(observe(privateMessage(1)),true);
  transport.onRequest=(method)=>method==='sendMessage'?null:undefined;
  await tick();assert.equal(calls('sendMessage').length,1);
  const markup=calls('sendMessage')[0].parameters.reply_markup;
  assert.ok(markup.inline_keyboard.flat().some(b=>b.url==='https://t.me/join365freebonusgroup'));
  close();await tick(now+minute);assert.equal(calls('sendMessage').length,1);
  assert.equal(calls('approveChatJoinRequest').length,0);
});

test('ordinary messages and opt-out commands retain their original ChatBot route',async()=>{
  configure();await activate();for(const text of ['hello','/stop','/start','/menu','website link'])assert.equal(observe(privateMessage(1,text)),false,text);
});

test('Bot credential replacement during a read stops every externally visible gate action',async()=>{
  configure();await activate();joinedBoth();observe(joinRequest());let changed=false;
  transport.onRequest=(method,p)=>{
    if(!changed&&method==='getChatMember'&&p.user_id===userId){changed=true;db().prepare("UPDATE telegram_promotion_settings SET chat_bot_token_ciphertext='replacement-cipher'").run();}
  };
  await tick();assert.equal(calls('approveChatJoinRequest').length,0);assert.equal(calls('banChatMember').length,0);assert.equal(calls('sendMessage').length,0);
  assert.equal(gate.joinGateStatus(db()).ready,false);
});

test('disabled gate leaves pending joins alone and never sends Hot instructions',async()=>{
  configure();await activate();joinedBoth();observe(joinRequest());
  await gate.saveJoinGateSettings(db(),input({enabled:false,revision:gate.joinGateStatus(db()).revision}),decrypt,()=>now+1);
  await tick(now+minute);assert.equal(calls('approveChatJoinRequest').length,0);assert.equal(calls('banChatMember').length,0);assert.equal(calls('sendMessage').length,0);
  assert.equal(observe(privateMessage(2,'/hot',userId,now+minute),now+minute),false);
});

test('gate migration adds only isolated tables and preserves existing credentials and PIN settings',()=>{
  configure();const connection=db();
  connection.prepare("INSERT INTO notes_vault_settings(id,pin_hash,revision,created_at,updated_at) VALUES('primary','fixture-pin-hash','vault-revision',123,456)").run();
  const before={...connection.prepare("SELECT * FROM telegram_promotion_settings WHERE id='primary'").get()};
  const vault={...connection.prepare("SELECT * FROM notes_vault_settings WHERE id='primary'").get()};
  for(const name of ['settings','members','jobs','candidates','discovery','events'])connection.exec('DROP TABLE telegram_join_gate_'+name);
  connection.exec('PRAGMA user_version=25');close();
  assert.equal(db().prepare('PRAGMA user_version').get().user_version,26);
  assert.deepEqual({...db().prepare("SELECT * FROM telegram_promotion_settings WHERE id='primary'").get()},before);
  assert.deepEqual({...db().prepare("SELECT * FROM notes_vault_settings WHERE id='primary'").get()},vault);
  assert.equal(gate.joinGateStatus(db()).enabled,false);
});

test('gate enablement refuses a different bot identity or a conflicting webhook',async()=>{
  configure();transport.onRequest=method=>method==='getMe'?{ok:true,result:{id:botId,is_bot:true,username:'FreeBonus365Bot'}}:undefined;
  await assert.rejects(activate());assert.equal(gate.joinGateStatus(db()).enabled,false);
  transport.onRequest=method=>method==='getWebhookInfo'?{ok:true,result:{url:'https://another-receiver.example/'}}:undefined;
  await assert.rejects(activate());assert.equal(gate.joinGateStatus(db()).enabled,false);assert.equal(calls('createChatInviteLink').length,0);
});

test('channel observations discover a private Hot candidate only after the bot administrator role is verified',async()=>{
  configure();observe({update_id:1,channel_post:{chat:{id:hot,type:'channel',title:'Untrusted title'},message_id:1,date:now/1000}});
  assert.equal(gate.joinGateStatus(db()).candidates.length,0,'raw update metadata is not yet verified');
  await tick();assert.deepEqual(gate.joinGateStatus(db()).candidates,[{chatId:String(hot),title:'Hot'}]);
  assert.equal(gate.joinGateStatus(db()).enabled,false);assert.equal(calls('createChatInviteLink').length,0);assert.equal(calls('approveChatJoinRequest').length,0);
});

test('a forwarded private channel cannot be added to candidates by a non-administrator',async()=>{
  configure();const message=privateMessage(1);delete message.message.text;
  message.message.forward_origin={type:'channel',chat:{id:hot,type:'channel'},message_id:5,date:now/1000};
  observe(message);await tick();assert.equal(gate.joinGateStatus(db()).candidates.length,0);
  membership(hot,userId,'administrator');message.update_id=2;message.message.message_id=1002;observe(message,now+minute);await tick(now+minute);
  assert.deepEqual(gate.joinGateStatus(db()).candidates,[{chatId:String(hot),title:'Hot'}]);
});

test('private callback verification is bound to its actual private sender and cannot inspect another customer',async()=>{
  configure();await activate();joinedBoth();
  const callback={update_id:1,callback_query:{id:'fixture-callback',data:'hot:check',from:{id:userId,is_bot:false},message:{message_id:101,date:now/1000,chat:{id:userId+1,type:'private'}}}};
  assert.equal(observe(callback),false);await tick();assert.equal(calls('sendMessage').length,0);assert.equal(calls('approveChatJoinRequest').length,0);
});

test('stale Hot requests and requests from another destination cannot enter the gate queue',async()=>{
  configure();await activate();joinedBoth();observe(joinRequest(1,userId,now-minute));
  const other=joinRequest(2);other.chat_join_request.chat.id=hot-1;observe(other);await tick();
  assert.equal(calls('approveChatJoinRequest').length,0);assert.equal(calls('banChatMember').length,0);assert.equal(gate.joinGateStatus(db()).counts.pending,0);
});

test('a system-managed block can be lifted after both joins without approving a nonexistent request',async()=>{
  configure();await activate();joinedBoth();observe(joinRequest());await tick();
  membership(group,userId,'left');observe(memberUpdate(2,group,userId,'left',now+minute));await tick(now+minute);assert.equal(calls('banChatMember').length,1);
  joinedBoth();observe(privateMessage(3,'/hot',userId,now+2*minute));await tick(now+2*minute);
  assert.equal(calls('unbanChatMember').length,1);
  assert.equal(calls('approveChatJoinRequest').length,1,'only the original actual request was approved');
  assert.ok(calls('sendMessage').at(-1).parameters.reply_markup.inline_keyboard.flat().some(button=>button.url==='https://t.me/+fixture-approval-1'));
});

test('two concurrent gate ticks cannot both approve the same request',{timeout:3000},async()=>{
  configure();await activate();joinedBoth();observe(joinRequest());
  let resume,entered;const paused=new Promise(resolve=>{resume=resolve;});const reached=new Promise(resolve=>{entered=resolve;});let waited=false;
  transport.onRequest=async(method,p)=>{
    if(!waited&&method==='getChatMember'&&p.user_id===userId){waited=true;entered();await paused;}
  };
  const first=tick();await reached;await tick();resume();await first;
  assert.equal(calls('approveChatJoinRequest').length,1);
});

test('turning the gate off during a membership read prevents approval and customer messages',async()=>{
  configure();await activate();joinedBoth();observe(joinRequest());let disabled=false;
  transport.onRequest=async(method,p)=>{
    if(!disabled&&method==='getChatMember'&&p.user_id===userId){disabled=true;await gate.saveJoinGateSettings(db(),input({enabled:false,revision:gate.joinGateStatus(db()).revision}),decrypt,()=>now+1);}
  };
  await tick();assert.equal(disabled,true);assert.equal(gate.joinGateStatus(db()).enabled,false);
  assert.equal(calls('approveChatJoinRequest').length,0);assert.equal(calls('banChatMember').length,0);assert.equal(calls('sendMessage').length,0);
});

test('an ambiguous approval is reconciled against actual membership rather than reported as a confirmed success',async()=>{
  configure();await activate();joinedBoth();observe(joinRequest());
  transport.onBoolean=(method)=>method==='approveChatJoinRequest'?null:undefined;
  await tick();assert.equal(calls('approveChatJoinRequest').length,1);assert.equal(gate.joinGateStatus(db()).counts.approved,0);
  membership(hot);close();await tick(now+2*minute);
  assert.equal(calls('approveChatJoinRequest').length,1,'a delivered approval is recovered by readback without repeating the mutation');
  assert.equal(gate.joinGateStatus(db()).counts.approved,1);
});

test('saving the same protected Hot channel does not abandon existing managed memberships',async()=>{
  configure();await activate();joinedBoth();observe(joinRequest());await tick();
  await gate.saveJoinGateSettings(db(),input({revision:gate.joinGateStatus(db()).revision}),decrypt,()=>now+1000);
  membership(group,userId,'left');observe(memberUpdate(2,group,userId,'left',now+minute));await tick(now+minute);
  assert.equal(calls('banChatMember').length,1,'settings changes must not silently stop checking already approved customers');
});

test('an explicit manual ban after a managed block takes precedence over automatic unban',async()=>{
  configure();await activate();joinedBoth();observe(joinRequest());await tick();
  membership(group,userId,'left');observe(memberUpdate(2,group,userId,'left',now+minute));await tick(now+minute);
  assert.equal(calls('banChatMember').length,1);
  const manual=memberUpdate(3,hot,userId,'kicked',now+minute+1000);manual.chat_member.from={id:9009,is_bot:false};observe(manual,now+minute+1000);
  joinedBoth();observe(privateMessage(4,'/hot',userId,now+2*minute));await tick(now+2*minute);
  assert.equal(calls('unbanChatMember').length,0,'an administrator override must not be mistaken for the old system ban');
});

test('a confirmed private gate answer cancels an older unmatched-message followup without changing subscription consent',async()=>{
  configure();await activate();joinedBoth();
  db().prepare("UPDATE telegram_promotion_settings SET private_followup_enabled=1,private_followup_message='Need help?',private_followup_started_at=?,private_followup_revision='fixture-followup'").run(now/1000-100);
  db().prepare("INSERT INTO telegram_private_contacts(user_id,updates_enabled,updates_started_at) VALUES(?,0,?)").run(userId,now-1000);
  followups.observePrivateFollowupInput(db(),db().prepare("SELECT * FROM telegram_promotion_settings WHERE id='primary'").get(),
    {chatId:userId,updateId:1,messageId:1000,at:now,unmatched:true});
  assert.equal(db().prepare('SELECT status FROM telegram_private_followups WHERE chat_id=?').get(userId).status,'pending');
  observe(privateMessage(2,'/hot',userId,now+1000),now+1000);await tick(now+1000);
  assert.equal(calls('sendMessage').length,1);
  assert.equal(db().prepare('SELECT status FROM telegram_join_gate_jobs WHERE user_id=?').get(userId).status,'done');
  assert.equal(db().prepare('SELECT status FROM telegram_private_followups WHERE chat_id=?').get(userId).status,'cancelled');
  assert.equal(db().prepare('SELECT updates_enabled FROM telegram_private_contacts WHERE user_id=?').get(userId).updates_enabled,0);
});

test('disabling and re-enabling the same Hot channel preserves the managed-member registry',async()=>{
  configure();await activate();joinedBoth();observe(joinRequest());await tick();
  await gate.saveJoinGateSettings(db(),input({enabled:false,revision:gate.joinGateStatus(db()).revision}),decrypt,()=>now+1000);
  await gate.saveJoinGateSettings(db(),input({revision:gate.joinGateStatus(db()).revision}),decrypt,()=>now+2000);
  membership(group,userId,'left');observe(memberUpdate(2,group,userId,'left',now+minute));await tick(now+minute);
  assert.equal(calls('banChatMember').length,1);
});

test('revalidating new credentials for the same verified bot keeps existing managed memberships',async()=>{
  configure();await activate();joinedBoth();observe(joinRequest());await tick();
  db().prepare("UPDATE telegram_promotion_settings SET chat_bot_token_ciphertext='rotated-cipher'").run();
  const rotated=value=>{assert.equal(value,'rotated-cipher');return token;};
  await gate.saveJoinGateSettings(db(),input({revision:gate.joinGateStatus(db()).revision}),rotated,()=>now+1000);
  membership(group,userId,'left');observe(memberUpdate(2,group,userId,'left',now+minute));transport.now=now+minute;
  await gate.runJoinGateOnce(rotated,()=>now+minute);
  assert.equal(calls('banChatMember').length,1);
});

test('a manual replacement ban cannot be lifted even if its update was not observed',async()=>{
  configure();await activate();joinedBoth();observe(joinRequest());await tick();
  membership(group,userId,'left');observe(memberUpdate(2,group,userId,'left',now+minute));await tick(now+minute);
  assert.equal(calls('banChatMember').length,1);
  membership(hot,userId,{status:'kicked',until_date:0});joinedBoth();
  observe(privateMessage(3,'/hot',userId,now+2*minute));await tick(now+2*minute);
  assert.equal(calls('unbanChatMember').length,0,'fresh Telegram ban identity must still match the program-owned restriction');
});

test('Telegram second-resolution dates do not drop a join request received in the enablement second',async()=>{
  configure();await gate.saveJoinGateSettings(db(),input(),decrypt,()=>now+500);joinedBoth();
  observe(joinRequest(1,userId,now+700),now+700);await tick(now+1000);
  assert.equal(calls('approveChatJoinRequest').length,1);
});

test('a newly observed direct Hot join is checked and removed when both prerequisites are not met',async()=>{
  configure();await activate();membership(hot);membership(official);
  observe(memberUpdate(1,hot,userId,'member'));await tick();
  assert.equal(calls('banChatMember').length,1);assert.equal(calls('approveChatJoinRequest').length,0);
  assert.equal(gate.joinGateStatus(db()).counts.blocked,1);
});

test('an already joined member with a stale request is enforced without declining a nonexistent request',async()=>{
  configure();await activate();membership(hot);membership(official);
  observe(joinRequest());await tick();
  assert.equal(calls('banChatMember').length,1);
  assert.equal(calls('approveChatJoinRequest').length,0);
  assert.equal(calls('declineChatJoinRequest').length,0);
  assert.equal(db().prepare('SELECT status FROM telegram_join_gate_jobs WHERE user_id=?').get(userId).status,'done');
});
