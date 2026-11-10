import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const fixture = mkdtempSync(path.join(tmpdir(), 'telegram-settings-'));
const appOrigin = 'https://directory.example';
const token = '12345678:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const otherToken = '87654321:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const channelId = '-1001234567890';
const groupId = '-1001234567891';
const otherGroupId = '-1001234567892';
const promotionMessage = 'New offers from the directory.';
const welcomeMessage = '欢迎加入群组！';
const previousEnv = Object.fromEntries(['APP_URL', 'DATA_DIR', 'SESSION_SECRET'].map(key => [key, process.env[key]]));

function writeFixture(relative, content) {
  const destination = path.join(fixture, relative);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

// Run the real authenticated route and repository against disposable SQLite.
// Stub only the session lookup and Telegram dependencies, with no network I/O.
writeFixture('package.json', '{"type":"commonjs"}');
symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(fixture, 'node_modules'), 'dir');
for (const relative of [
  'app/api/admin/_security', 'app/api/admin/telegram/route',
  ...['auth-core', 'brand-links', 'directory', 'image-media', 'image-url', 'sqlite', 'telegram-background', 'telegram-promotions'].map(name => `app/lib/${name}`),
]) {
  const source = readFileSync(new URL(`../${relative}.ts`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  writeFixture(`${relative}.js`, outputText);
}
writeFixture('app/chatgpt-auth.js', 'exports.getChatGPTUser = async () => ({ username: "fixture-admin" });');
writeFixture('app/lib/telegram-welcome.js', 'exports.startTelegramWelcomeWorker = () => { throw new Error("Unexpected worker start"); };');
writeFixture('app/lib/telegram-bot.js', `
const targets = new Map([
  ['@fixture_channel', ${channelId}], ['@fixture_group', ${groupId}], ['@other_group', ${otherGroupId}],
]);
exports.calls = [];
exports.webhookUrl = '';
exports.groupAdmin = true;
exports.telegramRequest = async (token, method, parameters = {}) => {
  exports.calls.push({ token, method, parameters });
  if (method === 'getMe') return { ok: true, result: { is_bot: true, id: Number(token.split(':')[0]) } };
  if (method === 'getWebhookInfo') return { ok: true, result: { url: exports.webhookUrl } };
  const id = targets.get(parameters.chat_id) ?? parameters.chat_id;
  if (method === 'getChat') {
    return { ok: true, result: { id, type: id === ${channelId} ? 'channel' : 'supergroup' } };
  }
  if (method === 'getChatMember') {
    if (id === ${channelId}) return { ok: true, result: { status: 'administrator', can_post_messages: true } };
    return { ok: true, result: { status: exports.groupAdmin ? 'administrator' : 'member' } };
  }
  throw new Error('Unexpected Telegram method in settings test');
};
`);

const require = createRequire(import.meta.url);
const route = require(path.join(fixture, 'app/api/admin/telegram/route.js'));
const telegram = require(path.join(fixture, 'app/lib/telegram-bot.js'));
const { getSqlite } = require(path.join(fixture, 'app/lib/sqlite.js'));
let database;
let databaseIndex = 0;

test.beforeEach(() => {
  process.env.APP_URL = appOrigin;
  process.env.DATA_DIR = path.join(fixture, `db-${++databaseIndex}`);
  process.env.SESSION_SECRET = 'telegram-settings-fixture-session-secret';
  telegram.calls.length = 0;
  telegram.webhookUrl = '';
  telegram.groupAdmin = true;
  database = getSqlite();
});

test.afterEach(() => database.close());
test.after(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(fixture, { recursive: true, force: true });
});

async function get() {
  const response = await route.GET(new Request(`${appOrigin}/api/admin/telegram`));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return response.json();
}

async function put(body, expectedStatus = 200) {
  const response = await route.PUT(new Request(`${appOrigin}/api/admin/telegram`, {
    method: 'PUT', headers: { 'content-type': 'application/json', origin: appOrigin }, body: JSON.stringify(body),
  }));
  const result = await response.json();
  assert.equal(response.status, expectedStatus, result.error);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return result;
}

function settingsRow() {
  return { ...database.prepare("SELECT * FROM telegram_promotion_settings WHERE id='primary'").get() };
}

function runtimeRow() {
  const row = database.prepare("SELECT * FROM telegram_welcome_state WHERE id='primary'").get();
  return row && { ...row };
}

function recordWelcomeProgress(revision) {
  database.prepare(`INSERT INTO telegram_welcome_state (id, revision, next_offset, last_polled_at, sent, last_error)
    VALUES ('primary', ?, 73, 12345678, 2, 'fixture state')`).run(revision);
  return runtimeRow();
}

const channel = { enabled: true, chatId: channelId };
const welcome = { enabled: true, chatId: groupId, message: welcomeMessage };

test('welcome starts disabled and can share the saved channel bot with a separate group', async () => {
  const initial = await get();
  assert.equal(initial.enabled, false);
  assert.equal(initial.hasToken, false);
  assert.deepEqual(initial.welcome, { enabled: false, chatId: '', message: '', sent: 0, lastPolledAt: null, lastError: '' });

  const configured = await put({ enabled: true, chatId: 'https://t.me/fixture_channel/', token });
  assert.equal(configured.chatId, channelId);
  assert.equal(configured.hasToken, true);
  assert.equal(configured.welcome.enabled, false);
  assert.equal(telegram.calls.some(call => call.method === 'getWebhookInfo'), false);

  telegram.calls.length = 0;
  const both = await put({ ...channel, welcome: { ...welcome, chatId: 'https://telegram.me/fixture_group/' } });
  assert.equal(both.chatId, channelId);
  assert.equal(both.welcome.chatId, groupId);
  assert.equal(both.welcome.enabled, true);
  assert.ok(telegram.calls.every(call => call.token === token));
  assert.ok(telegram.calls.some(call => call.method === 'getChat' && call.parameters.chat_id === '@fixture_group'));
  assert.ok(telegram.calls.some(call => call.method === 'getChatMember' && call.parameters.chat_id === Number(groupId)));
  assert.ok(telegram.calls.some(call => call.method === 'getWebhookInfo'));

  const welcomeOnly = await put({ ...channel, enabled: false });
  assert.equal(welcomeOnly.enabled, false);
  assert.equal(welcomeOnly.welcome.enabled, true);
  assert.match(settingsRow().token_ciphertext, /^v1\./);
  for (const result of [configured, both, welcomeOnly, await get()]) {
    assert.equal('token' in result || 'token_ciphertext' in result, false);
    assert.ok(!JSON.stringify(result).includes(token));
    assert.ok(!JSON.stringify(result).includes(settingsRow().token_ciphertext));
  }
});

test('welcome rejects a channel, a group without bot admin rights, and a configured webhook', async () => {
  await put({ ...channel, token });
  const original = settingsRow();
  const edit = { ...channel, promotionMessage, welcome };
  const wrongTarget = await put({ ...edit, welcome: { ...welcome, chatId: channelId } }, 400);
  assert.match(wrongTarget.error, /欢迎消息需要 Telegram 群组/);

  telegram.groupAdmin = false;
  const wrongPermissions = await put(edit, 400);
  assert.match(wrongPermissions.error, /欢迎群组的管理员/);
  telegram.groupAdmin = true;

  telegram.webhookUrl = 'https://existing-webhook.example/sensitive-path';
  const webhook = await put(edit, 400);
  assert.match(webhook.error, /Webhook/);
  assert.ok(!webhook.error.includes(telegram.webhookUrl));
  assert.deepEqual(settingsRow(), original);
  assert.equal(runtimeRow(), undefined);
});

test('legacy saves and template edits preserve welcome settings and delivery progress', async () => {
  await put({ ...channel, token, promotionMessage, welcome });
  const original = settingsRow();
  const runtime = recordWelcomeProgress(original.welcome_revision);

  const legacy = await put(channel);
  assert.equal(legacy.promotionMessage, promotionMessage);
  assert.deepEqual(legacy.welcome, { ...welcome, sent: 2, lastPolledAt: 12345678, lastError: 'fixture state' });
  assert.deepEqual(settingsRow(), original);

  const updated = await put({
    ...channel, token, promotionMessage: 'Updated promotion template.',
    welcome: { ...welcome, message: '欢迎来到我们的新群组！' },
  });
  assert.equal(updated.promotionMessage, 'Updated promotion template.');
  assert.equal(updated.welcome.message, '欢迎来到我们的新群组！');
  const saved = settingsRow();
  assert.equal(saved.token_ciphertext, original.token_ciphertext);
  assert.equal(saved.welcome_revision, original.welcome_revision);
  assert.equal(saved.welcome_started_at, original.welcome_started_at);
  assert.deepEqual(runtimeRow(), runtime);
});

test('changing the welcome group or bot resets progress and disabling clears the revision', async () => {
  await put({ ...channel, token, welcome });
  const first = settingsRow();
  recordWelcomeProgress(first.welcome_revision);

  const otherGroup = { ...welcome, chatId: otherGroupId };
  const moved = await put({ ...channel, welcome: { ...otherGroup, chatId: '@other_group' } });
  const movedSettings = settingsRow();
  assert.equal(moved.welcome.chatId, otherGroupId);
  assert.equal(moved.welcome.sent, 0);
  assert.notEqual(movedSettings.welcome_revision, first.welcome_revision);
  assert.equal(runtimeRow(), undefined);
  recordWelcomeProgress(movedSettings.welcome_revision);

  const swapped = await put({ ...channel, token: otherToken });
  const swappedSettings = settingsRow();
  assert.equal(swapped.welcome.chatId, otherGroupId);
  assert.equal(swapped.welcome.sent, 0);
  assert.notEqual(swappedSettings.token_ciphertext, movedSettings.token_ciphertext);
  assert.notEqual(swappedSettings.welcome_revision, movedSettings.welcome_revision);
  assert.equal(runtimeRow(), undefined);
  recordWelcomeProgress(swappedSettings.welcome_revision);

  const disabled = await put({ ...channel, welcome: { ...otherGroup, enabled: false } });
  assert.equal(disabled.welcome.enabled, false);
  assert.equal(disabled.welcome.sent, 0);
  assert.equal(settingsRow().welcome_revision, '');
  assert.equal(settingsRow().welcome_started_at, 0);
  assert.equal(runtimeRow(), undefined);
});
