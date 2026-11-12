import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';

// Run the actual polling, matching, public visibility and delivery code against
// disposable SQLite. Only Telegram requests and local image I/O are substituted.
const fixture = mkdtempSync(path.join(tmpdir(), 'telegram-brand-search-'));
writeFileSync(path.join(fixture, 'package.json'), '{"type":"commonjs"}');
for (const name of [
  'auth-core', 'brand-links', 'directory', 'image-url', 'sqlite', 'telegram-bot',
  'telegram-keywords', 'telegram-followups', 'telegram-brand-card', 'telegram-brand-search', 'telegram-welcome',
]) {
  writeFileSync(path.join(fixture, `${name}.js`), ts.transpileModule(
    readFileSync(new URL(`../app/lib/${name}.ts`, import.meta.url), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } },
  ).outputText);
}
writeFileSync(path.join(fixture, 'image-media.js'), `
exports.MAX_IMAGE_BYTES = 5 * 1024 * 1024;
exports.beforeOpen = undefined;
exports.openImage = async () => {
  await exports.beforeOpen?.();
  const bytes = Buffer.from('fixture-image');
  return { size: bytes.length, mime: 'image/png', stream: new Response(bytes).body };
};
`);
writeFileSync(path.join(fixture, 'telegram-background.js'), 'exports.cleanTelegramBackground = async () => null;');

const require = createRequire(import.meta.url);
const transport = require(path.join(fixture, 'telegram-bot.js'));
const images = require(path.join(fixture, 'image-media.js'));
const { pollTelegramWelcomeOnce } = require(path.join(fixture, 'telegram-welcome.js'));
const { getSqlite } = require(path.join(fixture, 'sqlite.js'));
const previousEnv = Object.fromEntries(['APP_URL', 'DATA_DIR', 'ADMIN_PATH'].map(key => [key, process.env[key]]));
const origin = 'https://365freebonus.com';
const now = 1_800_000_000_000;
const hour = 3_600_000;
const privateId = 701;
const groupId = -1001234567890;
const ok = result => ({ ok: true, result });

test.beforeEach(() => {
  process.env.APP_URL = origin;
  process.env.DATA_DIR = mkdtempSync(path.join(fixture, 'case-'));
  process.env.ADMIN_PATH = '/fixture-admin';
  images.beforeOpen = undefined;
});
test.afterEach(() => {
  const filename = path.join(process.env.DATA_DIR, 'directory.sqlite');
  globalThis.__directorySqlite?.get(filename)?.close();
  globalThis.__directorySqlite?.delete(filename);
});
test.after(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(fixture, { recursive: true, force: true });
});

function configure({ privateEnabled = true, groupEnabled = false, followup = false } = {}) {
  getSqlite().prepare(`INSERT INTO telegram_promotion_settings
    (id,enabled,chat_id,token_ciphertext,chat_bot_token_ciphertext,welcome_enabled,welcome_chat_id,welcome_message,
      welcome_started_at,welcome_revision,keyword_enabled,keyword_started_at,private_enabled,private_started_at,
      private_start_message,private_followup_enabled,private_followup_message,private_followup_started_at,private_followup_revision)
    VALUES ('primary',0,'','','fixture-cipher',0,?,'',?,'fixture-revision',?,?,?,?,'Choose a topic',?,'Please tell us what you need.',?,'followup-revision')`)
    .run(String(groupId), now / 1000 - 10, Number(groupEnabled), now / 1000 - 10,
      Number(privateEnabled), now / 1000 - 10, Number(followup), now / 1000 - 10);
}

function brand({ id = 'bintang', name = 'Bintang44', slug = id, category = 'All', published = 1,
  publishAt = null, startsAt = null, expiresAt = null, imageUrl = '', sortOrder = 0 } = {}) {
  getSqlite().prepare(`INSERT INTO brands
    (id,name,slug,category,tagline,description,color,icon,image_url,published,sort_order,link,
      promotion_starts_at,promotion_expires_at,publish_at)
    VALUES (?,?,?,?,?,?,'#aabbcc','sparkles',?,?,?, ?,?,?,?)`)
    .run(id, name, slug, category, `Welcome to ${name}`, `Introduction for ${name}.`, imageUrl,
      published, sortOrder, `https://brands.example/${slug}`, startsAt, expiresAt, publishAt);
  return id;
}

function input(updateId, { text = 'bint', id = privateId, type = 'private', at = now, senderId = type === 'private' ? id : 801, ...extra } = {}) {
  return { update_id: updateId, message: {
    message_id: updateId + 1000, date: Math.floor(at / 1000), text, chat: { id, type },
    from: { id: senderId, is_bot: false }, ...extra,
  } };
}

function callback(updateId, data, { id = privateId, type = 'private', senderId = type === 'private' ? id : 801 } = {}) {
  return { update_id: updateId, callback_query: {
    id: `callback-${updateId}`, data, from: { id: senderId, is_bot: false },
    message: { message_id: updateId + 2000, date: now / 1000, chat: { id, type } },
  } };
}

function harness(t) {
  const calls = [], offsets = [], acknowledgments = [], polls = [], responses = [];
  let time = now;
  t.mock.method(transport, 'telegramUpdates', async (token, offset) => {
    assert.equal(token, 'fixture-token');
    offsets.push(offset);
    assert.ok(polls.length, 'unexpected polling request');
    return polls.shift();
  });
  t.mock.method(transport, 'telegramRequest', async (token, method, parameters, upload) => {
    assert.equal(token, 'fixture-token');
    calls.push({ method, parameters, upload });
    return responses.length ? responses.shift() : ok({ message_id: 10000 + calls.length, date: Math.floor(time / 1000) });
  });
  t.mock.method(transport, 'answerTelegramCallback', async (token, id) => {
    assert.equal(token, 'fixture-token'); acknowledgments.push(id); return true;
  });
  return { calls, offsets, acknowledgments, run: async (updates, { at = now, replies = [] } = {}) => {
    time = at; polls.push(ok(updates)); responses.push(...replies);
    await pollTelegramWelcomeOnce(() => 'fixture-token', () => time);
  } };
}

function buttons(call) { return call.parameters.reply_markup?.inline_keyboard.flat(); }
function assertCard(call, { name = 'Bintang44', slug = 'bintang' } = {}) {
  assert.match(call.parameters.text ?? call.parameters.caption, new RegExp(`Introduction for ${name}\\.`));
  assert.deepEqual(buttons(call), [
    { text: name, url: `${origin}/${slug}` },
    { text: '🌐 Visit website', url: `${origin}/` },
    { text: '🚀 Join Now', url: `https://brands.example/${slug}` },
  ]);
}

test('partial brand names and slugs match without a configured rule, ignoring case, width, spaces and punctuation', async t => {
  configure(); brand({ slug: 'bintang-44' }); const h = harness(t);
  for (const [index, text] of ['bint', 'BINTANG', 'ｂｉｎｔａｎｇ', 'Bintang 44', 'bintang-44'].entries()) {
    await h.run([input(index + 1, { text })]);
    assert.equal(h.calls.length, index + 1);
    assertCard(h.calls.at(-1), { slug: 'bintang-44' });
  }
});

test('configured exact and contains keyword replies take priority over automatic brand search', async t => {
  configure(); brand(); const h = harness(t); const db = getSqlite();
  db.prepare(`INSERT INTO telegram_keyword_rules(keyword,keyword_key,match_mode,response,show_button)
    VALUES ('bint','bint','exact','Owner exact reply',0),('tang','tang','contains','Owner contains reply',0)`).run();
  await h.run([input(1)]); await h.run([input(2, { text: 'bintang' })]);
  assert.deepEqual(h.calls.map(call => call.parameters.text), ['Owner exact reply', 'Owner contains reply']);
  assert.ok(h.calls.every(call => call.parameters.reply_markup === undefined));
});

test('All includes public All, Update, New and expired brands while drafts and future publications remain hidden', async t => {
  configure(); const h = harness(t);
  const variants = [
    { id: 'allbrand', category: 'All' },
    { id: 'updatedbrand', category: 'Update', expiresAt: now + hour },
    { id: 'newbrand', category: 'New', expiresAt: now + hour },
    { id: 'expiredbrand', category: 'Update', expiresAt: now - 1 },
    { id: 'futurepromo', category: 'New', startsAt: now + hour, expiresAt: now + 2 * hour },
  ];
  for (const [index, variant] of variants.entries()) {
    const name = variant.id; brand({ ...variant, name });
    await h.run([input(index + 1, { text: name })]);
    assertCard(h.calls.at(-1), { name, slug: name });
    if (['expiredbrand', 'futurepromo'].includes(name)) assert.equal((h.calls.at(-1).parameters.text ?? '').includes(`${variant.category} ·`), false);
  }
  brand({ id: 'draftbrand', name: 'draftbrand', published: 0 });
  brand({ id: 'scheduledbrand', name: 'scheduledbrand', publishAt: now + hour });
  await h.run([input(6, { text: 'draftbrand' }), input(7, { text: 'scheduledbrand' })]);
  assert.equal(h.calls.length, variants.length);
});

test('exact brand names win over ambiguous partial matches, while ambiguous input sends a bounded selection menu', async t => {
  configure(); const h = harness(t);
  brand({ id: 'first', name: 'Bintang44' });
  brand({ id: 'second', name: 'Bintang444' });
  await h.run([input(1, { text: 'bintang44' })]); assertCard(h.calls[0], { slug: 'first' });
  await h.run([input(2, { text: 'bintang' })]);
  const menu = h.calls[1]; assert.equal(menu.method, 'sendMessage');
  assert.equal(buttons(menu).filter(button => button.callback_data?.startsWith('brand:')).length, 2);
  const chosen = buttons(menu).find(button => button.text === 'Bintang444');
  await h.run([callback(3, chosen.callback_data)]);
  assert.equal(h.calls.length, 3); assertCard(h.calls[2], { name: 'Bintang444', slug: 'second' });
  assert.deepEqual(h.acknowledgments, ['callback-3']);
  for (let i = 0; i < 10; i++) brand({ id: `extra-${i}`, name: `Bintang extra ${i}` });
  await h.run([input(4, { text: 'bintang' })]);
  assert.ok(buttons(h.calls.at(-1)).filter(button => button.callback_data?.startsWith('brand:')).length <= 8);
});

test('private and group flags, configured group target and original sender checks govern automatic search', async t => {
  configure({ privateEnabled: true, groupEnabled: false }); brand(); const h = harness(t);
  await h.run([input(1, { id: groupId, type: 'supergroup' })]); assert.equal(h.calls.length, 0);
  getSqlite().prepare("UPDATE telegram_promotion_settings SET keyword_enabled=1,private_enabled=0 WHERE id='primary'").run();
  await h.run([input(2), input(3, { id: groupId - 1, type: 'supergroup' }), input(4, { id: groupId, type: 'supergroup', from: { id: 801, is_bot: true } })]);
  assert.equal(h.calls.length, 0);
  await h.run([input(5, { id: groupId, type: 'supergroup', message_thread_id: 82, is_topic_message: true })]);
  assert.equal(h.calls.length, 1); assertCard(h.calls[0]);
  assert.equal(h.calls[0].parameters.chat_id, groupId);
  assert.equal(h.calls[0].parameters.message_thread_id, 82);
  assert.equal(h.calls[0].parameters.reply_parameters.message_id, 1005);
});

test('callbacks recheck private sender binding, configured group scope and brand publication', async t => {
  configure({ groupEnabled: true }); brand(); const h = harness(t);
  await h.run([callback(1, 'brand:bintang', { senderId: privateId + 1 }), callback(2, 'brand:bintang', { id: groupId - 1, type: 'supergroup' })]);
  assert.equal(h.calls.length, 0);
  await h.run([callback(3, 'brand:bintang', { id: groupId, type: 'supergroup' })]);
  assert.equal(h.calls.length, 1); assertCard(h.calls[0]);
  getSqlite().prepare("UPDATE brands SET published=0 WHERE id='bintang'").run();
  await h.run([callback(4, 'brand:bintang')]);
  assert.equal(h.calls.length, 2);
  assert.match(h.calls.at(-1).parameters.text, /no longer available/i);
  assert.equal(h.calls.at(-1).parameters.reply_markup, undefined);
  getSqlite().prepare("DELETE FROM brands WHERE id='bintang'").run();
  await h.run([callback(5, 'brand:bintang')]);
  assert.equal(h.calls.length, 3);
  assert.match(h.calls.at(-1).parameters.text, /no longer available/i);
  assert.equal(h.calls.at(-1).parameters.reply_markup, undefined);
});

test('a brand hidden while its callback is acknowledged cannot dispatch the formerly visible card', async t => {
  configure(); brand(); const h = harness(t);
  t.mock.method(transport, 'answerTelegramCallback', async () => {
    getSqlite().prepare("UPDATE brands SET published=0 WHERE id='bintang'").run();
    return true;
  });
  await h.run([callback(1, 'brand:bintang')]);
  assert.equal(h.calls.length, 0);
});

test('photo and GIF brand replies keep all three buttons, and rejected media falls back to a single text card', async t => {
  configure(); const h = harness(t);
  for (const [index, extension] of ['png', 'gif'].entries()) {
    const id = `media${index}`; const name = `Media ${index}`;
    brand({ id, name, imageUrl: `https://images.example/${id}.${extension}` });
    await h.run([input(index + 1, { text: id })]);
    assert.equal(h.calls.at(-1).method, extension === 'gif' ? 'sendAnimation' : 'sendPhoto');
    assertCard(h.calls.at(-1), { name, slug: id });
  }
  brand({ id: 'fallback', name: 'Fallback', imageUrl: 'https://images.example/logo.png' });
  await h.run([input(3, { text: 'fallback' })], { replies: [{ ok: false, code: 400, retryAfter: 0 }, ok({ message_id: 12000 })] });
  assert.equal(h.calls.at(-2).method, 'sendPhoto'); assert.equal(h.calls.at(-1).method, 'sendMessage');
  assertCard(h.calls.at(-1), { name: 'Fallback', slug: 'fallback' });
  assert.deepEqual(buttons(h.calls.at(-1)), buttons(h.calls.at(-2)));
});

for (const [label, mutation] of [
  ['publication', db => db.prepare("UPDATE brands SET published=0 WHERE id='bintang'").run()],
  ['private enable flag', db => db.prepare("UPDATE telegram_promotion_settings SET private_enabled=0 WHERE id='primary'").run()],
  ['poll ownership', db => db.prepare("UPDATE telegram_welcome_state SET lease_id='another-worker' WHERE id='primary'").run()],
]) {
  test(`image preparation cannot send a card after its ${label} changes`, async t => {
    configure(); brand({ imageUrl: `/api/images/${'a'.repeat(32)}.png` }); const h = harness(t);
    images.beforeOpen = async () => mutation(getSqlite());
    await h.run([input(1)]); assert.equal(h.calls.length, 0);
  });
}

test('recognized brand media cancels pending unmatched followup and records actual outbound message metadata', async t => {
  configure({ followup: true }); brand({ imageUrl: 'https://images.example/logo.png' }); const h = harness(t);
  await h.run([input(1, { text: 'unknown question' })]);
  assert.equal(getSqlite().prepare('SELECT status FROM telegram_private_followups WHERE chat_id=?').get(privateId).status, 'pending');
  await h.run([input(2, { at: now + 1000 })], { at: now + 1000, replies: [ok({ message_id: 20000, date: now / 1000 + 2 })] });
  const row = getSqlite().prepare('SELECT * FROM telegram_private_followups WHERE chat_id=?').get(privateId);
  assert.equal(row.status, 'cancelled');
  assert.equal(row.last_outbound_message_id, 20000); assert.equal(row.last_outbound_at, now + 2000);
  await h.run([], { at: now + 2 * hour }); assert.equal(h.calls.length, 1);
});

test('unmatched, one-character and command input does not accidentally expose brand cards', async t => {
  configure({ followup: true }); brand(); const h = harness(t);
  await h.run([input(1, { text: 'b' }), input(2, { text: '%%% ' }), input(3, { text: 'something unrelated' })]);
  assert.equal(h.calls.length, 0);
  assert.equal(getSqlite().prepare('SELECT status FROM telegram_private_followups WHERE chat_id=?').get(privateId).status, 'pending');
  await h.run([input(4, { text: '/start' }), input(5, { text: '/stop' })]);
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every(call => !buttons(call)?.some(button => button.text === '🚀 Join Now')));
});

test('one-card rate-limit retries and update offsets never duplicate a successful brand result', async t => {
  configure(); brand({ imageUrl: 'https://images.example/logo.png' }); const h = harness(t);
  const event = input(31);
  await h.run([event], { replies: [{ ok: false, code: 429, retryAfter: 20 }] });
  assert.equal(h.calls.length, 1);
  await h.run([event], { at: now + 20000 }); assert.equal(h.calls.length, 2);
  await h.run([event], { at: now + 21000 }); assert.equal(h.calls.length, 2);
  assert.deepEqual(h.offsets, [0, 31, 32]);
  assert.equal(getSqlite().prepare("SELECT private_replies FROM telegram_welcome_state WHERE id='primary'").get().private_replies, 1);
});

test('an ambiguous media result consumes the update and never automatically resends a possible delivered card', async t => {
  configure(); brand({ imageUrl: 'https://images.example/logo.png' }); const h = harness(t);
  const event = input(31);
  await h.run([event], { replies: [null] });
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].method, 'sendPhoto');
  await h.run([event], { at: now + 20000 });
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.offsets, [0, 32]);
  assert.equal(getSqlite().prepare("SELECT private_replies FROM telegram_welcome_state WHERE id='primary'").get().private_replies, 0);
});
