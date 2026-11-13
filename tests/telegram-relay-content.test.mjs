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
const { prepareRelayMessage, relayKeyboard, RELAY_WEBSITE, RELAY_DEFAULT_TARGET } = require(path.join(fixture, 'telegram-relay-content.js'));
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
  assert.equal(result.caption, `🎁 Big offer\n\nTap ${RELAY_WEBSITE} to discover more ✨`);
  assert.equal(JSON.stringify(result).includes('hidden-original'), false);
  assert.equal('caption_entities' in result, false);
  assert.equal('parse_mode' in result, false);
});

test('bare-domain, mention, user-link, email and phone entities all become the owner website', () => {
  const values = [
    ['url', 'brand.example/join'], ['mention', '@BrandAgent'], ['text_mention', 'Brand Agent'],
    ['email', 'hello@brand.example'], ['phone_number', '+60 123 456 789'],
  ];
  const caption = values.map(([, value]) => value).join('\n');
  const caption_entities = values.map(([type, value]) => ({ type, offset: caption.indexOf(value), length: value.length, user: { id: 999 } }));
  assert.equal(prepare(message({ caption, caption_entities })).caption, values.map(() => RELAY_WEBSITE).join('\n'));
});

test('literal web, Telegram, app and WhatsApp links are replaced while punctuation and ordinary copy remain', () => {
  const caption = 'Explore https://brand.example/join?code=123.\nContact t.me/oldgroup, telegram.me/oldchannel!\nAlso www.brand.example/path; wa.me/6012345678 and tg://resolve?domain=oldbot.\nKeep this paragraph.';
  const result = prepare(message({ caption }));
  assert.equal(result.caption, `Explore ${RELAY_WEBSITE}.\nContact ${RELAY_WEBSITE}, ${RELAY_WEBSITE}!\nAlso ${RELAY_WEBSITE}; ${RELAY_WEBSITE} and ${RELAY_WEBSITE}.\nKeep this paragraph.`);
  for (const fragment of ['brand.example', 'oldgroup', 'oldchannel', '6012345678', 'oldbot']) assert.equal(result.caption.includes(fragment), false);
});

test('entity-linked words next to Chinese copy do not eat adjacent words or make a different destination URL', () => {
  const caption = '点击这里报名';
  const result = prepare(message({ caption, caption_entities: [{ type: 'text_link', offset: 2, length: 2, url: 'https://brand.example' }] }));
  assert.equal(result.caption, `点击 ${RELAY_WEBSITE} 报名`);
});

test('invalid and overlapping entity offsets remain bounded and do not split emoji', () => {
  const caption = '🎁 JOIN https://brand.example';
  const result = prepare(message({ caption, caption_entities: [
    { type: 'text_link', offset: 1, length: 2, url: 'https://bad.example' },
    { type: 'url', offset: -1, length: 10 }, { type: 'url', offset: 0, length: Number.MAX_SAFE_INTEGER },
    { type: 'text_link', offset: caption.indexOf('JOIN'), length: 4, url: 'https://one.example' },
    { type: 'text_link', offset: caption.indexOf('JOIN') + 1, length: 3, url: 'https://two.example' },
  ] }));
  assert.equal(result.caption, `🎁 ${RELAY_WEBSITE} ${RELAY_WEBSITE}`);
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

test('relay long polling uses a separate allowed-update stream and keeps the ChatBot stream unchanged', async t => {
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
  assert.deepEqual(calls[1].parameters, { offset: 23, timeout: 10, limit: 10, allowed_updates: ['chat_member', 'message', 'callback_query'] });
  assert.ok(calls[0].path.startsWith('/botfixture-promotion-token/'));
  assert.ok(calls[1].path.startsWith('/botfixture-chat-token/'));
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
