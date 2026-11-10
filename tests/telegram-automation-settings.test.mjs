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
const promotionToken = '12345678:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const rotatedPromotionToken = '12345678:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const chatToken = '87654321:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const rotatedChatToken = '87654321:DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
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
  if (method === 'getMe') {
    const id = Number(token.split(':')[0]);
    const username = id === 12345678 ? 'FreeBonus365Bot' : id === 87654321 ? 'FreeBonus365ChatBot' : 'OtherBot';
    return { ok: true, result: { is_bot: true, id, username } };
  }
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

function recordChatProgress(revision) {
  database.prepare(`INSERT INTO telegram_welcome_state (id, revision, next_offset, last_polled_at, sent, keyword_replies, last_error)
    VALUES ('primary', ?, 73, 12345678, 2, 4, 'fixture state')
    ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, next_offset = excluded.next_offset,
      last_polled_at = excluded.last_polled_at, sent = excluded.sent, keyword_replies = excluded.keyword_replies,
      last_error = excluded.last_error`).run(revision);
  return runtimeRow();
}

const channel = { enabled: true, chatId: channelId };
const welcome = { enabled: true, chatId: groupId, message: welcomeMessage };
const keywordChatBot = { token: chatToken, keywordEnabled: true };
const bothBots = { ...channel, token: promotionToken, promotionMessage, welcome, chatBot: keywordChatBot };

test('the channel and chat group use different bot identities and settings never expose either token', async () => {
  const initial = await get();
  assert.equal(initial.enabled, false);
  assert.equal(initial.hasToken, false);
  assert.deepEqual(initial.welcome, { enabled: false, chatId: '', message: '', sent: 0, lastPolledAt: null, lastError: '' });
  assert.deepEqual(initial.chatBot, { hasToken: false, keywordEnabled: false, keywordReplies: 0 });

  const configured = await put({ enabled: true, chatId: 'https://t.me/fixture_channel/', token: promotionToken });
  assert.equal(configured.chatId, channelId);
  assert.equal(configured.hasToken, true);
  assert.equal(configured.welcome.enabled, false);
  assert.equal(configured.chatBot.hasToken, false);
  assert.ok(telegram.calls.every(call => call.token === promotionToken));
  assert.ok(telegram.calls.some(call => call.method === 'getChat' && call.parameters.chat_id === '@fixture_channel'));
  assert.equal(telegram.calls.some(call => call.method === 'getWebhookInfo'), false);

  telegram.calls.length = 0;
  const both = await put({ ...channel, welcome: { ...welcome, chatId: 'https://telegram.me/fixture_group/' }, chatBot: keywordChatBot });
  assert.equal(both.chatId, channelId);
  assert.equal(both.welcome.chatId, groupId);
  assert.equal(both.welcome.enabled, true);
  assert.deepEqual(both.chatBot, { hasToken: true, keywordEnabled: true, keywordReplies: 0 });
  assert.ok(telegram.calls.every(call => call.token === chatToken));
  assert.ok(telegram.calls.some(call => call.method === 'getChat' && call.token === chatToken && call.parameters.chat_id === '@fixture_group'));
  assert.ok(telegram.calls.some(call => call.method === 'getChatMember' && call.token === chatToken && call.parameters.chat_id === Number(groupId)));
  assert.ok(telegram.calls.some(call => call.method === 'getWebhookInfo' && call.token === chatToken));

  const chatOnly = await put({ ...channel, enabled: false });
  assert.equal(chatOnly.enabled, false);
  assert.equal(chatOnly.welcome.enabled, true);
  assert.equal(chatOnly.chatBot.keywordEnabled, true);
  const saved = settingsRow();
  assert.match(saved.token_ciphertext, /^v1\./);
  assert.match(saved.chat_bot_token_ciphertext, /^v1\./);
  for (const result of [configured, both, chatOnly, await get()]) {
    assert.equal('token' in result || 'token_ciphertext' in result, false);
    assert.equal('token' in result.chatBot || 'token_ciphertext' in result.chatBot, false);
    for (const secret of [promotionToken, chatToken, saved.token_ciphertext, saved.chat_bot_token_ciphertext]) {
      assert.ok(!JSON.stringify(result).includes(secret));
    }
  }
});

test('keyword replies can be enabled independently of welcome messages and announcements', async () => {
  const keywordOnly = {
    enabled: false, chatId: '', welcome: { enabled: false, chatId: '@fixture_group', message: '' },
    chatBot: keywordChatBot,
  };
  const saved = await put(keywordOnly);
  assert.equal(saved.hasToken, false);
  assert.equal(saved.welcome.enabled, false);
  assert.equal(saved.welcome.chatId, groupId);
  assert.deepEqual(saved.chatBot, { hasToken: true, keywordEnabled: true, keywordReplies: 0 });
  assert.ok(telegram.calls.every(call => call.token === chatToken));
  assert.ok(telegram.calls.some(call => call.method === 'getWebhookInfo'));
  assert.ok(telegram.calls.some(call => call.method === 'getChatMember'));
});

test('the two token fields reject the other bot and a promotion token cannot enable welcome', async () => {
  const wrongPromotion = await put({ ...channel, token: chatToken }, 400);
  assert.match(wrongPromotion.error, /FreeBonus365Bot/i);
  const wrongChat = await put({ enabled: false, chatId: '', welcome, chatBot: { token: promotionToken, keywordEnabled: false } }, 400);
  assert.match(wrongChat.error, /FreeBonus365ChatBot/i);
  const duplicateBot = await put({ ...channel, token: promotionToken, chatBot: { token: rotatedPromotionToken, keywordEnabled: true } }, 400);
  assert.match(duplicateBot.error, /两个不同机器人的 Token/);
  const noChatBot = await put({ ...channel, token: promotionToken, welcome }, 400);
  assert.match(noChatBot.error, /(?:FreeBonus365ChatBot|群组).*Token/i);
  const saved = await get();
  assert.equal(saved.hasToken, false);
  assert.equal(saved.chatBot.hasToken, false);
});

test('the keyword bot rejects a channel, missing group administration and a configured webhook', async () => {
  const edit = { enabled: false, chatId: '', welcome: { ...welcome, enabled: false }, chatBot: keywordChatBot };
  const wrongTarget = await put({ ...edit, welcome: { ...edit.welcome, chatId: channelId } }, 400);
  assert.match(wrongTarget.error, /群组/);

  telegram.groupAdmin = false;
  const wrongPermissions = await put(edit, 400);
  assert.match(wrongPermissions.error, /管理员/);
  telegram.groupAdmin = true;

  telegram.webhookUrl = 'https://existing-webhook.example/sensitive-path';
  const webhook = await put(edit, 400);
  assert.match(webhook.error, /Webhook/);
  assert.ok(!webhook.error.includes(telegram.webhookUrl));
  assert.equal((await get()).chatBot.hasToken, false);
  assert.equal(runtimeRow(), undefined);
});

test('legacy saves and template edits preserve both chat features and their delivery progress', async () => {
  await put(bothBots);
  const original = settingsRow();
  const runtime = recordChatProgress(original.welcome_revision);

  const legacy = await put(channel);
  assert.equal(legacy.promotionMessage, promotionMessage);
  assert.deepEqual(legacy.welcome, { ...welcome, sent: 2, lastPolledAt: 12345678, lastError: 'fixture state' });
  assert.deepEqual(legacy.chatBot, { hasToken: true, keywordEnabled: true, keywordReplies: 4 });
  assert.deepEqual(settingsRow(), original);

  const updated = await put({
    ...bothBots, promotionMessage: 'Updated promotion template.',
    welcome: { ...welcome, message: '欢迎来到我们的新群组！' },
  });
  assert.equal(updated.promotionMessage, 'Updated promotion template.');
  assert.equal(updated.welcome.message, '欢迎来到我们的新群组！');
  const saved = settingsRow();
  assert.equal(saved.token_ciphertext, original.token_ciphertext);
  assert.equal(saved.chat_bot_token_ciphertext, original.chat_bot_token_ciphertext);
  assert.equal(saved.welcome_revision, original.welcome_revision);
  assert.equal(saved.welcome_started_at, original.welcome_started_at);
  assert.equal(saved.keyword_started_at, original.keyword_started_at);
  assert.deepEqual(runtimeRow(), runtime);
});

test('moving the same chat bot and toggling either feature preserves its shared cursor', async () => {
  await put(bothBots);
  database.prepare("UPDATE telegram_promotion_settings SET welcome_started_at=100, keyword_started_at=200 WHERE id='primary'").run();
  const first = settingsRow();
  const progress = recordChatProgress(first.welcome_revision);

  const otherGroup = { ...welcome, chatId: otherGroupId };
  const moved = await put({ ...channel, welcome: { ...otherGroup, chatId: '@other_group' } });
  const movedSettings = settingsRow();
  assert.equal(moved.welcome.chatId, otherGroupId);
  assert.equal(movedSettings.welcome_revision, first.welcome_revision);
  assert.equal(runtimeRow().next_offset, progress.next_offset);
  assert.ok(movedSettings.welcome_started_at > first.welcome_started_at);
  assert.ok(movedSettings.keyword_started_at > first.keyword_started_at);

  const welcomeOff = await put({ ...channel, welcome: { ...otherGroup, enabled: false } });
  const disabledWelcome = settingsRow();
  assert.equal(welcomeOff.welcome.enabled, false);
  assert.equal(welcomeOff.chatBot.keywordEnabled, true);
  assert.equal(disabledWelcome.welcome_started_at, 0);
  assert.equal(disabledWelcome.keyword_started_at, movedSettings.keyword_started_at);
  assert.equal(runtimeRow().next_offset, progress.next_offset);

  await put({ ...channel, welcome: otherGroup });
  const reenabledWelcome = settingsRow();
  const keywordOff = await put({ ...channel, chatBot: { keywordEnabled: false } });
  const disabledKeyword = settingsRow();
  assert.equal(keywordOff.welcome.enabled, true);
  assert.equal(keywordOff.chatBot.keywordEnabled, false);
  assert.equal(disabledKeyword.keyword_started_at, 0);
  assert.equal(disabledKeyword.welcome_started_at, reenabledWelcome.welcome_started_at);
  assert.equal(disabledKeyword.welcome_revision, first.welcome_revision);
  assert.equal(runtimeRow().next_offset, progress.next_offset);

  await put({ ...channel, welcome: { ...otherGroup, enabled: false } });
  const bothDisabled = settingsRow();
  assert.equal(bothDisabled.welcome_started_at, 0);
  assert.equal(bothDisabled.keyword_started_at, 0);
  assert.equal(bothDisabled.welcome_revision, first.welcome_revision);
  assert.equal(runtimeRow().next_offset, progress.next_offset);
});

test('independent token rotations preserve the other bot and reset progress only for the chat bot', async () => {
  await put(bothBots);
  const first = settingsRow();
  const runtime = recordChatProgress(first.welcome_revision);

  await put({ ...channel, token: rotatedPromotionToken });
  const updatedPromotion = settingsRow();
  assert.notEqual(updatedPromotion.token_ciphertext, first.token_ciphertext);
  assert.equal(updatedPromotion.chat_bot_token_ciphertext, first.chat_bot_token_ciphertext);
  assert.equal(updatedPromotion.welcome_revision, first.welcome_revision);
  assert.equal(updatedPromotion.welcome_started_at, first.welcome_started_at);
  assert.equal(updatedPromotion.keyword_started_at, first.keyword_started_at);
  assert.deepEqual(runtimeRow(), runtime);

  const updated = await put({ ...channel, chatBot: { token: rotatedChatToken, keywordEnabled: true } });
  const updatedChat = settingsRow();
  assert.notEqual(updatedChat.chat_bot_token_ciphertext, updatedPromotion.chat_bot_token_ciphertext);
  assert.equal(updatedChat.token_ciphertext, updatedPromotion.token_ciphertext);
  assert.notEqual(updatedChat.welcome_revision, updatedPromotion.welcome_revision);
  assert.equal(updated.welcome.chatId, groupId);
  assert.equal(updated.welcome.sent, 0);
  assert.equal(updated.chatBot.keywordReplies, 0);
  assert.equal(runtimeRow(), undefined);
});
