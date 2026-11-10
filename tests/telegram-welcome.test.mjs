import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

const fixture = mkdtempSync(path.join(tmpdir(), 'directory-telegram-welcome-'));
writeFileSync(path.join(fixture, 'package.json'), '{"type":"commonjs"}');
for (const name of ['sqlite', 'telegram-bot', 'telegram-welcome']) {
  const source = readFileSync(new URL(`../app/lib/${name}.ts`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  writeFileSync(path.join(fixture, `${name}.js`), outputText);
}
const require = createRequire(import.meta.url);
const transport = require(path.join(fixture, 'telegram-bot.js'));
const { pollTelegramWelcomeOnce } = require(path.join(fixture, 'telegram-welcome.js'));
const { getSqlite } = require(path.join(fixture, 'sqlite.js'));

const previousDataDir = process.env.DATA_DIR;
const now = 1_800_000_000_000;
const minute = 60_000;
const cutoff = now / 1_000 - 10;
const chatId = -1001234567890;
const revision = 'welcome-revision';
const group = 'Public <Group>';
const token = 'fixture-token';
const ciphertext = 'fixture-ciphertext';
const ok = result => ({ ok: true, result });
const limited = retryAfter => ({ ok: false, code: 429, retryAfter });
const successfulSend = ok({ message_id: 1 });

function closeDatabase() {
  const filename = path.join(process.env.DATA_DIR, 'directory.sqlite');
  const databases = globalThis.__directorySqlite;
  databases?.get(filename)?.close();
  databases?.delete(filename);
}

test.beforeEach(() => {
  process.env.DATA_DIR = mkdtempSync(path.join(fixture, 'case-'));
});
test.afterEach(() => closeDatabase());
test.after(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDataDir;
  rmSync(fixture, { recursive: true, force: true });
});

function configureWelcome({ enabled = true, message = 'Welcome {name} to {group}!' } = {}) {
  getSqlite().prepare(`INSERT INTO telegram_promotion_settings (
    id, enabled, chat_id, token_ciphertext, welcome_enabled,
    welcome_chat_id, welcome_message, welcome_started_at, welcome_revision
  ) VALUES ('primary', 0, '', ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET welcome_enabled = excluded.welcome_enabled,
    welcome_message = excluded.welcome_message`).run(ciphertext, Number(enabled), String(chatId), message, cutoff, revision);
}

function putState({ offset = 0, lastPoll = now, leaseId = '', leaseUntil = 0 } = {}) {
  getSqlite().prepare(`INSERT INTO telegram_welcome_state (
    id, revision, next_offset, last_polled_at, lease_id, lease_until
  ) VALUES ('primary', ?, ?, ?, ?, ?)`).run(revision, offset, lastPoll, leaseId, leaseUntil);
}

function state() {
  return getSqlite().prepare("SELECT * FROM telegram_welcome_state WHERE id = 'primary'").get();
}

function tick(time = now) {
  return pollTelegramWelcomeOnce(value => value === ciphertext ? token : '', () => time);
}

function membership(updateId, {
  id = chatId, date = now / 1_000, firstName = 'Ada', lastName = 'Lovelace',
  bot = false, oldStatus = 'left', newStatus = 'member',
} = {}) {
  const user = { id: 500, is_bot: bot, first_name: firstName, last_name: lastName };
  return {
    update_id: updateId,
    chat_member: {
      date, chat: { id, type: 'supergroup', title: group },
      old_chat_member: { status: oldStatus, user },
      new_chat_member: { status: newStatus, user },
    },
  };
}

function mockTransport(t, updates, sends) {
  const take = (queue, method, parameter) => {
    assert.ok(queue.length, `Unexpected ${method}`);
    const reply = queue.shift();
    return typeof reply === 'function' ? reply(parameter) : reply;
  };
  const poll = t.mock.method(transport, 'telegramUpdates', async (actualToken, offset) => {
    assert.equal(actualToken, token);
    return take(updates, 'getUpdates', offset);
  });
  const send = t.mock.method(transport, 'telegramRequest', async (actualToken, method, params) => {
    assert.equal(actualToken, token);
    assert.equal(method, 'sendMessage');
    assert.equal(String(params.chat_id), String(chatId));
    assert.equal(params.parse_mode, undefined);
    return take(sends, method, params);
  });
  return {
    offsets: () => poll.mock.calls.map(call => call.arguments[1]),
    messages: () => send.mock.calls.map(call => call.arguments[2].text),
  };
}

test('only matching human joins are welcomed once and their cursor survives reopening SQLite', async t => {
  configureWelcome();
  const first = membership(104, { date: cutoff, firstName: 'Ada <3' });
  const second = membership(109, { firstName: 'Grace', lastName: 'Hopper' });
  const batch = [second, first, membership(105, { id: chatId - 1 }),
    membership(106, { date: cutoff - 1 }), membership(107, { bot: true }),
    membership(108, { oldStatus: 'member', newStatus: 'administrator' }), first,
    membership(110, { oldStatus: 'member', newStatus: 'left' }), { update_id: 111, message: {} }];
  const claimed = [];
  const captureSend = () => { claimed.push(state().next_offset); return successfulSend; };
  const requests = mockTransport(t, [ok(batch), ok(batch), ok([])], [captureSend, captureSend]);

  await tick();
  assert.deepEqual(requests.messages(), [`Welcome Ada <3 Lovelace to ${group}!`, `Welcome Grace Hopper to ${group}!`]);
  assert.deepEqual(claimed, [105, 110], 'the cursor must be durable before each network send');
  assert.equal(state().next_offset, 112);
  assert.equal(state().sent, 2);

  closeDatabase();
  await tick(now + minute);
  assert.equal(state().sent, 2);
  assert.equal(state().next_offset, 112);
  await tick(now + 2 * minute);
  assert.deepEqual(requests.offsets(), [0, 112, 112]);
  assert.equal(requests.messages().length, 2);
  assert.equal(state().next_offset, 0, 'an empty acknowledged batch releases the old offset');
});

test('explicit fetch and send rate limits respect retry delays and retry only the rejected event', async t => {
  configureWelcome();
  putState({ offset: 17 });
  const batch = ok([membership(17), membership(18, { firstName: 'Grace', lastName: 'Hopper' })]);
  const requests = mockTransport(t, [limited(30), batch, batch], [successfulSend, limited(40), successfulSend]);

  await tick();
  assert.equal(state().next_offset, 17);
  const fetchRetryAt = state().next_poll_at;
  assert.ok(fetchRetryAt >= now + 30_000);
  await tick(fetchRetryAt - 1);
  assert.deepEqual(requests.offsets(), [17]);

  await tick(fetchRetryAt);
  assert.equal(state().next_offset, 18);
  assert.equal(state().sent, 1);
  const sendRetryAt = state().next_poll_at;
  assert.ok(sendRetryAt >= fetchRetryAt + 40_000);
  await tick(sendRetryAt - 1);
  assert.deepEqual(requests.offsets(), [17, 17]);

  await tick(sendRetryAt);
  assert.deepEqual(requests.offsets(), [17, 17, 18]);
  assert.deepEqual(requests.messages(), [`Welcome Ada Lovelace to ${group}!`, `Welcome Grace Hopper to ${group}!`, `Welcome Grace Hopper to ${group}!`]);
  assert.equal(state().next_offset, 19);
  assert.equal(state().sent, 2);
});

test('an ambiguous send result does not resend the same welcome after reopening SQLite', async t => {
  configureWelcome();
  const first = membership(55);
  const second = membership(56, { firstName: 'Grace', lastName: 'Hopper' });
  const requests = mockTransport(t, [ok([first]), ok([first, second])], [null, successfulSend]);

  await tick();
  assert.equal(state().next_offset, 56);
  assert.equal(state().sent, 0);
  assert.ok(state().last_error);
  closeDatabase();
  await tick(now + minute);
  assert.deepEqual(requests.offsets(), [0, 56]);
  assert.deepEqual(requests.messages(), [`Welcome Ada Lovelace to ${group}!`, `Welcome Grace Hopper to ${group}!`]);
  assert.equal(state().sent, 1);
});

test('disabled and leased polls skip transport and stale work cannot send after settings change', async t => {
  configureWelcome({ enabled: false });
  const requests = mockTransport(t, [
    () => {
      configureWelcome({ message: '{group}: {name}' });
      return ok([membership(20)]);
    },
    () => {
      const db = getSqlite();
      db.prepare("UPDATE telegram_promotion_settings SET welcome_revision = 'new-target' WHERE id = 'primary'").run();
      db.prepare("DELETE FROM telegram_welcome_state WHERE id = 'primary'").run();
      return ok([membership(21)]);
    },
  ], [successfulSend]);

  await tick();
  assert.deepEqual(requests.offsets(), []);
  configureWelcome();
  putState({ leaseId: 'other-worker', leaseUntil: now + minute });
  await tick(now + 1);
  assert.deepEqual(requests.offsets(), []);

  await tick(now + 2 * minute);
  assert.deepEqual(requests.messages(), [`${group}: Ada Lovelace`]);
  await tick(now + 3 * minute);
  assert.deepEqual(requests.offsets(), [0, 21]);
  assert.equal(requests.messages().length, 1);
  assert.equal(state(), undefined);
});

test('a cursor from an old polling session cannot discard a lower new update ID', async t => {
  configureWelcome();
  putState({ offset: 991, lastPoll: now - 8 * 24 * 60 * minute });
  const requests = mockTransport(t, [ok([membership(12)])], [successfulSend]);

  await tick();
  assert.deepEqual(requests.offsets(), [0]);
  assert.deepEqual(requests.messages(), [`Welcome Ada Lovelace to ${group}!`]);
  assert.equal(state().next_offset, 13);
});
