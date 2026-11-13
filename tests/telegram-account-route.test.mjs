import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const fixture = mkdtempSync(path.join(tmpdir(), 'telegram-account-route-'));
const origin = 'https://directory.example';
const previousAppUrl = process.env.APP_URL;
function write(relative, content) {
  const destination = path.join(fixture, relative);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}
write('package.json', '{"type":"commonjs"}');
symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(fixture, 'node_modules'), 'dir');
for (const relative of ['app/api/admin/telegram/account/route', 'app/api/admin/_security', 'app/lib/auth-core']) {
  const source = readFileSync(new URL(`../${relative}.ts`, import.meta.url), 'utf8');
  write(`${relative}.js`, ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText);
}
write('app/chatgpt-auth.js', 'exports.authenticated = true; exports.getChatGPTUser = async () => exports.authenticated ? ({username:"fixture-admin"}) : null;');
write('app/lib/directory.js', 'exports.PromotionValidationError = class extends Error {}; exports.SettingsValidationError = class extends Error {};');
write('app/lib/telegram-account.js', `
exports.calls = [];
exports.failure = null;
exports.TelegramAccountError = class extends Error { constructor(message,status) { super(message);this.status=status; } };
exports.status = { connected:false, stage:'disconnected', hasApiCredentials:false, lastError:'', lastPolledAt:null, syncedAt:null, channels:[] };
exports.accountStatus = () => { exports.calls.push('status'); return exports.status; };
exports.handleAccountAction = async input => { exports.calls.push(input); if(exports.failure) throw exports.failure; return exports.status; };
`);
const require = createRequire(import.meta.url);
const route = require(path.join(fixture, 'app/api/admin/telegram/account/route.js'));
const account = require(path.join(fixture, 'app/lib/telegram-account.js'));
const auth = require(path.join(fixture, 'app/chatgpt-auth.js'));

test.beforeEach(() => { process.env.APP_URL = origin; auth.authenticated = true; account.calls.length = 0; account.failure = null; });
test.after(() => { if (previousAppUrl === undefined) delete process.env.APP_URL; else process.env.APP_URL = previousAppUrl; rmSync(fixture, { recursive:true, force:true }); });

function post(body, headers = {}) {
  return route.POST(new Request(`${origin}/api/admin/telegram/account`, {
    method:'POST', headers:{ 'content-type':'application/json', origin, ...headers }, body:typeof body === 'string' ? body : JSON.stringify(body),
  }));
}

test('account status and credential actions require administrator authentication', async () => {
  auth.authenticated = false;
  for (const response of [await route.GET(new Request(`${origin}/api/admin/telegram/account`)), await post({ action:'refresh' })]) {
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.deepEqual(account.calls, []);
});

test('account mutation rejects cross-origin, forged fetch context and non-JSON requests', async () => {
  for (const [headers, expected] of [
    [{origin:'https://other.example'},403],
    [{'sec-fetch-site':'cross-site'},403],
    [{'content-type':'text/plain'},415],
  ]) {
    const response = await post({ action:'disconnect' }, headers);
    assert.equal(response.status, expected);
  }
  assert.deepEqual(account.calls, []);
});

test('account action validation rejects excess fields, malformed credentials and non-channel sources', async () => {
  const valid = { action:'sendCode', apiId:12345, apiHash:'a'.repeat(32), phone:'+60123456789' };
  for (const body of [
    {...valid, session:'unexpected'}, {...valid,apiId:'12345'}, {...valid,apiId:2147483648},
    {...valid,apiHash:'wrong'}, {...valid,phone:'0123456789'}, {action:'code',code:'123abc'},
    {action:'password',password:''}, {action:'refresh',foo:true}, {action:'select',channelIds:['12345']},
    {action:'select',channelIds:['-100123','-100123']}, {action:'select',channelIds:Array.from({length:501},(_,i)=>`-100${i}`)},
    {action:'disconnect',session:'unexpected'}, {action:'unknown'},
  ]) assert.equal((await post(body)).status, 400);
  assert.deepEqual(account.calls, []);
});

test('valid account actions pass to the service without echoing secrets or caching replies', async () => {
  const inputs = [
    {action:'sendCode',apiId:12345,apiHash:'a'.repeat(32),phone:'+60123456789'},
    {action:'code',code:'12345'}, {action:'password',password:'fixture-2fa-password'},
    {action:'refresh'}, {action:'select',channelIds:['-10012345']}, {action:'disconnect'},
  ];
  for (const input of inputs) {
    const response = await post(input);
    assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.deepEqual(await response.json(),account.status);
  }
  assert.deepEqual(account.calls,inputs);
  const response = await route.GET(new Request(`${origin}/api/admin/telegram/account`));
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual(await response.json(),account.status);
});

test('known account failures retain a safe explanation; unexpected failures do not expose raw RPC errors', async () => {
  account.failure = new account.TelegramAccountError('Telegram 暂时限制登入，请稍后再试。',429);
  const limited = await post({action:'refresh'});
  assert.equal(limited.status,429);
  assert.deepEqual(await limited.json(),{error:'Telegram 暂时限制登入，请稍后再试。'});
  account.failure = new Error('sensitive RPC payload must not appear');
  const originalError = console.error;
  const logs = [];
  console.error = (...values) => logs.push(values.join(' '));
  try {
    const failed = await post({action:'refresh'});
    assert.equal(failed.status,500);
    assert.doesNotMatch(JSON.stringify(await failed.json()),/sensitive|RPC payload/);
    assert.doesNotMatch(logs.join('\n'),/sensitive|RPC payload/);
  } finally { console.error = originalError; }
});
