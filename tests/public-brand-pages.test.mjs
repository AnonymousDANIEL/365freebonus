import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

const fixture = mkdtempSync(path.join(tmpdir(), 'public-brand-pages-'));
writeFileSync(path.join(fixture, 'package.json'), '{"type":"commonjs"}');
for (const source of ['app/lib/directory.ts', 'app/lib/brand-links.ts', 'app/lib/public-brand-pages.ts',
  'app/lib/sqlite.ts', 'app/lib/server-directory.ts', 'app/lib/auth-core.ts', 'app/robots.ts', 'app/sitemap.ts']) {
  const output = path.join(fixture, source.replace(/\.ts$/, '.js'));
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, ts.transpileModule(readFileSync(new URL(`../${source}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText);
}
const require = createRequire(import.meta.url);
const { PUBLIC_SITE_URL, publicBrandDetailPath: detailPath } = require(path.join(fixture, 'app/lib/public-brand-pages.js'));
const repository = require(path.join(fixture, 'app/lib/server-directory.js'));
const { seedBrands } = require(path.join(fixture, 'app/lib/directory.js'));
const robots = require(path.join(fixture, 'app/robots.js')).default;
const sitemap = require(path.join(fixture, 'app/sitemap.js')).default;
const previousDataDir = process.env.DATA_DIR, previousAdminPath = process.env.ADMIN_PATH, previousAppUrl = process.env.APP_URL;
process.env.DATA_DIR = path.join(fixture, 'data');
process.env.ADMIN_PATH = '/private-fixture-panel';
process.env.APP_URL = 'https://untrusted-preview.invalid';
test.after(() => {
  for (const [key, value] of [['DATA_DIR', previousDataDir], ['ADMIN_PATH', previousAdminPath], ['APP_URL', previousAppUrl]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  for (const [filename, db] of globalThis.__directorySqlite || []) {
    if (filename.startsWith(fixture)) { db.close(); globalThis.__directorySqlite.delete(filename); }
  }
  rmSync(fixture, { recursive: true, force: true });
});
const now = Date.now();
function brand(overrides = {}) {
  return { id: 'real', name: 'Real Brand', slug: 'real-brand', category: 'All', promotionDays: null,
    promotionExpiresAt: null, promotionStartsAt: null, publishAt: null, published: true,
    tagline: 'Find provider information.', description: 'Real Brand provides details of account eligibility, verification requirements and provider terms for visitors in Malaysia.',
    color: '#112233', icon: 'sparkles', imageUrl: '', featured: false, sortOrder: 1, link: 'https://provider.invalid/', ...overrides };
}

test('one shared rule permits substantive public brand pages and excludes thin, draft, future and auth collisions', () => {
  const real = brand();
  assert.equal(detailPath(real, '/private-fixture-panel', now, [real]), '/real-brand');
  for (const changes of [{ published: false }, { publishAt: now + 1 }, { slug: 'private-fixture-panel' },
    { slug: 'login' }, { slug: 'api' }, { slug: '../secret' }, { slug: 'Real-Brand' }, { description: '' },
    { description: 'hello' }, { description: real.name }, { description: real.tagline }]) {
    assert.equal(detailPath(brand(changes), '/private-fixture-panel', now), null);
  }
  assert.equal(detailPath(brand({ publishAt: now }), '/private-fixture-panel', now), '/real-brand');
  assert.equal(detailPath(brand({ category: 'Update', promotionExpiresAt: now - 1 }), '/private-fixture-panel', now), '/real-brand');
  for (const demo of seedBrands) assert.equal(detailPath(demo, '/private-fixture-panel', now, seedBrands), null);
});

test('duplicate descriptions with only brand names replaced do not create indexable copies', () => {
  const first = brand();
  const second = brand({ id: 'other', name: 'Other Brand', slug: 'other-brand', description: first.description.replaceAll('Real Brand', 'Other Brand') });
  assert.equal(detailPath(first, '/private-fixture-panel', now, [first, second]), null);
  assert.equal(detailPath(second, '/private-fixture-panel', now, [first, second]), null);
  assert.equal(detailPath(first, '/private-fixture-panel', now, [first, { ...second, published: false }]), '/real-brand');
});

test('public annotation, detail lookup and sitemap share release schedules without exposing drafts or hidden auth paths', async () => {
  const real = repository.createBrand(brand(), now);
  const thin = repository.createBrand(brand({ id: 'thin', name: 'Thin Brand', slug: 'thin-brand', description: 'A short label.' }), now);
  const expired = repository.createBrand(brand({ id: 'expired', name: 'Expired Label', slug: 'expired-label', category: 'Update',
    description: 'Expired Label maintains a separate explanation of participation steps, current availability and limitations supplied by its provider.' }), now - 10 * 24 * 60 * 60_000);
  repository.createBrand(brand({ id: 'draft', name: 'Draft Brand', slug: 'draft-brand', published: false,
    description: 'This is private draft material that must never appear as a public brand page or in the public website map.' }), now);
  repository.createBrand(brand({ id: 'future', name: 'Future Brand', slug: 'future-brand', category: 'New',
    promotionStartsAt: now + 24 * 60 * 60_000, autoPublishAtStart: true,
    description: 'This future publication contains scheduled information which should only become visible after its configured release time.' }), now);
  repository.createBrand(brand({ id: 'collision', name: 'Private Collision', slug: 'private-fixture-panel',
    description: 'This brand cannot claim the authenticated management route or disclose that private route in public links.' }), now);
  const data = await repository.readDirectory(false, now, '/private-fixture-panel');
  assert.equal(data.brands.find(value => value.id === real.id)?.detailPath, '/real-brand');
  assert.equal(data.brands.find(value => value.id === thin.id)?.detailPath, undefined);
  assert.equal(data.brands.find(value => value.id === expired.id)?.category, 'All');
  assert.equal(data.brands.find(value => value.id === expired.id)?.detailPath, '/expired-label');
  assert.equal(data.brands.some(value => value.id === 'draft' || value.id === 'future'), false);
  assert.equal(repository.readPublicBrandBySlug('draft-brand', now), null);
  assert.equal(repository.readPublicBrandBySlug('future-brand', now), null);
  assert.equal(repository.readPublicBrandBySlug('thin-brand', now)?.id, thin.id);
  const administrative = await repository.readDirectory(true, now, '/private-fixture-panel');
  assert.equal(administrative.brands.some(value => value.detailPath !== undefined), false);
  const urls = await sitemap();
  assert.deepEqual(urls, [{ url: `${PUBLIC_SITE_URL}/` }, { url: `${PUBLIC_SITE_URL}/expired-label` }, { url: `${PUBLIC_SITE_URL}/real-brand` }]);
  assert.doesNotMatch(JSON.stringify(urls), /private-fixture-panel|draft-brand|future-brand|thin-brand|lastModified|untrusted-preview/);
});

test('robots allows public images through the API prefix while keeping sitemap canonical and auth path private', () => {
  const result = robots();
  assert.deepEqual(result.rules, { userAgent: '*', allow: ['/', '/api/images/'], disallow: '/api/' });
  assert.equal(result.sitemap, 'https://365freebonus.com/sitemap.xml');
  assert.doesNotMatch(JSON.stringify(result), /private-fixture-panel|untrusted-preview/);
});

test('sitemap propagates storage failures instead of serving an incomplete successful root-only map', async () => {
  const invalid = path.join(fixture, 'not-a-directory'); writeFileSync(invalid, 'fixture');
  process.env.DATA_DIR = invalid;
  try { await assert.rejects(sitemap()); }
  finally { process.env.DATA_DIR = path.join(fixture, 'data'); }
});
