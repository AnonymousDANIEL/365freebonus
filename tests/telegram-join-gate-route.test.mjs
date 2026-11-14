import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Exercise the real route, Zod schema and administrator/origin/body boundary.
// Only authentication lookup and gate service calls are replaced; no production
// data, credentials, channel actions or Telegram network requests are involved.
const fixture = mkdtempSync(path.join(tmpdir(), 'telegram-join-gate-route-'));
const origin = 'https://directory.example';
const previousAppUrl = process.env.APP_URL;
function write(relative, content) {
  const destination = path.join(fixture, relative);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}
write('package.json', '{"type":"commonjs"}');
symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(fixture, 'node_modules'), 'dir');
for (const relative of ['app/api/admin/telegram/gate/route', 'app/api/admin/_security', 'app/lib/auth-core']) {
  write(`${relative}.js`, ts.transpileModule(readFileSync(new URL(`../${relative}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText);
}
write('app/chatgpt-auth.js', 'exports.authenticated=true; exports.getChatGPTUser=async()=>exports.authenticated?({username:"fixture-admin"}):null;');
write('app/lib/directory.js', 'exports.PromotionValidationError=class extends Error {}; exports.SettingsValidationError=class extends Error {};');
write('app/lib/telegram-join-gate.js', 'exports.JoinGateError=class extends Error { constructor(message,status=400,retryAfter=0){super(message);this.status=status;this.retryAfter=retryAfter;} };');
write('app/lib/telegram-promotions.js', `
exports.calls=[];exports.failure=null;
exports.status={enabled:false,targetChatId:'',targetTitle:'',requiredChats:[],revision:'gate-revision',inviteLink:'',ready:false,lastError:'',lastCheckedAt:null,counts:{pending:0,approved:0,blocked:0,failed:0,unknown:0},candidates:[]};
exports.telegramJoinGateStatus=()=>{exports.calls.push('status');if(exports.failure)throw exports.failure;return exports.status;};
exports.saveTelegramJoinGateSettings=async input=>{exports.calls.push(input);if(exports.failure)throw exports.failure;return exports.status;};
`);
const require = createRequire(import.meta.url);
const route = require(path.join(fixture, 'app/api/admin/telegram/gate/route.js'));
const gate = require(path.join(fixture, 'app/lib/telegram-promotions.js'));
const { JoinGateError } = require(path.join(fixture, 'app/lib/telegram-join-gate.js'));
const auth = require(path.join(fixture, 'app/chatgpt-auth.js'));
const requirement = { chatId: '@join365freebonus', label: 'BONUS OFFICIAL', url: 'https://t.me/join365freebonus' };
const valid = () => ({ enabled: true, targetChatId: '-1001234567890', requiredChats: [{ ...requirement }], revision: 'gate-revision' });
function put(body, headers = {}) {
  return route.PUT(new Request(`${origin}/api/admin/telegram/gate`, {
    method: 'PUT', headers: { 'content-type': 'application/json', origin, ...headers },
    body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body),
  }));
}
function uncached(response, expected) {
  assert.equal(response.status, expected);
  assert.equal(response.headers.get('cache-control'), 'no-store');
}
test.beforeEach(() => { process.env.APP_URL = origin; auth.authenticated = true; gate.calls.length = 0; gate.failure = null; });
test.after(() => {
  if (previousAppUrl === undefined) delete process.env.APP_URL; else process.env.APP_URL = previousAppUrl;
  rmSync(fixture, { recursive: true, force: true });
});

test('gate status and updates require administrator authentication before reaching the service', async () => {
  auth.authenticated = false;
  uncached(await route.GET(new Request(`${origin}/api/admin/telegram/gate`)), 401);
  uncached(await put(valid()), 401);
  assert.deepEqual(gate.calls, []);
});

test('gate mutation enforces origin, fetch context and JSON content type', async () => {
  for (const [headers, expected] of [
    [{ origin: 'https://other.example' }, 403],
    [{ origin: '' }, 403],
    [{ 'sec-fetch-site': 'cross-site' }, 403],
    [{ 'content-type': 'text/plain' }, 415],
  ]) uncached(await put(valid(), headers), expected);
  assert.deepEqual(gate.calls, []);
});

test('gate mutation rejects malformed, invalid-UTF8 and oversized request bodies without service calls', async () => {
  uncached(await put('{broken JSON'), 400);
  uncached(await put(new Uint8Array([0xff])), 400);
  uncached(await put(valid(), { 'content-length': '30001' }), 413);
  uncached(await put(' '.repeat(30001)), 413);
  assert.deepEqual(gate.calls, []);
});

test('strict gate input prevents credential fields, malformed targets and off-site membership links', async () => {
  const bad = [
    { ...valid(), token: 'do-not-accept-a-token' },
    { ...valid(), enabled: 'true' },
    { ...valid(), targetChatId: '@public_hot' },
    { ...valid(), targetChatId: 'https://t.me/+private-invitation' },
    { ...valid(), targetChatId: '12345' },
    { ...valid(), targetChatId: '-9007199254740992' },
    { ...valid(), targetChatId: '' },
    { ...valid(), requiredChats: [] },
    { ...valid(), requiredChats: [{ ...requirement, membership: true }] },
    { ...valid(), requiredChats: [{ ...requirement, chatId: 'https://other.example/group' }] },
    { ...valid(), requiredChats: [{ ...requirement, chatId: 'https://t.me/+private-link' }] },
    { ...valid(), requiredChats: [{ ...requirement, chatId: '@a' }] },
    { ...valid(), requiredChats: [{ ...requirement, url: 'https://t.me.evil.example/join365freebonus' }] },
    { ...valid(), requiredChats: [{ ...requirement, url: 'javascript:alert(1)' }] },
    { ...valid(), requiredChats: [{ ...requirement, url: 'http://t.me/join365freebonus' }] },
    { ...valid(), requiredChats: [{ ...requirement, url: 'https://t.me/join365freebonus?redirect=other' }] },
    { ...valid(), requiredChats: [{ ...requirement, label: ' ' }] },
    { ...valid(), requiredChats: Array.from({ length: 9 }, (_, index) => ({ ...requirement, label: `Rule ${index}` })) },
    { ...valid(), revision: 'x'.repeat(81) },
  ];
  for (const body of bad) uncached(await put(body), 400);
  assert.deepEqual(gate.calls, []);
});

test('valid settings preserve the concurrency revision and pass trimmed references to the gate service', async () => {
  const body = {
    enabled: true, targetChatId: ' -1001234567890 ', revision: ' gate-revision ',
    requiredChats: [
      { chatId: ' @join365freebonus ', label: ' BONUS OFFICIAL ', url: ' https://t.me/join365freebonus ' },
      { chatId: 'https://t.me/join365freebonusgroup/', label: 'BONUS GROUP', url: 'https://t.me/join365freebonusgroup/' },
      { chatId: '-1009876543210', label: 'Another channel', url: 'https://t.me/another_channel' },
    ],
  };
  const response = await put(body);
  uncached(response, 200);
  assert.deepEqual(gate.calls, [{
    enabled: true, targetChatId: '-1001234567890', revision: ' gate-revision ',
    requiredChats: [
      requirement,
      { chatId: 'https://t.me/join365freebonusgroup/', label: 'BONUS GROUP', url: 'https://t.me/join365freebonusgroup/' },
      { chatId: '-1009876543210', label: 'Another channel', url: 'https://t.me/another_channel' },
    ],
  }]);
  assert.deepEqual(await response.json(), gate.status);
});

test('disabled draft settings can be saved without a target or requirements and eight conditions remain supported', async () => {
  const draft = { enabled: false, targetChatId: '', requiredChats: [], revision: 'gate-revision' };
  uncached(await put(draft), 200);
  assert.deepEqual(gate.calls, [draft]);
  const maximum = { ...valid(), requiredChats: Array.from({ length: 8 }, (_, index) => ({ chatId: `@channel_${index}`, label: `Rule ${index}`, url: `https://t.me/channel_${index}` })) };
  uncached(await put(maximum), 200);
  assert.deepEqual(gate.calls[1], maximum);
});

test('GET and PUT expose only the service status with no caching or echoed request fields', async () => {
  const status = await route.GET(new Request(`${origin}/api/admin/telegram/gate`));
  uncached(status, 200);
  assert.deepEqual(await status.json(), gate.status);
  const saved = await put(valid());
  uncached(saved, 200);
  const result = await saved.json();
  assert.deepEqual(result, gate.status);
  for (const forbidden of ['token', 'cookie', 'password', 'session_ciphertext']) assert.equal(forbidden in result, false);
  assert.deepEqual(gate.calls, ['status', valid()]);
});

test('known gate failures preserve a safe explanation while unexpected failures never expose raw details', async t => {
  gate.failure = new JoinGateError('频道设置已更新，请刷新后再保存。', 409);
  const conflict = await put(valid());
  uncached(conflict, 409);
  assert.deepEqual(await conflict.json(), { error: '频道设置已更新，请刷新后再保存。' });
  gate.failure = new JoinGateError('Telegram 正在限制请求频率，请稍后再试。', 429);
  uncached(await route.GET(new Request(`${origin}/api/admin/telegram/gate`)), 429);
  const marker = 'PRIVATE_TOKEN_AND_RAW_TELEGRAM_RESPONSE';
  gate.failure = new Error(marker);
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  const failed = await put(valid());
  uncached(failed, 500);
  assert.doesNotMatch(JSON.stringify(await failed.json()), new RegExp(marker));
  assert.doesNotMatch(logs.join('\n'), new RegExp(marker));
});
