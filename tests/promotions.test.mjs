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

test('v1/v2 migrations retain brand assets, text, ordering and status while mapping legacy categories to All', async () => {
  const currentDataDir = process.env.DATA_DIR;
  try {
    for (const version of [1, 2]) {
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
      if (version === 2) legacy.exec(`ALTER TABLE site_settings ADD COLUMN cover_image_url TEXT NOT NULL DEFAULT '';
        ALTER TABLE site_settings ADD COLUMN avatar_image_url TEXT NOT NULL DEFAULT '';
        UPDATE site_settings SET cover_image_url='/cover.png', avatar_image_url='/avatar.png';`);
      legacy.close();
      process.env.DATA_DIR = legacyPath;
      const saved = await repository.readDirectory(true, now);
      assert.equal(sqlite.getSqlite().prepare('PRAGMA user_version').get().user_version, 4);
      assert.equal(saved.brands.length, 1, 'migration must not add demo brands to an existing site');
      assert.deepEqual(saved.brands[0], {
        id: 'original', name: 'Existing brand', slug: 'original', category: 'All',
        tagline: 'Original tagline', description: 'Original description', color: '#aabbcc', icon: 'sparkles',
        imageUrl: '/api/images/original.gif', featured: true, published: true, sortOrder: 73,
        link: 'https://brand.example', promotionDays: null, promotionExpiresAt: null,
      });
      assert.equal(saved.settings.name, 'Existing site');
      assert.equal(saved.settings.coverImageUrl, version === 2 ? '/cover.png' : '');
      assert.equal(saved.settings.avatarImageUrl, version === 2 ? '/avatar.png' : '');
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
  assert.deepEqual([saved.category, saved.promotionDays, saved.promotionExpiresAt], ['All', null, null]);
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
  repository.createBrand(example('draft', { category: 'New', promotionDays: 1, published: false }), now);
  for (const time of [now, now + 10 * day]) {
    const data = await repository.readDirectory(false, time);
    assert.equal(data.brands.some(brand => brand.id === 'draft'), false);
    assert.equal(Object.getPrototypeOf(data.settings), Object.prototype);
    assert.deepEqual(JSON.parse(JSON.stringify(data)), data);
    for (const brand of data.brands) {
      assert.ok(['All', 'Update', 'New'].includes(brand.category));
      assert.ok(brand.promotionDays === null || Number.isInteger(brand.promotionDays));
      assert.ok(brand.promotionExpiresAt === null || Number.isSafeInteger(brand.promotionExpiresAt));
    }
  }
});

test.after(() => {
  for (const db of globalThis.__directorySqlite?.values() || []) db.close();
  if (previousDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDataDir;
  rmSync(fixture, { recursive: true, force: true });
});
