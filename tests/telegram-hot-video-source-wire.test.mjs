import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv,createHmac,randomBytes } from 'node:crypto';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url),actualPath=require.resolve('teleproto'),{Api}=require('teleproto'),bigInt=require('big-integer');
const {BinaryReader}=require('teleproto/compat/extensions/BinaryReader');
const dir=mkdtempSync(path.join(tmpdir(),'hot-source-real-wire-'));writeFileSync(path.join(dir,'package.json'),'{"type":"commonjs"}');
for(const name of ['sqlite','telegram-relay-content','telegram-caption-watch-cycle', 'telegram-account'])writeFileSync(path.join(dir,name+'.js'),ts.transpileModule(readFileSync(new URL('../app/lib/'+name+'.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText);
mkdirSync(path.join(dir,'node_modules/teleproto/sessions'),{recursive:true});mkdirSync(path.join(dir,'node_modules/big-integer'),{recursive:true});
writeFileSync(path.join(dir,'node_modules/big-integer/index.js'),`module.exports=require(${JSON.stringify(require.resolve('big-integer'))});`);
writeFileSync(path.join(dir,'node_modules/teleproto/sessions/index.js'),`exports.StringSession=class{constructor(value){this.value=value;}save(){return this.value;}};`);
// Keep the real pinned SDK's classes and wire decoder. Only transport is replaced.
writeFileSync(path.join(dir,'node_modules/teleproto/index.js'),`
const actual=require(${JSON.stringify(actualPath)});exports.Api=actual.Api;exports.utils=actual.utils;exports.Logger=actual.Logger;
exports.state={messages:[],calls:[],entity:null};
exports.TelegramClient=class{constructor(session){this.session=session;}setLogLevel(){}async connect(){exports.state.calls.push('connect');}async disconnect(){}async destroy(){}
async getEntity(){exports.state.calls.push('getEntity');return exports.state.entity;}
iterMessages(peer,params){exports.state.calls.push('history');return {async *[Symbol.asyncIterator](){let rows=exports.state.messages.filter(m=>m.id>(params.minId||0)&&(!params.maxId||m.id<params.maxId));rows.sort((a,b)=>params.reverse?a.id-b.id:b.id-a.id);for(const m of rows.slice(0,params.limit))yield m;}};}
async downloadMedia(){throw Error('Metadata reader must never download a video');}async invoke(){throw Error('Metadata reader must never publish or edit a message');}};
`);
const {getSqlite}=require(path.join(dir,'sqlite.js')),{readHotVideoSourcePages,ensureTelegramAccountTables}=require(path.join(dir,'telegram-account.js'));
const sdk=require(path.join(dir,'node_modules/teleproto')),oldData=process.env.DATA_DIR,oldSecret=process.env.SESSION_SECRET;
const context='365freebonus:telegram-personal-account:v1',secret='private-wire-fixture-encryption-secret-at-least32',chat=-1001000000123,channelId=bigInt('1000000123'),revision='wire-source-revision';let db;
function seal(value){const iv=randomBytes(12),key=createHmac('sha256',secret).update(context).digest(),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(context));const bytes=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return ['v1',iv.toString('base64url'),bytes.toString('base64url'),cipher.getAuthTag().toString('base64url')].join('.')}
function wire(id,{ttl,mime='video/mp4',date=Math.floor(Date.now()/1000)-100,roundMessage,animated=false}={}){
 const doc=new Api.Document({id:bigInt(700000+id),accessHash:bigInt(33),fileReference:Buffer.from('fixture'),date,mimeType:mime,size:bigInt(1702*1024*1024),dcId:4,
  attributes:[new Api.DocumentAttributeVideo({duration:3*3600,w:1280,h:720,roundMessage}),...(animated?[new Api.DocumentAttributeAnimated()]:[])]});
 const m=new Api.Message({id,peerId:new Api.PeerChannel({channelId}),date,message:'',media:new Api.MessageMediaDocument({document:doc,...(ttl===undefined?{}:{ttlSeconds:ttl})})});
 const decoded=new BinaryReader(m.getBytes()).tgReadObject();assert.ok(decoded instanceof Api.Message);assert.ok(decoded.media instanceof Api.MessageMediaDocument);return decoded;
}
const input=()=>({chatId:chat,revision,beforeId:0,afterId:0,backfillDone:false,limit:50});
test.beforeEach(()=>{process.env.DATA_DIR=mkdtempSync(path.join(dir,'case-'));process.env.SESSION_SECRET=secret;db=getSqlite();ensureTelegramAccountTables(db);
 db.prepare("UPDATE telegram_personal_account SET generation='wire-account',stage='connected',config_ciphertext=?,session_ciphertext=? WHERE id='primary'").run(seal({apiId:123,apiHash:'a'.repeat(32)}),seal('fixture-private-session'));
 db.prepare("INSERT INTO telegram_personal_sources(chat_id,title,username,peer_ciphertext,joined,selected,last_message_id) VALUES(?,'Fixture source','',?,1,0,123)").run(chat,seal({id:channelId.toString(),accessHash:'33',protected:false}));
 db.prepare("INSERT INTO telegram_hot_video_sources(chat_id,title,selected,revision) VALUES(?,'Fixture source',1,?)").run(chat,revision);
 sdk.state.calls=[];sdk.state.messages=[];sdk.state.entity=new Api.Channel({id:channelId,accessHash:bigInt(33),broadcast:true,title:'Fixture source',photo:new Api.ChatPhotoEmpty(),date:Math.floor(Date.now()/1000)});
});
test.afterEach(()=>{const file=path.join(process.env.DATA_DIR,'directory.sqlite');globalThis.__directorySqlite?.get(file)?.close();globalThis.__directorySqlite?.delete(file)});
test.after(()=>{if(oldData===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=oldData;if(oldSecret===undefined)delete process.env.SESSION_SECRET;else process.env.SESSION_SECRET=oldSecret;rmSync(dir,{recursive:true,force:true})});
test('real TL-decoded normal MP4 has null absent TTL and remains eligible in the actual reader',async()=>{
 const a=wire(41),b=wire(42);assert.equal(a.media.ttlSeconds,null);assert.equal(typeof a.date,'number');assert.equal(a.media.document.attributes[0].roundMessage,false);
 sdk.state.messages=[a,b];const result=await readHotVideoSourcePages(db,input());assert.equal(result.state,'ok');assert.deepEqual(result.videos.map(v=>v.sourceMessageId),[42,41]);assert.deepEqual(result.videos.map(v=>v.bytes),[1702*1024*1024,1702*1024*1024]);
 assert.equal(result.inspection.absentTtlNull,2);assert.equal(result.inspection.eligibleVideos,2);assert.equal(result.inspection.invalidMetadata,0);assert.deepEqual(sdk.state.calls,['connect','getEntity','history']);
 assert.deepEqual({...db.prepare('SELECT selected,last_message_id FROM telegram_personal_sources').get()},{selected:0,last_message_id:123});assert.equal(db.prepare('SELECT COUNT(*) AS n FROM telegram_hot_video_jobs').get().n,0);
});
test('real wire TTL zero is non-ephemeral, positive TTL is rejected, and unsupported real wire videos stay excluded',async()=>{
 const zero=wire(41,{ttl:0}),ephemeral=wire(42,{ttl:30});assert.equal(zero.media.ttlSeconds,0);assert.equal(ephemeral.media.ttlSeconds,30);
 sdk.state.messages=[zero,ephemeral,wire(43,{mime:'video/webm'}),wire(44,{animated:true}),wire(45,{roundMessage:true})];
 const result=await readHotVideoSourcePages(db,input());assert.equal(result.state,'ok');assert.deepEqual(result.videos.map(v=>v.sourceMessageId),[41]);assert.equal(result.inspection.ephemeralVideos,1);assert.equal(result.inspection.unsupportedVideos,3);assert.equal(result.lastMessageId,45);
});
test('reader accepts a Date timestamp without multiplying milliseconds twice and rejects a future source time',async()=>{
 const normal=wire(41),future=wire(42);normal.date=new Date((Math.floor(Date.now()/1000)-100)*1000);future.date=new Date(Date.now()+60000);sdk.state.messages=[normal,future];
 const result=await readHotVideoSourcePages(db,input());assert.deepEqual(result.videos.map(v=>v.sourceMessageId),[41]);assert.equal(result.videos[0].createdAt,normal.date.getTime());assert.equal(result.inspection.dateObjects,2);assert.equal(result.inspection.invalidMetadata,1);
});
