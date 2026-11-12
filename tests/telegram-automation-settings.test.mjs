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
const replacementChatToken = '99887766:EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE';
const channelId = '-1001234567890';
const groupId = '-1001234567891';
const otherGroupId = '-1001234567892';
const promotionMessage = 'New offers from the directory.';
const welcomeMessage = '欢迎加入群组！';
const privateStartMessage = '欢迎私聊，请浏览最新优惠。';
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
  ...['auth-core', 'brand-links', 'directory', 'image-media', 'image-url', 'sqlite', 'telegram-background', 'telegram-brand-card', 'telegram-promotions'].map(name => `app/lib/${name}`),
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
exports.channelAdmin = true;
exports.telegramRequest = async (token, method, parameters = {}) => {
  exports.calls.push({ token, method, parameters });
  if (method === 'getMe') {
    const id = Number(token.split(':')[0]);
    const username = id === 12345678 ? 'FreeBonus365Bot' : [87654321, 99887766].includes(id) ? 'FreeBonus365ChatBot' : 'OtherBot';
    return { ok: true, result: { is_bot: true, id, username } };
  }
  if (method === 'getWebhookInfo') return { ok: true, result: { url: exports.webhookUrl } };
  const id = targets.get(parameters.chat_id) ?? parameters.chat_id;
  if (method === 'getChat') {
    return { ok: true, result: { id, type: id === ${channelId} ? 'channel' : 'supergroup' } };
  }
  if (method === 'getChatMember') {
    if (id === ${channelId}) return { ok: true, result: {
      status: exports.channelAdmin ? 'administrator' : 'member', can_post_messages: token.startsWith('12345678:'),
    } };
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
  telegram.channelAdmin = true;
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
  database.prepare(`INSERT INTO telegram_welcome_state (id, revision, next_offset, last_polled_at, sent, keyword_replies, private_replies, last_error)
    VALUES ('primary', ?, 73, 12345678, 2, 4, 6, 'fixture state')
    ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, next_offset = excluded.next_offset,
      last_polled_at = excluded.last_polled_at, sent = excluded.sent, keyword_replies = excluded.keyword_replies,
      private_replies = excluded.private_replies, last_error = excluded.last_error`).run(revision);
  return runtimeRow();
}

const channel = { enabled: true, chatId: channelId };
const welcome = { enabled: true, chatId: groupId, message: welcomeMessage };
const keywordChatBot = { token: chatToken, keywordEnabled: true };
const bothBots = { ...channel, token: promotionToken, promotionMessage, welcome, chatBot: keywordChatBot };
const privateChat = { privateEnabled: true, privateStartMessage };
const initialChatStatus = {
  hasToken: false, keywordEnabled: false, keywordReplies: 0,
  privateEnabled: false, privateStartMessage: '', privateReplies: 0,
  followup: { enabled: false, message: '', delayMinutes: 60, counts: { pending: 0, sent: 0, failed: 0, unknown: 0, cancelled: 0 }, lastError: '' },
};
const keywordChatStatus = { ...initialChatStatus, hasToken: true, keywordEnabled: true };

test('Telegram settings reject invalid nested shapes and unknown fields before transport or persistence', async () => {
  const base = { enabled: false, chatId: '' };
  const before = settingsRow();
  for (const invalid of [
    { ...base, enabled: 'false' },
    { ...base, chatId: 123 },
    { ...base, token: 'a'.repeat(161) },
    { ...base, promotionMessage: 'a'.repeat(2_001) },
    { ...base, token_ciphertext: 'must-not-overwrite' },
    { ...base, welcome: [] },
    { ...base, welcome: { enabled: false, chatId: '', message: '', unknown: true } },
    { ...base, welcome: { enabled: 'false', chatId: '', message: '' } },
    { ...base, welcome: { enabled: false, chatId: 'a'.repeat(81), message: '' } },
    { ...base, welcome: { enabled: false, chatId: '', message: 'a'.repeat(2_001) } },
    { ...base, chatBot: null },
    { ...base, chatBot: { keywordEnabled: false, unknown: true } },
    { ...base, chatBot: { keywordEnabled: 0 } },
    { ...base, chatBot: { keywordEnabled: false, privateEnabled: 'true' } },
    { ...base, chatBot: { keywordEnabled: false, privateStartMessage: 'a'.repeat(2_001) } },
    { ...base, chatBot: { keywordEnabled: false, followup: null } },
    { ...base, chatBot: { keywordEnabled: false, followup: { enabled: 'true', message: 'Reply' } } },
    { ...base, chatBot: { keywordEnabled: false, followup: { enabled: false, message: 'a'.repeat(2_001) } } },
    { ...base, chatBot: { keywordEnabled: false, followup: { enabled: false, message: '', delayMinutes: 1 } } },
  ]) {
    await put(invalid, 400);
    assert.deepEqual(settingsRow(), before, 'schema rejection must not mutate saved settings');
    assert.equal(telegram.calls.length, 0, 'schema rejection must not contact Telegram');
  }
  const valid = await put({
    ...base, promotionMessage: `  ${'a'.repeat(2_000)}  `,
    welcome: { enabled: false, chatId: '', message: '' },
    chatBot: { keywordEnabled: false, privateEnabled: false, privateStartMessage: '' },
  });
  assert.equal(valid.promotionMessage, 'a'.repeat(2_000), 'trim before applying the maximum length');
  assert.equal(valid.chatBot.privateEnabled, false);
  assert.equal(telegram.calls.length, 0);
});

test('the channel and chat group use different bot identities and settings never expose either token', async () => {
  const initial = await get();
  assert.equal(initial.enabled, false);
  assert.equal(initial.hasToken, false);
  assert.deepEqual(initial.welcome, { enabled: false, chatId: '', message: '', sent: 0, lastPolledAt: null, lastError: '' });
  assert.deepEqual(initial.chatBot, initialChatStatus);

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
  assert.deepEqual(both.chatBot, keywordChatStatus);
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
  assert.deepEqual(saved.chatBot, keywordChatStatus);
  assert.ok(telegram.calls.every(call => call.token === chatToken));
  assert.ok(telegram.calls.some(call => call.method === 'getWebhookInfo'));
  assert.ok(telegram.calls.some(call => call.method === 'getChatMember'));
});

test('private chat can be enabled without a group, welcome messages, or the promotion bot', async () => {
  const config = { enabled: false, chatId: '', chatBot: { token: chatToken, keywordEnabled: false, ...privateChat } };
  telegram.webhookUrl = 'https://existing-webhook.example/private-webhook';
  const blocked = await put(config, 400);
  assert.match(blocked.error, /Webhook/);
  assert.ok(!blocked.error.includes(telegram.webhookUrl));
  assert.deepEqual((await get()).chatBot, initialChatStatus);

  telegram.webhookUrl = '';
  telegram.calls.length = 0;
  const saved = await put(config);
  assert.equal(saved.hasToken, false);
  assert.equal(saved.welcome.enabled, false);
  assert.equal(saved.welcome.chatId, '');
  assert.deepEqual(saved.chatBot, { ...initialChatStatus, hasToken: true, ...privateChat });
  assert.ok(telegram.calls.every(call => call.token === chatToken));
  assert.deepEqual(telegram.calls.map(call => call.method).sort(), ['getMe', 'getWebhookInfo']);
  assert.ok(settingsRow().private_started_at > 0);
});

test('channel welcome requires private chat, channel administration and disabled group keyword replies', async () => {
  const channelWelcome = { ...welcome, chatId: channelId };
  const config = { enabled: false, chatId: '', welcome: channelWelcome, chatBot: { token: chatToken, keywordEnabled: false, ...privateChat } };
  const privateOff = await put({ ...config, chatBot: { ...config.chatBot, privateEnabled: false } }, 400);
  assert.match(privateOff.error, /需要 Telegram 群组|私聊/);

  telegram.channelAdmin = false;
  const noAdmin = await put(config, 400);
  assert.match(noAdmin.error, /频道.*管理员/);
  telegram.channelAdmin = true;

  const saved = await put(config);
  assert.deepEqual(saved.welcome, { ...channelWelcome, sent: 0, lastPolledAt: null, lastError: '' });
  assert.deepEqual(saved.chatBot, { ...initialChatStatus, hasToken: true, ...privateChat });
  const keywordOn = await put({ enabled: false, chatId: '', chatBot: { keywordEnabled: true } }, 400);
  assert.match(keywordOn.error, /群组/);
  const disablePrivate = await put({ enabled: false, chatId: '', chatBot: { keywordEnabled: false, privateEnabled: false } }, 400);
  assert.match(disablePrivate.error, /需要 Telegram 群组|私聊/);
  assert.deepEqual(await get(), saved);
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

test('legacy saves and template edits preserve chat features and their delivery progress', async () => {
  await put({ ...bothBots, chatBot: { ...keywordChatBot, ...privateChat } });
  const original = settingsRow();
  const runtime = recordChatProgress(original.welcome_revision);

  const legacy = await put(channel);
  assert.equal(legacy.promotionMessage, promotionMessage);
  assert.deepEqual(legacy.welcome, { ...welcome, sent: 2, lastPolledAt: 12345678, lastError: 'fixture state' });
  assert.deepEqual(legacy.chatBot, { ...keywordChatStatus, ...privateChat, keywordReplies: 4, privateReplies: 6 });
  assert.deepEqual(settingsRow(), original);

  const updated = await put({
    ...bothBots, promotionMessage: 'Updated promotion template.',
    welcome: { ...welcome, message: '欢迎来到我们的新群组！' },
  });
  assert.equal(updated.promotionMessage, 'Updated promotion template.');
  assert.equal(updated.welcome.message, '欢迎来到我们的新群组！');
  assert.deepEqual(updated.chatBot, legacy.chatBot);
  const saved = settingsRow();
  assert.equal(saved.token_ciphertext, original.token_ciphertext);
  assert.equal(saved.chat_bot_token_ciphertext, original.chat_bot_token_ciphertext);
  assert.equal(saved.welcome_revision, original.welcome_revision);
  assert.equal(saved.welcome_started_at, original.welcome_started_at);
  assert.equal(saved.keyword_started_at, original.keyword_started_at);
  assert.equal(saved.private_started_at, original.private_started_at);
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

test('independent token rotations preserve the other bot and clear contacts only on a different ChatBot identity', async () => {
  await put({ ...bothBots, chatBot: { ...keywordChatBot, ...privateChat } });
  const first = settingsRow();
  const runtime = recordChatProgress(first.welcome_revision);
  database.prepare('INSERT INTO telegram_private_contacts (user_id) VALUES (?)').run(14321098765);
  const contacts = () => database.prepare('SELECT user_id FROM telegram_private_contacts ORDER BY user_id').all().map(row => row.user_id);

  await put({ ...channel, token: rotatedPromotionToken });
  const updatedPromotion = settingsRow();
  assert.notEqual(updatedPromotion.token_ciphertext, first.token_ciphertext);
  assert.equal(updatedPromotion.chat_bot_token_ciphertext, first.chat_bot_token_ciphertext);
  assert.equal(updatedPromotion.welcome_revision, first.welcome_revision);
  assert.equal(updatedPromotion.welcome_started_at, first.welcome_started_at);
  assert.equal(updatedPromotion.keyword_started_at, first.keyword_started_at);
  assert.equal(updatedPromotion.private_started_at, first.private_started_at);
  assert.deepEqual(runtimeRow(), runtime);
  assert.deepEqual(contacts(), [14321098765]);

  const updated = await put({ ...channel, chatBot: { token: rotatedChatToken, keywordEnabled: true } });
  const updatedChat = settingsRow();
  assert.notEqual(updatedChat.chat_bot_token_ciphertext, updatedPromotion.chat_bot_token_ciphertext);
  assert.equal(updatedChat.token_ciphertext, updatedPromotion.token_ciphertext);
  assert.notEqual(updatedChat.welcome_revision, updatedPromotion.welcome_revision);
  assert.equal(updated.welcome.chatId, groupId);
  assert.equal(updated.welcome.sent, 0);
  assert.deepEqual(updated.chatBot, { ...keywordChatStatus, ...privateChat });
  assert.ok(!JSON.stringify(updated).includes('14321098765'));
  assert.equal(runtimeRow(), undefined);
  assert.deepEqual(contacts(), [14321098765]);

  recordChatProgress(updatedChat.welcome_revision);
  const replacement = await put({ ...channel, chatBot: { token: replacementChatToken, keywordEnabled: true } });
  const replacedChat = settingsRow();
  assert.notEqual(replacedChat.chat_bot_token_ciphertext, updatedChat.chat_bot_token_ciphertext);
  assert.equal(replacedChat.token_ciphertext, updatedPromotion.token_ciphertext);
  assert.notEqual(replacedChat.welcome_revision, updatedChat.welcome_revision);
  assert.deepEqual(replacement.chatBot, { ...keywordChatStatus, ...privateChat });
  assert.equal(runtimeRow(), undefined);
  assert.deepEqual(contacts(), []);
});

test('unmatched followup requires private chat and a nonempty template, then saves without a group', async () => {
  const base = { enabled: false, chatId: '', chatBot: { token: chatToken, keywordEnabled: false, privateEnabled: true } };
  const missingPrivate = await put({ ...base, chatBot: { ...base.chatBot, privateEnabled: false, followup: { enabled: true, message: 'Can we help?' } } }, 400);
  assert.match(missingPrivate.error, /私聊/);
  const missingText = await put({ ...base, chatBot: { ...base.chatBot, followup: { enabled: true, message: '  ' } } }, 400);
  assert.match(missingText.error, /文案/);
  assert.equal(telegram.calls.length, 0);
  const configured = await put({ ...base, chatBot: { ...base.chatBot, followup: { enabled: true, message: '  Can we help?  ' } } });
  assert.deepEqual(configured.chatBot.followup, { ...initialChatStatus.followup, enabled: true, message: 'Can we help?' });
  const saved = settingsRow();
  assert.equal(saved.private_followup_enabled, 1);
  assert.ok(saved.private_followup_started_at > 0);
  assert.ok(saved.private_followup_revision);
  assert.deepEqual(telegram.calls.map(call => call.method).sort(), ['getMe', 'getWebhookInfo']);
});

test('legacy saves preserve followup settings and cursor while template edits cancel only waiting followups', async () => {
  const base = { enabled: false, chatId: '', chatBot: { token: chatToken, keywordEnabled: false, privateEnabled: true, followup: { enabled: true, message: 'First followup.' } } };
  await put(base);
  const first = settingsRow();
  const progress = recordChatProgress(first.welcome_revision);
  const insert = database.prepare("INSERT INTO telegram_private_followups(chat_id,revision,settings_revision,customer_update_id,due_at,next_attempt_at,status,lease_id,lease_until) VALUES(?,?,?,?,?,?,?,?,?)");
  insert.run(123456701, 'row-one', first.private_followup_revision, 50, 1234, 1234, 'pending', '', 0);
  insert.run(123456702, 'row-two', first.private_followup_revision, 51, 1234, 1234, 'sending', 'lease', 9999);
  insert.run(123456703, 'row-three', first.private_followup_revision, 52, 1234, 1234, 'sent', '', 0);
  const unchanged = await put({ enabled: false, chatId: '' });
  assert.deepEqual(settingsRow(), first);
  assert.equal(unchanged.chatBot.followup.counts.pending, 2);
  assert.equal(unchanged.chatBot.followup.counts.sent, 1);
  assert.deepEqual(runtimeRow(), progress);
  const updated = await put({ enabled: false, chatId: '', chatBot: { keywordEnabled: false, followup: { enabled: true, message: 'New followup.' } } });
  const current = settingsRow();
  assert.notEqual(current.private_followup_revision, first.private_followup_revision);
  assert.equal(current.chat_bot_token_ciphertext, first.chat_bot_token_ciphertext);
  assert.equal(current.welcome_revision, first.welcome_revision);
  assert.deepEqual(runtimeRow(), progress);
  assert.deepEqual(database.prepare('SELECT status,lease_id,lease_until,next_attempt_at FROM telegram_private_followups ORDER BY chat_id').all().map(row => ({...row})), [
    { status: 'cancelled', lease_id: '', lease_until: 0, next_attempt_at: 0 },
    { status: 'cancelled', lease_id: '', lease_until: 0, next_attempt_at: 0 },
    { status: 'sent', lease_id: '', lease_until: 0, next_attempt_at: 1234 },
  ]);
  assert.equal(updated.chatBot.followup.counts.cancelled, 2);
  assert.equal(JSON.stringify(updated).includes('123456701'), false);
  assert.equal(JSON.stringify(updated).includes('row-one'), false);
  const disabled = await put({ enabled: false, chatId: '', chatBot: { keywordEnabled: false, privateEnabled: false } });
  assert.equal(disabled.chatBot.followup.enabled, false, 'legacy clients can still disable private chat');
  assert.equal(settingsRow().private_followup_started_at, 0);
  assert.equal(disabled.chatBot.followup.message, 'New followup.');
});

test('followup status exposes aggregates only and token rotation cancels pending work', async () => {
  const base = { enabled: false, chatId: '', chatBot: { token: chatToken, keywordEnabled: false, privateEnabled: true, followup: { enabled: true, message: 'Followup.' } } };
  await put(base);
  const first = settingsRow();
  database.prepare("INSERT INTO telegram_private_followups(chat_id,settings_revision,status,last_error) VALUES(?,?,?,?)").run(234567891, first.private_followup_revision, 'unknown', 'Telegram 未确认发送结果。');
  database.prepare("INSERT INTO telegram_private_followups(chat_id,settings_revision,status) VALUES(?,?,?)").run(234567892, first.private_followup_revision, 'pending');
  const status = await get();
  assert.deepEqual(status.chatBot.followup.counts, { pending: 1, sent: 0, failed: 0, unknown: 1, cancelled: 0 });
  assert.equal(status.chatBot.followup.lastError, 'Telegram 未确认发送结果。');
  for (const sensitive of ['234567891','234567892',first.chat_bot_token_ciphertext,chatToken]) assert.equal(JSON.stringify(status).includes(sensitive), false);
  const rotated = await put({ enabled: false, chatId: '', chatBot: { token: rotatedChatToken, keywordEnabled: false } });
  assert.notEqual(settingsRow().private_followup_revision, first.private_followup_revision);
  assert.equal(rotated.chatBot.followup.enabled, true);
  assert.equal(rotated.chatBot.followup.counts.pending, 0);
  assert.equal(rotated.chatBot.followup.counts.cancelled, 1);
});
