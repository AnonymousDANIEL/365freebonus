import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { scryptSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';

// Compile the actual server modules in an isolated fixture, so persistence and
// auth checks can run without a Next request context or touching app data.
const fixture = mkdtempSync(path.join(tmpdir(), 'directory-backend-'));
writeFileSync(path.join(fixture, 'package.json'), '{"type":"commonjs"}');
for (const name of ['sqlite', 'directory', 'server-directory', 'auth-core', 'session-store', 'image-url', 'image-media']) {
  const source = readFileSync(new URL(`../app/lib/${name}.ts`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } });
  writeFileSync(path.join(fixture, `${name}.js`), outputText);
}
const require = createRequire(import.meta.url);
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = path.join(fixture, 'data');
const directory = require(path.join(fixture, 'server-directory.js'));
const auth = require(path.join(fixture, 'auth-core.js'));
const sessions = require(path.join(fixture, 'session-store.js'));
const sqlite = require(path.join(fixture, 'sqlite.js'));
const { isSafeImageUrl } = require(path.join(fixture, 'image-url.js'));
const images = require(path.join(fixture, 'image-media.js'));
const salt = '0123456789abcdef0123456789abcdef';
const password = 'a-long-fixture-password';
const config = { username: 'admin', passwordHash: `scrypt$${salt}$${scryptSync(password, Buffer.from(salt, 'hex'), 64).toString('hex')}`, secret: 'fixture-session-secret-with-more-than-32-characters' };

test('credentials and session integrity reject wrong password, tampering, expiry and revocation', async () => {
  assert.equal(await auth.verifyCredentials('admin', password, config), true);
  assert.equal(await auth.verifyCredentials('admin', 'wrong-password', config), false);
  assert.equal(await auth.verifyCredentials('stranger', password, config), false);
  const { token, payload } = auth.issueSession(config);
  assert.equal(auth.verifySession(token, config)?.sub, 'admin');
  const altered = `${token.split('.')[0]}.invalid`;
  assert.equal(auth.verifySession(altered, config), null);
  assert.equal(auth.verifySession(token, config, payload.exp), null);
  sessions.saveSession(payload);
  assert.equal(sessions.sessionIsActive(payload), true);
  sessions.revokeSession(payload);
  assert.equal(sessions.sessionIsActive(payload), false);
});

test('authentication has no default password and CSRF does not trust forwarded host', () => {
  const previous = { ADMIN_PASSWORD_HASH: process.env.ADMIN_PASSWORD_HASH, ADMIN_PATH: process.env.ADMIN_PATH, SESSION_SECRET: process.env.SESSION_SECRET, APP_URL: process.env.APP_URL, RAILWAY_PUBLIC_DOMAIN: process.env.RAILWAY_PUBLIC_DOMAIN, NODE_ENV: process.env.NODE_ENV };
  try {
    delete process.env.ADMIN_PASSWORD_HASH; delete process.env.SESSION_SECRET;
    assert.equal(auth.authConfig(), null);
    process.env.ADMIN_PASSWORD_HASH = config.passwordHash; process.env.SESSION_SECRET = config.secret;
    assert.equal(auth.authConfig()?.username, 'admin');
    process.env.NODE_ENV = 'production'; delete process.env.APP_URL; delete process.env.RAILWAY_PUBLIC_DOMAIN;
    const request = new Request('http://internal:3000/api/admin/brands', { headers: { Origin: 'https://attacker.test', 'X-Forwarded-Host': 'attacker.test' } });
    assert.equal(auth.hasValidOrigin(request), false);
    process.env.APP_URL = 'https://directory.example';
    assert.equal(auth.hasValidOrigin(request), false);
    assert.equal(auth.hasValidOrigin(new Request('http://internal:3000/api/admin/brands', { headers: { Origin: 'https://directory.example' } })), true);
    delete process.env.ADMIN_PATH;
    assert.equal(auth.safeReturnPath(undefined), '/admin');
    process.env.ADMIN_PATH = '/dashboard-fixture';
    assert.equal(auth.safeReturnPath('//attacker.test'), '/dashboard-fixture');
    assert.equal(auth.safeReturnPath('/.//attacker.test'), '/dashboard-fixture');
    assert.equal(auth.safeReturnPath('/\\attacker.test'), '/dashboard-fixture');
    assert.equal(auth.safeReturnPath(undefined), '/dashboard-fixture');
    assert.equal(auth.safeReturnPath('/dashboard-fixture?tab=settings'), '/dashboard-fixture?tab=settings');
    assert.equal(auth.safeReturnPath('/admin?tab=settings'), '/dashboard-fixture?tab=settings');
  } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});

test('DB login limiter caps attempts, resets after its window and ignores prepended IP spoofing', () => {
  const key = 'fixture-ip';
  const now = Date.now();
  for (let attempt = 0; attempt < 8; attempt++) assert.equal(sessions.consumeLoginAttempt(key, now).allowed, true);
  assert.equal(sessions.consumeLoginAttempt(key, now).allowed, false);
  assert.equal(sessions.consumeLoginAttempt(key, now + 15 * 60 * 1000 + 1).allowed, true);
  const a = new Request('http://local', { headers: { 'x-forwarded-for': '198.51.100.2, 203.0.113.4' } });
  const b = new Request('http://local', { headers: { 'x-forwarded-for': '192.0.2.7, 203.0.113.4' } });
  assert.equal(sessions.clientIpKey(a), sessions.clientIpKey(b));
});

test('directory props are plain serializable objects for the Next server/client boundary', async () => {
  const data = await directory.readDirectory(true);
  assert.equal(Object.getPrototypeOf(data), Object.prototype, 'directory envelope must be plain');
  assert.equal(Object.getPrototypeOf(data.settings), Object.prototype, 'SQLite settings rows must be converted to plain objects');
  assert.equal(Object.getPrototypeOf(data.brands), Array.prototype);
  assert.ok(data.brands.length > 0);
  for (const brand of data.brands) {
    assert.equal(Object.getPrototypeOf(brand), Object.prototype, 'SQLite brand rows must be converted to plain objects');
    assert.equal(typeof brand.featured, 'boolean');
    assert.equal(typeof brand.published, 'boolean');
    assert.equal(typeof brand.sortOrder, 'number');
  }
  assert.deepEqual(JSON.parse(JSON.stringify(data)), data, 'props must survive a JSON boundary without losing values or types');
});

test('directory CRUD persists, excludes drafts and never resurrects deleted rows', async () => {
  const initial = await directory.readDirectory(true);
  assert.ok(initial.brands.length > 0);
  const sample = { ...initial.brands[0], id: 'fixture-brand', slug: 'fixture-brand', name: 'Fixture brand', published: false, sortOrder: 0 };
  const created = directory.createBrand(sample);
  assert.equal(Object.getPrototypeOf(created), Object.prototype);
  assert.equal((await directory.readDirectory()).brands.some(brand => brand.id === sample.id), false);
  const { id: _id, ...fields } = sample;
  const updated = directory.updateBrand(sample.id, { ...fields, published: true });
  assert.equal(Object.getPrototypeOf(updated), Object.prototype);
  assert.equal((await directory.readDirectory()).brands[0].id, sample.id);
  assert.throws(() => directory.createBrand({ ...sample, id: 'duplicate-slug' }), /UNIQUE/);
  const settings = { ...initial.settings, headline: 'Line one\nLine two' };
  directory.updateSettings(settings);
  const persistedHeadline = execFileSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(fixture, 'server-directory.js'))}).readDirectory().then(result => process.stdout.write(result.settings.headline))`], { env: process.env, encoding: 'utf8' });
  assert.equal(persistedHeadline, settings.headline);
  directory.deleteBrand(sample.id);
  directory.deleteBrand(initial.brands[0].id);
  assert.equal((await directory.readDirectory(true)).brands.some(brand => brand.id === sample.id || brand.id === initial.brands[0].id), false);
});

test('image settings migration preserves the v1 row and old updates do not clear image selections', async () => {
  const legacyPath = path.join(fixture, 'legacy');
  mkdirSync(legacyPath);
  const legacy = new DatabaseSync(path.join(legacyPath, 'directory.sqlite'));
  legacy.exec(`CREATE TABLE site_settings (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, eyebrow TEXT NOT NULL,
    headline TEXT NOT NULL, description TEXT NOT NULL, announcement TEXT NOT NULL,
    contact_url TEXT NOT NULL DEFAULT ''
  );
  INSERT INTO site_settings VALUES ('primary', 'Existing site', 'Tagline', 'Existing headline', 'Existing description', 'Existing notice', 'https://contact.example');
  CREATE TABLE brands (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL, tagline TEXT NOT NULL, description TEXT NOT NULL,
    color TEXT NOT NULL, icon TEXT NOT NULL, image_url TEXT NOT NULL DEFAULT '',
    featured INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0, link TEXT NOT NULL DEFAULT ''
  );
  PRAGMA user_version = 1;`);
  legacy.close();
  const fixtureData = process.env.DATA_DIR;
  try {
    process.env.DATA_DIR = legacyPath;
    const upgraded = sqlite.getSqlite();
    const row = upgraded.prepare('SELECT * FROM site_settings').get();
    assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 5);
    assert.deepEqual({ ...row }, {
      id: 'primary', name: 'Existing site', eyebrow: 'Tagline', headline: 'Existing headline',
      description: 'Existing description', announcement: 'Existing notice', contact_url: 'https://contact.example',
      cover_image_url: '', avatar_image_url: '',
      whatsapp_url: '', whatsapp_enabled: 0, telegram_url: '', telegram_enabled: 0,
      facebook_url: '', facebook_enabled: 0,
    });
  } finally { process.env.DATA_DIR = fixtureData; }

  const { coverImageUrl: _cover, avatarImageUrl: _avatar, ...oldSettings } = (await directory.readDirectory()).settings;
  const cover = '/images/custom-cover.webp';
  const avatar = 'https://cdn.example/avatar.png';
  directory.updateSettings({ ...oldSettings, coverImageUrl: cover, avatarImageUrl: avatar });
  const saved = directory.updateSettings({ ...oldSettings, name: 'Updated using old fields' });
  assert.equal(saved.coverImageUrl, cover);
  assert.equal(saved.avatarImageUrl, avatar);
  assert.equal(saved.name, 'Updated using old fields');
  directory.updateSettings({ ...oldSettings, avatarImageUrl: '' });
  assert.equal((await directory.readDirectory()).settings.avatarImageUrl, '');
  assert.equal((await directory.readDirectory()).settings.coverImageUrl, cover);
});

test('image setting addresses allow safe same-site paths and HTTPS URLs only', () => {
  for (const value of ['', '/images/banner.webp?rev=2', '/api/images/7ab01f.png', 'https://cdn.example/photo.png']) assert.equal(isSafeImageUrl(value), true, value);
  for (const value of ['//external.example/file.png', '/\\external.example/file.png', '/%2fexternal.example/file.png', '/%2e%2e/file.png', 'https://user:secret@cdn.example/file.png', 'https://cdn.example/"bad.png', 'http://cdn.example/photo.png', 'data:image/png;base64,abc', 'javascript:alert(1)']) assert.equal(isSafeImageUrl(value), false, value);
});

test('raster uploads persist and stream with detected type, and reject SVG, oversize and traversal', async () => {
  // Real 2x2-pixel fixtures for each supported format.
  const fixtures = {
    png: ['image/png', 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR42mO8vKWcgYGBiYGBgYGBAQAYbgICgbNezwAAAABJRU5ErkJggg=='],
    jpg: ['image/jpeg', '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABQb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwC2AT5J/9k='],
    gif: ['image/gif', 'R0lGODdhAgACAIEAANO0dwAAAAAAAAAAACwAAAAAAgACAAAIBgABCAQQEAA7'],
    webp: ['image/webp', 'UklGRjYAAABXRUJQVlA4ICoAAACQAQCdASoCAAIAAUAmJaACdLoAA5gA/vKIf/yDHkp6GtEv5I7z2XwAAAA='],
  };
  for (const [extension, [mime, base64]] of Object.entries(fixtures)) {
    const bytes = Buffer.from(base64, 'base64');
    const request = new Request('http://local/api/admin/images', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
    const url = await images.saveImage(await images.readImageUpload(request));
    assert.match(url, new RegExp(`^/api/images/[0-9a-f]{32}\\.${extension}$`));
    const filename = url.split('/').at(-1);
    assert.deepEqual(readFileSync(path.join(process.env.DATA_DIR, 'media', filename)), bytes);
    const opened = await images.openImage(filename);
    assert.equal(opened.mime, mime);
    assert.equal(opened.size, bytes.length);
    assert.deepEqual(Buffer.from(await new Response(opened.stream).arrayBuffer()), bytes);
  }
  const disguisedSvg = new Request('http://local/api/admin/images', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: '<svg xmlns="http://www.w3.org/2000/svg" />' });
  await assert.rejects(images.saveImage(await images.readImageUpload(disguisedSvg)), { status: 415 });
  const oversized = new Request('http://local/api/admin/images', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: new Uint8Array(images.MAX_IMAGE_BYTES + 1) });
  await assert.rejects(images.readImageUpload(oversized), { status: 413 });
  assert.equal(await images.openImage('../directory.sqlite'), null);
  assert.equal(await images.openImage(`${'0'.repeat(32)}.png`), null);
});

test.after(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDataDir;
  rmSync(fixture, { recursive: true, force: true });
});

