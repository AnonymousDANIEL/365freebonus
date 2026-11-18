import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import ts from 'typescript';

const fixture = mkdtempSync(path.join(tmpdir(), 'scheduled-media-'));
const appUrl = 'https://directory.example';
const apiUrl = `${appUrl}/api/admin/telegram/scheduled-messages/upload`;
const beforeEnv = { APP_URL: process.env.APP_URL, DATA_DIR: process.env.DATA_DIR };
const chunkSize = 4 * 1024 * 1024;
function write(name, content) {
  const location = path.join(fixture, name);
  mkdirSync(path.dirname(location), { recursive: true });
  writeFileSync(location, content);
}
write('package.json', '{"type":"commonjs"}');
symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(fixture, 'node_modules'), 'dir');
for (const name of ['app/api/admin/telegram/scheduled-messages/upload/route', 'app/api/admin/_security', 'app/lib/auth-core',
  'app/lib/sqlite', 'app/lib/telegram-hot-video-mp4', 'app/lib/telegram-scheduled-media']) {
  const source = readFileSync(new URL(`../${name}.ts`, import.meta.url), 'utf8');
  write(`${name}.js`, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText);
}
write('app/chatgpt-auth.js', 'exports.signedIn=true;exports.getChatGPTUser=async()=>exports.signedIn?{username:"fixture"}:null;');
write('app/lib/directory.js', 'exports.SettingsValidationError=class extends Error{};exports.PromotionValidationError=class extends Error{};');
write('app/lib/telegram-bot.js', `
exports.mediaCalls=[];
exports.telegramScheduledMediaFileRequest=async (...args)=>{exports.mediaCalls.push(args);return {ok:true,result:{message_id:123}};};
`);
const require = createRequire(import.meta.url);
const route = require(path.join(fixture, 'app/api/admin/telegram/scheduled-messages/upload/route.js'));
const auth = require(path.join(fixture, 'app/chatgpt-auth.js'));
const { getSqlite } = require(path.join(fixture, 'app/lib/sqlite.js'));
const { mediaCalls } = require(path.join(fixture, 'app/lib/telegram-bot.js'));
const { readScheduledMessageMedia, sendScheduledMessageMedia } = require(path.join(fixture, 'app/lib/telegram-scheduled-media.js'));

test.beforeEach(() => {
  process.env.APP_URL = appUrl;
  process.env.DATA_DIR = path.join(fixture, 'data', randomUUID());
  auth.signedIn = true;
  mediaCalls.length = 0;
});
test.after(() => {
  for (const [key, value] of Object.entries(beforeEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(fixture, { recursive: true, force: true });
});
function POST(id, bytes, options = {}) {
  const { offset = 0, size = bytes.length, name = 'daily.png', mime = 'image/png', headers = {} } = options;
  const params = new URLSearchParams({ uploadId: id, name, offset: String(offset), size: String(size) });
  return new Request(`${apiUrl}?${params}`, { method: 'POST', body: bytes,
    headers: { origin: appUrl, 'content-type': mime, ...headers } });
}
const GET = (id, headers = {}) => new Request(`${apiUrl}?id=${encodeURIComponent(id)}`, { headers });
const image = () => sharp({ create: { width: 3, height: 3, channels: 3, background: '#ff0000' } });
const photo = () => image().png().toBuffer();

test('media upload and inline preview require admin permission and reject cross-origin writes before reading', async () => {
  const id = randomUUID(), png = await photo();
  auth.signedIn = false;
  const unauthenticated = POST(id, png);
  assert.equal((await route.POST(unauthenticated)).status, 401);
  assert.equal(unauthenticated.bodyUsed, false);
  assert.equal((await route.GET(GET(id))).status, 401);
  auth.signedIn = true;
  const crossOrigin = POST(id, png, { headers: { origin: 'https://wrong.example' } });
  assert.equal((await route.POST(crossOrigin)).status, 403);
  assert.equal(crossOrigin.bodyUsed, false);
  assert.deepEqual(mediaCalls, []);
});

test('one photo or GIF is saved privately for immediate preview and a later captioned send', async () => {
  for (const [mime, kind, original, filename, bytes] of [
    ['image/png', 'photo', '../morning.png', 'morning.png', await photo()],
    ['image/gif', 'animation', 'Friday.gif', 'Friday.gif', await image().gif().toBuffer()],
  ]) {
    const id = randomUUID(), attempt = () => route.POST(POST(id, bytes, { mime, name: original }));
    const response = await attempt();
    const asset = { id, kind, name: filename, bytes: bytes.length };
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), asset);
    assert.deepEqual(await (await attempt()).json(), asset);
    assert.deepEqual(readScheduledMessageMedia(getSqlite(), id), asset);

    const preview = await route.GET(GET(id));
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-type'), mime);
    assert.equal(preview.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(Buffer.from(await preview.arrayBuffer()), bytes);
    assert.equal((await route.GET(GET('../directory.sqlite'))).status, 404);
    assert.equal(mediaCalls.length, 0, 'Uploading and preview do not send to Telegram');
    const caption = 'Daily offer\n\nSee today’s terms. ';
    assert.deepEqual(await sendScheduledMessageMedia(getSqlite(), 'fixture', -100123, caption, id), { ok: true, result: { message_id: 123 } });
    const [token, chatId, verbatim, file] = mediaCalls.pop();
    assert.deepEqual([token, chatId, verbatim, file.fileName, file.mime, file.kind], ['fixture', -100123, caption, filename, mime, kind]);
    assert.deepEqual(readFileSync(file.path), bytes);
  }
});

function mp4Box(label, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(label, 4);
  return Buffer.concat([head, body]);
}
function videoFixture() {
  const hdlr = Buffer.alloc(16), tkhd = Buffer.alloc(84), time = Buffer.alloc(24);
  hdlr.write('vide', 8);
  tkhd.writeUInt32BE(320 * 65536, 76);
  tkhd.writeUInt32BE(180 * 65536, 80);
  time.writeUInt32BE(1000, 12);
  time.writeUInt32BE(6200, 16);
  const mdia = mp4Box('mdia', Buffer.concat([mp4Box('hdlr', hdlr), mp4Box('mdhd', time)]));
  const trak = mp4Box('trak', Buffer.concat([mp4Box('tkhd', tkhd), mdia]));
  return Buffer.concat([mp4Box('ftyp', Buffer.from('isom0000isommp42')),
    mp4Box('moov', trak), mp4Box('mdat', Buffer.alloc(11 * 1024 * 1024, 7))]);
}

test('MP4 larger than the proxy limit uploads in resumable chunks with scoped byte range previews', async () => {
  const bytes = videoFixture(), id = randomUUID();
  const upload = (offset, chunk = bytes.subarray(offset, offset + chunkSize)) =>
    route.POST(POST(id, chunk, { offset, size: bytes.length, mime: 'video/mp4', name: 'daily.mp4' }));
  assert.equal((await upload(chunkSize)).status, 409);
  const first = { id, received: chunkSize };
  assert.deepEqual(await (await upload(0)).json(), first);
  assert.deepEqual(await (await upload(0)).json(), first);
  const invalidReplay = Buffer.from(bytes.subarray(0, chunkSize));
  invalidReplay[500] = 0;
  assert.equal((await upload(0, invalidReplay)).status, 409);
  assert.equal((await route.GET(GET(id))).status, 404);
  assert.deepEqual(await (await upload(chunkSize)).json(), { id, received: 2 * chunkSize });
  const last = { id, kind: 'video', bytes: bytes.length, name: 'daily.mp4' };
  assert.deepEqual(await (await upload(2 * chunkSize)).json(), last);
  assert.deepEqual(await (await upload(2 * chunkSize)).json(), last);
  assert.equal((await upload(0, invalidReplay)).status, 409);
  const preview = await route.GET(GET(id, { range: 'bytes=4-83' }));
  assert.equal(preview.status, 206);
  assert.equal(preview.headers.get('content-range'), `bytes 4-83/${bytes.length}`);
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), bytes.subarray(4, 84));
  const invalidRange = await route.GET(GET(id, { range: 'bytes=0-2,10-12' }));
  assert.equal(invalidRange.status, 416);
  assert.equal(invalidRange.headers.get('content-range'), `bytes */${bytes.length}`);
});

test('missing, spoofed and too large files cannot be scheduled or previewed', async () => {
  const png = await photo();
  assert.equal((await route.POST(POST(randomUUID(), png, { mime: 'image/gif' }))).status, 415);
  assert.equal((await route.POST(POST(randomUUID(), Buffer.alloc(80), { mime: 'video/mp4' }))).status, 415);
  assert.equal((await route.POST(POST(randomUUID(), png, { size: 10 * 1024 * 1024 + 1 }))).status, 413);
  assert.equal((await route.POST(POST(randomUUID(), png, { size: png.length + 1 }))).status, 409);
  assert.deepEqual(readdirSync(path.join(process.env.DATA_DIR, 'telegram-scheduled-media')), []);

  const id = randomUUID();
  assert.equal((await route.POST(POST(id, png))).status, 201);
  rmSync(path.join(process.env.DATA_DIR, 'telegram-scheduled-media', `${id}.bin`));
  assert.equal((await route.GET(GET(id))).status, 404);
  assert.deepEqual(await sendScheduledMessageMedia(getSqlite(), 'fixture', -100123, 'Caption', id), { ok: false, code: 400, retryAfter: 0 });
  assert.deepEqual(mediaCalls, []);
});
