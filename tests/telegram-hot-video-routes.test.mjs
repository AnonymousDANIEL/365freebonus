import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Real administrator/origin/schema/upload boundaries and private SQLite/files.
// Only authentication lookup, facade actions and Telegram transport are replaced.
const fixture = mkdtempSync(path.join(tmpdir(), 'telegram-hot-video-routes-'));
const origin = 'https://directory.example';
const previousAppUrl = process.env.APP_URL, previousData = process.env.DATA_DIR;
function write(relative, content) {
  const filename = path.join(fixture, relative); mkdirSync(path.dirname(filename), { recursive: true }); writeFileSync(filename, content);
}
write('package.json', '{"type":"commonjs"}');
symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(fixture, 'node_modules'), 'dir');
for (const relative of ['app/api/admin/telegram/hot-videos/route', 'app/api/admin/telegram/hot-videos/upload/route',
  'app/api/admin/_security', 'app/lib/auth-core', 'app/lib/sqlite', 'app/lib/telegram-hot-videos', 'app/lib/telegram-hot-video-upload']) {
  write(`${relative}.js`, ts.transpileModule(readFileSync(new URL(`../${relative}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText);
}
write('app/chatgpt-auth.js', 'exports.authenticated=true;exports.getChatGPTUser=async()=>exports.authenticated?({username:"fixture-admin"}):null;');
write('app/lib/directory.js', 'exports.PromotionValidationError=class extends Error {};exports.SettingsValidationError=class extends Error {};');
write('app/lib/telegram-bot.js', `exports.calls=[];const unexpected=async(...args)=>{exports.calls.push(args);throw Error('Unexpected Telegram request');};
exports.telegramRequest=unexpected;exports.telegramVideoFileRequest=unexpected;`);
write('app/lib/telegram-promotions.js', `
exports.calls=[];exports.failure=null;exports.actualStatus=false;
exports.status={enabled:false,targetChatId:'',revision:'fixture-revision',videos:[],jobs:[]};
exports.telegramHotVideoStatus=()=>{exports.calls.push(['status']);if(exports.failure)throw exports.failure;
 return exports.actualStatus?require('./telegram-hot-videos').hotVideoStatus(require('./sqlite').getSqlite()):exports.status;};
for(const [name,kind] of [['saveTelegramHotVideoSettings','settings'],['queueTelegramHotVideo','send'],['updateTelegramHotVideo','update'],
 ['deleteTelegramHotVideo','delete'],['cancelTelegramHotVideoJob','cancel']])exports[name]=async input=>{exports.calls.push([kind,input]);if(exports.failure)throw exports.failure;return exports.status;};
`);
const require = createRequire(import.meta.url);
const route = require(path.join(fixture, 'app/api/admin/telegram/hot-videos/route.js'));
const uploadRoute = require(path.join(fixture, 'app/api/admin/telegram/hot-videos/upload/route.js'));
const auth = require(path.join(fixture, 'app/chatgpt-auth.js'));
const facade = require(path.join(fixture, 'app/lib/telegram-promotions.js'));
const backend = require(path.join(fixture, 'app/lib/telegram-hot-videos.js'));
const { getSqlite } = require(path.join(fixture, 'app/lib/sqlite.js'));
const transport = require(path.join(fixture, 'app/lib/telegram-bot.js'));
const fsPromises = require('node:fs/promises');
const videoId = '4db5f5b9-169f-480a-8d04-500104112e97', requestId = '2f5aca44-68c0-4ff8-9cbe-8cb2bc50f020';
const validSettings = () => ({ enabled: true, targetChatId: '-1001234567890', intervalHours: 6, firstRunAt: null, revision: 'fixture-revision' });
const validSend = () => ({ action: 'send', videoId, runAt: null, requestId });
function request(method, body, headers = {}) {
  return new Request(`${origin}/api/admin/telegram/hot-videos`, { method,
    headers: { origin, 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body) }),
  });
}
function uncached(response, status) { assert.equal(response.status, status); assert.equal(response.headers.get('cache-control'), 'no-store'); }
function mp4() {
  const bytes = Buffer.alloc(32); bytes.writeUInt32BE(24, 0); bytes.write('ftyp', 4); bytes.write('isom', 8);
  bytes.write('isom', 16); bytes.write('mp42', 20); bytes.writeUInt32BE(8, 24); bytes.write('mdat', 28); return bytes;
}
function upload(bytes = mp4(), headers = {}, extras = {}) {
  return new Request(`${origin}/api/admin/telegram/hot-videos/upload`, { method: 'POST',
    headers: { origin, 'content-type': 'video/mp4', 'x-video-size': String(Buffer.isBuffer(bytes) ? bytes.length : 32),
      'x-video-filename': encodeURIComponent('holiday.mp4'), 'x-video-title': encodeURIComponent('Hot video'), ...headers },
    body: bytes, ...(bytes instanceof ReadableStream ? { duplex: 'half' } : {}), ...extras,
  });
}
function trackedStream(chunks) {
  const state = { reads: 0, cancelled: false };
  const stream = new ReadableStream({
    pull(controller) { state.reads++; const value = chunks.shift(); if (value === undefined) controller.close(); else if (value instanceof Error) controller.error(value); else controller.enqueue(value); },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, state };
}
function storedFiles() { const directory = path.join(process.env.DATA_DIR, 'hot-videos'); try { return readdirSync(directory); } catch { return []; } }
function uploads() { return getSqlite().prepare('SELECT * FROM telegram_hot_video_uploads').all(); }
function videos() { return getSqlite().prepare('SELECT * FROM telegram_hot_videos').all(); }
test.beforeEach(() => {
  process.env.APP_URL = origin; process.env.DATA_DIR = path.join(fixture, `data-${randomUUID()}`);
  auth.authenticated = true; facade.calls.length = 0; facade.failure = null; facade.actualStatus = false; transport.calls.length = 0;
});
test.afterEach(() => { assert.equal(transport.calls.length, 0, 'route and upload validation must never post to Telegram'); });
test.after(() => {
  if (previousAppUrl === undefined) delete process.env.APP_URL; else process.env.APP_URL = previousAppUrl;
  if (previousData === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousData;
  for (const [filename, db] of globalThis.__directorySqlite || []) if (filename.startsWith(fixture)) { db.close(); globalThis.__directorySqlite.delete(filename); }
  rmSync(fixture, { recursive: true, force: true });
});

test('Hot video API requires administrator authentication before reading body or calling services', async () => {
  auth.authenticated = false;
  uncached(await route.GET(request('GET')), 401);
  uncached(await route.PUT(request('PUT', validSettings())), 401);
  uncached(await route.POST(request('POST', validSend())), 401);
  const incoming = trackedStream([mp4()]); uncached(await uploadRoute.POST(upload(incoming.stream)), 401);
  assert.equal(incoming.state.reads, 0); assert.deepEqual(facade.calls, []); assert.deepEqual(storedFiles(), []);
});

test('Hot video mutation and upload reject cross-origin or forged fetch context before reading the stream', async () => {
  for (const headers of [{ origin: 'https://other.example' }, { origin: '' }, { 'sec-fetch-site': 'cross-site' }]) {
    uncached(await route.PUT(request('PUT', validSettings(), headers)), 403);
    uncached(await route.POST(request('POST', validSend(), headers)), 403);
    const incoming = trackedStream([mp4()]); uncached(await uploadRoute.POST(upload(incoming.stream, headers)), 403);
    assert.equal(incoming.state.reads, 0);
  }
  uncached(await route.POST(request('POST', validSend(), { 'content-type': 'text/plain' })), 415);
  assert.deepEqual(facade.calls, []); assert.deepEqual(storedFiles(), []);
});

test('Hot video API rejects malformed, invalid-UTF8 and oversized JSON without dispatching', async () => {
  for (const body of ['{invalid', new Uint8Array([0xff]), ' '.repeat(30001)]) uncached(await route.POST(request('POST', body)), body.length > 30000 ? 413 : 400);
  uncached(await route.PUT(request('PUT', validSettings(), { 'content-length': '30001' })), 413);
  assert.deepEqual(facade.calls, []);
});

test('Hot video strict settings reject credentials, unsafe targets and invalid schedule shapes', async () => {
  for (const body of [{ ...validSettings(), token: 'secret' }, { ...validSettings(), enabled: 'true' },
    { ...validSettings(), targetChatId: '@public_hot' }, { ...validSettings(), targetChatId: 'https://t.me/+private' },
    { ...validSettings(), targetChatId: '-9007199254740992' }, { ...validSettings(), intervalHours: 0 },
    { ...validSettings(), intervalHours: 25 }, { ...validSettings(), intervalHours: 1.5 },
    { ...validSettings(), firstRunAt: '2026-11-15T12:00:00+08:00' }, { ...validSettings(), firstRunAt: -1 },
    { ...validSettings(), firstRunAt: Number.MAX_SAFE_INTEGER + 1 }, { ...validSettings(), revision: 'x'.repeat(81) }]) uncached(await route.PUT(request('PUT', body)), 400);
  assert.deepEqual(facade.calls, []);
});

test('Hot video strict actions reject unknown fields, malformed IDs and empty updates', async () => {
  for (const body of [{ ...validSend(), caption: 'must not accept a caption' }, { ...validSend(), button: 'external' },
    { ...validSend(), videoId: '../video.mp4' }, { ...validSend(), requestId: 'retry-with-no-id' },
    { ...validSend(), runAt: 1.5 }, { action: 'update', id: videoId }, { action: 'update', id: videoId, title: ' ' },
    { action: 'update', id: videoId, active: 1 }, { action: 'delete', id: videoId, path: '/data/private' },
    { action: 'cancel', id: 'invalid' }, { action: 'send', videoId, runAt: null }, { action: 'other', id: videoId }]) uncached(await route.POST(request('POST', body)), 400);
  assert.deepEqual(facade.calls, []);
});

test('Hot video routes dispatch only validated settings and action contracts with uncached safe status', async () => {
  const body = { ...validSettings(), targetChatId: ' -1001234567890 ' };
  uncached(await route.PUT(request('PUT', body)), 200);
  assert.deepEqual(facade.calls.shift(), ['settings', validSettings()]); facade.calls.length = 0;
  const cases = [[validSend(), ['send', { videoId, runAt: null, requestId }]],
    [{ ...validSend(), runAt: 1800000000000 }, ['send', { videoId, runAt: 1800000000000, requestId }]],
    [{ action: 'update', id: videoId, title: ' New name ', active: false }, ['update', { id: videoId, title: 'New name', active: false }]],
    [{ action: 'delete', id: videoId }, ['delete', videoId]], [{ action: 'cancel', id: videoId }, ['cancel', videoId]]];
  for (const [input, expected] of cases) {
    const response = await route.POST(request('POST', input)); uncached(response, 200);
    assert.deepEqual(facade.calls, [expected, ['status']]); assert.deepEqual(await response.json(), facade.status); facade.calls.length = 0;
  }
  const response = await route.GET(request('GET')); uncached(response, 200); assert.deepEqual(await response.json(), facade.status);
});

test('Hot video failures preserve safe known errors while unexpected failures redact raw details', async t => {
  facade.failure = new backend.HotVideoError('设置已改变，请刷新。', 409);
  const conflict = await route.POST(request('POST', validSend())); uncached(conflict, 409); assert.deepEqual(await conflict.json(), { error: '设置已改变，请刷新。' });
  facade.failure = new Error('PRIVATE_TOKEN_RAW_RESPONSE');
  const logs = []; t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  const failed = await route.GET(request('GET')); uncached(failed, 500);
  assert.doesNotMatch(JSON.stringify(await failed.json()) + logs.join(' '), /PRIVATE_TOKEN_RAW_RESPONSE/);
});

test('a valid raw MP4 upload stores private UUID bytes and SHA without a public URL or credential fields', async () => {
  facade.actualStatus = true; const bytes = mp4();
  const response = await uploadRoute.POST(upload(bytes)); uncached(response, 201);
  const [video] = videos(); assert.ok(video); assert.equal(video.bytes, bytes.length); assert.equal(video.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(video.file_name, `${video.id}.mp4`); assert.match(video.file_name, /^[a-f0-9-]{36}\.mp4$/);
  const filename = path.join(process.env.DATA_DIR, 'hot-videos', video.file_name);
  assert.deepEqual(readFileSync(filename), bytes); assert.equal(statSync(filename).mode & 0o777, 0o600);
  assert.equal(statSync(path.dirname(filename)).mode & 0o777, 0o700); assert.deepEqual(uploads(), []);
  const json = await response.json(); assert.equal(json.videos[0].title, 'Hot video'); assert.equal(json.videos[0].originalName, 'holiday.mp4');
  assert.doesNotMatch(JSON.stringify(json), /file_name|fileName|sha256|token_hash|token_ciphertext|SESSION_SECRET|\/data\/|\/api\/images\//);
  assert.equal(JSON.stringify(json).includes(video.file_name), false);
});

test('upload filenames are display-only and paths are stripped before saving private metadata', async () => {
  facade.actualStatus = true;
  const response = await uploadRoute.POST(upload(mp4(), { 'x-video-filename': encodeURIComponent('C:\\private\\..\\offer.mp4'), 'x-video-title': encodeURIComponent('🎁 新视频') }));
  uncached(response, 201); const [video] = videos(); assert.equal(video.original_name, 'offer.mp4'); assert.equal(video.title, '🎁 新视频');
  assert.equal(storedFiles()[0], `${video.id}.mp4`); assert.equal(storedFiles().length, 1);
});

test('upload rejects MIME, filename, title and size-header errors before reserving disk', async () => {
  for (const [headers, status] of [[{ 'content-type': 'image/png' }, 415], [{ 'x-video-size': '0' }, 400],
    [{ 'x-video-size': '1e2' }, 400], [{ 'x-video-size': '23' }, 400], [{ 'x-video-size': String(50 * 1024 * 1024 + 1) }, 413],
    [{ 'content-length': '33' }, 400], [{ 'content-length': '-1' }, 400], [{ 'x-video-filename': 'movie.gif' }, 415],
    [{ 'x-video-filename': '%invalid' }, 400], [{ 'x-video-filename': 'bad%00.mp4' }, 400],
    [{ 'x-video-title': encodeURIComponent('x'.repeat(161)) }, 400], [{ 'x-video-title': 'bad%0Aname' }, 400]]) {
    const incoming = trackedStream([mp4()]); uncached(await uploadRoute.POST(upload(incoming.stream, headers)), status); assert.equal(incoming.state.reads, 0);
  }
  assert.deepEqual(uploads(), []); assert.deepEqual(videos(), []); assert.deepEqual(storedFiles(), []);
});

test('forged small upload size cancels the stream and removes partial bytes and reservation', async () => {
  const incoming = trackedStream([mp4().subarray(0, 16), Buffer.alloc(32)]);
  uncached(await uploadRoute.POST(upload(incoming.stream)), 413);
  assert.equal(incoming.state.cancelled, true); assert.ok(incoming.state.reads >= 2);
  assert.deepEqual(uploads(), []); assert.deepEqual(videos(), []); assert.deepEqual(storedFiles(), []);
});

test('truncated, invalid-header and interrupted uploads cannot leave private files or quota reservations', async () => {
  const wrong = mp4(); wrong.write('fake', 4);
  const invalidBox = mp4(); invalidBox.writeUInt32BE(1000, 0);
  for (const [chunks, status] of [[[mp4().subarray(0, 31)], 400], [[wrong], 400], [[invalidBox], 400], [[mp4().subarray(0, 16), Error('PRIVATE_STREAM_FAILURE')], 503]]) {
    const incoming = trackedStream(chunks); const response = await uploadRoute.POST(upload(incoming.stream)); uncached(response, status);
    assert.doesNotMatch(JSON.stringify(await response.json()), /PRIVATE_STREAM_FAILURE/);
    assert.deepEqual(uploads(), []); assert.deepEqual(videos(), []); assert.deepEqual(storedFiles(), []);
  }
});

test('an aborted upload cleans its reservation and temporary file without consuming the stream', async () => {
  const abort = new AbortController(); abort.abort(); const incoming = trackedStream([mp4()]);
  uncached(await uploadRoute.POST(upload(incoming.stream, {}, { signal: abort.signal })), 408);
  assert.equal(incoming.state.reads, 0); assert.equal(incoming.state.cancelled, true);
  assert.deepEqual(uploads(), []); assert.deepEqual(storedFiles(), []);
});

test('full video quota and concurrent-upload reservations reject before reading or creating a file', async () => {
  const db = getSqlite(); db.prepare(`INSERT INTO telegram_hot_videos(id,title,original_name,file_name,bytes,sha256,sort_order,created_at)
    VALUES(?,'Existing','old.mp4',?,? ,?,1,?)`).run(videoId, `${videoId}.mp4`, backend.HOT_VIDEO_STORAGE_BYTES, 'a'.repeat(64), Date.now());
  let incoming = trackedStream([mp4()]); uncached(await uploadRoute.POST(upload(incoming.stream)), 413);
  assert.equal(incoming.state.reads, 0); assert.deepEqual(uploads(), []); assert.deepEqual(storedFiles(), []);
  db.prepare('DELETE FROM telegram_hot_videos').run();
  for (let i = 0; i < 2; i++) backend.reserveHotVideoUpload(db, { id: randomUUID(), bytes: 32 });
  incoming = trackedStream([mp4()]); uncached(await uploadRoute.POST(upload(incoming.stream)), 429);
  assert.equal(incoming.state.reads, 0); assert.equal(uploads().length, 2); assert.deepEqual(storedFiles(), []);
});

test('low free disk rejects before reservations or stream reads', async t => {
  t.mock.method(fsPromises, 'statfs', async () => ({ bavail: 0n, bsize: 4096n }));
  const incoming = trackedStream([mp4()]); uncached(await uploadRoute.POST(upload(incoming.stream)), 507);
  assert.equal(incoming.state.reads, 0); assert.deepEqual(uploads(), []); assert.deepEqual(storedFiles(), []);
});

test('registration failure after rename removes the final file and releases only its own reservation', async t => {
  t.mock.method(backend, 'registerHotVideo', () => { throw Error('PRIVATE_DB_FAILURE'); });
  const response = await uploadRoute.POST(upload()); uncached(response, 503);
  assert.doesNotMatch(JSON.stringify(await response.json()), /PRIVATE_DB_FAILURE/);
  assert.deepEqual(videos(), []); assert.deepEqual(uploads(), []); assert.deepEqual(storedFiles(), []);
});

test('a failed partial upload releases its reservation so a subsequent valid upload can succeed', async () => {
  const incoming = trackedStream([mp4().subarray(0, 16), Buffer.alloc(32)]);
  uncached(await uploadRoute.POST(upload(incoming.stream)), 413);
  facade.actualStatus = true; uncached(await uploadRoute.POST(upload()), 201);
  assert.equal(videos().length, 1); assert.equal(storedFiles().length, 1); assert.deepEqual(uploads(), []);
});

test('failure to render status after a committed upload keeps its durable file and registration available on refresh', async t => {
  t.mock.method(console, 'error', () => undefined);
  t.mock.method(facade, 'telegramHotVideoStatus', () => { throw Error('PRIVATE_STATUS_FAILURE'); });
  const response = await uploadRoute.POST(upload()); uncached(response, 500);
  assert.doesNotMatch(JSON.stringify(await response.json()), /PRIVATE_STATUS_FAILURE/);
  const [video] = videos(); assert.ok(video); assert.equal(storedFiles()[0], video.file_name);
  assert.deepEqual(readFileSync(path.join(process.env.DATA_DIR, 'hot-videos', video.file_name)), mp4());
  assert.deepEqual(uploads(), []);
});
