import test from 'node:test';
import assert from 'node:assert/strict';
import bigInt from 'big-integer';
import { Api } from 'teleproto';
import { BinaryReader } from 'teleproto/extensions/BinaryReader';

// Exercise the pinned SDK's real TL serializer and decoder, not constructor-only
// mocks. These metadata-only fixtures never connect to Telegram or hold content.
const seconds=1794744000,channelId=bigInt(1234567890);
function message({ttlSeconds,protectedMessage=false,round=false,animated=false,date=seconds}={}){
 return new Api.Message({id:17,peerId:new Api.PeerChannel({channelId}),date,message:'',noforwards:protectedMessage,
  media:new Api.MessageMediaDocument({ttlSeconds,document:new Api.Document({id:bigInt(7001),accessHash:bigInt(8001),
   fileReference:Buffer.from([1,2,3]),date,mimeType:'video/mp4',size:bigInt(1702*1024*1024),dcId:4,
   attributes:[new Api.DocumentAttributeVideo({duration:20,w:1280,h:720,roundMessage:round,supportsStreaming:true}),
    ...(animated?[new Api.DocumentAttributeAnimated()]:[])]})})});
}
const wire=value=>new BinaryReader(value.getBytes()).tgReadObject();

test('ordinary video TTL omission becomes null on real SDK wire decoding',()=>{
 const constructed=message(),decoded=wire(constructed);
 assert.equal(constructed.media.ttlSeconds,undefined);
 assert.ok(decoded instanceof Api.Message);assert.ok(decoded.media instanceof Api.MessageMediaDocument);
 assert.equal(decoded.media.ttlSeconds,null);
 // Presence guards must accommodate both constructor and decoder absence.
 assert.equal(constructed.media.ttlSeconds!=null,false);assert.equal(decoded.media.ttlSeconds!=null,false);
});
test('actual decoded message dates are Unix seconds and map once to milliseconds',()=>{
 const decoded=wire(message());assert.equal(typeof decoded.date,'number');assert.equal(decoded.date,seconds);
 assert.equal(Number(decoded.date)*1000,1794744000000);assert.equal(decoded.date instanceof Date,false);
});
test('decoded document/video metadata preserves class identity, dimensions and large byte size',()=>{
 const decoded=wire(message()),document=decoded.media.document,attribute=document.attributes.find(value=>value instanceof Api.DocumentAttributeVideo);
 assert.ok(document instanceof Api.Document);assert.equal(document.mimeType,'video/mp4');assert.equal(document.size.toString(),String(1702*1024*1024));
 assert.equal(attribute.w,1280);assert.equal(attribute.h,720);assert.equal(attribute.duration,20);assert.equal(attribute.roundMessage,false);assert.equal(attribute.supportsStreaming,true);
 assert.equal(document.attributes.some(value=>value instanceof Api.DocumentAttributeAnimated),false);assert.equal(decoded.noforwards,false);
});
for(const ttlSeconds of [0,30])test('explicit TTL '+ttlSeconds+' remains distinguishable from absent TTL after decoding',()=>{
 const decoded=wire(message({ttlSeconds}));assert.equal(decoded.media.ttlSeconds,ttlSeconds);assert.equal(decoded.media.ttlSeconds!=null,true);
});
test('protected and nonordinary video flags survive real SDK decoding',()=>{
 assert.equal(wire(message({protectedMessage:true})).noforwards,true);
 const round=wire(message({round:true})).media.document.attributes.find(value=>value instanceof Api.DocumentAttributeVideo);assert.equal(round.roundMessage,true);
 assert.equal(wire(message({animated:true})).media.document.attributes.some(value=>value instanceof Api.DocumentAttributeAnimated),true);
});
test('channel-message response decoding also yields absent TTL as null with ordinary Message instances',()=>{
 const response=new Api.messages.ChannelMessages({pts:25,count:1,messages:[message()],topics:[],chats:[],users:[]});
 const decoded=wire(response);assert.ok(decoded instanceof Api.messages.ChannelMessages);assert.equal(decoded.messages.length,1);
 assert.ok(decoded.messages[0] instanceof Api.Message);assert.equal(decoded.messages[0].media.ttlSeconds,null);assert.equal(decoded.messages[0].date,seconds);
});
