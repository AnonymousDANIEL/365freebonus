import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import ts from 'typescript';

const fixture = mkdtempSync(path.join(tmpdir(), 'telegram-relay-content-'));
writeFileSync(path.join(fixture, 'package.json'), '{"type":"commonjs"}');
for (const name of ['telegram-relay-content', 'telegram-bot']) {
  writeFileSync(path.join(fixture, `${name}.js`), ts.transpileModule(
    readFileSync(new URL(`../app/lib/${name}.ts`, import.meta.url), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } },
  ).outputText);
}
const require = createRequire(import.meta.url);
const { prepareRelayMessage, normalizeRelayCaptionEntities, inspectRelayDelivery, isRelayCustomEmojiId, relayKeyboard, RELAY_WEBSITE, RELAY_DEFAULT_TARGET } = require(path.join(fixture, 'telegram-relay-content.js'));
const transport = require(path.join(fixture, 'telegram-bot.js'));
const https = require('node:https');
const now = 1_800_000_000_123;
const context = { botId: 123456789, targetChatId: -1009876543210, startedAt: now };
const photo = (file = 'photo_large', unique = 'unique_photo', width = 1200) => ({ file_id: file, file_unique_id: unique, width, height: width, file_size: width * 10 });
function message(extra = {}) {
  return { message_id: 201, date: Math.floor(now / 1000), chat: { id: -1001111111111, type: 'supergroup' },
    from: { id: 701, is_bot: false }, photo: [photo()], caption: 'A useful brand introduction.\nVisit https://brand.example/join', ...extra };
}
const prepare = value => prepareRelayMessage(value, context);
test.after(() => rmSync(fixture, { recursive: true, force: true }));

// Inputs below model Telegram updates. No real bot credentials, network calls,
// group messages or production data are used.
test('relay buttons contain exactly the three owner destinations', () => {
  assert.equal(RELAY_DEFAULT_TARGET, '@join365freebonusgroup');
  assert.deepEqual(relayKeyboard(), [
    [{ text: '🌐 Visit website', url: 'https://365freebonus.com/' }],
    [{ text: '🎁 365 Free Bonus Official', url: 'https://t.me/join365freebonus' }],
    [{ text: '💬 NEED HELP?', url: 'https://t.me/FreeBonus365ChatBot' }],
  ]);
  const first = relayKeyboard(); first[0][0].url = 'https://invalid.example';
  assert.equal(relayKeyboard()[0][0].url, RELAY_WEBSITE, 'callers cannot mutate future keyboards');
});

test('date-time formats preserve the empty original-text format and reject invalid options', () => {
  for (const format of ['', 'r', 'wDT', 'dt']) {
    const entity = {type:'date_time',offset:0,length:4,unix_time:1800000000,date_time_format:format};
    assert.deepEqual(prepare(message({caption:'Date',caption_entities:[entity]})).captionEntities,[entity]);
  }
  assert.deepEqual(prepare(message({caption:'Date',caption_entities:[{type:'date_time',offset:0,length:4,unix_time:1800000000,date_time_format:'invalid'}]})).captionEntities,[]);
});

test('rewritten URL entities retain exact adjacent emoji and text spacing', () => {
  const oldUrl='https://old.example';
  const caption=`🥳${oldUrl}中文`;
  const result=prepare(message({caption,caption_entities:[
    {type:'custom_emoji',offset:0,length:2,custom_emoji_id:'1234567890123456789'},
    {type:'url',offset:2,length:oldUrl.length},
    {type:'bold',offset:2+oldUrl.length,length:2},
  ]}));
  assert.equal(result.caption,`🥳${RELAY_WEBSITE}中文`);
  assert.deepEqual(result.captionEntities,[
    {type:'custom_emoji',offset:0,length:2,custom_emoji_id:'1234567890123456789'},
    {type:'url',offset:2,length:RELAY_WEBSITE.length},
    {type:'bold',offset:2+RELAY_WEBSITE.length,length:2},
  ]);
});

test('a captioned group photo selects the largest image and keeps plain text, paragraphs and spoiler state', () => {
  const input = message({ photo: [photo('small_file', 'small_unique', 100), photo()], has_media_spoiler: true });
  const result = prepare(input);
  assert.equal(result.sourceChatId, input.chat.id);
  assert.equal(result.sourceMessageId, input.message_id);
  assert.equal(result.mediaKind, 'photo');
  assert.equal(result.fileId, 'photo_large');
  assert.equal(result.fileUniqueId, 'unique_photo');
  assert.equal(result.mediaGroupId, '');
  assert.equal(result.hasSpoiler, true);
  assert.equal(result.caption, `A useful brand introduction.\nVisit ${RELAY_WEBSITE}`);
  assert.equal(result.fingerprint.length, 64);
});

test('captioned GIF animations use their existing Telegram animation file ID', () => {
  const result = prepare(message({ photo: undefined, animation: { file_id: 'animation_file', file_unique_id: 'animation_unique', mime_type: 'video/mp4' }, caption: 'An animated promotion.' }));
  assert.equal(result.mediaKind, 'animation');
  assert.equal(result.fileId, 'animation_file');
  assert.equal(result.caption, 'An animated promotion.');
});

test('captioned videos keep media identity while replacing caption links and discarding source buttons', () => {
  const result = prepare(message({ photo: undefined, video: { file_id: 'video_file', file_unique_id: 'video_unique', mime_type: 'video/mp4' },
    caption: '🎬 Watch this https://old.example/offer', reply_markup: { inline_keyboard: [[{text:'Original link',url:'https://old.example/join'}]] } }));
  assert.equal(result.mediaKind, 'video');
  assert.equal(result.fileId, 'video_file');
  assert.equal(result.fileUniqueId, 'video_unique');
  assert.equal(result.caption, `🎬 Watch this ${RELAY_WEBSITE}`);
  assert.equal('reply_markup' in result, false);
  assert.equal(JSON.stringify(result).includes('old.example'), false);
});

test('GIF animation takes priority if Telegram also supplies a video representation', () => {
  const result = prepare(message({ photo: undefined, animation: {file_id:'animation_file',file_unique_id:'animation_unique'},
    video: {file_id:'video_file',file_unique_id:'video_unique'} }));
  assert.equal(result.mediaKind, 'animation');
  assert.equal(result.fileId, 'animation_file');
});

test('text-only, captionless media and image documents are never turned into text forwards', () => {
  for (const input of [
    message({ photo: undefined, text: 'A text announcement' }),
    message({ caption: undefined }), message({ caption: ' \n\t ' }),
    message({ photo: undefined, video: { file_id: 'video', file_unique_id: 'video_unique' }, caption: undefined }),
    message({ photo: undefined, video: { file_id: 'video', file_unique_id: 'video_unique' }, caption: ' \n ' }),
    message({ photo: undefined, animation: { file_id: 'gif', file_unique_id: 'gif_unique' }, caption: undefined }),
    message({ photo: undefined, document: { file_id: 'image_doc', file_unique_id: 'doc_unique', mime_type: 'image/png' } }),
    message({ paid_media: { star_count: 1 } }),
  ]) assert.equal(prepare(input), null);
});

test('only valid source groups and messages received since activation qualify', () => {
  for (const input of [
    message({ chat: { id: 701, type: 'private' } }),
    message({ chat: { id: context.targetChatId, type: 'supergroup' } }),
    message({ chat: { id: '-1001111111111', type: 'supergroup' } }),
    message({ message_id: 0 }), message({ message_id: 1.5 }),
    message({ date: Math.floor(now / 1000) - 1 }), message({ date: Number.MAX_SAFE_INTEGER }),
  ]) assert.equal(prepare(input), null);
  assert.ok(prepare(message()), 'Telegram second-resolution timestamps include the activation second');
  assert.ok(prepare(message({ chat: { id: -301, type: 'group' } })));
  assert.equal(prepareRelayMessage(message(), { ...context, botId: 0 }), null);
  assert.equal(prepareRelayMessage(message(), { ...context, targetChatId: 0 }), null);
  assert.equal(prepareRelayMessage(message(), { ...context, startedAt: NaN }), null);
});

test('protected source content is skipped instead of attempting a different copy mechanism', () => {
  assert.equal(prepare(message({ has_protected_content: true })), null);
  assert.equal(prepare(message({ chat: { id: -1001111111111, type: 'supergroup', has_protected_content: true } })), null);
});

test('own bot, via-bot, forwarded origin and destination-origin messages are excluded', () => {
  for (const extra of [
    { from: { id: context.botId, is_bot: true } }, { via_bot: { id: context.botId } },
    { sender_chat: { id: context.targetChatId } }, { forward_from: { id: context.botId } },
    { forward_from_chat: { id: context.targetChatId } },
    { forward_origin: { type: 'user', sender_user: { id: context.botId } } },
    { forward_origin: { type: 'channel', chat: { id: context.targetChatId } } },
    { forward_origin: { type: 'chat', sender_chat: { id: context.targetChatId } } },
  ]) assert.equal(prepare(message(extra)), null);
});

test('a different bot may supply an eligible source message when Telegram delivers it', () => {
  assert.ok(prepare(message({ from: { id: 456789123, is_bot: true } })));
});

test('canonical relay keyboards identify recirculated content even after another bot copies it', () => {
  assert.equal(prepare(message({ reply_markup: { inline_keyboard: relayKeyboard() } })), null);
  const buttons = relayKeyboard().reverse().map(row => row.map(button => ({ ...button, text: 'copied label', url: button.url.toLowerCase() + (button.url.endsWith('/') ? '' : '/') })));
  assert.equal(prepare(message({ reply_markup: { inline_keyboard: buttons } })), null);
  const result = prepare(message({ reply_markup: { inline_keyboard: [[{ text: 'Original join', url: 'https://brand.example/join' }], [{ text: 'callback', callback_data: 'original-action' }]] } }));
  assert.ok(result);
  assert.equal('reply_markup' in result, false, 'source buttons are never copied into the output');
});

test('hidden text links after emoji use Telegram UTF-16 entity offsets without corrupting the surrounding copy', () => {
  const caption = '🎁 Big offer\n\nTap JOIN to discover more ✨';
  const result = prepare(message({ caption, caption_entities: [{ type: 'text_link', offset: caption.indexOf('JOIN'), length: 4, url: 'https://hidden-original.example' }] }));
  assert.equal(result.caption, caption);
  assert.deepEqual(result.captionEntities,[{type:"text_link",offset:caption.indexOf("JOIN"),length:4,url:RELAY_WEBSITE}]);
  assert.equal(JSON.stringify(result).includes('hidden-original'), false);
  assert.equal('caption_entities' in result, false);
  assert.equal('parse_mode' in result, false);
});

test('visible contact links become the owner website and hidden user-link targets retain their labels', () => {
  const values = [
    ['url', 'brand.example/join'], ['mention', '@BrandAgent'], ['text_mention', 'Brand Agent'],
    ['email', 'hello@brand.example'], ['phone_number', '+60 123 456 789'],
  ];
  const caption = values.map(([, value]) => value).join('\n');
  const caption_entities = values.map(([type, value]) => ({ type, offset: caption.indexOf(value), length: value.length, user: { id: 999 } }));
  const result=prepare(message({caption,caption_entities}));
  assert.equal(result.caption, [RELAY_WEBSITE,RELAY_WEBSITE,'Brand Agent',RELAY_WEBSITE,RELAY_WEBSITE].join('\n'));
  assert.deepEqual(result.captionEntities.find(e=>e.type==='text_link'),{type:'text_link',offset:result.caption.indexOf('Brand Agent'),length:11,url:RELAY_WEBSITE});
});

test('literal web, Telegram, app and WhatsApp links are replaced while punctuation and ordinary copy remain', () => {
  const caption = 'Explore https://brand.example/join?code=123.\nContact t.me/oldgroup, telegram.me/oldchannel!\nAlso www.brand.example/path; wa.me/6012345678 and tg://resolve?domain=oldbot.\nKeep this paragraph.';
  const result = prepare(message({ caption }));
  assert.equal(result.caption, `Explore ${RELAY_WEBSITE}.\nContact ${RELAY_WEBSITE}, ${RELAY_WEBSITE}!\nAlso ${RELAY_WEBSITE}; ${RELAY_WEBSITE} and ${RELAY_WEBSITE}.\nKeep this paragraph.`);
  for (const fragment of ['brand.example', 'oldgroup', 'oldchannel', '6012345678', 'oldbot']) assert.equal(result.caption.includes(fragment), false);
});

test('clear bare contacts and additional URL schemes are rewritten with exact UTF-16 style offsets', () => {
  const addresses = ['brand.com/join?code=1', '//brand.net/path', 'ftp://brand.example/file', 'ftps://brand.example/file',
    'mailto:hello@brand.example', 'tel:+60123456789', 'hello@brand.example', '@BrandAgent'];
  const caption = `🎁 ${addresses.join(' | ')} ✨ END`;
  const result = prepare(message({ caption, caption_entities: [{type:'bold',offset:caption.indexOf('END'),length:3}] }));
  assert.equal(result.caption, `🎁 ${addresses.map(() => RELAY_WEBSITE).join(' | ')} ✨ END`);
  assert.deepEqual(result.captionEntities.find(entity => entity.type === 'bold'), {type:'bold',offset:result.caption.indexOf('END'),length:3});
  assert.equal(result.captionEntities.filter(entity => entity.type === 'url').length, addresses.length);
  assert.equal(result.caption.isWellFormed(), true);
});

test('ordinary sentences, decimals, filenames and custom artwork fallback are not interpreted as links', () => {
  const caption = 'e.g. Version 1.2.3 costs 50.00. Read file.md.\nbrand.com @BrandAgent https://logo.example';
  const offset = caption.indexOf('brand.com');
  const custom = {type:'custom_emoji',offset,length:caption.length-offset,custom_emoji_id:'-1234567890123456789'};
  const result = prepare(message({caption,caption_entities:[custom]}));
  assert.equal(result.caption, caption);
  assert.deepEqual(result.captionEntities, [custom]);
  assert.equal(result.customEmojiLost, false);
  const code = prepare(message({caption:'brand.com\n@BrandAgent',caption_entities:[{type:'pre',offset:0,length:21}]}));
  assert.equal(code.caption, 'brand.com\n@BrandAgent');
});

test('authoritative source link entities override fallback artwork protection', () => {
  const caption = 'brand.com';
  const result = prepare(message({caption,caption_entities:[
    {type:'custom_emoji',offset:0,length:caption.length,custom_emoji_id:'1234'},
    {type:'url',offset:0,length:caption.length},
  ]}));
  assert.equal(result.caption, RELAY_WEBSITE);
  assert.equal(result.customEmojiLost, true);
});

function delivery(caption, caption_entities = []) {
  return {caption, caption_entities, reply_markup:{inline_keyboard:relayKeyboard()}};
}

test('delivery inspection verifies exact caption, original custom artwork, safe links and fixed buttons', () => {
  const caption = `🎁 See ${RELAY_WEBSITE}`;
  const entities = [
    {type:'custom_emoji',offset:0,length:2,custom_emoji_id:'-9223372036854775808'},
    {type:'bold',offset:3,length:3},
    {type:'url',offset:7,length:RELAY_WEBSITE.length},
  ];
  assert.deepEqual(inspectRelayDelivery(caption, entities, delivery(caption, entities)), {
    captionMatches:true,customEmojiPreserved:true,linksSafe:true,buttonsMatch:true,
  });
  assert.equal(inspectRelayDelivery(caption, entities, delivery(` ${caption}`, entities)).captionMatches, false);
  assert.deepEqual(inspectRelayDelivery(caption, entities, null), {
    captionMatches:false,customEmojiPreserved:false,linksSafe:false,buttonsMatch:false,
  });
});

test('delivery custom artwork compares ID, position, length and multiplicity rather than counts alone', () => {
  const caption = '🟦🟦';
  const expected = [
    {type:'custom_emoji',offset:0,length:2,custom_emoji_id:'9007199254740993123'},
    {type:'custom_emoji',offset:2,length:2,custom_emoji_id:'-9007199254740993123'},
  ];
  assert.equal(inspectRelayDelivery(caption, expected, delivery(caption, expected.toReversed())).customEmojiPreserved, true);
  for (const actual of [[], [expected[0], expected[0]], [expected[0], {...expected[1],custom_emoji_id:'123'}],
    [{...expected[0],offset:2}, {...expected[1],offset:0}], [expected[0], {...expected[1],length:1}],
    [expected[0], {...expected[1],custom_emoji_id:'9223372036854775808'}], [...expected, expected[0]]]) {
    assert.equal(inspectRelayDelivery(caption, expected, delivery(caption, actual)).customEmojiPreserved, false);
  }
});

test('delivery inspection rejects foreign clickable entities and naked contacts even without metadata', () => {
  for (const [type, caption, fields] of [
    ['url','https://old.example',{}], ['text_link','JOIN',{url:'https://old.example'}],
    ['mention','@BrandAgent',{}], ['text_mention','Agent',{user:{id:123}}],
    ['email','hello@brand.example',{}], ['phone_number','+60123456789',{}],
  ]) assert.equal(inspectRelayDelivery(caption, [], delivery(caption, [{type,offset:0,length:caption.length,...fields}])).linksSafe, false);
  for (const caption of ['brand.com', '@BrandAgent', 'hello@brand.example', 'ftp://brand.example/file', 'mailto:hello@brand.example', 'tel:+60123456789']) {
    assert.equal(inspectRelayDelivery(caption, [], delivery(caption)).linksSafe, false, caption);
  }
  assert.equal(inspectRelayDelivery(RELAY_WEBSITE, [], delivery(RELAY_WEBSITE)).linksSafe, true);
  assert.equal(inspectRelayDelivery('ok', [], {...delivery('ok'),caption_entities:{}}).linksSafe, false);
  assert.equal(inspectRelayDelivery('ok', [], delivery('ok', [{type:'bold',offset:0,length:99}])).linksSafe, false);
});

test('delivery inspection preserves safe labels and does not mistake nonclickable logo fallback or code for links', () => {
  for (const entity of [
    {type:'text_link',offset:0,length:9,url:RELAY_WEBSITE},
    {type:'custom_emoji',offset:0,length:9,custom_emoji_id:'1234'},
    {type:'code',offset:0,length:9},
  ]) assert.equal(inspectRelayDelivery('brand.com', [entity], delivery('brand.com', [entity])).linksSafe, true);
  assert.equal(inspectRelayDelivery('brand.com', [], delivery('brand.com', [
    {type:'custom_emoji',offset:0,length:9,custom_emoji_id:'1234'},
    {type:'url',offset:0,length:9},
  ])).linksSafe, false, 'actual clickable metadata is never masked by fallback protection');
});

test('delivery buttons reject reordered, extra, missing or foreign-action buttons', () => {
  const variants = [relayKeyboard().reverse(), relayKeyboard().slice(0,2), [...relayKeyboard(),[{text:'extra',url:RELAY_WEBSITE}]],
    [[{...relayKeyboard()[0][0],callback_data:'foreign'}],...relayKeyboard().slice(1)],
    [[{...relayKeyboard()[0][0],url:'https://old.example'}],...relayKeyboard().slice(1)],
    [[{...relayKeyboard()[0][0],text:'Visit website'}],...relayKeyboard().slice(1)]];
  for (const inline_keyboard of variants) assert.equal(inspectRelayDelivery('ok', [], {...delivery('ok'),reply_markup:{inline_keyboard}}).buttonsMatch, false);
  assert.equal(inspectRelayDelivery('ok', [], {...delivery('ok'),reply_markup:{inline_keyboard:relayKeyboard(),remove_keyboard:true}}).buttonsMatch, false);
});

test('hidden links preserve Chinese copy exactly and only replace the destination', () => {
  const caption = '点击这里报名';
  const result = prepare(message({ caption, caption_entities: [{ type: 'text_link', offset: 2, length: 2, url: 'https://brand.example' }] }));
  assert.equal(result.caption, caption);
  assert.deepEqual(result.captionEntities,[{type:'text_link',offset:2,length:2,url:RELAY_WEBSITE}]);
});

test('invalid and overlapping entity offsets remain bounded and do not split emoji', () => {
  const caption = '🎁 JOIN https://brand.example';
  const result = prepare(message({ caption, caption_entities: [
    { type: 'text_link', offset: 1, length: 2, url: 'https://bad.example' },
    { type: 'url', offset: -1, length: 10 }, { type: 'url', offset: 0, length: Number.MAX_SAFE_INTEGER },
    { type: 'text_link', offset: caption.indexOf('JOIN'), length: 4, url: 'https://one.example' },
    { type: 'text_link', offset: caption.indexOf('JOIN') + 1, length: 3, url: 'https://two.example' },
  ] }));
  assert.equal(result.caption, `🎁 JOIN ${RELAY_WEBSITE}`);
  assert.equal(result.caption.isWellFormed(), true);
});

test('long captions stay within the media limit with whole emoji and no chopped owner URL', () => {
  const emoji = prepare(message({ caption: '🎁'.repeat(600) }));
  assert.ok(emoji.caption.length <= 1024);
  assert.ok(emoji.caption.endsWith('…'));
  assert.equal(emoji.caption.isWellFormed(), true);
  const caption = 'A'.repeat(1010) + ' https://long-original.example/some-path';
  const clipped = prepare(message({ caption }));
  assert.ok(clipped.caption.length <= 1024);
  assert.equal(clipped.caption.includes('https://'), false, 'a URL crossing the clip boundary is removed as a whole');
});

test('fingerprints identify equivalent reposts across groups and source file IDs', () => {
  const one = prepare(message({ caption: 'Explore https://one.example' }));
  const two = prepare(message({ message_id: 999, chat: { id: -1002222222222, type: 'group' }, photo: [photo('different_bot_file_id')], caption: 'Explore https://two.example' }));
  assert.equal(one.fingerprint, two.fingerprint);
  assert.notEqual(prepare(message({ caption: 'Another offer' })).fingerprint, one.fingerprint);
  assert.notEqual(prepare(message({ photo: [photo('other_file', 'other_unique')] })).fingerprint, one.fingerprint);
});

test('album identifiers and media file IDs remain validated opaque values', () => {
  assert.equal(prepare(message({ media_group_id: '12345' })).mediaGroupId, '12345');
  assert.equal(prepare(message({ media_group_id: 'invalid value' })), null);
  assert.equal(prepare(message({ photo: [{ file_id: 'https://host.example/file', file_unique_id: 'unique' }] })), null);
  assert.equal(prepare(message({ photo: [{ file_id: 'valid_file' }] })), null);
  assert.equal(prepare(message({ photo: [] })), null);
});

test('relay long polling stays separate while ChatBot also receives gate membership and discovery updates', async t => {
  const calls = [];
  t.mock.method(https, 'request', (options, callback) => {
    const response = new EventEmitter(); response.setEncoding = () => response;
    const outgoing = new EventEmitter();
    outgoing.end = body => {
      calls.push({ path: options.path, parameters: JSON.parse(body) });
      callback(response);
      queueMicrotask(() => { response.emit('data', JSON.stringify({ ok: true, result: [{ update_id: 10, message: {} }] })); response.emit('end'); });
    };
    return outgoing;
  });
  const relay = await transport.telegramRelayUpdates('fixture-promotion-token', 17);
  const chat = await transport.telegramUpdates('fixture-chat-token', 23);
  assert.equal(relay.ok, true); assert.equal(chat.ok, true);
  assert.deepEqual(calls[0].parameters, { offset: 17, timeout: 10, limit: 20, allowed_updates: ['message', 'channel_post', 'my_chat_member'] });
  assert.deepEqual(calls[1].parameters, { offset: 23, timeout: 10, limit: 10, allowed_updates: ['chat_member', 'message', 'callback_query', 'chat_join_request', 'my_chat_member', 'channel_post'] });
  assert.ok(calls[0].path.startsWith('/botfixture-promotion-token/'));
  assert.ok(calls[1].path.startsWith('/botfixture-chat-token/'));
});

test('gate moderation transport accepts only a confirmed true and preserves Telegram retry deadlines', async t => {
  let responseBody;
  const calls=[];
  t.mock.method(https,'request',(options,callback)=>{
    const response=new EventEmitter();response.setEncoding=()=>response;
    const outgoing=new EventEmitter();
    outgoing.end=body=>{
      calls.push({path:options.path,parameters:JSON.parse(body)});callback(response);
      queueMicrotask(()=>{response.emit('data',JSON.stringify(responseBody));response.emit('end');});
    };
    return outgoing;
  });
  for(const method of ['approveChatJoinRequest','declineChatJoinRequest','banChatMember','unbanChatMember']){
    responseBody={ok:true,result:true};
    assert.deepEqual(await transport.telegramBooleanRequest('fixture-chat-token',method,{chat_id:-100123,user_id:701}),{ok:true,result:true});
    assert.ok(calls.at(-1).path.endsWith('/'+method));
  }
  for(const result of [false,{},null,'true']){
    responseBody={ok:true,result};
    assert.equal(await transport.telegramBooleanRequest('fixture-chat-token','approveChatJoinRequest',{chat_id:-100123,user_id:701}),null);
  }
  responseBody={ok:false,error_code:429,parameters:{retry_after:120}};
  assert.deepEqual(await transport.telegramBooleanRequest('fixture-chat-token','banChatMember',{chat_id:-100123,user_id:701}),{ok:false,code:429,retryAfter:120});
  assert.equal(calls.length,9,'each moderation request is submitted once without a transport retry');
});

test('video multipart transport keeps caption and fixed owner buttons on the uploaded video', async t => {
  const calls = [];
  t.mock.method(https, 'request', (options, callback) => {
    const response = new EventEmitter(); response.setEncoding = () => response;
    const outgoing = new EventEmitter();
    outgoing.end = body => {
      calls.push({ options, body: body.toString('utf8') });
      callback(response);
      queueMicrotask(() => { response.emit('data', JSON.stringify({ ok: true, result: { message_id: 25 } })); response.emit('end'); });
    };
    return outgoing;
  });
  const reply = await transport.telegramRequest('fixture-promotion-token', 'sendVideo', {
    chat_id: context.targetChatId, caption: `Visit ${RELAY_WEBSITE}`, reply_markup: { inline_keyboard: relayKeyboard() },
  }, { field: 'video', fileName: 'video.mp4', mime: 'video/mp4', bytes: Buffer.from('sample-video') });
  assert.equal(reply.ok, true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].options.path.endsWith('/sendVideo'));
  assert.match(calls[0].body, /name="video"; filename="video.mp4"/);
  assert.match(calls[0].body, /Content-Type: video\/mp4/);
  assert.ok(calls[0].body.includes('sample-video'));
  assert.ok(calls[0].body.includes(JSON.stringify({ inline_keyboard: relayKeyboard() })));
  assert.ok(calls[0].body.includes(`Visit ${RELAY_WEBSITE}`));
});

test('caption correction sends the original custom entities and fixed buttons without uploading media or parse mode', async t => {
  const calls = [];
  const caption = `🟦 Visit ${RELAY_WEBSITE}`;
  const caption_entities = [{type:'custom_emoji',offset:0,length:2,custom_emoji_id:'-9007199254740993123'},
    {type:'url',offset:9,length:RELAY_WEBSITE.length}];
  t.mock.method(https, 'request', (options, callback) => {
    const response = new EventEmitter(); response.setEncoding = () => response;
    const outgoing = new EventEmitter();
    outgoing.end = body => {
      calls.push({options,parameters:JSON.parse(body)}); callback(response);
      queueMicrotask(() => { response.emit('data', JSON.stringify({ok:true,result:{message_id:25,...delivery(caption,caption_entities)}})); response.emit('end'); });
    };
    return outgoing;
  });
  const parameters = {chat_id:context.targetChatId,message_id:25,caption,caption_entities,reply_markup:{inline_keyboard:relayKeyboard()}};
  const reply = await transport.telegramRequest('fixture-promotion-token', 'editMessageCaption', parameters);
  assert.equal(reply.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.path, '/botfixture-promotion-token/editMessageCaption');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(calls[0].parameters, parameters);
  assert.equal('parse_mode' in calls[0].parameters, false);
  assert.equal(['photo','animation','video','media'].some(key => key in calls[0].parameters), false);
  assert.equal(inspectRelayDelivery(caption, caption_entities, reply.result).customEmojiPreserved, true);
});


test('custom emoji artwork and original caption whitespace survive without altering fallback Unicode', () => {
  const caption = ' \nFriday plans? 🥳\n⭐⭐⭐⭐\n➡FREE RM20 CASH\n🔗TEKAN LINK⬇️\n ';
  const party = caption.indexOf('🥳');
  const stars = caption.indexOf('⭐⭐⭐⭐');
  const arrow = caption.indexOf('➡');
  const cash = caption.indexOf('FREE RM20 CASH');
  const original = [
    { type:'custom_emoji', offset:party, length:2, custom_emoji_id:'5368324170671202286' },
    ...Array.from({length:4},(_,i)=>({ type:'custom_emoji', offset:stars+i, length:1, custom_emoji_id:String(5368324170671200000n+BigInt(i)) })),
    { type:'custom_emoji', offset:arrow, length:1, custom_emoji_id:'5368324170671202290' },
    { type:'bold', offset:cash, length:'FREE RM20 CASH'.length },
  ];
  const result = prepare(message({ caption, caption_entities:original }));
  assert.equal(result.caption, caption, 'no trim, emoji conversion or whitespace normalization is allowed');
  assert.deepEqual(result.captionEntities, original.toSorted((a,b)=>a.offset-b.offset||b.length-a.length));
  assert.equal(result.captionTruncated, false);
  assert.equal(result.customEmojiLost, false);
});

test('custom emoji IDs accept every canonical nonzero signed int64 boundary without Number conversion', () => {
  for (const id of ['1','-1','9007199254740993123','-9007199254740993123','9223372036854775807','-9223372036854775808']) {
    assert.equal(isRelayCustomEmojiId(id),true,id);
  }
  for (const id of ['0','-0','+1','01','-01','1.0','1e3',' 1','1 ','1\n','-1\r\n','9223372036854775808','-9223372036854775809','99999999999999999999',1,null,undefined]) {
    assert.equal(isRelayCustomEmojiId(id),false,String(id));
  }
});

test('negative custom emoji artwork IDs survive exact text and saved-entity normalization', () => {
  const caption='  🆎🆎50%!\n🟦🟦\n';
  const original=[
    {type:'custom_emoji',offset:2,length:2,custom_emoji_id:'-9223372036854775808'},
    {type:'custom_emoji',offset:4,length:2,custom_emoji_id:'-9007199254740993123'},
    {type:'custom_emoji',offset:caption.indexOf('🟦'),length:2,custom_emoji_id:'-1234567890123456789'},
    {type:'custom_emoji',offset:caption.lastIndexOf('🟦'),length:2,custom_emoji_id:'9223372036854775807'},
  ];
  const result=prepare(message({caption,caption_entities:original}));
  assert.equal(result.caption,caption);
  assert.deepEqual(result.captionEntities,original);
  assert.equal(result.customEmojiLost,false);
  assert.deepEqual(normalizeRelayCaptionEntities(caption,result.captionEntities),original);
});

test('invalid or discarded original custom emoji is explicitly marked as lost', () => {
  const caption='🆎🟦';
  for (const invalid of [
    {type:'custom_emoji',offset:0,length:2,custom_emoji_id:'0'},
    {type:'custom_emoji',offset:0,length:2,custom_emoji_id:'9223372036854775808'},
    {type:'custom_emoji',offset:1,length:1,custom_emoji_id:'-12'},
  ]) {
    const result=prepare(message({caption,caption_entities:[invalid]}));
    assert.equal(result.caption,caption);
    assert.equal(result.customEmojiLost,true);
    assert.deepEqual(result.captionEntities,[]);
  }
});

test('rewritten links shift later custom emoji and formatting in UTF-16 coordinates', () => {
  const caption='🌟 https://an-old-brand.example/join\n➡ New offer';
  const result=prepare(message({caption,caption_entities:[
    {type:'custom_emoji',offset:0,length:2,custom_emoji_id:'5368324170671202286'},
    {type:'custom_emoji',offset:caption.indexOf('➡'),length:1,custom_emoji_id:'5368324170671202287'},
    {type:'bold',offset:caption.indexOf('New offer'),length:9},
  ]}));
  assert.equal(result.caption,`🌟 ${RELAY_WEBSITE}\n➡ New offer`);
  assert.deepEqual(result.captionEntities.find(e=>e.type==='custom_emoji'&&e.offset>0),
    {type:'custom_emoji',offset:result.caption.indexOf('➡'),length:1,custom_emoji_id:'5368324170671202287'});
  assert.deepEqual(result.captionEntities.find(e=>e.type==='bold'),{type:'bold',offset:result.caption.indexOf('New offer'),length:9});
  assert.deepEqual(result.captionEntities.find(e=>e.type==='url'),{type:'url',offset:3,length:RELAY_WEBSITE.length});
});

test('formatting, quote and code metadata are preserved without accepting invalid crossings', () => {
  const caption='🔥 ABCDE\nquoted ⭐\nconst x = 1';
  const quote=caption.indexOf('quoted');const code=caption.indexOf('const');
  const result=prepare(message({caption,caption_entities:[
    {type:'custom_emoji',offset:0,length:2,custom_emoji_id:'5368324170671202286'},
    {type:'custom_emoji',offset:1,length:1,custom_emoji_id:'5368324170671202287'},
    {type:'bold',offset:3,length:4}, {type:'italic',offset:4,length:4},
    {type:'blockquote',offset:quote,length:8},
    {type:'custom_emoji',offset:caption.indexOf('⭐'),length:1,custom_emoji_id:'5368324170671202288'},
    {type:'pre',offset:code,length:11,language:'javascript'},
  ]}));
  assert.equal(result.caption,caption);
  assert.equal(result.captionEntities.some(e=>e.type==='italic'),false,'partial crossings are rejected');
  assert.equal(result.captionEntities.filter(e=>e.type==='custom_emoji').length,2);
  assert.deepEqual(result.captionEntities.find(e=>e.type==='pre'),{type:'pre',offset:code,length:11,language:'javascript'});
});

test('date-time entities preserve supported metadata while invalid IDs and unknown fields do not reach delivery',()=>{
  const caption='Today ⭐ and 🥳';
  const result=prepare(message({caption,caption_entities:[
    {type:'date_time',offset:0,length:5,unix_time:1800000000,date_time_format:'r'},
    {type:'custom_emoji',offset:caption.indexOf('⭐'),length:1,custom_emoji_id:'not-an-id'},
    {type:'custom_emoji',offset:caption.indexOf('🥳'),length:2,custom_emoji_id:'5368324170671202286',private:'discard'},
  ]}));
  assert.deepEqual(result.captionEntities,[
    {type:'date_time',offset:0,length:5,unix_time:1800000000,date_time_format:'r'},
    {type:'custom_emoji',offset:caption.indexOf('🥳'),length:2,custom_emoji_id:'5368324170671202286'},
  ]);
});

test('caption clipping flags the loss and never leaves half a custom emoji or entity',()=>{
  const caption='A'.repeat(1022)+'🥳More text';
  const result=prepare(message({caption,caption_entities:[
    {type:'custom_emoji',offset:1022,length:2,custom_emoji_id:'5368324170671202286'},
    {type:'bold',offset:1000,length:caption.length-1000},
  ]}));
  assert.equal(result.captionTruncated,true);
  assert.equal(result.caption,'A'.repeat(1022)+'…');
  assert.equal(result.caption.isWellFormed(),true);
  assert.deepEqual(result.captionEntities,[]);
});

test('saved-caption validator accepts only original styles, custom emoji IDs and owner URL entities',()=>{
  const caption=`🥳 ${RELAY_WEBSITE}`;
  const entities=[
    {type:'custom_emoji',offset:0,length:2,custom_emoji_id:'5368324170671202286'},
    {type:'url',offset:3,length:RELAY_WEBSITE.length},
  ];
  assert.deepEqual(normalizeRelayCaptionEntities(caption,entities),entities);
  assert.deepEqual(normalizeRelayCaptionEntities(caption,[...entities,
    {type:'text_link',offset:0,length:2,url:'https://foreign.example'},
    {type:'custom_emoji',offset:0,length:2,custom_emoji_id:'bad'},
    {type:'unknown',offset:0,length:2},
  ]),entities);
  assert.deepEqual(normalizeRelayCaptionEntities('https://foreign.example',[{type:'url',offset:0,length:23}]),[]);
});


test('hidden link labels retain formatting and logo emoji while external targets are removed',()=>{
  const caption='Before JOIN after 🥳';
  const join=caption.indexOf('JOIN');
  const result=prepare(message({caption,caption_entities:[
    {type:'bold',offset:0,length:caption.length},
    {type:'text_link',offset:join,length:4,url:'https://old.example'},
    {type:'custom_emoji',offset:caption.indexOf('🥳'),length:2,custom_emoji_id:'5368324170671202286'},
  ]}));
  assert.equal(result.caption,caption);
  assert.deepEqual(result.captionEntities.find(e=>e.type==='bold'),{type:'bold',offset:0,length:caption.length});
  assert.deepEqual(result.captionEntities.find(e=>e.type==='text_link'),{type:'text_link',offset:join,length:4,url:RELAY_WEBSITE});
  assert.equal(result.captionEntities.find(e=>e.type==='custom_emoji').custom_emoji_id,'5368324170671202286');
  assert.equal(JSON.stringify(result).includes('old.example'),false);
});

test('custom emoji retains its artwork when source link nesting conflicts with Bot API nesting',()=>{
  const caption='⭐⭐⭐⭐';
  const result=prepare(message({caption,caption_entities:[
    {type:'text_link',offset:0,length:4,url:'https://old.example'},
    ...Array.from({length:4},(_,i)=>({type:'custom_emoji',offset:i,length:1,custom_emoji_id:String(5368324170671200000n+BigInt(i))})),
  ]}));
  assert.equal(result.caption,caption);
  assert.equal(result.captionEntities.filter(e=>e.type==='custom_emoji').length,4);
  assert.equal(JSON.stringify(result).includes('old.example'),false);
});


test('literal URL fallback never consumes an adjacent ordinary or custom emoji',()=>{
  const caption='https://first.example🥳https://second.example🇲🇾➡Done';
  const party=caption.indexOf('🥳');
  const result=prepare(message({caption,caption_entities:[{type:'custom_emoji',offset:party,length:2,custom_emoji_id:'5368324170671202286'}]}));
  assert.equal(result.caption,`${RELAY_WEBSITE}🥳${RELAY_WEBSITE}🇲🇾➡Done`);
  assert.deepEqual(result.captionEntities.find(e=>e.type==='custom_emoji'),{type:'custom_emoji',offset:RELAY_WEBSITE.length,length:2,custom_emoji_id:'5368324170671202286'});
});
