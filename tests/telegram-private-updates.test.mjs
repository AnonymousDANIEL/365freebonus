import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';

// Real queue, migrations and public-visibility rules; only Telegram and image
// I/O are replaced. These tests never contact users or production resources.
const fixture = mkdtempSync(path.join(tmpdir(), 'telegram-private-updates-'));
writeFileSync(path.join(fixture, 'package.json'), '{"type":"commonjs"}');
for (const name of ['auth-core', 'brand-links', 'directory', 'image-url', 'sqlite', 'server-directory', 'telegram-brand-card', 'telegram-followups', 'telegram-private-updates']) {
  writeFileSync(path.join(fixture, `${name}.js`), ts.transpileModule(
    readFileSync(new URL(`../app/lib/${name}.ts`, import.meta.url), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } },
  ).outputText);
}
writeFileSync(path.join(fixture, 'telegram-bot.js'), `
exports.calls = [];
exports.responses = [];
exports.now = 0;
exports.telegramRequest = async (token, method, parameters, upload) => {
  exports.calls.push({ token, method, parameters, upload });
  if (exports.responses.length) {
    const next = exports.responses.shift();
    return typeof next === 'function' ? await next(parameters) : next;
  }
  return { ok: true, result: { message_id: 9000 + exports.calls.length, date: Math.floor(exports.now / 1000) } };
};
`);
writeFileSync(path.join(fixture, 'image-media.js'), `
exports.MAX_IMAGE_BYTES = 5 * 1024 * 1024;
exports.onRead = null;
exports.openImage = async () => {
  if (exports.onRead) await exports.onRead();
  const bytes = Buffer.from('fixture-image');
  return { size: bytes.length, mime: 'image/png', stream: new Response(bytes).body };
};
`);
writeFileSync(path.join(fixture, 'telegram-background.js'), 'exports.cleanTelegramBackground = async () => null;');

const require = createRequire(import.meta.url);
const updates = require(path.join(fixture, 'telegram-private-updates.js'));
const telegram = require(path.join(fixture, 'telegram-bot.js'));
const images = require(path.join(fixture, 'image-media.js'));
const { getSqlite } = require(path.join(fixture, 'sqlite.js'));
const repository = require(path.join(fixture, 'server-directory.js'));
const directory = require(path.join(fixture, 'directory.js'));
const previousEnv = Object.fromEntries(['APP_URL', 'DATA_DIR', 'ADMIN_PATH'].map(key => [key, process.env[key]]));
const now = 1_800_000_000_000;
const day = 86_400_000;
const userId = 701;
const origin = 'https://365freebonus.com';
const ciphertext = 'fixture-chat-ciphertext';
const token = 'fixture-chat-token';
const uploadedImage = `/api/images/${'a'.repeat(32)}.png`;
const ok = result => ({ ok: true, result });

function closeDatabase() {
  const filename = path.join(process.env.DATA_DIR, 'directory.sqlite');
  globalThis.__directorySqlite?.get(filename)?.close();
  globalThis.__directorySqlite?.delete(filename);
}
test.beforeEach(() => {
  process.env.APP_URL = origin;
  process.env.DATA_DIR = mkdtempSync(path.join(fixture, 'case-'));
  process.env.ADMIN_PATH = '/fixture-admin';
  telegram.calls.length = 0;
  telegram.responses.length = 0;
  images.onRead = null;
});
test.afterEach(closeDatabase);
test.after(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(fixture, { recursive: true, force: true });
});

function configure({ enabled = true, privateEnabled = true, startedAt = now - 10_000, revision = 'updates-revision', template = '' } = {}) {
  getSqlite().prepare(`INSERT INTO telegram_promotion_settings
    (id,enabled,chat_id,token_ciphertext,chat_bot_token_ciphertext,private_enabled,private_started_at,
     private_updates_enabled,private_updates_started_at,private_updates_revision,promotion_message)
    VALUES ('primary',0,'','fixture-promotion-ciphertext',?,?,?,?,?,?,?)`)
    .run(ciphertext, Number(privateEnabled), Math.floor((now - day) / 1000), Number(enabled), startedAt, revision, template);
}
function contact(id = userId, { enabled = true, startedAt = now - 20_000 } = {}) {
  getSqlite().prepare('INSERT INTO telegram_private_contacts(user_id,updates_enabled,updates_started_at) VALUES (?,?,?)')
    .run(id, Number(enabled), startedAt);
}
function enqueue({
  id = 'brand', revision = 'promotion-revision', category = 'Update', published = true,
  publishAt = null, start = now, expiry = now + day, createdAt = now,
  imageUrl = '', status = 'skipped', description = 'The current brand introduction.',
} = {}) {
  const db = getSqlite();
  db.prepare(`INSERT INTO brands(id,name,slug,category,tagline,description,color,icon,image_url,published,link,
    promotion_starts_at,promotion_expires_at,publish_at)
    VALUES (?,?,?,?,'Welcome to this brand',?,'#aabbcc','sparkles',?,?,'https://brand.example/join',?,?,?)`)
    .run(id, `Name ${id}`, id, category, description, imageUrl, Number(published), start, expiry, publishAt);
  db.prepare('INSERT INTO telegram_promotion_outbox(brand_id,revision,status,created_at) VALUES (?,?,?,?)')
    .run(id, revision, status, createdAt);
  return id;
}
function delivery(id = 'brand', recipient = userId, revision = 'promotion-revision') {
  return getSqlite().prepare(`SELECT * FROM telegram_private_brand_updates
    WHERE brand_id=? AND promotion_revision=? AND user_id=?`).get(id, revision, recipient);
}
function queuePending(id = 'brand', recipient = userId, revision = 'promotion-revision', settingsRevision = 'updates-revision') {
  getSqlite().prepare(`INSERT INTO telegram_private_brand_updates
    (brand_id,promotion_revision,user_id,settings_revision) VALUES (?,?,?,?)`)
    .run(id, revision, recipient, settingsRevision);
}
function downgradeFixtureToV16() {
  // Only disposable fixture databases are altered. This reconstructs the real
  // v16 schema without depending on git history or a second production module.
  getSqlite().exec(`DROP TABLE telegram_relay_media_keys; DROP TABLE telegram_relay_outbox; DROP TABLE telegram_relay_state; ALTER TABLE telegram_promotion_settings DROP COLUMN relay_enabled; ALTER TABLE telegram_promotion_settings DROP COLUMN relay_chat_id; ALTER TABLE telegram_promotion_settings DROP COLUMN relay_started_at; ALTER TABLE telegram_promotion_settings DROP COLUMN relay_revision; DROP TABLE telegram_private_brand_updates;
    DROP TABLE telegram_private_updates_state;
    ALTER TABLE telegram_promotion_settings DROP COLUMN private_updates_enabled;
    ALTER TABLE telegram_promotion_settings DROP COLUMN private_updates_started_at;
    ALTER TABLE telegram_promotion_settings DROP COLUMN private_updates_revision;
    ALTER TABLE telegram_private_contacts DROP COLUMN updates_enabled;
    ALTER TABLE telegram_private_contacts DROP COLUMN updates_started_at;
    ALTER TABLE telegram_promotion_outbox DROP COLUMN created_at;
    PRAGMA user_version=16;`);
  closeDatabase();
}
async function tick(at = now) {
  telegram.now = at;
  await updates.deliverTelegramPrivateUpdateOnce(value => {
    assert.equal(value, ciphertext, 'private notices must decrypt the ChatBot credential');
    return token;
  }, () => at);
}
function expectedButtons(id = 'brand') {
  return [
    [{ text: `Name ${id}`, url: `${origin}/${id}` }],
    [{ text: '🌐 Visit website', url: `${origin}/` }, { text: '🚀 Join Now', url: 'https://brand.example/join' }],
  ];
}

test('private updates use the ChatBot independently of channel settings and carry the brand card and emoji buttons', async () => {
  configure({ template: 'Discover {name}\n{link}' });
  contact();
  enqueue({ imageUrl: 'https://images.example/logo.gif' });
  await tick();
  assert.equal(telegram.calls.length, 1);
  const call = telegram.calls[0];
  assert.equal(call.token, token);
  assert.equal(call.method, 'sendAnimation');
  assert.equal(call.parameters.chat_id, userId);
  assert.match(call.parameters.caption, /Discover Name brand/);
  assert.match(call.parameters.caption, /The current brand introduction/);
  assert.equal(call.parameters.caption.includes(`${origin}/brand`), false);
  assert.deepEqual(call.parameters.reply_markup.inline_keyboard, expectedButtons());
  assert.equal(delivery().status, 'sent');
  assert.equal(getSqlite().prepare("SELECT status FROM telegram_promotion_outbox WHERE brand_id='brand'").get().status, 'skipped');
});

test('a sent notice survives database reopening and a new promotion revision sends exactly once', async () => {
  configure(); contact(); enqueue();
  await tick();
  closeDatabase();
  await tick(now + 2000);
  assert.equal(telegram.calls.length, 1);
  getSqlite().prepare("UPDATE telegram_promotion_outbox SET revision='new-revision',created_at=? WHERE brand_id='brand'").run(now + 3000);
  await tick(now + 3000);
  assert.equal(telegram.calls.length, 2);
  assert.equal(delivery('brand', userId, 'new-revision').status, 'sent');
  await tick(now + 5000);
  assert.equal(telegram.calls.length, 2);
});

test('history, hidden/future/expired brands and contacts who joined later or opted out are excluded', async () => {
  configure(); contact();
  contact(702, { enabled: false });
  contact(703, { startedAt: now + 1 });
  contact(704);
  contact(-1001);
  getSqlite().prepare("INSERT INTO telegram_private_followups(chat_id,revision,opted_out) VALUES (704,'opted-out',1)").run();
  enqueue({ id: 'history', start: now - 20_000, createdAt: now - 20_000 });
  enqueue({ id: 'hidden', published: false });
  enqueue({ id: 'scheduled-publication', publishAt: now + 60_000 });
  enqueue({ id: 'scheduled-promotion', start: now + 60_000 });
  enqueue({ id: 'expired', expiry: now - 1 });
  enqueue({ id: 'all', category: 'All' });
  enqueue({ id: 'eligible' });
  await tick(now + 2000);
  assert.equal(telegram.calls.length, 1);
  assert.equal(telegram.calls[0].parameters.chat_id, userId);
  assert.match(telegram.calls[0].parameters.text, /Name eligible/);
  const rows = getSqlite().prepare('SELECT brand_id,user_id FROM telegram_private_brand_updates').all();
  assert.deepEqual(rows.map(row => ({ ...row })), [{ brand_id: 'eligible', user_id: userId }]);
});

test('a schedule saved before notification activation becomes eligible only at its public start', async () => {
  configure(); contact();
  enqueue({ createdAt: 0, start: now + 1000, publishAt: now + 1000 });
  await tick(now);
  assert.equal(telegram.calls.length, 0);
  contact(702, { startedAt: now + 500 });
  await tick(now + 1000);
  assert.equal(telegram.calls.length, 1);
  assert.equal(delivery().status, 'sent');
  await tick(now + 2000);
  assert.equal(telegram.calls.length, 2, 'a customer who subscribes before the public start receives the future event');
  assert.equal(delivery('brand', 702).status, 'sent');
});

test('private recipients share a one-second send throttle without losing queued recipients', async () => {
  configure(); contact(); contact(702); enqueue();
  await tick(now);
  await tick(now);
  await tick(now + 999);
  assert.equal(telegram.calls.length, 1);
  await tick(now + 1000);
  assert.equal(telegram.calls.length, 2);
  assert.deepEqual(telegram.calls.map(call => call.parameters.chat_id), [701, 702]);
  assert.deepEqual(updates.privateBrandUpdateStatus(getSqlite()).counts, { pending: 0, sending: 0, sent: 2, failed: 0, unknown: 0, cancelled: 0 });
});

test('disabled private chat or private updates cancels queued notices without contacting Telegram', async () => {
  configure({ enabled: false }); contact(); enqueue(); queuePending();
  await tick();
  assert.equal(delivery().status, 'cancelled');
  getSqlite().prepare("UPDATE telegram_promotion_settings SET private_updates_enabled=1,private_enabled=0 WHERE id='primary'").run();
  getSqlite().prepare("UPDATE telegram_private_brand_updates SET status='pending'").run();
  await tick(now + 1000);
  assert.equal(delivery().status, 'cancelled');
  assert.equal(telegram.calls.length, 0);
});

test('old setting revisions and newly ineligible queued brands are cancelled instead of sent', async () => {
  configure(); contact();
  enqueue({ id: 'stale' }); queuePending('stale', userId, 'promotion-revision', 'old-settings');
  enqueue({ id: 'hidden', published: false }); queuePending('hidden');
  await tick();
  assert.equal(delivery('stale').status, 'cancelled');
  assert.equal(delivery('hidden').status, 'cancelled');
  assert.equal(telegram.calls.length, 0);
});

test('a successful private brand notice records actual outbound identity and cancels unmatched followup', async () => {
  configure(); contact(); enqueue();
  getSqlite().prepare(`INSERT INTO telegram_private_followups(chat_id,revision,status,customer_at,due_at)
    VALUES (?,'followup-episode','pending',?,?)`).run(userId, now - 1000, now + 3_600_000);
  telegram.responses.push(ok({ message_id: 4321, date: now / 1000 }));
  await tick();
  const followup = getSqlite().prepare('SELECT * FROM telegram_private_followups WHERE chat_id=?').get(userId);
  assert.equal(followup.status, 'cancelled');
  assert.equal(followup.last_outbound_message_id, 4321);
  assert.equal(followup.last_outbound_at, now);
  assert.equal(delivery().message_id, 4321);
});

test('definitively rejected media falls back to text with the same buttons while ambiguous media is never retried', async () => {
  configure(); contact(); enqueue({ imageUrl: 'https://images.example/logo.png' });
  telegram.responses.push({ ok: false, code: 400, retryAfter: 0 }, ok({ message_id: 1234, date: now / 1000 }));
  await tick();
  assert.deepEqual(telegram.calls.map(call => call.method), ['sendPhoto', 'sendMessage']);
  assert.deepEqual(telegram.calls[1].parameters.reply_markup.inline_keyboard, expectedButtons());
  assert.equal(delivery().status, 'sent');
  enqueue({ id: 'ambiguous', imageUrl: 'https://images.example/logo.png', createdAt: now + 1000 });
  telegram.responses.push(null);
  await tick(now + 1000);
  assert.equal(delivery('ambiguous').status, 'unknown');
  await tick(now + 100_000);
  assert.equal(telegram.calls.length, 3);
});

test('explicit rate limits pause the entire private queue and retry only the rejected notice', async () => {
  configure(); contact(); contact(702); enqueue();
  telegram.responses.push({ ok: false, code: 429, retryAfter: 20 });
  await tick();
  assert.equal(delivery().status, 'pending');
  await tick(now + 19_999);
  assert.equal(telegram.calls.length, 1);
  await tick(now + 20_000);
  assert.equal(telegram.calls.length, 2);
  assert.equal(delivery('brand', 702).status, 'sent');
  assert.equal(delivery().status, 'pending');
  await tick(now + 21_000);
  assert.equal(delivery().status, 'sent');
  assert.deepEqual(telegram.calls.map(call => call.parameters.chat_id), [701, 702, 701]);
});

test('repeated rate limits stop at five attempts and blocked recipients are removed with their other queue cancelled', async () => {
  configure(); contact(); enqueue();
  for (let attempt = 0, time = now; attempt < 5; attempt++) {
    telegram.responses.push({ ok: false, code: 429, retryAfter: 1 });
    await tick(time);
    time = getSqlite().prepare("SELECT next_send_at FROM telegram_private_updates_state WHERE id='primary'").get().next_send_at;
  }
  assert.equal(delivery().status, 'failed');
  assert.equal(delivery().attempts, 5);
  const later = getSqlite().prepare("SELECT next_send_at FROM telegram_private_updates_state WHERE id='primary'").get().next_send_at;
  enqueue({ id: 'blocked', createdAt: later });
  enqueue({ id: 'blocked-other', createdAt: later });
  telegram.responses.push({ ok: false, code: 403, retryAfter: 0 });
  await tick(later);
  assert.equal(delivery('blocked').status, 'failed');
  assert.equal(delivery('blocked-other').status, 'cancelled');
  assert.equal(getSqlite().prepare('SELECT 1 FROM telegram_private_contacts WHERE user_id=?').get(userId), undefined);
});

test('an expired sending lease becomes unknown and is not automatically sent again', async () => {
  configure(); contact(); enqueue(); queuePending();
  getSqlite().prepare(`UPDATE telegram_private_brand_updates SET status='sending',attempts=1,lease_id='interrupted',lease_until=?`).run(now - 1);
  await tick();
  assert.equal(delivery().status, 'unknown');
  assert.equal(telegram.calls.length, 0);
});

test('publication, subscription, identity, settings and ownership changes during image preparation prevent dispatch', async () => {
  const actions = [
    db => db.prepare("UPDATE brands SET published=0 WHERE id='brand'").run(),
    db => db.prepare('UPDATE telegram_private_contacts SET updates_enabled=0 WHERE user_id=?').run(userId),
    db => db.prepare("UPDATE telegram_promotion_settings SET private_updates_revision='replacement' WHERE id='primary'").run(),
    db => db.prepare("UPDATE telegram_promotion_settings SET chat_bot_token_ciphertext='replacement' WHERE id='primary'").run(),
    db => db.prepare("UPDATE telegram_private_updates_state SET lease_id='replacement'").run(),
  ];
  for (const action of actions) {
    closeDatabase();
    process.env.DATA_DIR = mkdtempSync(path.join(fixture, 'guard-'));
    configure(); contact(); enqueue({ imageUrl: uploadedImage });
    images.onRead = () => action(getSqlite());
    await tick();
  }
  assert.equal(telegram.calls.length, 0);
});

test('configuration cancellation after a rejected media send prevents its text fallback', async () => {
  configure(); contact(); enqueue({ imageUrl: 'https://images.example/logo.png' });
  telegram.responses.push(() => {
    getSqlite().prepare("UPDATE telegram_promotion_settings SET private_updates_enabled=0 WHERE id='primary'").run();
    return { ok: false, code: 400, retryAfter: 0 };
  });
  await tick();
  assert.equal(telegram.calls.length, 1);
  assert.equal(delivery().status, 'cancelled');
});

test('a credential rotation before any send releases the notice to use the replacement token', async () => {
  configure(); contact(); enqueue({ imageUrl: uploadedImage });
  images.onRead = () => {
    getSqlite().prepare("UPDATE telegram_promotion_settings SET chat_bot_token_ciphertext='replacement-cipher' WHERE id='primary'").run();
  };
  await tick();
  assert.equal(telegram.calls.length, 0);
  assert.equal(delivery().status, 'pending');
  images.onRead = null;
  telegram.now = now + 1000;
  await updates.deliverTelegramPrivateUpdateOnce(value => {
    assert.equal(value, 'replacement-cipher');
    return 'replacement-chat-token';
  }, () => now + 1000);
  assert.equal(telegram.calls.length, 1);
  assert.equal(telegram.calls[0].token, 'replacement-chat-token');
  assert.equal(delivery().status, 'sent');
});

test('turning notifications back on does not revive cancelled history but allows a later event', async () => {
  configure(); contact(); contact(702); enqueue();
  await tick();
  assert.equal(delivery('brand', 702).status, 'pending');
  getSqlite().prepare("UPDATE telegram_promotion_settings SET private_updates_enabled=0 WHERE id='primary'").run();
  await tick(now + 1000);
  assert.equal(delivery('brand', 702).status, 'cancelled');
  getSqlite().prepare(`UPDATE telegram_promotion_settings SET private_updates_enabled=1,
    private_updates_started_at=?, private_updates_revision='new-settings' WHERE id='primary'`).run(now + 2000);
  await tick(now + 2000);
  assert.equal(telegram.calls.length, 1);
  enqueue({ id: 'later-event', createdAt: now + 3000 });
  await tick(now + 3000);
  assert.equal(telegram.calls.length, 2);
  assert.match(telegram.calls[1].parameters.text, /Name later-event/);
  assert.equal(delivery('brand', 702).status, 'cancelled');
});

test('repository revisions stamp their event time without changing timestamps on ordinary brand edits', () => {
  configure(); contact();
  const saved = repository.createBrand({ ...directory.seedBrands[0], id: 'repository-brand', slug: 'repository-brand', category: 'New', promotionDays: 2 }, now);
  const first = getSqlite().prepare('SELECT revision,created_at FROM telegram_promotion_outbox WHERE brand_id=?').get(saved.id);
  assert.equal(first.created_at, now);
  const { id, publishAt: _publishAt, ...input } = saved;
  repository.updateBrand(id, { ...input, description: 'An ordinary edit.' }, now + 1000);
  assert.deepEqual(getSqlite().prepare('SELECT revision,created_at FROM telegram_promotion_outbox WHERE brand_id=?').get(id), first);
  repository.updateBrand(id, { ...input, category: 'Update' }, now + 2000);
  const changed = getSqlite().prepare('SELECT revision,created_at FROM telegram_promotion_outbox WHERE brand_id=?').get(id);
  assert.notEqual(changed.revision, first.revision);
  assert.equal(changed.created_at, now + 2000);
});

test('first publishing an older draft reaches current subscribers while republishing keeps already sent recipients deduplicated', async () => {
  configure(); contact();
  const draft = repository.createBrand({
    ...directory.seedBrands[0], id: 'older-draft', slug: 'older-draft', name: 'Older draft',
    category: 'New', promotionDays: 2, promotionStartsAt: null, published: false,
    link: 'https://brand.example/join',
  }, now - 30_000);
  const db = getSqlite();
  const event = () => ({ ...db.prepare('SELECT revision,status,created_at FROM telegram_promotion_outbox WHERE brand_id=?').get(draft.id) });
  db.prepare("UPDATE telegram_promotion_outbox SET status='skipped' WHERE brand_id=?").run(draft.id);
  const original = event();
  assert.equal(original.created_at, now - 30_000);
  await tick();
  assert.equal(telegram.calls.length, 0, 'the old draft must remain unavailable');

  const fields = brand => {
    const { id: _id, publishAt: _publishAt, ...input } = brand;
    return input;
  };
  const published = repository.updateBrand(draft.id, { ...fields(draft), published: true }, now + 1000);
  assert.deepEqual(event(), { ...original, created_at: now + 1000 });
  assert.equal(published.promotionStartsAt, null);
  assert.equal(published.promotionExpiresAt, draft.promotionExpiresAt);
  await tick(now + 1000);
  assert.equal(telegram.calls.length, 1, 'publication is a fresh availability event after subscription');
  assert.equal(telegram.calls[0].parameters.chat_id, userId);
  assert.equal(delivery(draft.id, userId, original.revision).status, 'sent');

  const hidden = repository.updateBrand(draft.id, { ...fields(published), published: false }, now + 2000);
  await tick(now + 2000);
  assert.equal(telegram.calls.length, 1);
  contact(702, { startedAt: now + 2500 });
  repository.updateBrand(draft.id, { ...fields(hidden), published: true }, now + 3000);
  assert.deepEqual(event(), { ...original, created_at: now + 3000 });
  await tick(now + 3000);
  assert.equal(telegram.calls.length, 2);
  assert.deepEqual(telegram.calls.map(call => call.parameters.chat_id), [userId, 702]);
  assert.equal(delivery(draft.id, userId, original.revision).attempts, 1, 'republishing must not resend to a completed recipient');
  assert.equal(delivery(draft.id, 702, original.revision).status, 'sent');
  await tick(now + 5000);
  assert.equal(telegram.calls.length, 2);
});

test('v16 migration preserves existing data and opt-outs while enabling only future private notices', async t => {
  t.mock.method(Date, 'now', () => now);
  configure(); contact(); contact(702);
  enqueue({ id: 'legacy-active', createdAt: now - 1000, start: now - 1000 });
  enqueue({ id: 'legacy-future', createdAt: now - 1000, start: now + 60_000, publishAt: now + 60_000 });
  const db = getSqlite();
  db.prepare("INSERT INTO telegram_private_followups(chat_id,revision,opted_out) VALUES (?,'optout',1)").run(userId);
  db.prepare("INSERT INTO notes_vault_settings(id,pin_hash,revision,created_at,updated_at) VALUES ('primary','fixture-pin-hash','vault-revision',1,1)").run();
  db.prepare("INSERT INTO secure_notes(title_ciphertext,body_ciphertext,revision,created_at,updated_at) VALUES ('fixture-title','fixture-body','note-revision',1,1)").run();
  const beforeVault = { ...db.prepare('SELECT * FROM notes_vault_settings').get() };
  const beforeNote = { ...db.prepare('SELECT * FROM secure_notes').get() };
  downgradeFixtureToV16();
  const migrated = getSqlite();
  assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 19);
  const settings = migrated.prepare("SELECT * FROM telegram_promotion_settings WHERE id='primary'").get();
  assert.equal(settings.private_updates_enabled, 1);
  assert.equal(settings.private_updates_started_at, now);
  assert.ok(settings.private_updates_revision);
  assert.equal(settings.chat_bot_token_ciphertext, ciphertext);
  assert.equal(settings.token_ciphertext, 'fixture-promotion-ciphertext');
  assert.deepEqual({ ...migrated.prepare('SELECT * FROM notes_vault_settings').get() }, beforeVault);
  assert.deepEqual({ ...migrated.prepare('SELECT * FROM secure_notes').get() }, beforeNote);
  assert.equal(migrated.prepare('SELECT updates_enabled FROM telegram_private_contacts WHERE user_id=?').get(userId).updates_enabled, 0);
  assert.equal(migrated.prepare('SELECT updates_enabled FROM telegram_private_contacts WHERE user_id=702').get().updates_enabled, 1);
  assert.deepEqual(migrated.prepare('SELECT created_at FROM telegram_promotion_outbox').all().map(row => row.created_at), [0, 0]);
  await tick(now);
  assert.equal(telegram.calls.length, 0, 'migration must not announce old active campaigns');
  await tick(now + 60_000);
  assert.equal(telegram.calls.length, 1);
  assert.equal(telegram.calls[0].parameters.chat_id, 702);
  assert.match(telegram.calls[0].parameters.text, /Name legacy-future/);
});

test('migration does not enable private notices when private chat is disabled or its bot is unconfigured', async t => {
  t.mock.method(Date, 'now', () => now);
  for (const [privateEnabled, hasToken] of [[false, true], [true, false]]) {
    closeDatabase();
    process.env.DATA_DIR = mkdtempSync(path.join(fixture, 'disabled-migration-'));
    configure({ privateEnabled }); contact(); enqueue();
    if (!hasToken) getSqlite().prepare("UPDATE telegram_promotion_settings SET chat_bot_token_ciphertext='' WHERE id='primary'").run();
    downgradeFixtureToV16();
    const settings = getSqlite().prepare("SELECT * FROM telegram_promotion_settings WHERE id='primary'").get();
    assert.equal(settings.private_updates_enabled, 0);
    assert.equal(settings.private_enabled, Number(privateEnabled));
    assert.equal(settings.chat_bot_token_ciphertext, hasToken ? ciphertext : '');
    await tick();
  }
  assert.equal(telegram.calls.length, 0);
});
