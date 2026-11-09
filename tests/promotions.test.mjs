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
  'app/lib/sqlite.ts', 'app/lib/directory.ts', 'app/lib/server-directory.ts',
  'app/lib/image-url.ts', 'app/lib/auth-core.ts', 'app/lib/session-store.ts',
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
const sqlite = require(path.join(fixture, 'app/lib/sqlite.js'));
const { brandInput } = require(path.join(fixture, 'app/api/admin/_validation.js'));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = path.join(fixture, 'data');
const now = 1_800_000_000_000;
const day = 86_400_000;

function fields(brand) { const { id: _id, ...input } = brand; return input; }
function example(id, extra = {}) {
  return { ...directory.seedBrands[0], id, slug: id, name: id, ...extra };
}

test('migrations preserve brand data and existing expiry without creating Telegram notifications for legacy brands', async () => {
  const currentDataDir = process.env.DATA_DIR;
  try {
    for (const version of [1, 2, 4]) {
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
      if (version === 4) {
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
      legacy.close();
      process.env.DATA_DIR = legacyPath;
      const saved = await repository.readDirectory(true, now);
      const upgraded = sqlite.getSqlite();
      assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 5);
      assert.equal(upgraded.prepare('SELECT COUNT(*) AS count FROM telegram_promotion_outbox').get().count, 0);
      assert.equal(saved.brands.length, 1, 'migration must not add demo brands to an existing site');
      assert.deepEqual(saved.brands[0], {
        id: 'original', name: 'Existing brand', slug: 'original', category: version === 4 ? 'New' : 'All',
        tagline: 'Original tagline', description: 'Original description', color: '#aabbcc', icon: 'sparkles',
        imageUrl: '/api/images/original.gif', featured: true, published: true, sortOrder: 73,
        link: 'https://brand.example', promotionDays: version === 4 ? 7 : null,
        promotionStartsAt: null, promotionExpiresAt: version === 4 ? now + 7 * day : null,
      });
      assert.equal(saved.settings.name, 'Existing site');
      assert.equal(saved.settings.coverImageUrl, version >= 2 ? '/cover.png' : '');
      assert.equal(saved.settings.avatarImageUrl, version >= 2 ? '/avatar.png' : '');
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

test('scheduled promotions appear in their category at start and return to All at expiry', async () => {
  const start = now + 3 * day;
  const expiry = start + 2 * day;
  const saved = repository.createBrand(example('scheduled', { category: 'Update', promotionDays: 2, promotionStartsAt: start, promotionExpiresAt: now + 100 * day }), now);
  assert.equal(saved.promotionStartsAt, start);
  assert.equal(saved.promotionExpiresAt, expiry);

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

test.after(() => {
  for (const db of globalThis.__directorySqlite?.values() || []) db.close();
  if (previousDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDataDir;
  rmSync(fixture, { recursive: true, force: true });
});
