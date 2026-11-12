import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';

// Exercise the real repository and schema in an isolated database, without
// touching the preview/production volume or needing administrator credentials.
const project = path.resolve(new URL('..', import.meta.url).pathname);
const fixture = mkdtempSync(path.join(tmpdir(), 'directory-promotions-'));
writeFileSync(path.join(fixture, 'package.json'), '{"type":"commonjs"}');
symlinkSync(path.join(project, 'node_modules'), path.join(fixture, 'node_modules'), 'dir');
for (const source of [
  'app/lib/sqlite.ts', 'app/lib/directory.ts', 'app/lib/server-directory.ts', 'app/lib/brand-links.ts', 'app/lib/brand-schedule-input.ts',
  'app/lib/image-url.ts', 'app/lib/auth-core.ts', 'app/lib/session-store.ts', 'app/lib/admin-credentials.ts',
  'app/chatgpt-auth.ts', 'app/api/admin/_security.ts', 'app/api/admin/_validation.ts',
]) {
  const target = path.join(fixture, source.replace(/\.ts$/, '.js'));
  mkdirSync(path.dirname(target), { recursive: true });
  const { outputText } = ts.transpileModule(readFileSync(path.join(project, source), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  writeFileSync(target, outputText);
}
const require = createRequire(import.meta.url);
const repository = require(path.join(fixture, 'app/lib/server-directory.js'));
const directory = require(path.join(fixture, 'app/lib/directory.js'));
const { brandScheduleInput, malaysiaDateTimeInput } = require(path.join(fixture, 'app/lib/brand-schedule-input.js'));
const { brandAnnouncementPath, brandAnchorPath, isBrandShortSlug } = require(path.join(fixture, 'app/lib/brand-links.js'));
const sqlite = require(path.join(fixture, 'app/lib/sqlite.js'));
const { brandInput } = require(path.join(fixture, 'app/api/admin/_validation.js'));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = path.join(fixture, 'data');
const now = 1_800_000_000_000;
const day = 86_400_000;

function fields(brand) { const { id: _id, publishAt: _publishAt, ...input } = brand; return input; }
function example(id, extra = {}) {
  return { ...directory.seedBrands[0], id, slug: id, name: id, ...extra };
}

test('migrations preserve brand data and existing expiry without creating Telegram notifications for legacy brands', async () => {
  const currentDataDir = process.env.DATA_DIR;
  try {
    for (const version of [1, 2, 4, 5, 6, 7, 8]) {
      const hasChatBot = version === 8;
      const legacyPath = path.join(fixture, `legacy-${version}`);
      mkdirSync(legacyPath);
      const legacy = new DatabaseSync(path.join(legacyPath, 'directory.sqlite'));
      legacy.exec(`CREATE TABLE brands (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL, tagline TEXT NOT NULL, description TEXT NOT NULL,
        color TEXT NOT NULL, icon TEXT NOT NULL, image_url TEXT NOT NULL DEFAULT '',
        featured INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0, link TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE site_settings (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, eyebrow TEXT NOT NULL, headline TEXT NOT NULL,
        description TEXT NOT NULL, announcement TEXT NOT NULL, contact_url TEXT NOT NULL DEFAULT ''
      );
      INSERT INTO site_settings VALUES ('primary', 'Existing site', 'Eyebrow', 'Headline', 'Description', 'Notice', '');
      INSERT INTO brands VALUES ('original', 'Existing brand', 'original', 'Gaming', 'Original tagline', 'Original description', '#aabbcc', 'sparkles', '/api/images/original.gif', 1, 1, 73, 'https://brand.example');
      PRAGMA user_version=${version};`);
      if (version >= 2) legacy.exec(`ALTER TABLE site_settings ADD COLUMN cover_image_url TEXT NOT NULL DEFAULT '';
        ALTER TABLE site_settings ADD COLUMN avatar_image_url TEXT NOT NULL DEFAULT '';
        UPDATE site_settings SET cover_image_url='/cover.png', avatar_image_url='/avatar.png';`);
      if (version >= 4) {
        legacy.exec(`ALTER TABLE brands ADD COLUMN promotion_days INTEGER DEFAULT NULL;
          ALTER TABLE brands ADD COLUMN promotion_expires_at INTEGER DEFAULT NULL;
          ALTER TABLE site_settings ADD COLUMN whatsapp_url TEXT NOT NULL DEFAULT '';
          ALTER TABLE site_settings ADD COLUMN whatsapp_enabled INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE site_settings ADD COLUMN telegram_url TEXT NOT NULL DEFAULT '';
          ALTER TABLE site_settings ADD COLUMN telegram_enabled INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE site_settings ADD COLUMN facebook_url TEXT NOT NULL DEFAULT '';
          ALTER TABLE site_settings ADD COLUMN facebook_enabled INTEGER NOT NULL DEFAULT 0;`);
        legacy.prepare("UPDATE brands SET category='New', promotion_days=7, promotion_expires_at=?").run(now + 7 * day);
      }
      if (version >= 5) {
        legacy.exec(`ALTER TABLE brands ADD COLUMN promotion_starts_at INTEGER DEFAULT NULL;
          CREATE TABLE telegram_promotion_outbox (
            brand_id TEXT PRIMARY KEY REFERENCES brands(id) ON DELETE CASCADE,
            revision TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
            last_error TEXT NOT NULL DEFAULT '', sent_at INTEGER, message_id INTEGER
          );
          CREATE TABLE telegram_promotion_settings (
            id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, chat_id TEXT NOT NULL, token_ciphertext TEXT NOT NULL
          );
          INSERT INTO telegram_promotion_outbox (brand_id, revision, attempts) VALUES ('original', 'legacy-revision', 2);`);
        legacy.prepare('UPDATE brands SET promotion_starts_at=?, promotion_expires_at=?').run(now + day, now + 8 * day);
        legacy.prepare(`INSERT INTO brands VALUES ('legacy-draft', 'Old draft', 'legacy-draft', 'Update', 'Draft', 'Draft',
          '#aabbcc', 'sparkles', '', 0, 0, 80, '', 1, ?, ?)`).run(now + 2 * day, now + day);
      }
      if (version >= 6) {
        legacy.exec(`ALTER TABLE brands ADD COLUMN publish_at INTEGER DEFAULT NULL;
          INSERT INTO telegram_promotion_settings (id, enabled, chat_id, token_ciphertext)
          VALUES ('primary', 1, '-10012345', 'existing-ciphertext');`);
        legacy.prepare("UPDATE brands SET publish_at=? WHERE id='original'").run(now + day);
      }
      if (version >= 7) {
        legacy.exec(`ALTER TABLE telegram_promotion_settings ADD COLUMN promotion_message TEXT NOT NULL DEFAULT '';
          ALTER TABLE telegram_promotion_settings ADD COLUMN welcome_enabled INTEGER NOT NULL DEFAULT 0 CHECK (welcome_enabled IN (0, 1));
          ALTER TABLE telegram_promotion_settings ADD COLUMN welcome_chat_id TEXT NOT NULL DEFAULT '';
          ALTER TABLE telegram_promotion_settings ADD COLUMN welcome_message TEXT NOT NULL DEFAULT '';
          ALTER TABLE telegram_promotion_settings ADD COLUMN welcome_started_at INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE telegram_promotion_settings ADD COLUMN welcome_revision TEXT NOT NULL DEFAULT '';
          CREATE TABLE telegram_welcome_state (
            id TEXT PRIMARY KEY, revision TEXT NOT NULL,
            next_offset INTEGER NOT NULL DEFAULT 0, last_polled_at INTEGER NOT NULL DEFAULT 0,
            next_poll_at INTEGER NOT NULL DEFAULT 0, lease_id TEXT NOT NULL DEFAULT '',
            lease_until INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 0,
            last_error TEXT NOT NULL DEFAULT ''
          );
          UPDATE telegram_promotion_settings SET promotion_message='Existing promotion message',
            welcome_enabled=1, welcome_chat_id='-10054321', welcome_message='Existing welcome message',
            welcome_started_at=1800000000, welcome_revision='legacy-welcome';
          INSERT INTO telegram_welcome_state (id, revision, next_offset, sent)
          VALUES ('primary', 'legacy-welcome', 12345, 3);`);
      }
      if (hasChatBot) {
        legacy.exec(`ALTER TABLE telegram_promotion_settings ADD COLUMN chat_bot_token_ciphertext TEXT NOT NULL DEFAULT '';
          ALTER TABLE telegram_promotion_settings ADD COLUMN keyword_enabled INTEGER NOT NULL DEFAULT 0 CHECK (keyword_enabled IN (0, 1));
          ALTER TABLE telegram_promotion_settings ADD COLUMN keyword_started_at INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE telegram_welcome_state ADD COLUMN keyword_replies INTEGER NOT NULL DEFAULT 0;
          CREATE TABLE telegram_keyword_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT, keyword TEXT NOT NULL, keyword_key TEXT NOT NULL,
            match_mode TEXT NOT NULL CHECK (match_mode IN ('exact', 'contains')),
            response TEXT NOT NULL, UNIQUE (keyword_key, match_mode)
          );
          UPDATE telegram_promotion_settings SET chat_bot_token_ciphertext='existing-chat-ciphertext',
            keyword_enabled=1, keyword_started_at=1800000001;
          UPDATE telegram_welcome_state SET last_polled_at=1800000002000, keyword_replies=5;
          INSERT INTO telegram_keyword_rules (id, keyword, keyword_key, match_mode, response)
          VALUES (7, 'Bonus', 'bonus', 'exact', 'Existing keyword response');`);
      }
      legacy.close();
      process.env.DATA_DIR = legacyPath;
      const saved = await repository.readDirectory(true, now);
      const upgraded = sqlite.getSqlite();
      assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 17);
      assert.equal(upgraded.prepare('SELECT COUNT(*) AS count FROM telegram_promotion_outbox').get().count, version >= 5 ? 1 : 0);
      assert.equal(upgraded.prepare('SELECT COUNT(*) AS count FROM telegram_private_contacts').get().count, 0);
      const runtime = upgraded.prepare("SELECT revision, next_offset, last_polled_at, sent, keyword_replies, private_replies FROM telegram_welcome_state WHERE id='primary'").get();
      assert.deepEqual(runtime && { ...runtime }, hasChatBot ? {
        revision: 'legacy-welcome', next_offset: 12345, last_polled_at: 1800000002000, sent: 3, keyword_replies: 5, private_replies: 0,
      } : undefined);
      const rules = upgraded.prepare('SELECT * FROM telegram_keyword_rules ORDER BY id').all().map(rule => ({ ...rule }));
      assert.deepEqual(rules, hasChatBot ? [
        { id: 7, keyword: 'Bonus', keyword_key: 'bonus', match_mode: 'exact', response: 'Existing keyword response', show_button: 1 },
      ] : []);
      if (version >= 6) {
        const settings = upgraded.prepare("SELECT * FROM telegram_promotion_settings WHERE id='primary'").get();
        assert.deepEqual({ ...settings }, {
          id: 'primary', enabled: 1, chat_id: '-10012345', token_ciphertext: 'existing-ciphertext',
          promotion_message: version >= 7 ? 'Existing promotion message' : '',
          welcome_enabled: Number(hasChatBot), welcome_chat_id: version >= 7 ? '-10054321' : '',
          welcome_message: version >= 7 ? 'Existing welcome message' : '',
          welcome_started_at: hasChatBot ? 1800000000 : 0, welcome_revision: hasChatBot ? 'legacy-welcome' : '',
          chat_bot_token_ciphertext: hasChatBot ? 'existing-chat-ciphertext' : '',
          keyword_enabled: Number(hasChatBot), keyword_started_at: hasChatBot ? 1800000001 : 0,
          private_enabled: 0, private_started_at: 0, private_start_message: '',
          private_followup_enabled: 0, private_followup_message: '', private_followup_started_at: 0, private_followup_revision: '',
          private_updates_enabled: 0, private_updates_started_at: 0, private_updates_revision: '',
        });
        const outbox = upgraded.prepare("SELECT revision, status, attempts FROM telegram_promotion_outbox WHERE brand_id='original'").get();
        assert.deepEqual({ ...outbox }, { revision: 'legacy-revision', status: 'pending', attempts: 2 });
      }
      assert.equal(saved.brands.length, version >= 5 ? 2 : 1, 'migration must not add demo brands to an existing site');
      assert.deepEqual(saved.brands[0], {
        id: 'original', name: 'Existing brand', slug: 'original', category: version >= 4 ? 'New' : 'All',
        tagline: 'Original tagline', description: 'Original description', color: '#aabbcc', icon: 'sparkles',
        imageUrl: '/api/images/original.gif', featured: true, published: true, sortOrder: 73,
        link: 'https://brand.example', promotionDays: version >= 4 ? 7 : null,
        promotionStartsAt: version >= 5 ? now + day : null,
        promotionExpiresAt: version >= 4 ? now + (version >= 5 ? 8 : 7) * day : null,
        publishAt: version >= 6 ? now + day : null,
      });
      assert.equal(saved.settings.name, 'Existing site');
      assert.equal(saved.settings.coverImageUrl, version >= 2 ? '/cover.png' : '');
      assert.equal(saved.settings.avatarImageUrl, version >= 2 ? '/avatar.png' : '');
      if (version === 5) {
        assert.equal(saved.brands[1].published, false);
        assert.equal(saved.brands[1].publishAt, null);
        const { brands, nextPublishAt } = await repository.readDirectory(false, now);
        assert.deepEqual(brands.map(brand => [brand.id, brand.category]), [['original', 'All']]);
        assert.equal(nextPublishAt, undefined);
        const afterStart = await repository.readDirectory(false, now + day);
        assert.deepEqual(afterStart.brands.map(brand => [brand.id, brand.category]), [['original', 'New']]);
        assert.deepEqual({ ...upgraded.prepare('SELECT revision, attempts FROM telegram_promotion_outbox').get() }, { revision: 'legacy-revision', attempts: 2 });
      }
    }
  } finally { process.env.DATA_DIR = currentDataDir; }
});

test('optional/legacy category inputs default to All and duration validation permits only whole days 1–365', () => {
  const body = fields(example('validation'));
  const { category: _category, promotionDays: _days, promotionExpiresAt: _expiry, ...legacyBody } = body;
  assert.equal(brandInput.parse(legacyBody).category, 'All');
  for (const category of ['Gaming', 'Lifestyle', 'Entertainment']) assert.equal(brandInput.parse({ ...legacyBody, category }).category, 'All');
  for (const days of [1, 7, 365]) assert.equal(brandInput.parse({ ...legacyBody, category: 'Update', promotionDays: days }).promotionDays, days);
  for (const promotionDays of [0, 366, 1.5, '7', Number.NaN]) assert.equal(brandInput.safeParse({ ...legacyBody, category: 'New', promotionDays }).success, false);
  const saved = repository.createBrand({ ...example('old-client'), category: undefined, promotionDays: undefined, promotionExpiresAt: undefined }, now);
  assert.deepEqual([saved.category, saved.promotionDays, saved.promotionStartsAt, saved.promotionExpiresAt], ['All', null, null, null]);
});

test('admin and public brand descriptions preserve the same 4000-character multiline copy across saves', async () => {
  const id = 'description-roundtrip';
  const descriptionFor = heading => {
    const beginning = `${heading}\n\n中文介绍 🎁 **原样文字**\n  保留段落内的空格\n\nhttps://brand.example/${'long-path-'.repeat(30)}\n\n`;
    const ending = '\n\n最后一段：继续发现 ✨';
    return beginning + 'A'.repeat(4000 - Array.from(beginning).length - Array.from(ending).length) + ending;
  };
  const original = descriptionFor('Original introduction');
  const latest = descriptionFor('Updated introduction');
  assert.equal(Array.from(original).length, 4000);
  assert.equal(Array.from(latest).length, 4000);

  const input = brandInput.parse(fields(example(id, { category: 'All', published: true, description: original })));
  const saved = repository.createBrand({ ...input, id }, now);
  assert.equal(saved.description, original);
  assert.equal(sqlite.getSqlite().prepare('SELECT description FROM brands WHERE id=?').get(id).description, original);
  for (const includeDrafts of [true, false]) {
    const payload = await repository.readDirectory(includeDrafts, now);
    assert.equal(payload.brands.find(brand => brand.id === id).description, original);
  }

  const update = brandInput.parse({ ...fields(saved), description: latest });
  const updated = repository.updateBrand(id, update, now + 1);
  assert.equal(updated.description, latest);
  assert.equal(sqlite.getSqlite().prepare('SELECT description FROM brands WHERE id=?').get(id).description, latest);
  for (const includeDrafts of [true, false]) {
    const payload = await repository.readDirectory(includeDrafts, now + 1);
    assert.equal(payload.brands.find(brand => brand.id === id).description, latest);
  }
  assert.equal(brandInput.safeParse({ ...fields(updated), description: latest + 'x' }).success, false);
});

test('public categories expire at the exact deadline while the published brand remains and admin sees the configured promotion', async () => {
  const saved = repository.createBrand(example('expires', { category: 'Update', promotionDays: 1, promotionExpiresAt: now + 900 * day }), now);
  assert.equal(saved.promotionExpiresAt, now + day, 'server must ignore a supplied expiry timestamp');
  const before = (await repository.readDirectory(false, now + day - 1)).brands.find(brand => brand.id === saved.id);
  const atDeadline = (await repository.readDirectory(false, now + day)).brands.find(brand => brand.id === saved.id);
  const admin = (await repository.readDirectory(true, now + day)).brands.find(brand => brand.id === saved.id);
  assert.equal(before.category, 'Update');
  assert.equal(atDeadline.category, 'All');
  assert.equal(atDeadline.published, true);
  assert.equal(atDeadline.imageUrl, saved.imageUrl);
  assert.equal(admin.category, 'Update');
  assert.equal(admin.promotionExpiresAt, now + day);
  assert.equal(directory.effectiveBrandCategory(saved, now + day), 'All');
});

test('ordinary saves, full-object retries and published/featured changes never extend expiry, even after expiry', () => {
  const original = repository.createBrand(example('unchanged', { category: 'New', promotionDays: 7 }), now);
  const originalDeadline = original.promotionExpiresAt;
  const fullSave = repository.updateBrand(original.id, { ...fields(original), tagline: 'Edited text', promotionExpiresAt: now + 1000 * day }, now + day);
  assert.equal(fullSave.promotionExpiresAt, originalDeadline);
  const { promotionDays: _days, promotionExpiresAt: _expiry, ...withoutPromotionDays } = fields(fullSave);
  const flagsSave = repository.updateBrand(original.id, { ...withoutPromotionDays, featured: false, published: false }, now + 2 * day);
  assert.equal(flagsSave.promotionExpiresAt, originalDeadline);
  const expiredSave = repository.updateBrand(original.id, { ...fields(flagsSave), published: true, promotionDays: 7 }, now + 20 * day);
  assert.equal(expiredSave.promotionExpiresAt, originalDeadline);
  assert.equal(directory.effectiveBrandCategory(expiredSave, now + 20 * day), 'All');
});

test('only category/duration changes restart expiry; repeating that request preserves its first deadline; All clears it', () => {
  const initial = repository.createBrand(example('restart', { category: 'New', promotionDays: undefined }), now);
  assert.equal(initial.promotionDays, 7);
  const changedDays = repository.updateBrand(initial.id, { ...fields(initial), promotionDays: 14 }, now + day);
  assert.equal(changedDays.promotionExpiresAt, now + 15 * day);
  const retry = repository.updateBrand(initial.id, { ...fields(initial), promotionDays: 14 }, now + 2 * day);
  assert.equal(retry.promotionExpiresAt, changedDays.promotionExpiresAt);
  const changedCategory = repository.updateBrand(initial.id, { ...fields(retry), category: 'Update' }, now + 3 * day);
  assert.equal(changedCategory.promotionExpiresAt, now + 17 * day);
  const cleared = repository.updateBrand(initial.id, { ...fields(changedCategory), category: 'All' }, now + 4 * day);
  assert.deepEqual([cleared.category, cleared.promotionDays, cleared.promotionExpiresAt], ['All', null, null]);
  assert.equal(cleared.id, initial.id);
});

test('drafts stay unpublished at and after expiry and returned props keep a normal serializable shape', async () => {
  repository.createBrand(example('draft', { category: 'New', promotionDays: 1, promotionStartsAt: now + day, published: false }), now);
  for (const time of [now, now + day, now + 10 * day]) {
    const data = await repository.readDirectory(false, time);
    assert.equal(data.brands.some(brand => brand.id === 'draft'), false);
    assert.equal(Object.getPrototypeOf(data.settings), Object.prototype);
    assert.deepEqual(JSON.parse(JSON.stringify(data)), data);
    for (const brand of data.brands) {
      assert.ok(['All', 'Update', 'New'].includes(brand.category));
      assert.ok(brand.promotionDays === null || Number.isInteger(brand.promotionDays));
      assert.ok(brand.promotionStartsAt === null || Number.isSafeInteger(brand.promotionStartsAt));
      assert.ok(brand.promotionExpiresAt === null || Number.isSafeInteger(brand.promotionExpiresAt));
    }
  }
});

test('an already public brand stays visible while its scheduled promotion starts and expires', async () => {
  const start = now + 3 * day;
  const expiry = start + 2 * day;
  const existing = repository.createBrand(example('scheduled'), now);
  const saved = repository.updateBrand(existing.id, { ...fields(existing), category: 'Update', promotionDays: 2, promotionStartsAt: start, promotionExpiresAt: now + 100 * day, autoPublishAtStart: true }, now);
  assert.equal(saved.promotionStartsAt, start);
  assert.equal(saved.promotionExpiresAt, expiry);
  assert.equal(saved.publishAt, null);

  const getBrand = async (time, admin = false) => (await repository.readDirectory(admin, time)).brands.find(brand => brand.id === saved.id);
  const pending = await getBrand(start - 1);
  assert.equal(pending.category, 'All');
  assert.equal(pending.scheduledCategory, 'Update');
  assert.equal(pending.published, true);
  assert.equal(directory.effectiveBrandCategory(pending, start - 1), 'All');
  assert.equal(directory.effectiveBrandCategory(pending, start), 'Update');
  assert.equal(directory.effectiveBrandCategory(pending, expiry), 'All');
  const admin = await getBrand(start - 1, true);
  assert.equal(admin.category, 'Update');
  assert.equal(admin.promotionStartsAt, start);
  assert.equal(admin.scheduledCategory, undefined);

  for (const time of [start, expiry - 1]) {
    const active = await getBrand(time);
    assert.equal(active.category, 'Update');
    assert.equal(active.scheduledCategory, undefined);
    assert.equal(directory.effectiveBrandCategory(saved, time), 'Update');
  }
  const expired = await getBrand(expiry);
  assert.equal(expired.category, 'All');
  assert.equal(expired.scheduledCategory, undefined);
  assert.equal(expired.published, true);
  assert.equal(directory.effectiveBrandCategory(saved, expiry), 'All');
});

test('scheduled publication exposes only the earliest deadline until each brand becomes public', async () => {
  const currentDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = path.join(fixture, 'scheduled-publication');
  try {
    const earlyStart = now + day;
    const lateStart = now + 2 * day;
    for (const [id, start, published] of [['later-hidden-brand', lateStart, false], ['earlier-hidden-brand', earlyStart, true]]) {
      const input = brandInput.parse({ ...fields(example(id, {
        category: 'New', promotionDays: 2, promotionStartsAt: start, published, featured: true,
        description: `Private description for ${id}`, link: `https://brand.example/${id}`,
      })), autoPublishAtStart: true });
      const saved = repository.createBrand({ ...input, id }, now);
      assert.equal(saved.publishAt, start);
      assert.equal(saved.published, true);
      assert.equal(Object.hasOwn(saved, 'autoPublishAtStart'), false);
    }

    const pending = await repository.readDirectory(false, earlyStart - 1);
    assert.equal(pending.nextPublishAt, earlyStart);
    assert.deepEqual(Object.keys(pending).sort(), ['brands', 'nextPublishAt', 'settings']);
    const publicPayload = JSON.stringify(pending);
    assert.equal(publicPayload.includes('hidden-brand'), false, 'unreleased brands must not leak content or featured cards');
    assert.equal(publicPayload.includes(String(lateStart)), false, 'only the earliest deadline is disclosed');
    const admin = await repository.readDirectory(true, earlyStart - 1);
    assert.equal(admin.brands.find(brand => brand.id === 'later-hidden-brand').publishAt, lateStart);
    assert.equal(admin.brands.find(brand => brand.id === 'earlier-hidden-brand').publishAt, earlyStart);

    const firstRelease = await repository.readDirectory(false, earlyStart);
    assert.equal(firstRelease.nextPublishAt, lateStart);
    assert.equal(firstRelease.brands.some(brand => brand.id === 'later-hidden-brand'), false);
    const released = firstRelease.brands.find(brand => brand.id === 'earlier-hidden-brand');
    assert.equal(released.category, 'New');
    assert.equal(released.featured, true);
    assert.equal(Object.hasOwn(released, 'publishAt'), false);
    const secondRelease = await repository.readDirectory(false, lateStart);
    assert.equal(secondRelease.brands.find(brand => brand.id === 'later-hidden-brand').category, 'New');
    assert.equal(Object.hasOwn(secondRelease, 'nextPublishAt'), false);
    const originalLater = admin.brands.find(brand => brand.id === 'later-hidden-brand');
    const replayed = repository.updateBrand(originalLater.id, {
      ...fields(originalLater), published: false, autoPublishAtStart: true,
    }, lateStart + 1);
    assert.equal(replayed.published, true, 'a retry of scheduling intent after release must not hide the brand');
    assert.equal(replayed.publishAt, lateStart);

    const afterExpiry = await repository.readDirectory(false, lateStart + 2 * day);
    assert.equal(afterExpiry.brands.find(brand => brand.id === 'earlier-hidden-brand').category, 'All');
    assert.equal(afterExpiry.brands.find(brand => brand.id === 'later-hidden-brand').category, 'All');
  } finally { process.env.DATA_DIR = currentDataDir; }
});

test('draft scheduling intent is explicit and a pending publication can be retried, moved, or unpublished', async () => {
  const start = now + day;
  const draft = repository.createBrand(example('pending-draft', { category: 'Update', promotionStartsAt: start, published: false }), now);
  assert.equal(draft.publishAt, null);
  const ordinary = repository.updateBrand(draft.id, { ...fields(draft), tagline: 'Draft edit' }, now + 1);
  assert.equal(ordinary.published, false);
  assert.equal(ordinary.publishAt, null);

  const input = brandInput.parse({ ...fields(ordinary), promotionStartsAt: start + day, autoPublishAtStart: true });
  const scheduled = repository.updateBrand(draft.id, input, now + 2);
  assert.equal(scheduled.published, true);
  assert.equal(scheduled.publishAt, start + day);
  assert.equal(Object.hasOwn(scheduled, 'autoPublishAtStart'), false);
  const retry = repository.updateBrand(draft.id, input, now + 3);
  assert.deepEqual(retry, scheduled);

  const moved = repository.updateBrand(draft.id, { ...fields(retry), promotionStartsAt: start + 2 * day }, now + 4);
  assert.equal(moved.publishAt, start + 2 * day);
  assert.equal((await repository.readDirectory(false, start + day)).brands.some(brand => brand.id === draft.id), false);

  const unpublished = repository.updateBrand(draft.id, { ...fields(moved), published: false }, now + 5);
  assert.equal(unpublished.publishAt, null);
  assert.equal(unpublished.promotionStartsAt, moved.promotionStartsAt);
  assert.equal(unpublished.published, false);
  assert.equal((await repository.readDirectory(false, moved.publishAt)).brands.some(brand => brand.id === draft.id), false);
});

test('the editor can save the current Malaysia minute and the server publishes an already due explicit schedule', async () => {
  const currentDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = path.join(fixture, 'current-minute-publication');
  try {
    const requestedStart = now;
    const saveTime = requestedStart + 3_000;
    const input = brandInput.parse({ ...fields(example('current-minute', { category: 'New', published: false, promotionDays: 2 })),
      ...brandScheduleInput({ category: 'New', published: false }, undefined, malaysiaDateTimeInput(requestedStart)) });
    assert.equal(input.autoPublishAtStart, true);
    const saved = repository.createBrand({ ...input, id: 'current-minute' }, saveTime);
    assert.equal(saved.published, true);
    assert.equal(saved.publishAt, requestedStart);
    assert.equal(saved.promotionStartsAt, requestedStart);
    assert.equal(saved.promotionExpiresAt, requestedStart + 2 * day);
    const pending = await repository.readDirectory(false, requestedStart - 1);
    assert.equal(pending.brands.some(brand => brand.id === saved.id), false);
    assert.equal(pending.nextPublishAt, requestedStart);
    const due = await repository.readDirectory(false, requestedStart);
    assert.equal(due.brands.find(brand => brand.id === saved.id).category, 'New');
    assert.equal(due.nextPublishAt, undefined);
    assert.equal((await repository.readDirectory(false, saveTime)).brands.some(brand => brand.id === saved.id), true);
    assert.equal((await repository.readDirectory(false, saved.promotionExpiresAt)).brands.find(brand => brand.id === saved.id).category, 'All');
  } finally { process.env.DATA_DIR = currentDataDir; }
});

test('a schedule request crossing its deadline remains idempotent and a later explicit unpublish stays hidden', async () => {
  const currentDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = path.join(fixture, 'crossed-publication-deadline');
  try {
    const draft = repository.createBrand(example('crossing-draft', { published: false }), now);
    const requestedStart = now + 60_000;
    const editing = { ...fields(draft), category: 'Update', published: false, promotionDays: 3 };
    const input = brandInput.parse({ ...editing,
      ...brandScheduleInput(editing, draft, malaysiaDateTimeInput(requestedStart)) });
    const saved = repository.updateBrand(draft.id, input, requestedStart + 1_000);
    assert.equal(saved.publishAt, requestedStart);
    assert.equal(saved.promotionExpiresAt, requestedStart + 3 * day);
    assert.equal((await repository.readDirectory(false, requestedStart + 1_000)).brands.find(brand => brand.id === saved.id).category, 'Update');
    const readJob = sqlite.getSqlite().prepare('SELECT revision FROM telegram_promotion_outbox WHERE brand_id=?');
    const revision = readJob.get(saved.id).revision;
    const replayed = repository.updateBrand(saved.id, input, requestedStart + 10 * 60_000);
    assert.deepEqual(replayed, saved, 'a retry after the grace window preserves a previously accepted schedule');
    assert.equal(readJob.get(saved.id).revision, revision);

    const unpublishing = { ...fields(replayed), published: false };
    const cancelPayload = brandInput.parse({ ...unpublishing,
      ...brandScheduleInput(unpublishing, replayed, malaysiaDateTimeInput(requestedStart)) });
    assert.equal(cancelPayload.autoPublishAtStart, undefined);
    const cancelled = repository.updateBrand(saved.id, cancelPayload, requestedStart + 11 * 60_000);
    assert.equal(cancelled.published, false);
    assert.equal(cancelled.publishAt, null);
    assert.equal(cancelled.promotionStartsAt, requestedStart);
    assert.equal((await repository.readDirectory(false, requestedStart + day)).brands.some(brand => brand.id === saved.id), false);
  } finally { process.env.DATA_DIR = currentDataDir; }
});

test('recent-past grace requires explicit automatic publication and older schedules fail without changing saved data', async () => {
  assert.equal(directory.PROMOTION_START_GRACE_MS, 120_000);
  const graceStart = now - directory.PROMOTION_START_GRACE_MS;
  const accepted = repository.createBrand(example('grace-edge', {
    category: 'New', published: false, promotionStartsAt: graceStart, autoPublishAtStart: true,
  }), now);
  assert.equal(accepted.published, true);
  assert.equal(accepted.publishAt, graceStart);
  assert.equal(accepted.promotionExpiresAt, graceStart + 7 * day);
  for (const autoPublishAtStart of [undefined, false]) {
    assert.throws(() => repository.createBrand(example(`no-grace-${String(autoPublishAtStart)}`, {
      category: 'New', published: false, promotionStartsAt: now - 1, autoPublishAtStart,
    }), now), directory.PromotionValidationError);
  }
  const tooOld = graceStart - 1;
  assert.throws(() => repository.createBrand(example('grace-too-old-create', {
    category: 'New', published: false, promotionStartsAt: tooOld, autoPublishAtStart: true,
  }), now), directory.PromotionValidationError);
  const original = repository.createBrand(example('grace-too-old-update', { category: 'New', promotionStartsAt: now + day }), now);
  const db = sqlite.getSqlite();
  const job = db.prepare('SELECT * FROM telegram_promotion_outbox WHERE brand_id=?').get(original.id);
  assert.throws(() => repository.updateBrand(original.id, { ...fields(original), name: 'Must remain unchanged',
    promotionStartsAt: tooOld, autoPublishAtStart: true }, now), directory.PromotionValidationError);
  assert.deepEqual((await repository.readDirectory(true, now)).brands.find(brand => brand.id === original.id), original);
  assert.deepEqual(db.prepare('SELECT * FROM telegram_promotion_outbox WHERE brand_id=?').get(original.id), job);
  assert.equal(db.prepare('SELECT 1 FROM brands WHERE id=?').get('grace-too-old-create'), undefined);
});

test('unchanged draft dates require explicit editor publishing intent and do not override later cancellation', async () => {
  const currentDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = path.join(fixture, 'unchanged-editor-schedule');
  try {
    const start = now + day;
    const draft = repository.createBrand(example('unchanged-draft-date', { category: 'Update', promotionStartsAt: start, published: false }), now);
    const dateInput = malaysiaDateTimeInput(start);
    const ordinaryPayload = brandInput.parse({ ...fields(draft), tagline: 'Only edit the description',
      ...brandScheduleInput(draft, draft, dateInput) });
    assert.equal(ordinaryPayload.autoPublishAtStart, undefined);
    const unchanged = repository.updateBrand(draft.id, ordinaryPayload, now + 1);
    assert.equal(unchanged.published, false);
    assert.equal((await repository.readDirectory(false, start)).brands.some(brand => brand.id === draft.id), false);

    const editing = { ...fields(unchanged), published: true };
    const schedulePayload = brandInput.parse({ ...editing, ...brandScheduleInput(editing, unchanged, dateInput) });
    assert.equal(schedulePayload.promotionStartsAt, start);
    assert.equal(schedulePayload.autoPublishAtStart, true);
    const scheduled = repository.updateBrand(draft.id, schedulePayload, now + 2);
    assert.equal(scheduled.publishAt, start);
    const pending = await repository.readDirectory(false, start - 1);
    assert.equal(pending.nextPublishAt, start);
    assert.equal(pending.brands.some(brand => brand.id === draft.id), false);
    assert.equal((await repository.readDirectory(false, start)).brands.find(brand => brand.id === draft.id).category, 'Update');

    const unchecked = { ...fields(scheduled), published: false };
    const cancelled = repository.updateBrand(draft.id, { ...unchecked,
      ...brandScheduleInput(unchecked, scheduled, dateInput) }, now + 3);
    assert.equal(cancelled.publishAt, null);
    const afterCancel = await repository.readDirectory(false, start);
    assert.equal(afterCancel.nextPublishAt, undefined);
    assert.equal(afterCancel.brands.some(brand => brand.id === draft.id), false);
    const clearing = brandScheduleInput({ category: 'Update', published: true }, scheduled, '');
    assert.deepEqual(clearing, { promotionStartsAt: null });
  } finally { process.env.DATA_DIR = currentDataDir; }
});

test('clearing the schedule of a pending published brand releases it immediately', async () => {
  const start = now + 6 * day;
  const scheduled = repository.createBrand(example('released-early', {
    category: 'Update', promotionStartsAt: start, promotionDays: 2, published: false, autoPublishAtStart: true,
  }), now);
  assert.equal(scheduled.publishAt, start);
  const releaseTime = now + 1;
  const released = repository.updateBrand(scheduled.id, { ...fields(scheduled), promotionStartsAt: null }, releaseTime);
  assert.equal(released.published, true);
  assert.equal(released.publishAt, null);
  assert.equal(released.promotionExpiresAt, releaseTime + 2 * day);
  const visible = (await repository.readDirectory(false, releaseTime)).brands.find(brand => brand.id === released.id);
  assert.equal(visible.category, 'Update');
});

test('scheduled saves preserve omitted and unchanged starts while explicit null makes a promotion immediate', () => {
  const start = now + 3 * day;
  const scheduled = repository.createBrand(example('edit-schedule', { category: 'New', promotionDays: 2, promotionStartsAt: start }), now);
  const { promotionStartsAt: _start, ...withoutStart } = fields(scheduled);
  const ordinary = repository.updateBrand(scheduled.id, { ...withoutStart, tagline: 'Updated before start' }, now + day);
  assert.equal(ordinary.promotionStartsAt, start);
  assert.equal(ordinary.promotionExpiresAt, scheduled.promotionExpiresAt);
  const changedDuration = repository.updateBrand(scheduled.id, { ...withoutStart, promotionDays: 5 }, now + day);
  assert.equal(changedDuration.promotionStartsAt, start);
  assert.equal(changedDuration.promotionExpiresAt, start + 5 * day);

  const afterStart = start + day;
  const samePastStart = repository.updateBrand(scheduled.id, { ...fields(changedDuration), tagline: 'Updated after start' }, afterStart);
  assert.equal(samePastStart.promotionStartsAt, start);
  assert.equal(samePastStart.promotionExpiresAt, changedDuration.promotionExpiresAt);

  const immediate = repository.updateBrand(scheduled.id, { ...fields(samePastStart), promotionStartsAt: null }, afterStart);
  assert.equal(immediate.promotionStartsAt, null);
  assert.equal(immediate.promotionExpiresAt, afterStart + 5 * day);
  const retry = repository.updateBrand(scheduled.id, { ...fields(immediate), promotionStartsAt: null }, afterStart + 1);
  assert.equal(retry.promotionExpiresAt, immediate.promotionExpiresAt);
  const cleared = repository.updateBrand(scheduled.id, { ...fields(retry), category: 'All', promotionStartsAt: start + 30 * day }, afterStart + 2);
  assert.deepEqual([cleared.category, cleared.promotionDays, cleared.promotionStartsAt, cleared.promotionExpiresAt], ['All', null, null, null]);
});

test('invalid scheduled starts are rejected before brand or notification changes are committed', async () => {
  const body = fields(example('validation', { category: 'New' }));
  for (const promotionStartsAt of [-1, 0, 1.5, '1800000000000', Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(brandInput.safeParse({ ...body, promotionStartsAt }).success, false);
  }
  assert.equal(brandInput.parse({ ...body, promotionStartsAt: null }).promotionStartsAt, null);
  assert.equal(brandInput.parse({ ...body, promotionStartsAt: now }).promotionStartsAt, now);
  assert.throws(() => repository.createBrand(example('invalid-past-start', { category: 'New', promotionStartsAt: now - 1 }), now), directory.PromotionValidationError);
  assert.equal((await repository.readDirectory(true, now)).brands.some(brand => brand.id === 'invalid-past-start'), false);

  const original = repository.createBrand(example('invalid-reschedule', { category: 'New', promotionStartsAt: now + day }), now);
  const db = sqlite.getSqlite();
  const readJob = db.prepare('SELECT * FROM telegram_promotion_outbox WHERE brand_id=?');
  const originalJob = readJob.get(original.id);
  assert.throws(() => repository.updateBrand(original.id, { ...fields(original), name: 'Must not save', promotionStartsAt: now - 1 }, now), directory.PromotionValidationError);
  assert.deepEqual((await repository.readDirectory(true, now)).brands.find(brand => brand.id === original.id), original);
  assert.deepEqual(readJob.get(original.id), originalJob);
  assert.equal(readJob.get('invalid-past-start'), undefined);
});

test('older clients reassign elapsed scheduled promotions to start immediately', () => {
  const saved = repository.createBrand(example('reassign-expired', { category: 'New', promotionDays: 1, promotionStartsAt: now + day }), now);
  const { promotionStartsAt: _start, ...previousFields } = fields(saved);
  const afterExpiry = saved.promotionExpiresAt + 1;
  const readJob = sqlite.getSqlite().prepare('SELECT revision FROM telegram_promotion_outbox WHERE brand_id=?');
  const initialRevision = readJob.get(saved.id).revision;
  const input = { ...previousFields, category: 'Update' };
  const reassigned = repository.updateBrand(saved.id, input, afterExpiry);
  assert.equal(reassigned.promotionStartsAt, null);
  assert.equal(reassigned.promotionExpiresAt, afterExpiry + day);
  assert.equal(directory.effectiveBrandCategory(reassigned, afterExpiry), 'Update');
  const revision = readJob.get(saved.id).revision;
  assert.notEqual(revision, initialRevision);
  assert.equal(repository.updateBrand(saved.id, input, afterExpiry + 1).promotionExpiresAt, reassigned.promotionExpiresAt);
  assert.equal(readJob.get(saved.id).revision, revision);
});

test('the Telegram outbox tracks category and start revisions and removes cancelled promotions', () => {
  const db = sqlite.getSqlite();
  const readJob = db.prepare('SELECT * FROM telegram_promotion_outbox WHERE brand_id=?');
  const saved = repository.createBrand(example('notification', { category: 'Update', promotionDays: 2, promotionStartsAt: now + day }), now);
  const initialJob = readJob.get(saved.id);
  assert.equal(initialJob.status, 'pending');
  assert.ok(initialJob.revision);
  assert.equal(initialJob.attempts, 0);
  db.prepare("UPDATE telegram_promotion_outbox SET status='sent', attempts=1, sent_at=?, message_id=101 WHERE brand_id=?").run(now, saved.id);
  const deliveredJob = readJob.get(saved.id);

  const ordinary = repository.updateBrand(saved.id, { ...fields(saved), name: 'Edited', promotionDays: 4, published: false, featured: false }, now + 1);
  assert.deepEqual(readJob.get(saved.id), deliveredJob, 'content, duration and publication changes must not resend a delivered notification');
  const moved = repository.updateBrand(saved.id, { ...fields(ordinary), promotionStartsAt: now + 2 * day }, now + 2);
  const movedJob = readJob.get(saved.id);
  assert.notEqual(movedJob.revision, initialJob.revision);
  assert.equal(movedJob.status, 'pending');
  assert.equal(movedJob.attempts, 0);
  assert.equal(movedJob.sent_at, null);
  assert.equal(movedJob.message_id, null);
  const retry = repository.updateBrand(saved.id, fields(moved), now + 3);
  assert.deepEqual(readJob.get(saved.id), movedJob);

  const changedCategory = repository.updateBrand(saved.id, { ...fields(retry), category: 'New' }, now + 4);
  const categoryJob = readJob.get(saved.id);
  assert.notEqual(categoryJob.revision, movedJob.revision);
  assert.equal(categoryJob.status, 'pending');
  const cancelled = repository.updateBrand(saved.id, { ...fields(changedCategory), category: 'All' }, now + 5);
  assert.equal(readJob.get(saved.id), undefined);

  repository.updateBrand(saved.id, { ...fields(cancelled), category: 'New' }, now + 6);
  assert.equal(readJob.get(saved.id).status, 'pending');
  assert.equal(repository.deleteBrand(saved.id), true);
  assert.equal(readJob.get(saved.id), undefined);
});

test('extending an expired promotion that becomes active queues one new notification', () => {
  const db = sqlite.getSqlite();
  const readJob = db.prepare('SELECT revision, status FROM telegram_promotion_outbox WHERE brand_id=?');
  for (const [id, promotionStartsAt] of [['reactivate-immediate', null], ['reactivate-scheduled', now + day]]) {
    const saved = repository.createBrand(example(id, { category: 'New', promotionDays: 1, promotionStartsAt }), now);
    db.prepare("UPDATE telegram_promotion_outbox SET status='sent' WHERE brand_id=?").run(id);
    const original = readJob.get(id);
    const active = repository.updateBrand(id, { ...fields(saved), promotionDays: 2 }, promotionStartsAt ?? now);
    assert.deepEqual(readJob.get(id), original, 'an active duration edit must not announce again');
    const afterExpiry = active.promotionExpiresAt + 1;
    const input = { ...fields(active), promotionDays: 3 };
    const restarted = repository.updateBrand(id, input, afterExpiry);
    assert.equal(directory.effectiveBrandCategory(restarted, afterExpiry), 'New');
    const queued = readJob.get(id);
    assert.notEqual(queued.revision, original.revision);
    assert.equal(queued.status, 'pending');
    repository.updateBrand(id, input, afterExpiry + 1);
    assert.deepEqual(readJob.get(id), queued, 'retry must keep the first reactivation revision');
  }
});

test('brand short links use the saved slug and respect the publication gate', () => {
  const adminPath = '/secret-admin';
  const brand = repository.createBrand(example('short-link-id', { name: 'Unrelated Brand Name', slug: 'custom-public-slug' }), now);
  const anchor = '/#brand-card-short-link-id';
  assert.equal(brandAnchorPath(brand.id), anchor);
  assert.equal(brandAnnouncementPath(brand.slug, brand.id, adminPath), '/custom-public-slug');
  assert.equal(repository.readPublicBrandIdBySlug(brand.slug, now), brand.id);
  assert.equal(repository.readPublicBrandIdBySlug('unrelated-brand-name', now), null);
  assert.equal(repository.readPublicBrandIdBySlug('unknown-short-link', now), null);

  for (const slug of ['admin', 'login', 'api', 'secret-admin', '', 'Uppercase', 'a--b', 'a/b', 'a%2Fb', 'a'.repeat(101)]) {
    assert.equal(isBrandShortSlug(slug, adminPath), false, slug);
    assert.equal(brandAnnouncementPath(slug, brand.id, adminPath), anchor);
  }
  assert.equal(isBrandShortSlug('a'.repeat(100), adminPath), true);

  const draft = repository.createBrand(example('short-link-draft', { published: false }), now);
  const start = now + day;
  const scheduled = repository.createBrand(example('short-link-scheduled', {
    category: 'New', promotionStartsAt: start, published: false, autoPublishAtStart: true,
  }), now);
  assert.equal(repository.readPublicBrandIdBySlug(draft.slug, start), null);
  assert.equal(repository.readPublicBrandIdBySlug(scheduled.slug, start - 1), null);
  assert.equal(repository.readPublicBrandIdBySlug(scheduled.slug, start), scheduled.id);
});

test.after(() => {
  for (const db of globalThis.__directorySqlite?.values() || []) db.close();
  if (previousDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDataDir;
  rmSync(fixture, { recursive: true, force: true });
});
