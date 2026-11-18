import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const fixture = mkdtempSync(path.join(tmpdir(), 'telegram-scheduled-message-routes-'));
const origin = 'https://directory.example';
const previousOrigin = process.env.APP_URL;
function write(relative, content) {
  const target = path.join(fixture, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}
write('package.json', '{"type":"commonjs"}');
symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(fixture, 'node_modules'), 'dir');
for (const source of ['app/api/admin/telegram/scheduled-messages/route', 'app/api/admin/_security', 'app/lib/auth-core']) {
  write(`${source}.js`, ts.transpileModule(readFileSync(new URL(`../${source}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText);
}
write('app/chatgpt-auth.js', 'exports.authenticated=true;exports.getChatGPTUser=async()=>exports.authenticated?({username:"fixture-admin"}):null;');
write('app/lib/directory.js', 'exports.PromotionValidationError=class extends Error {};exports.SettingsValidationError=class extends Error {};');
write('app/lib/telegram-scheduled-messages.js', 'exports.ScheduledMessageError=class extends Error {constructor(message,status=400){super(message);this.status=status;}};');
write('app/lib/telegram-promotions.js', `
exports.calls=[];exports.failure=null;exports.status={now:123,plans:[],deliveries:[],targets:[],counts:{},scheduler:{workerHealthy:true}};
for(const [name,kind] of [['telegramScheduledMessageStatus','status'],['saveTelegramScheduledMessagePlan','save'],
 ['deleteTelegramScheduledMessagePlan','delete'],['verifyTelegramScheduledMessageTargets','verify'],
 ['saveTelegramScheduledMessageTarget','saveTarget'],['deleteTelegramScheduledMessageTarget','deleteTarget']])
 exports[name]=input=>{exports.calls.push([kind,input]);if(exports.failure)throw exports.failure;return exports.status;};
`);
const require = createRequire(import.meta.url);
const route = require(path.join(fixture, 'app/api/admin/telegram/scheduled-messages/route.js'));
const auth = require(path.join(fixture, 'app/chatgpt-auth.js'));
const facade = require(path.join(fixture, 'app/lib/telegram-promotions.js'));
const { ScheduledMessageError } = require(path.join(fixture, 'app/lib/telegram-scheduled-messages.js'));
const plan = () => ({ requestId: randomUUID(), name: 'Daily reminder', text: 'First line\n\n🎁 Keep this exact line.  ', times: ['00:00', '08:30', '23:59'], enabled: false });
const edit = () => { const { requestId, ...fields } = plan(); return { id: randomUUID(), revision: randomUUID(), ...fields }; };
function request(method, body, headers = {}) {
  return new Request(`${origin}/api/admin/telegram/scheduled-messages`, { method,
    headers: { origin, 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body) }),
  });
}
function uncached(response, status) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('cache-control'), 'no-store');
}
test.beforeEach(() => { process.env.APP_URL = origin; auth.authenticated = true; facade.calls.length = 0; facade.failure = null; });
test.after(() => {
  if (previousOrigin === undefined) delete process.env.APP_URL; else process.env.APP_URL = previousOrigin;
  rmSync(fixture, { recursive: true, force: true });
});

test('scheduled-message API authenticates every operation before body reads or service calls', async () => {
  auth.authenticated = false;
  for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
    const incoming = request(method, method === 'GET' ? undefined : edit());
    uncached(await route[method](incoming), 401);
    assert.equal(incoming.bodyUsed, false);
  }
  assert.deepEqual(facade.calls, []);
});

test('mutations including target verification reject forged origins and non-JSON before body reads', async () => {
  for (const method of ['POST', 'PUT', 'DELETE']) {
    for (const headers of [{ origin: 'https://evil.example' }, { origin: '' }, { 'sec-fetch-site': 'cross-site' }]) {
      const incoming = request(method, { action: 'verify' }, headers);
      uncached(await route[method](incoming), 403); assert.equal(incoming.bodyUsed, false);
    }
    const incoming = request(method, plan(), { 'content-type': 'text/plain' });
    uncached(await route[method](incoming), 415); assert.equal(incoming.bodyUsed, false);
  }
  assert.deepEqual(facade.calls, []);
});

test('bad JSON, invalid UTF-8 and streamed size limits cannot reach scheduling', async () => {
  for (const body of ['{bad', new Uint8Array([0xff]), ' '.repeat(30001)]) {
    uncached(await route.POST(request('POST', body)), body.length > 30000 ? 413 : 400);
  }
  uncached(await route.PUT(request('PUT', edit(), { 'content-length': '30001' })), 413);
  assert.deepEqual(facade.calls, []);
});

test('daily times reject invalid clock values, duplicate slots and excessive slot lists', async () => {
  const invalid = [[], ['24:00'], ['8:00'], ['08:60'], ['08:00 '], ['08:00', '08:00'], [800], null,
    Array.from({ length: 25 }, (_, i) => `${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`)];
  for (const times of invalid) uncached(await route.POST(request('POST', { ...plan(), times })), 400);
  assert.deepEqual(facade.calls, []);
});

test('strict plan payload rejects recipient, token, parse-mode and unexpected action injection', async () => {
  for (const extra of [{ chatId: '-1001234567890' }, { token: 'private' }, { targets: ['other'] },
    { parse_mode: 'HTML' }, { action: 'send' }, { text: ' ' }, { text: 'x'.repeat(4097) },
    { name: '' }, { name: 'x'.repeat(101) }, { enabled: 1 }, { requestId: undefined }, { requestId: 'retry' }]) {
    uncached(await route.POST(request('POST', { ...plan(), ...extra })), 400);
  }
  assert.deepEqual(facade.calls, []);
});

test('create preserves copy and newlines exactly and trims only the internal plan name', async () => {
  const body = { ...plan(), name: '  Morning plan  ' };
  const response = await route.POST(request('POST', body)); uncached(response, 200);
  assert.deepEqual(facade.calls, [['save', { ...body, name: 'Morning plan' }]]);
  assert.deepEqual(await response.json(), facade.status);
  facade.calls.length = 0;
  const full = { ...plan(), text: '界'.repeat(4096), times: ['00:00'] };
  uncached(await route.POST(request('POST', full)), 200);
  assert.equal(facade.calls[0][1].text, full.text);
});

test('updates and deletes require explicit UUID revision leases', async () => {
  for (const body of [{ ...edit(), revision: '' }, { ...edit(), id: '../id' }, { ...plan() }, { ...edit(), revision: undefined },
    { ...edit(), requestId: randomUUID() }]) {
    uncached(await route.PUT(request('PUT', body)), 400);
  }
  for (const body of [{ id: randomUUID() }, { id: randomUUID(), revision: 'stale' }, { id: randomUUID(), revision: randomUUID(), force: true }]) {
    uncached(await route.DELETE(request('DELETE', body)), 400);
  }
  assert.deepEqual(facade.calls, []);
});

test('read, update, delete and permission refresh use their intended services without send actions', async () => {
  uncached(await route.GET(request('GET')), 200);
  assert.deepEqual(facade.calls.splice(0), [['status', undefined]]);
  const body = edit(); uncached(await route.PUT(request('PUT', body)), 200);
  assert.deepEqual(facade.calls.splice(0), [['save', body]]);
  const deleting = { id: body.id, revision: body.revision };
  uncached(await route.DELETE(request('DELETE', deleting)), 200);
  assert.deepEqual(facade.calls.splice(0), [['delete', deleting]]);
  uncached(await route.POST(request('POST', { action: 'verify' })), 200);
  assert.deepEqual(facade.calls.splice(0), [['verify', undefined]]);
  for (const body of [{ action: 'verify', send: true }, { action: 'verify', token: 'secret' }]) {
    uncached(await route.POST(request('POST', body)), 400);
  }
  assert.deepEqual(facade.calls, []);
});

test('known scheduler conflicts and permission errors retain safe non-cacheable status', async () => {
  for (const status of [400, 403, 409, 429, 503]) {
    facade.failure = new ScheduledMessageError('计划状态已改变，请刷新后重试。', status);
    const response = await route.PUT(request('PUT', edit())); uncached(response, status);
    assert.deepEqual(await response.json(), { error: facade.failure.message });
  }
});

test('dated plans accept a validated channel selection and private media ID', async () => {
  const body = { ...plan(), calendarDate: '2026-11-19', mediaId: randomUUID(),
    targetKeys: ['official', `custom:${randomUUID()}`] };
  uncached(await route.POST(request('POST', body)), 200);
  assert.deepEqual(facade.calls.splice(0), [['save', body]]);
  for (const invalid of [
    { calendarDate: '2026/11/19' },
    { targetKeys: ['official', 'official'] },
    { targetKeys: ['@arbitrary-channel'] },
    { targetKeys: [] },
    { mediaId: '../private.jpg' },
    { text: 'x'.repeat(1025) },
  ]) uncached(await route.POST(request('POST', { ...body, ...invalid })), 400);
  assert.deepEqual(facade.calls, []);
});

test('custom channel create, edit and removal require stable IDs and explicit revisions', async () => {
  const requestId = randomUUID();
  const key = `custom:${requestId}`;
  const revision = randomUUID();
  const target = { action: 'upsertTarget', title: '  Main announcements  ', address: ' @channel_updates ' };
  const saved = { title: 'Main announcements', address: '@channel_updates' };
  uncached(await route.POST(request('POST', { ...target, requestId })), 200);
  uncached(await route.POST(request('POST', { ...target, key, revision })), 200);
  uncached(await route.DELETE(request('DELETE', { targetKey: key, revision })), 200);
  assert.deepEqual(facade.calls.splice(0), [
    ['saveTarget', { ...saved, requestId }],
    ['saveTarget', { ...saved, key, revision }],
    ['deleteTarget', { key, revision }],
  ]);
  for (const fields of [{ key }, { key: 'official', revision }, { requestId, revision },
    { requestId, token: 'sensitive' }]) uncached(await route.POST(request('POST', { ...target, ...fields })), 400);
  uncached(await route.DELETE(request('DELETE', { targetKey: key })), 400);
  uncached(await route.DELETE(request('DELETE', { targetKey: 'hot', revision })), 400);
  assert.deepEqual(facade.calls, []);
});
