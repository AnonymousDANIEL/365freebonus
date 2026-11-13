import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import sharp from 'sharp';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const fixture = mkdtempSync(path.join(tmpdir(), 'telegram-relay-media-'));
writeFileSync(path.join(fixture, 'package.json'), '{"type":"commonjs"}');
writeFileSync(path.join(fixture, 'telegram-bot.js'), `
exports.calls=[]; exports.metadata=null;
exports.telegramRequest=async(token,method,parameters)=>{exports.calls.push({method,parameters});return exports.metadata;};
`);
writeFileSync(path.join(fixture, 'telegram-relay-media.js'), ts.transpileModule(
  readFileSync(new URL('../app/lib/telegram-relay-media.ts', import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } },
).outputText.replace('require("sharp")', `require(${JSON.stringify(require.resolve('sharp'))})`));
const media = require(path.join(fixture, 'telegram-relay-media.js'));
const telegram = require(path.join(fixture, 'telegram-bot.js'));
const https = require('node:https');
const token = '12345678:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
test.after(() => rmSync(fixture, { recursive: true, force: true }));
test.beforeEach(() => { telegram.calls.length = 0; telegram.metadata = null; });

function fakeDownload(t, { body = [Buffer.from('sample')], status = 200, headers = {}, abort = false } = {}) {
  const calls = [];
  t.mock.method(https, 'request', (options, callback) => {
    calls.push(options);
    const request = new EventEmitter();
    request.end = () => {
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = status; response.headers = headers;
        let destroyed = false;
        response.destroy = () => { destroyed = true; response.emit('close'); };
        callback(response);
        if (destroyed) return;
        for (const bytes of body) { response.emit('data', bytes); if (destroyed) return; }
        if (abort) response.emit('aborted'); else response.emit('end');
        response.emit('close');
      });
    };
    return request;
  });
  return calls;
}

test('media hashes are independent of filenames, captions, and Telegram source identifiers', async () => {
  const bytes = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#3579bb' } }).png().toBuffer();
  const a = await media.relayMediaIdentity(bytes, 'photo');
  const b = await media.relayMediaIdentity(Buffer.from(bytes), 'photo');
  assert.deepEqual(a, b);
  assert.match(a.contentHash, /^[a-f0-9]{64}$/);
  assert.match(a.visualHash, /^[a-f0-9]{64}$/);
});

test('visually identical PNG containers with different metadata share a visual hash', async () => {
  const bytes = await sharp({ create: { width: 91, height: 70, channels: 3, background: '#e67342' } }).png().toBuffer();
  const withMetadata = await sharp(bytes).withMetadata({ density: 150 }).png().toBuffer();
  const a = await media.relayMediaIdentity(bytes, 'photo');
  const b = await media.relayMediaIdentity(withMetadata, 'photo');
  assert.notEqual(a.contentHash, b.contentHash);
  assert.equal(a.visualHash, b.visualHash);
});

test('different image content and aspect ratios remain distinct', async () => {
  const image = async (width, height, color) => sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
  const ids = await Promise.all([
    image(80, 60, '#3579bb'), image(80, 60, '#3579bc'), image(60, 80, '#3579bb'),
  ].map(async bytes => media.relayMediaIdentity(await bytes, 'photo')));
  assert.equal(new Set(ids.map(id => id.visualHash)).size, 3);
});

test('animation identity hashes the whole file instead of only its first frame', async () => {
  const a = await media.relayMediaIdentity(Buffer.from('animation first and second frames'), 'animation');
  const b = await media.relayMediaIdentity(Buffer.from('animation first and third frames'), 'animation');
  assert.equal(a.visualHash, ''); assert.equal(b.visualHash, '');
  assert.notEqual(a.contentHash, b.contentHash);
  const unsupportedPhoto = await media.relayMediaIdentity(Buffer.from('not locally decodable'), 'photo');
  assert.equal(unsupportedPhoto.visualHash, '');
  await assert.rejects(media.relayMediaIdentity(Buffer.alloc(0), 'photo'), RangeError);
});

test('video identity hashes the full file and has a separate upload size cap', async () => {
  const first = await media.relayMediaIdentity(Buffer.from('video first and second frames'), 'video');
  const second = await media.relayMediaIdentity(Buffer.from('video first and third frames'), 'video');
  assert.equal(first.visualHash, '');
  assert.equal(second.visualHash, '');
  assert.notEqual(first.contentHash, second.contentHash);
  assert.equal(media.relayMediaMaxBytes('video'), 50 * 1024 * 1024);
  assert.equal(media.relayMediaMaxBytes('photo'), 10 * 1024 * 1024);
  assert.equal(media.relayMediaMaxBytes('animation'), 20 * 1024 * 1024);
});

test('Bot media download fixes the Telegram host and returns only bounded successful bytes', async t => {
  telegram.metadata = { ok: true, result: { file_path: 'photos/file_12.jpg', file_size: 6 } };
  const calls = fakeDownload(t, { body: [Buffer.from('sam'), Buffer.from('ple')], headers: { 'content-length': '6' } });
  const bytes = await media.downloadBotRelayMedia(token, 'opaque_file-id', 'photo');
  assert.equal(bytes.toString(), 'sample');
  assert.deepEqual(telegram.calls, [{ method: 'getFile', parameters: { file_id: 'opaque_file-id' } }]);
  assert.equal(calls.length, 1); assert.equal(calls[0].hostname, 'api.telegram.org');
  assert.equal(calls[0].path, `/file/bot${token}/photos/file_12.jpg`);
});

test('external, traversal, encoded and malformed Bot file paths never reach download transport', async t => {
  const calls = fakeDownload(t);
  for (const file_path of ['https://bad.example/file', '../file.jpg', '/file.jpg', 'photos/../file.jpg', 'photos/%2e%2e/file.jpg', 'photos//file.jpg', 'photos/file.jpg?secret=1', 'photos\\file.jpg']) {
    telegram.metadata = { ok: true, result: { file_path } };
    assert.equal(await media.downloadBotRelayMedia(token, 'file-id', 'photo'), null);
  }
  assert.equal(await media.downloadBotRelayMedia('invalid/token', 'file-id', 'photo'), null);
  assert.equal(await media.downloadBotRelayMedia(token, '../id', 'photo'), null);
  assert.equal(calls.length, 0);
});

test('oversized Bot metadata is rejected before requesting file bytes', async t => {
  const calls = fakeDownload(t);
  telegram.metadata = { ok: true, result: { file_path: 'photos/file.jpg', file_size: media.RELAY_PHOTO_MAX_BYTES + 1 } };
  assert.equal(await media.downloadBotRelayMedia(token, 'file-id', 'photo'), null);
  telegram.metadata = { ok: true, result: { file_path: 'animations/file.mp4', file_size: media.RELAY_ANIMATION_MAX_BYTES + 1 } };
  assert.equal(await media.downloadBotRelayMedia(token, 'file-id', 'animation'), null);
  telegram.metadata = { ok: true, result: { file_path: 'videos/file.mp4', file_size: 20 * 1024 * 1024 + 1 } };
  assert.equal(await media.downloadBotRelayMedia(token, 'file-id', 'video'), null, 'video uploads may be larger but public Bot downloads remain capped');
  assert.equal(calls.length, 0);
});

test('a bounded Bot video can be downloaded for content identity without using a thumbnail', async t => {
  telegram.metadata = { ok: true, result: { file_path: 'videos/file_12.mp4', file_size: 6 } };
  fakeDownload(t, { body: [Buffer.from('sample')] });
  const bytes = await media.downloadBotRelayMedia(token, 'video-id', 'video');
  assert.equal(bytes.toString(), 'sample');
  assert.equal((await media.relayMediaIdentity(bytes, 'video')).visualHash, '');
});

test('streamed data cannot exceed the size cap when metadata omits its size', async t => {
  telegram.metadata = { ok: true, result: { file_path: 'photos/file.jpg' } };
  fakeDownload(t, { body: [Buffer.alloc(media.RELAY_PHOTO_MAX_BYTES), Buffer.from('x')] });
  assert.equal(await media.downloadBotRelayMedia(token, 'file-id', 'photo'), null);
});

test('redirects, oversized declared responses and interrupted downloads are not used', async t => {
  telegram.metadata = { ok: true, result: { file_path: 'photos/file.jpg' } };
  for (const response of [{ status: 302 }, { headers: { 'content-length': String(media.RELAY_PHOTO_MAX_BYTES + 1) } }, { abort: true }]) {
    t.mock.restoreAll(); fakeDownload(t, response);
    assert.equal(await media.downloadBotRelayMedia(token, 'file-id', 'photo'), null);
  }
});
