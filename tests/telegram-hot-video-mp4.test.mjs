import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,writeFileSync,rmSync,openSync,closeSync,writeSync,ftruncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
const dir=mkdtempSync(path.join(tmpdir(),'hot-mp4-metadata-'));
writeFileSync(path.join(dir,'package.json'),'{"type":"commonjs"}');
writeFileSync(path.join(dir,'metadata.js'),ts.transpileModule(readFileSync(new URL('../app/lib/telegram-hot-video-mp4.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText);
const {readHotVideoMetadata}=createRequire(import.meta.url)(path.join(dir,'metadata.js'));
test.after(()=>rmSync(dir,{recursive:true,force:true}));
const box=(type,body=Buffer.alloc(0))=>{const b=Buffer.alloc(body.length+8);b.writeUInt32BE(b.length);b.write(type,4);body.copy(b,8);return b};
const ftyp=box('ftyp',Buffer.from('isom0000isommp42'));
function moov({version=0,handler='vide',scale=1000,width=1920,height=1080,seconds=6.25,track=true}={}){
 const time=Buffer.alloc(version===1?36:24);time[0]=version;const base=version===1?20:12;time.writeUInt32BE(scale,base);if(version===1)time.writeBigUInt64BE(BigInt(Math.round(seconds*scale)),base+4);else time.writeUInt32BE(Math.round(seconds*scale),base+4);
 const header=Buffer.alloc(version===1?96:84);header[0]=version;header.writeUInt32BE(width*65536,header.length-8);header.writeUInt32BE(height*65536,header.length-4);
 const hdlr=Buffer.alloc(16);hdlr.write(handler,8);
 return box('moov',Buffer.concat([box('mvhd',time),...(track?[box('trak',Buffer.concat([box('tkhd',header),box('mdia',Buffer.concat([box('hdlr',hdlr),box('mdhd',time)]))]))]:[])]));
}
async function parse(buffer){const filename=path.join(dir,'case.mp4');writeFileSync(filename,buffer,{mode:0o600});return readHotVideoMetadata(filename,buffer.length);}
for(const version of [0,1])test('bounded MP4 metadata extracts video width, height, fractional duration and faststart for version '+version,async()=>{
 const result=await parse(Buffer.concat([ftyp,moov({version}),box('mdat',Buffer.alloc(16))]));assert.deepEqual(result,{width:1920,height:1080,duration:6.25,supportsStreaming:true});
});
test('metadata at the end remains a video but does not falsely claim progressive streaming',async()=>{assert.equal((await parse(Buffer.concat([ftyp,box('mdat',Buffer.alloc(16)),moov()]))).supportsStreaming,false)});
test('large media payload is skipped by position with no full-video read or rewriting',async()=>{
 const file=path.join(dir,'sparse.mp4'),fd=openSync(file,'w',0o600),payload=512*1024*1024,meta=moov();
 try{writeSync(fd,ftyp);const h=Buffer.alloc(8);h.writeUInt32BE(payload);h.write('mdat',4);writeSync(fd,h);ftruncateSync(fd,ftyp.length+payload+meta.length);writeSync(fd,meta,0,meta.length,ftyp.length+payload)}finally{closeSync(fd)}
 assert.deepEqual(await readHotVideoMetadata(file,ftyp.length+payload+meta.length),{width:1920,height:1080,duration:6.25,supportsStreaming:false});
});
for(const [name,buffer] of [
 ['audio-only',Buffer.concat([ftyp,moov({handler:'soun'}),box('mdat',Buffer.alloc(16))])],
 ['missing track',Buffer.concat([ftyp,moov({track:false}),box('mdat',Buffer.alloc(16))])],
 ['zero timescale',Buffer.concat([ftyp,moov({scale:0}),box('mdat',Buffer.alloc(16))])],
 ['zero video width',Buffer.concat([ftyp,moov({width:0}),box('mdat',Buffer.alloc(16))])],
 ['missing movie',Buffer.concat([ftyp,box('mdat',Buffer.alloc(16))])],
 ['not MP4',Buffer.alloc(32)],
 ['truncated box',Buffer.concat([ftyp,moov().subarray(0,24)])],
 ['missing media payload',Buffer.concat([ftyp,moov()])],
])test('rejects '+name+' before video submission',async()=>{await assert.rejects(parse(buffer),/MP4/)});
test('rejects oversized movie metadata without allocating the declared payload',async()=>{
 const h=Buffer.alloc(8);h.writeUInt32BE(17*1024*1024);h.write('moov',4);
 const file=path.join(dir,'metadata-too-big.mp4'),fd=openSync(file,'w');try{writeSync(fd,ftyp);writeSync(fd,h);ftruncateSync(fd,ftyp.length+17*1024*1024)}finally{closeSync(fd)}
 await assert.rejects(readHotVideoMetadata(file,ftyp.length+17*1024*1024),/MP4/);
});
