import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

const fixture=mkdtempSync(path.join(tmpdir(),'telegram-relay-diagnostics-'));
writeFileSync(path.join(fixture,'package.json'),'{"type":"commonjs"}');
writeFileSync(path.join(fixture,'telegram-relay-diagnostics.js'),ts.transpileModule(
  readFileSync(new URL('../app/lib/telegram-relay-diagnostics.ts',import.meta.url),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}},
).outputText);
const require=createRequire(import.meta.url);
const {relayFormattingDiagnostics}=require(path.join(fixture,'telegram-relay-diagnostics.js'));
const now=1_800_000_000_000;
const privateMarker='PRIVATE_SOURCE_CONTENT_DO_NOT_LOG';
const custom=JSON.stringify([{type:'custom_emoji',offset:0,length:2,custom_emoji_id:'5280000000000000001'}]);
function database(){
  const db=new DatabaseSync(':memory:');
  db.exec(`PRAGMA user_version=21;CREATE TABLE telegram_relay_outbox(
    id INTEGER PRIMARY KEY,origin TEXT,status TEXT,caption_entities TEXT,last_error TEXT,queued_at INTEGER,sent_at INTEGER,
    caption TEXT,file_id TEXT,source_chat_id INTEGER,target_chat_id INTEGER,token TEXT);
  `);
  return db;
}
function add(db,{origin='bot',status='sent',entities=custom,error='',queued=now-1000,sent=now-500}={}){
  db.prepare(`INSERT INTO telegram_relay_outbox(origin,status,caption_entities,last_error,queued_at,sent_at,
    caption,file_id,source_chat_id,target_chat_id,token) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(origin,status,entities,error,queued,sent,privateMarker,privateMarker,-100999888,-100111222,privateMarker);
}
test.after(()=>rmSync(fixture,{recursive:true,force:true}));

test('diagnostics expose fixed aggregates only and never source content, IDs, credentials or raw errors',()=>{
  const db=database();
  try{
    add(db,{origin:'account'});
    add(db,{entities:'[]',error:privateMarker,queued:now-2000});
    add(db,{entities:JSON.stringify([{type:'private',text:privateMarker}]),queued:now-3000});
    const result=relayFormattingDiagnostics(db,now);
    assert.equal(result.sampledJobs,3);assert.equal(result.metadataRecorded,3);
    assert.equal(result.expectedCustomEmojiEntities,1);assert.equal(result.customEmojiJobs.sent,1);
    assert.equal(result.positiveCustomEmojiEntities,1);assert.equal(result.negativeCustomEmojiEntities,0);
    assert.deepEqual(result.origins,{bot:2,account:1,other:0});
    assert.equal(result.latestOutcome,'sent_preserved');
    const encoded=JSON.stringify(result);
    for(const value of [privateMarker,'5280000000000000001','-100999888','-100111222','custom_emoji_id','caption_entities','file_id','token'])assert.equal(encoded.includes(value),false,value);
  }finally{db.close();}
});

test('diagnostics distinguish recorded custom metadata, legacy records and invalid JSON without falling back to content',()=>{
  const db=database();
  try{
    add(db,{entities:''});add(db,{entities:'{'+privateMarker});add(db,{entities:'null'});add(db,{entities:'x'.repeat(140000)});
    const result=relayFormattingDiagnostics(db,now);
    assert.equal(result.metadataRecorded,0);assert.equal(result.legacyUnknown,1);assert.equal(result.invalidMetadata,3);
    assert.equal(result.expectedCustomEmojiEntities,0);assert.equal(result.latestOutcome,'invalid_metadata');
    assert.equal(JSON.stringify(result).includes(privateMarker),false);
  }finally{db.close();}
});

test('known outcomes are fixed enums and warning counts preserve the latest custom result',()=>{
  const db=database();
  try{
    add(db,{error:'Telegram 未保留部分原始自定义 Emoji '+privateMarker,queued:now-1000});
    add(db,{error:'Telegram 返回的文案与提交原文不一致 '+privateMarker,queued:now-2000});
    add(db,{status:'failed',error:'Telegram 拒绝发送含自定义 Emoji '+privateMarker,queued:now-3000,sent:null});
    add(db,{status:'failed',entities:'[]',error:'原文超过当前媒体文案长度限制 '+privateMarker,queued:now-4000,sent:null});
    const result=relayFormattingDiagnostics(db,now);
    assert.equal(result.missingCustomEmojiWarnings,1);assert.equal(result.captionChangedWarnings,1);
    assert.equal(result.customRejectedFailures,1);assert.equal(result.overlengthFailures,1);
    assert.equal(result.latestOutcome,'sent_without_custom_emoji');
    assert.equal(result.latestCustomQueuedAt,now-1000);assert.equal(result.latestCustomSentAt,now-500);
    assert.equal(JSON.stringify(result).includes(privateMarker),false);
  }finally{db.close();}
});

test('signed custom emoji IDs are reduced to counts and dropped source metadata remains visible',()=>{
  const db=database();
  try{
    add(db,{entities:JSON.stringify([
      {type:'custom_emoji',custom_emoji_id:'-9223372036854775808'},
      {type:'custom_emoji',custom_emoji_id:'9223372036854775807'},
      {type:'custom_emoji',custom_emoji_id:'9223372036854775808'},
      {type:'custom_emoji',custom_emoji_id:privateMarker},
    ]),queued:now-2000});
    add(db,{status:'failed',entities:'[]',error:'原始自定义 Emoji 资料未能完整保留 '+privateMarker,queued:now-1000,sent:null});
    const result=relayFormattingDiagnostics(db,now);
    assert.equal(result.expectedCustomEmojiEntities,4);
    assert.equal(result.positiveCustomEmojiEntities,1);assert.equal(result.negativeCustomEmojiEntities,1);
    assert.equal(result.invalidCustomEmojiEntities,2);assert.equal(result.droppedCustomEmojiFailures,1);
    assert.equal(result.latestOutcome,'source_custom_emoji_dropped');
    const json=JSON.stringify(result);
    for(const marker of [privateMarker,'-9223372036854775808','9223372036854775807','9223372036854775808'])assert.equal(json.includes(marker),false);
  }finally{db.close();}
});

test('diagnostic interval and 200-job cap exclude old, future and unsampled records',()=>{
  const db=database();
  try{
    for(let i=0;i<210;i++)add(db,{queued:now-1000-i,sent:now-500});
    add(db,{queued:now-100000000,error:'Telegram 未保留部分原始自定义 Emoji'});
    add(db,{queued:now+1000,error:'Telegram 未保留部分原始自定义 Emoji'});
    const result=relayFormattingDiagnostics(db,now);
    assert.equal(result.sampledJobs,200);assert.equal(result.expectedCustomEmojiEntities,200);
    assert.equal(result.missingCustomEmojiWarnings,0);assert.equal(result.sampleLimit,200);
    assert.equal(relayFormattingDiagnostics(db,now,now-1004).sampledJobs,5);
    assert.equal(relayFormattingDiagnostics(db,now,now).latestOutcome,'none');
    assert.throws(()=>relayFormattingDiagnostics(db,NaN),RangeError);
  }finally{db.close();}
});

test('every valid job status is counted and private unknown origins/statuses never become output labels',()=>{
  const db=database();
  try{
    for(const status of ['pending','sending','sent','failed','unknown','cancelled'])add(db,{status});
    add(db,{origin:privateMarker,status:privateMarker,queued:now-2000});
    const result=relayFormattingDiagnostics(db,now);
    assert.deepEqual(result.customEmojiJobs,{pending:1,sending:1,sent:1,failed:1,unknown:1,cancelled:1});
    assert.equal(result.origins.other,1);assert.equal(JSON.stringify(result).includes(privateMarker),false);
  }finally{db.close();}
});

test('a sent post with an unresolved edit warning is never reported as preserved',()=>{
  const db=database();
  try{
    add(db,{error:'个人账号备用补正当前不可用，请检查本人账号连接和编辑权限；原媒体不会重复发送。'});
    const result=relayFormattingDiagnostics(db,now);
    assert.equal(result.latestOutcome,'unclassified');
    assert.equal(result.customEmojiJobs.sent,1);
  }finally{db.close();}
});
