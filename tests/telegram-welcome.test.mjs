import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

const fixture = mkdtempSync(path.join(tmpdir(), 'directory-telegram-welcome-'));
writeFileSync(path.join(fixture, 'package.json'), '{"type":"commonjs"}');
for (const name of ['sqlite', 'telegram-bot', 'telegram-keywords', 'telegram-welcome']) {
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
const privateChatId = 701;
const revision = 'welcome-revision';
const group = 'Public <Group>';
const token = 'fixture-chat-token';
const ciphertext = 'fixture-chat-ciphertext';
const promotionToken = 'fixture-promotion-token';
const promotionCiphertext = 'fixture-promotion-ciphertext';
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

function configureWelcome({
  enabled = true, message = 'Welcome {name} to {group}!', chatCiphertext = ciphertext, groupChatId = chatId,
} = {}) {
  getSqlite().prepare(`INSERT INTO telegram_promotion_settings (
    id, enabled, chat_id, token_ciphertext, chat_bot_token_ciphertext, welcome_enabled,
    welcome_chat_id, welcome_message, welcome_started_at, welcome_revision
  ) VALUES ('primary', 0, '', ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET welcome_enabled = excluded.welcome_enabled,
    welcome_chat_id = excluded.welcome_chat_id, welcome_message = excluded.welcome_message,
    chat_bot_token_ciphertext = excluded.chat_bot_token_ciphertext`)
    .run(promotionCiphertext, chatCiphertext, Number(enabled), String(groupChatId), message, cutoff, revision);
}

function configureKeywords(rules, startedAt = cutoff, enabled = true) {
  const db = getSqlite();
  db.prepare("UPDATE telegram_promotion_settings SET keyword_enabled = ?, keyword_started_at = ? WHERE id = 'primary'").run(Number(enabled), startedAt);
  const insert = db.prepare('INSERT INTO telegram_keyword_rules (keyword, keyword_key, match_mode, response, show_button) VALUES (?, ?, ?, ?, ?)');
  for (const [keyword, mode, response, showButton = true] of rules) insert.run(keyword, keyword, mode, response, Number(showButton));
}

function configurePrivate({ enabled = true, startMessage = 'Choose a topic' } = {}) {
  getSqlite().prepare(`UPDATE telegram_promotion_settings SET private_enabled = ?, private_started_at = ?,
    private_start_message = ? WHERE id = 'primary'`).run(Number(enabled), cutoff, startMessage);
}

function privateContacts() {
  return getSqlite().prepare('SELECT user_id FROM telegram_private_contacts ORDER BY user_id').all().map(row => row.user_id);
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
  const decrypt = value => value === ciphertext ? token : value === promotionCiphertext ? promotionToken : '';
  return pollTelegramWelcomeOnce(decrypt, () => time);
}

function groupMessage(updateId, {
  id = chatId, date = now / 1_000, text = 'bonus', bot = false, ...extra
} = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 1_000, chat: { id, type: 'supergroup', title: group },
      from: { id: 501, is_bot: bot, first_name: 'Ada' }, date, text, ...extra,
    },
  };
}

function membership(updateId, {
  id = chatId, type = 'supergroup', userId = 500, date = now / 1_000, firstName = 'Ada', lastName = 'Lovelace',
  bot = false, oldStatus = 'left', newStatus = 'member',
} = {}) {
  const user = { id: userId, is_bot: bot, first_name: firstName, last_name: lastName };
  return {
    update_id: updateId,
    chat_member: {
      date, chat: { id, type, title: group },
      old_chat_member: { status: oldStatus, user },
      new_chat_member: { status: newStatus, user },
    },
  };
}

function privateMessage(updateId, { id = privateChatId, fromId = id, text = '/start' } = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 1_000, date: now / 1_000, text,
      chat: { id, type: 'private' }, from: { id: fromId, is_bot: false, first_name: 'Ada' },
    },
  };
}

function privateCallback(updateId, data, fromId = privateChatId) {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`, data,
      from: { id: fromId, is_bot: false, first_name: 'Ada' },
      message: { message_id: 1_400, date: now / 1_000, chat: { id: privateChatId, type: 'private' } },
    },
  };
}

function mockTransport(t, updates, sends, { chatIds = [chatId] } = {}) {
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
    assert.ok(chatIds.includes(Number(params.chat_id)), `Unexpected chat ${params.chat_id}`);
    assert.equal(params.parse_mode, undefined);
    return take(sends, method, params);
  });
  return {
    offsets: () => poll.mock.calls.map(call => call.arguments[1]),
    messages: () => send.mock.calls.map(call => call.arguments[2].text),
    parameters: () => send.mock.calls.map(call => call.arguments[2]),
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

test('welcome and keyword replies share a cursor and select one matching rule per original group message', async t => {
  configureWelcome();
  configureKeywords([
    ['bonus', 'contains', 'Short match'],
    ['bonus', 'exact', '<Exact> & reply'],
    ['free bonus', 'contains', 'Long match'],
    ['gold', 'contains', 'Earlier rule'],
    ['deal', 'contains', 'Later rule'],
  ], cutoff + 5);
  const exact = groupMessage(210, { text: '  ＢＯＮＵＳ  ', message_thread_id: 26 });
  const batch = [
    exact, membership(200, { date: cutoff }),
    groupMessage(201, { id: chatId - 1 }), groupMessage(202, { bot: true }),
    groupMessage(203, { forward_origin: { type: 'user' } }),
    groupMessage(204, { via_bot: { id: 503, is_bot: true } }),
    groupMessage(205, { sender_chat: { id: chatId, type: 'supergroup' } }),
    groupMessage(206, { date: cutoff + 1 }), groupMessage(207, { text: null, caption: 'bonus' }),
    { update_id: 208, edited_message: groupMessage(208).message },
    groupMessage(209, { text: 'No matching text' }), exact,
    groupMessage(211, { text: 'Try a FREE BONUS today', is_topic_message: true, message_thread_id: 27 }),
    groupMessage(212, { text: 'A deal with gold', message_thread_id: -1 }),
  ];
  const requests = mockTransport(t, [ok(batch)], Array(4).fill(successfulSend));

  await tick();
  assert.deepEqual(requests.offsets(), [0]);
  assert.deepEqual(requests.messages(), [`Welcome Ada Lovelace to ${group}!`, '<Exact> & reply', 'Long match', 'Earlier rule']);
  const [welcome, ...replies] = requests.parameters();
  assert.equal(welcome.reply_parameters, undefined);
  assert.deepEqual(replies.map(reply => reply.reply_parameters), [1210, 1211, 1212].map(message_id => ({
    message_id, allow_sending_without_reply: false,
  })));
  assert.deepEqual(replies.map(reply => reply.message_thread_id), [undefined, 27, undefined]);
  assert.equal(state().sent, 1);
  assert.equal(state().keyword_replies, 3);
  assert.equal(state().next_offset, 213);
});

test('keyword-only polling uses the chat token and does not retry an ambiguous reply after reopening SQLite', async t => {
  configureWelcome({ enabled: false, chatCiphertext: '' });
  configureKeywords([
    ['bonus', 'exact', 'Bonus reply'],
    ['support', 'exact', 'Support reply'],
  ]);
  const first = groupMessage(301);
  const second = groupMessage(302, { text: 'support' });
  const requests = mockTransport(t, [ok([membership(300), first]), ok([first, second])], [null, successfulSend]);

  await tick();
  assert.deepEqual(requests.offsets(), [], 'the promotion token must not substitute for a missing chat token');
  configureWelcome({ enabled: false });
  await tick();
  assert.equal(state().next_offset, 302);
  assert.equal(state().keyword_replies, 0);
  closeDatabase();

  await tick(now + minute);
  assert.deepEqual(requests.offsets(), [0, 302]);
  assert.deepEqual(requests.messages(), ['Bonus reply', 'Support reply']);
  assert.deepEqual(requests.parameters().map(reply => reply.reply_parameters.message_id), [1301, 1302]);
  assert.equal(state().sent, 0);
  assert.equal(state().keyword_replies, 1);
  assert.equal(state().next_offset, 303);
});

test('private-only polling answers start, menu navigation, and keywords with group features off', async t => {
  configureWelcome({ enabled: false, groupChatId: '' });
  configurePrivate();
  configureKeywords(Array.from({ length: 10 }, (_, index) => {
    const id = index + 1;
    return [`topic ${id}`, 'exact', `Answer ${id}`];
  }), cutoff, false);
  const batch = [
    privateMessage(400, { text: '/start welcome' }),
    privateCallback(401, 'dm:page:1'), privateCallback(402, 'dm:rule:9'),
    privateCallback(403, 'dm:rule:999'), privateCallback(404, 'dm:rule:9', privateChatId + 1),
    privateMessage(405, { text: 'TOPIC 1' }), privateMessage(406, { text: '/menu' }),
    privateMessage(407, { id: privateChatId + 1, fromId: privateChatId + 2, text: 'topic 1' }),
  ];
  const requests = mockTransport(t, [ok(batch)], Array(5).fill(successfulSend), { chatIds: [privateChatId] });
  const callback = t.mock.method(transport, 'answerTelegramCallback', async (actualToken, queryId) => {
    assert.equal(actualToken, token);
    assert.ok(queryId);
    return true;
  });

  await tick();
  const [menu, nextPage, selectedRule, keywordReply, menuAgain] = requests.parameters();
  const buttonData = payload => payload.reply_markup.inline_keyboard.flat().map(button => button.callback_data);
  assert.match(menu.text, /Choose a topic/);
  assert.deepEqual(buttonData(menu), [...Array.from({ length: 8 }, (_, index) => `dm:rule:${index + 1}`), 'dm:page:1']);
  assert.deepEqual(buttonData(nextPage), ['dm:rule:9', 'dm:rule:10', 'dm:page:0']);
  assert.equal(selectedRule.text, 'Answer 9');
  assert.equal(keywordReply.text, 'Answer 1');
  assert.deepEqual(buttonData(selectedRule), ['dm:page:0']);
  assert.deepEqual(buttonData(keywordReply), ['dm:page:0']);
  assert.deepEqual(buttonData(menuAgain), buttonData(menu));
  assert.deepEqual(callback.mock.calls.map(call => call.arguments[1]), ['callback-401', 'callback-402', 'callback-403']);
  assert.deepEqual(privateContacts(), [privateChatId]);
  assert.deepEqual(requests.offsets(), [0]);
  assert.equal(state().private_replies, 5);
  assert.equal(state().next_offset, 408);
});

test('known group joiners receive a DM and a rejected DM clears the contact for subsequent joins', async t => {
  configureWelcome();
  configurePrivate();
  configureKeywords([['bonus', 'exact', 'Bonus reply']]);
  const batch = [
    privateMessage(500, { text: 'Hi' }), membership(501, { userId: privateChatId }),
    membership(502, { userId: privateChatId + 1 }), membership(503, { userId: privateChatId }),
    membership(504, { userId: privateChatId }), membership(505, { userId: privateChatId + 2, bot: true }),
  ];
  const forbidden = { ok: false, code: 403, retryAfter: 0 };
  const requests = mockTransport(t, [ok(batch), ok(batch)], [successfulSend, successfulSend, forbidden, successfulSend], { chatIds: [privateChatId, chatId] });

  await tick();
  const sent = requests.parameters();
  assert.deepEqual(sent.map(reply => Number(reply.chat_id)), [privateChatId, chatId, privateChatId, chatId]);
  assert.ok(sent[0].reply_markup.inline_keyboard.flat().some(button => button.callback_data === 'dm:page:0'));
  for (const reply of [sent[1], sent[3]]) {
    assert.ok(reply.reply_markup.inline_keyboard.flat().some(button => button.url === 'https://t.me/FreeBonus365ChatBot?start=welcome'));
  }
  assert.deepEqual(privateContacts(), []);
  assert.equal(state().sent, 3);
  assert.equal(state().private_replies, 0);

  closeDatabase();
  await tick(now + minute);
  assert.deepEqual(requests.offsets(), [0, 506]);
  assert.equal(requests.messages().length, 4);
  assert.deepEqual(privateContacts(), []);
});

test('channel joins send only to known private contacts with both features enabled', async t => {
  const channelId = chatId - 10;
  configureWelcome({ groupChatId: channelId });
  configurePrivate();
  configureKeywords([['bonus', 'exact', 'Bonus reply']]);
  const channelJoin = (updateId, userId) => membership(updateId, { id: channelId, type: 'channel', userId });
  const requests = mockTransport(t, [ok([
    privateMessage(600, { text: 'Hi' }), channelJoin(601, privateChatId + 1), channelJoin(602, privateChatId),
  ]), ok([channelJoin(603, privateChatId)])], [successfulSend], { chatIds: [privateChatId] });

  await tick();
  assert.deepEqual(requests.parameters().map(reply => Number(reply.chat_id)), [privateChatId]);
  assert.ok(requests.parameters()[0].reply_markup.inline_keyboard.flat().some(button => button.callback_data === 'dm:page:0'));
  assert.equal(state().sent, 1);
  assert.deepEqual(privateContacts(), [privateChatId]);
  configurePrivate({ enabled: false });
  await tick(now + minute);
  assert.equal(requests.messages().length, 1);
});

test('private menus paginate only button rules while both modes still reply to typed keywords', async t => {
  configureWelcome();
  configurePrivate();
  configureKeywords(Array.from({ length: 20 }, (_, index) => [
    `topic ${index + 1}`, 'exact', `Answer ${index + 1}`, index % 2 === 1,
  ]));
  const requests = mockTransport(t, [ok([
    privateMessage(800, { text: '/start' }), privateCallback(801, 'dm:page:1'),
    privateCallback(802, 'dm:rule:1'), privateCallback(803, 'dm:rule:18'),
    privateMessage(804, { text: 'topic 1' }), groupMessage(805, { text: 'topic 1' }),
    privateMessage(806, { text: 'topic 2' }),
  ])], Array(6).fill(successfulSend), { chatIds: [privateChatId, chatId] });
  const acknowledged = t.mock.method(transport, 'answerTelegramCallback', async () => true);
  await tick();
  const [menu, secondPage, buttonAnswer, hiddenAnswer, groupAnswer, typedButtonAnswer] = requests.parameters();
  const buttons = payload => payload.reply_markup.inline_keyboard.flat().map(button => button.callback_data);
  assert.deepEqual(buttons(menu), [...Array.from({ length: 8 }, (_, index) => `dm:rule:${(index + 1) * 2}`), 'dm:page:1']);
  assert.deepEqual(buttons(secondPage), ['dm:rule:18', 'dm:rule:20', 'dm:page:0']);
  assert.equal(buttonAnswer.text, 'Answer 18');
  assert.equal(hiddenAnswer.text, 'Answer 1');
  assert.equal(hiddenAnswer.reply_markup, undefined, 'text-only replies do not attach a return button');
  assert.equal(groupAnswer.text, 'Answer 1');
  assert.equal(groupAnswer.reply_markup, undefined);
  assert.equal(typedButtonAnswer.text, 'Answer 2');
  assert.deepEqual(buttons(typedButtonAnswer), ['dm:page:0']);
  assert.equal(acknowledged.mock.calls.length, 3, 'hidden stale callback is still acknowledged');
  assert.equal(state().private_replies, 5);
  assert.equal(state().keyword_replies, 1);
});

test('text-only private rules keep exact matching priority and never create an empty button menu', async t => {
  configureWelcome();
  configurePrivate({ startMessage: '' });
  configureKeywords([
    ['bonus', 'exact', 'Private exact reply', false],
    ['bon', 'contains', 'Private contains reply', false],
  ]);
  const requests = mockTransport(t, [ok([
    privateMessage(900, { text: '/start' }), privateMessage(901, { text: '/menu' }),
    membership(902, { userId: privateChatId }), privateMessage(903, { text: 'bonus' }),
    privateCallback(904, 'dm:rule:1'), groupMessage(905, { text: 'bonus' }),
  ])], Array(5).fill(successfulSend), { chatIds: [privateChatId, chatId] });
  const acknowledged = t.mock.method(transport, 'answerTelegramCallback', async () => true);
  await tick();
  const replies = requests.parameters();
  assert.equal(replies.length, 5);
  assert.match(replies[0].text, /输入关键词/);
  assert.match(replies[1].text, /输入关键词/);
  assert.match(replies[2].text, /^Welcome/);
  assert.equal(replies[3].text, 'Private exact reply');
  assert.equal(replies[4].text, 'Private exact reply');
  assert.ok(replies.every(reply => reply.reply_markup === undefined));
  assert.equal(acknowledged.mock.calls.length, 1);
  assert.equal(state().sent, 1);
  assert.equal(state().private_replies, 3);
});

test('a rule hidden while its old button callback is being acknowledged does not send a queued answer', async t => {
  configureWelcome({ enabled: false });
  configurePrivate();
  configureKeywords([['bonus', 'exact', 'Do not send after hiding']], cutoff, false);
  const requests = mockTransport(t, [ok([privateCallback(1000, 'dm:rule:1')])], [], { chatIds: [privateChatId] });
  t.mock.method(transport, 'answerTelegramCallback', async () => {
    getSqlite().prepare('UPDATE telegram_keyword_rules SET show_button=0 WHERE id=1').run();
    return true;
  });
  await tick();
  assert.deepEqual(requests.messages(), []);
  assert.equal(state().private_replies, 0);
});
