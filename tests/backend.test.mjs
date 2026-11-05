import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { scryptSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

// Compile the actual server modules in an isolated fixture, so persistence and
// auth checks can run without a Next request context or touching app data.
const fixture = mkdtempSync(path.join(tmpdir(), 'directory-backend-'));
writeFileSync(path.join(fixture, 'package.json'), '{"type":"commonjs"}');
for (const name of ['sqlite', 'directory', 'server-directory', 'auth-core', 'session-store']) {
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
  const previous = { ADMIN_PASSWORD_HASH: process.env.ADMIN_PASSWORD_HASH, SESSION_SECRET: process.env.SESSION_SECRET, APP_URL: process.env.APP_URL, RAILWAY_PUBLIC_DOMAIN: process.env.RAILWAY_PUBLIC_DOMAIN, NODE_ENV: process.env.NODE_ENV };
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
    assert.equal(auth.safeReturnPath('//attacker.test'), '/admin');
    assert.equal(auth.safeReturnPath('/\\attacker.test'), '/admin');
    assert.equal(auth.safeReturnPath('/admin?tab=settings'), '/admin?tab=settings');
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

test.after(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDataDir;
  rmSync(fixture, { recursive: true, force: true });
});
