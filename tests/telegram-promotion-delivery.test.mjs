import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';

// Exercise the real queue claim and delivery against disposable SQLite. The
// only substitutes are Telegram transport and image I/O: no live messages,
// administrator credentials, production data, or external requests are used.
const fixture = mkdtempSync(path.join(tmpdir(), 'telegram-promotion-delivery-'));
writeFileSync(path.join(fixture, 'package.json'), '{"type":"commonjs"}');
for (const name of ['auth-core', 'brand-links', 'directory', 'image-url', 'sqlite', 'telegram-brand-card', 'telegram-promotions']) {
  writeFileSync(path.join(fixture, `${name}.js`), ts.transpileModule(
    readFileSync(new URL(`../app/lib/${name}.ts`, import.meta.url), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } },
  ).outputText);
}
writeFileSync(path.join(fixture, 'telegram-welcome.js'), 'exports.startTelegramWelcomeWorker = () => { throw new Error("Unexpected background worker"); };');
writeFileSync(path.join(fixture, 'telegram-bot.js'), `
exports.calls = [];
exports.responses = [];
exports.telegramRequest = async (token, method, parameters, upload) => {
  exports.calls.push({ token, method, parameters, upload });
  return exports.responses.length ? exports.responses.shift() : { ok: true, result: { message_id: 123 } };
};
`);
writeFileSync(path.join(fixture, 'image-media.js'), `
exports.MAX_IMAGE_BYTES = 5 * 1024 * 1024;
exports.mime = 'image/png';
exports.openImage = async () => {
  const bytes = Buffer.from('fixture-image');
  return { size: bytes.length, mime: exports.mime, stream: new Response(bytes).body };
};
`);
writeFileSync(path.join(fixture, 'telegram-background.js'), `
exports.cleaned = null;
exports.cleanTelegramBackground = async () => exports.cleaned;
`);

const require = createRequire(import.meta.url);
const promotions = require(path.join(fixture, 'telegram-promotions.js'));
const { sendTelegramBrandCard } = require(path.join(fixture, 'telegram-brand-card.js'));
const telegram = require(path.join(fixture, 'telegram-bot.js'));
const images = require(path.join(fixture, 'image-media.js'));
const background = require(path.join(fixture, 'telegram-background.js'));
const { getSqlite } = require(path.join(fixture, 'sqlite.js'));
const previousEnv = Object.fromEntries(['APP_URL', 'DATA_DIR', 'SESSION_SECRET', 'ADMIN_PATH'].map(key => [key, process.env[key]]));
const origin = 'https://365freebonus.com';
const secret = 'promotion-delivery-fixture-session-secret';
const token = '12345678:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const chatId = -1001234567890;
const brandPage = `${origin}/syabas99`;
const uploadedImage = `/api/images/${'a'.repeat(32)}.png`;

function encryptedToken() {
  const context = '365freebonus:telegram-promotion-token:v1';
  const key = createHmac('sha256', secret).update(context).digest();
  const iv = Buffer.alloc(12, 7);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
}

function closeDatabase() {
  const filename = path.join(process.env.DATA_DIR, 'directory.sqlite');
  globalThis.__directorySqlite?.get(filename)?.close();
  globalThis.__directorySqlite?.delete(filename);
}

test.beforeEach(() => {
  process.env.APP_URL = origin;
  process.env.DATA_DIR = mkdtempSync(path.join(fixture, 'case-'));
  process.env.SESSION_SECRET = secret;
  process.env.ADMIN_PATH = '/fixture-admin';
  telegram.calls.length = 0;
  telegram.responses.length = 0;
  images.mime = 'image/png';
  background.cleaned = null;
  getSqlite().prepare(`INSERT INTO telegram_promotion_settings
    (id, enabled, chat_id, token_ciphertext) VALUES ('primary', 1, ?, ?)`)
    .run(String(chatId), encryptedToken());
});
test.afterEach(closeDatabase);
test.after(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(fixture, { recursive: true, force: true });
});

function enqueue({
  id = 'brand-id', name = 'Syabas99', slug = 'syabas99', category = 'Update',
  tagline = 'Welcome to Syabas99', description = 'Explore the brand details and available offers.',
  link = 'https://brand.example/join?source=directory', imageUrl = '',
} = {}) {
  const db = getSqlite();
  const now = Date.now();
  db.prepare(`INSERT INTO brands (id, name, slug, category, tagline, description,
    color, icon, image_url, published, link, promotion_starts_at, promotion_expires_at)
    VALUES (?, ?, ?, ?, ?, ?, '#aabbcc', 'sparkles', ?, 1, ?, ?, ?)`)
    .run(id, name, slug, category, tagline, description, imageUrl, link, now - 1_000, now + 86_400_000);
  db.prepare(`INSERT INTO telegram_promotion_outbox (brand_id, revision) VALUES (?, ?)`)
    .run(id, `revision-${id}`);
  return id;
}

function setTemplate(message) {
  getSqlite().prepare("UPDATE telegram_promotion_settings SET promotion_message=? WHERE id='primary'").run(message);
}

function state(id = 'brand-id') {
  return getSqlite().prepare('SELECT status, attempts, message_id FROM telegram_promotion_outbox WHERE brand_id=?').get(id);
}

function buttons(parameters) {
  return parameters.reply_markup?.inline_keyboard;
}

function expectedButtons({ name = 'Syabas99', page = brandPage, link = 'https://brand.example/join?source=directory' } = {}) {
  return [
    [{ text: name, url: page }],
    [{ text: 'Visit website', url: `${origin}/` }, ...(link ? [{ text: 'Join Now', url: link }] : [])],
  ];
}

test('current brand introduction and destinations are read from SQLite and one queued notice sends once', async () => {
  enqueue({ description: 'Old introduction', link: 'https://brand.example/old' });
  getSqlite().prepare(`UPDATE brands SET name='Updated name', slug='updated-name',
    tagline='Current welcome', description='Current brand introduction', link='https://brand.example/current' WHERE id='brand-id'`).run();

  await promotions.deliverTelegramPromotionOnce();
  assert.equal(telegram.calls.length, 1);
  const call = telegram.calls[0];
  assert.equal(call.token, token);
  assert.equal(call.method, 'sendMessage');
  assert.equal(call.parameters.chat_id, chatId);
  assert.match(call.parameters.text, /Update · Updated name/);
  assert.match(call.parameters.text, /Current welcome/);
  assert.match(call.parameters.text, /Current brand introduction/);
  assert.equal(call.parameters.text.includes(origin), false);
  assert.deepEqual(buttons(call.parameters), expectedButtons({ name: 'Updated name', page: `${origin}/updated-name`, link: 'https://brand.example/current' }));
  assert.deepEqual({ ...state() }, { status: 'sent', attempts: 1, message_id: 123 });

  await promotions.deliverTelegramPromotionOnce();
  assert.equal(telegram.calls.length, 1, 'already sent promotion must not be duplicated');
});

test('custom templates retain owner copy, add the introduction and replace legacy link text with buttons', async () => {
  const introduction = 'A distinct description for this brand.';
  enqueue({ description: introduction });
  setTemplate(`Latest {category}: {name}\n{tagline}\n{link}\n${brandPage}`);
  await promotions.deliverTelegramPromotionOnce();
  const { parameters } = telegram.calls[0];
  assert.match(parameters.text, /Latest Update: Syabas99/);
  assert.match(parameters.text, /Welcome to Syabas99/);
  assert.ok(parameters.text.includes(introduction));
  assert.equal(parameters.text.includes('{link}'), false);
  assert.equal(parameters.text.includes(brandPage), false);
  assert.deepEqual(buttons(parameters), expectedButtons());
});

test('description placeholders and existing exact introductions do not duplicate the brand introduction', async () => {
  const introduction = 'Introduction shown exactly once.';
  for (const [index, message] of [
    `About {name}\n{description}`,
    `About {name}\n${introduction}`,
  ].entries()) {
    enqueue({ id: `case-${index}`, slug: `case-${index}`, description: introduction });
    setTemplate(message);
    await promotions.deliverTelegramPromotionOnce();
    const text = telegram.calls.at(-1).parameters.text;
    assert.equal(text.split(introduction).length - 1, 1);
    assert.equal(text.includes('{description}'), false);
  }
});

test('identical tagline and description appear once in the default notification', async () => {
  const introduction = 'One shared introduction.';
  enqueue({ tagline: introduction, description: introduction });
  await promotions.deliverTelegramPromotionOnce();
  assert.equal(telegram.calls[0].parameters.text.split(introduction).length - 1, 1);
});

test('photo, GIF and cleaned-document notices retain their caption and the same three buttons', async () => {
  const variants = [
    { method: 'sendPhoto', imageUrl: 'https://images.example/logo.png' },
    { method: 'sendAnimation', imageUrl: 'https://images.example/logo.gif' },
    { method: 'sendDocument', imageUrl: uploadedImage, cleaned: { extension: 'png', mime: 'image/png', bytes: Buffer.from('transparent fixture') } },
  ];
  for (const [index, variant] of variants.entries()) {
    const id = `media-${index}`;
    background.cleaned = variant.cleaned ?? null;
    enqueue({ id, slug: id, category: 'New', imageUrl: variant.imageUrl });
    await promotions.deliverTelegramPromotionOnce();
    const call = telegram.calls.at(-1);
    assert.equal(call.method, variant.method);
    assert.match(call.parameters.caption, /New · Syabas99/);
    assert.match(call.parameters.caption, /Explore the brand details/);
    assert.equal(call.parameters.caption.includes(origin), false);
    assert.deepEqual(buttons(call.parameters), expectedButtons({ page: `${origin}/${id}` }));
    if (variant.method === 'sendDocument') {
      assert.equal(call.upload.field, 'document');
      assert.equal(call.upload.fileName, `${id}.png`);
      assert.equal(call.parameters.disable_content_type_detection, true);
    }
    assert.equal(state(id).status, 'sent');
  }
});

test('uploaded photos and GIFs use binary media paths and preserve the inline keyboard', async () => {
  for (const [index, [mime, extension, method]] of [
    ['image/png', 'png', 'sendPhoto'], ['image/gif', 'gif', 'sendAnimation'],
  ].entries()) {
    const id = `upload-${index}`;
    images.mime = mime;
    enqueue({ id, slug: id, imageUrl: `/api/images/${'a'.repeat(32)}.${extension}` });
    await promotions.deliverTelegramPromotionOnce();
    const call = telegram.calls.at(-1);
    assert.equal(call.method, method);
    assert.equal(call.upload.mime, mime);
    assert.deepEqual(buttons(call.parameters), expectedButtons({ page: `${origin}/${id}` }));
  }
});

test('definitively rejected media falls back to text without losing any destination buttons', async () => {
  for (const [index, code] of [400, 403].entries()) {
    const id = `fallback-${index}`;
    enqueue({ id, slug: id, imageUrl: 'https://images.example/logo.png' });
    telegram.responses.push({ ok: false, code, retryAfter: 0 }, { ok: true, result: { message_id: 124 + index } });
    await promotions.deliverTelegramPromotionOnce();
    const media = telegram.calls.at(-2);
    const text = telegram.calls.at(-1);
    assert.equal(media.method, 'sendPhoto');
    assert.equal(text.method, 'sendMessage');
    assert.match(text.parameters.text, /Explore the brand details/);
    assert.deepEqual(buttons(media.parameters), expectedButtons({ page: `${origin}/${id}` }));
    assert.deepEqual(buttons(text.parameters), buttons(media.parameters));
    assert.equal(state(id).status, 'sent');
  }
});

test('long introductions keep media, fit Telegram caption limits and use well-formed Unicode in text fallback', async () => {
  enqueue({ tagline: 'A'.repeat(180), description: '🎁'.repeat(2_000), imageUrl: 'https://images.example/logo.png' });
  telegram.responses.push({ ok: false, code: 400, retryAfter: 0 }, { ok: true, result: { message_id: 125 } });
  await promotions.deliverTelegramPromotionOnce();
  const [media, text] = telegram.calls;
  assert.equal(media.method, 'sendPhoto', 'a long brand introduction must not remove the image');
  assert.ok(media.parameters.caption.length <= 1_024);
  assert.equal(media.parameters.caption.isWellFormed(), true);
  assert.ok(media.parameters.caption.endsWith('…'));
  assert.ok(text.parameters.text.length <= 4_096);
  assert.equal(text.parameters.text.isWellFormed(), true);
  assert.ok(text.parameters.text.endsWith('…'));
  assert.deepEqual(buttons(media.parameters), expectedButtons());
  assert.deepEqual(buttons(text.parameters), expectedButtons());
});

test('long custom copy still carries media and full text fallback is bounded', async () => {
  enqueue({ description: 'The real brand introduction.', imageUrl: 'https://images.example/logo.gif' });
  setTemplate(`{name}\n${'🎉'.repeat(2_100)}`);
  telegram.responses.push({ ok: false, code: 400, retryAfter: 0 }, { ok: true, result: { message_id: 126 } });
  await promotions.deliverTelegramPromotionOnce();
  const [media, text] = telegram.calls;
  assert.equal(media.method, 'sendAnimation');
  for (const [value, maximum] of [[media.parameters.caption, 1_024], [text.parameters.text, 4_096]]) {
    assert.ok(value.length <= maximum);
    assert.equal(value.isWellFormed(), true);
    assert.ok(value.endsWith('…'));
  }
  assert.deepEqual(buttons(media.parameters), expectedButtons());
  assert.deepEqual(buttons(text.parameters), expectedButtons());
});

test('missing or unsafe external links omit Join Now while safe trimmed destinations remain dynamic', async () => {
  for (const [index, link] of ['', 'javascript:alert(1)', 'https://user:password@brand.example/', 'https://brand.example/has space'].entries()) {
    const id = `unsafe-${index}`;
    enqueue({ id, slug: id, link });
    await promotions.deliverTelegramPromotionOnce();
    assert.deepEqual(buttons(telegram.calls.at(-1).parameters), expectedButtons({ page: `${origin}/${id}`, link: '' }));
    assert.equal(state(id).status, 'sent');
  }
  enqueue({ id: 'trimmed-link', slug: 'trimmed-link', link: '  https://brand.example/join  ' });
  await promotions.deliverTelegramPromotionOnce();
  assert.deepEqual(buttons(telegram.calls.at(-1).parameters), expectedButtons({ page: `${origin}/trimmed-link`, link: 'https://brand.example/join' }));
});

test('reserved or administrator slugs use the existing brand-anchor route in the brand button', async () => {
  for (const [index, slug] of ['login', 'api', 'fixture-admin'].entries()) {
    const id = `reserved-${index}`;
    enqueue({ id, slug });
    await promotions.deliverTelegramPromotionOnce();
    assert.deepEqual(buttons(telegram.calls.at(-1).parameters), expectedButtons({ page: `${origin}/#brand-card-${id}` }));
  }
});


const publicCard = {
  id: 'card-id', name: 'Syabas99', slug: 'syabas99', category: 'All',
  tagline: '', description: 'Public brand introduction.',
  link: 'https://brand.example/join?source=directory', imageUrl: 'https://images.example/logo.png',
};

test('brand-card authorization may cancel before preparation or after media preparation without sending', async () => {
  let checks = 0;
  const before = await sendTelegramBrandCard(token, chatId, publicCard, origin, {
    beforeSend: () => { checks++; return false; },
  });
  assert.equal(before, undefined);
  assert.equal(checks, 1);
  assert.equal(telegram.calls.length, 0);

  checks = 0;
  const after = await sendTelegramBrandCard(token, chatId, publicCard, origin, {
    beforeSend: () => ++checks < 2,
  });
  assert.equal(after, undefined);
  assert.equal(checks, 2);
  assert.equal(telegram.calls.length, 0);
});

test('brand-card authorization is checked again before rejected-media text fallback', async () => {
  let checks = 0;
  telegram.responses.push({ ok: false, code: 400, retryAfter: 0 });
  const response = await sendTelegramBrandCard(token, chatId, publicCard, origin, {
    beforeSend: () => ++checks < 3,
  });
  assert.equal(response, undefined);
  assert.equal(checks, 3);
  assert.equal(telegram.calls.length, 1);
  assert.equal(telegram.calls[0].method, 'sendPhoto');
});

test('All brand cards omit a promotion label and preserve topic/reply parameters on media and fallback', async () => {
  telegram.responses.push({ ok: false, code: 400, retryAfter: 0 }, { ok: true, result: { message_id: 321 } });
  const parameters = { message_thread_id: 77, reply_parameters: { message_id: 88, allow_sending_without_reply: false } };
  const result = await sendTelegramBrandCard(token, chatId, publicCard, origin, { parameters });
  assert.equal(result.ok, true);
  assert.equal(telegram.calls.length, 2);
  for (const call of telegram.calls) {
    assert.equal(call.parameters.message_thread_id, 77);
    assert.deepEqual(call.parameters.reply_parameters, parameters.reply_parameters);
    const copy = call.parameters.caption ?? call.parameters.text;
    assert.equal(copy, 'Syabas99\n\nPublic brand introduction.');
    assert.deepEqual(buttons(call.parameters), expectedButtons());
  }
});
