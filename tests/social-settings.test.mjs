import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';

// Compile the real repository/validation modules and use temporary databases;
// these checks never read application data or need an administrator session.
const project = path.resolve(new URL('..', import.meta.url).pathname);
const fixture = mkdtempSync(path.join(tmpdir(), 'directory-social-settings-'));
writeFileSync(path.join(fixture, 'package.json'), '{"type":"commonjs"}');
symlinkSync(path.join(project, 'node_modules'), path.join(fixture, 'node_modules'), 'dir');
for (const source of [
  'app/lib/sqlite.ts', 'app/lib/directory.ts', 'app/lib/server-directory.ts',
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
const repositoryFile = path.join(fixture, 'app/lib/server-directory.js');
const repository = require(repositoryFile);
const directory = require(path.join(fixture, 'app/lib/directory.js'));
const sqlite = require(path.join(fixture, 'app/lib/sqlite.js'));
const { settingsInput } = require(path.join(fixture, 'app/api/admin/_validation.js'));
const { apiError } = require(path.join(fixture, 'app/api/admin/_security.js'));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = path.join(fixture, 'data');

const socialFields = ['whatsappUrl', 'whatsappEnabled', 'telegramUrl', 'telegramEnabled', 'facebookUrl', 'facebookEnabled'];
const platforms = ['whatsapp', 'telegram', 'facebook'];
const emptySocial = Object.fromEntries(platforms.flatMap(platform => [[`${platform}Url`, ''], [`${platform}Enabled`, false]]));
const legacyHeadline = 'Discover more.\nFind your favourite.';
const legacyDescription = 'Thoughtfully chosen brands and fresh ideas, all in one elegant space. Take a look around — your next favourite could be here.';
const headline = '365 Free Bonus\nFind your favourite.';
const description = 'Free bonus offers.\nFind your next favourite at 365 FreeBonus.';

function socials(settings) { return Object.fromEntries(socialFields.map(key => [key, settings[key]])); }
function oldSettings(settings) { return Object.fromEntries(Object.entries(settings).filter(([key]) => !socialFields.includes(key))); }
function restartedSettings() {
  return JSON.parse(execFileSync(process.execPath, ['-e', `require(${JSON.stringify(repositoryFile)}).readDirectory(true).then(data => process.stdout.write(JSON.stringify(data.settings)))`], { env: process.env, encoding: 'utf8' }));
}

function createV3Fixture(filename, oldHeadline, oldDescription) {
  const db = new DatabaseSync(filename);
  db.exec(`CREATE TABLE site_settings (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, eyebrow TEXT NOT NULL,
    headline TEXT NOT NULL, description TEXT NOT NULL, announcement TEXT NOT NULL,
    contact_url TEXT NOT NULL DEFAULT '', cover_image_url TEXT NOT NULL DEFAULT '',
    avatar_image_url TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE brands (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL, tagline TEXT NOT NULL, description TEXT NOT NULL,
    color TEXT NOT NULL, icon TEXT NOT NULL, image_url TEXT NOT NULL DEFAULT '',
    featured INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0, link TEXT NOT NULL DEFAULT '',
    promotion_days INTEGER DEFAULT NULL, promotion_expires_at INTEGER DEFAULT NULL
  );
  CREATE TABLE admin_sessions (id_hash TEXT PRIMARY KEY, username TEXT NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE login_attempts (ip_hash TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  INSERT INTO brands VALUES ('existing', 'Existing brand', 'existing', 'New', 'Original tagline', 'Original description', '#aabbcc', 'sparkles', '/api/images/original.gif', 1, 1, 73, 'https://brand.example', 7, 1800000000000);
  INSERT INTO admin_sessions VALUES ('existing-session', 'admin', 1900000000000);
  INSERT INTO login_attempts VALUES ('existing-attempts', 3, 1900000000000);
  PRAGMA user_version=3;`);
  db.prepare('INSERT INTO site_settings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('primary', 'Existing site', 'Existing eyebrow', oldHeadline, oldDescription, 'Existing notice', 'https://contact.example', '/cover.gif', '/avatar.webp');
  db.close();
}

test('new installations have exact multiline hero copy and disabled social channels as plain booleans', async () => {
  assert.equal(directory.defaultSettings.headline, headline);
  assert.equal(directory.defaultSettings.description, description);
  const { settings } = await repository.readDirectory();
  assert.equal(settings.headline, headline);
  assert.equal(settings.description, description);
  assert.deepEqual(socials(settings), emptySocial);
  assert.equal(Object.getPrototypeOf(settings), Object.prototype);
  assert.deepEqual(JSON.parse(JSON.stringify(settings)), settings);
  assert.equal(sqlite.getSqlite().prepare('PRAGMA user_version').get().user_version, 11);
});

test('v4 migration replaces only exact legacy hero fields and retains site assets, brands and auth data', async () => {
  const currentDataDir = process.env.DATA_DIR;
  try {
    for (const [index, oldHeadline, oldDescription] of [
      [0, legacyHeadline, legacyDescription],
      [1, 'Owner custom heading', legacyDescription],
      [2, legacyHeadline, 'Owner custom description'],
      [3, 'Owner custom heading', 'Owner custom description'],
    ]) {
      const dataDir = path.join(fixture, `v3-${index}`);
      mkdirSync(dataDir);
      createV3Fixture(path.join(dataDir, 'directory.sqlite'), oldHeadline, oldDescription);
      process.env.DATA_DIR = dataDir;
      const data = await repository.readDirectory(true);
      const db = sqlite.getSqlite();
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 11);
      assert.equal(data.settings.headline, oldHeadline === legacyHeadline ? headline : oldHeadline);
      assert.equal(data.settings.description, oldDescription === legacyDescription ? description : oldDescription);
      assert.deepEqual(socials(data.settings), emptySocial);
      assert.deepEqual({ name: data.settings.name, eyebrow: data.settings.eyebrow, announcement: data.settings.announcement, contactUrl: data.settings.contactUrl, coverImageUrl: data.settings.coverImageUrl, avatarImageUrl: data.settings.avatarImageUrl }, {
        name: 'Existing site', eyebrow: 'Existing eyebrow', announcement: 'Existing notice', contactUrl: 'https://contact.example', coverImageUrl: '/cover.gif', avatarImageUrl: '/avatar.webp',
      });
      assert.deepEqual(data.brands, [{
        id: 'existing', name: 'Existing brand', slug: 'existing', category: 'New',
        tagline: 'Original tagline', description: 'Original description', color: '#aabbcc', icon: 'sparkles',
        imageUrl: '/api/images/original.gif', featured: true, published: true, sortOrder: 73,
        link: 'https://brand.example', promotionDays: 7, promotionStartsAt: null, promotionExpiresAt: 1800000000000, publishAt: null,
      }]);
      assert.deepEqual({ ...db.prepare('SELECT * FROM admin_sessions').get() }, { id_hash: 'existing-session', username: 'admin', expires_at: 1900000000000 });
      assert.deepEqual({ ...db.prepare('SELECT * FROM login_attempts').get() }, { ip_hash: 'existing-attempts', attempts: 3, expires_at: 1900000000000 });
      // Matching legacy words written by the owner after v4 are still their
      // content; a process restart must not run the copy migration again.
      repository.updateSettings({ ...data.settings, headline: legacyHeadline, description: legacyDescription });
      const restarted = restartedSettings();
      assert.equal(restarted.headline, legacyHeadline);
      assert.equal(restarted.description, legacyDescription);
    }
  } finally { process.env.DATA_DIR = currentDataDir; }
});

test('social links and visibility persist across process restart and old full saves preserve all six fields', async () => {
  const initial = (await repository.readDirectory()).settings;
  const expected = {
    whatsappUrl: 'https://wa.me/60123456789', whatsappEnabled: true,
    telegramUrl: 'https://t.me/example', telegramEnabled: true,
    facebookUrl: 'http://facebook.example/page', facebookEnabled: false,
  };
  const saved = repository.updateSettings(settingsInput.parse({ ...initial, ...expected }));
  assert.deepEqual(socials(saved), expected);
  assert.equal(Object.getPrototypeOf(saved), Object.prototype);
  assert.deepEqual(socials(restartedSettings()), expected);
  const legacy = settingsInput.parse({ ...oldSettings(saved), name: 'Saved using old client' });
  for (const key of socialFields) assert.equal(key in legacy, false, 'omitted social fields must not be defaulted by validation');
  const updated = repository.updateSettings(legacy);
  assert.equal(updated.name, 'Saved using old client');
  assert.deepEqual(socials(updated), expected);
  assert.deepEqual(socials((await repository.readDirectory(true)).settings), expected);
  assert.deepEqual(socials((await repository.readDirectory()).settings), { ...expected, facebookUrl: '' }, 'public data must not expose the saved URL of a disabled channel');
  const row = sqlite.getSqlite().prepare('SELECT whatsapp_enabled, telegram_enabled, facebook_enabled FROM site_settings').get();
  assert.deepEqual({ ...row }, { whatsapp_enabled: 1, telegram_enabled: 1, facebook_enabled: 0 });
});

test('social URL and visibility changes merge independently, retain disabled URLs, and reject empty enabled channels atomically', async () => {
  const current = (await repository.readDirectory(true)).settings;
  const base = oldSettings(current);
  const disabled = repository.updateSettings(settingsInput.parse({ ...base, whatsappEnabled: false }));
  assert.equal(disabled.whatsappEnabled, false);
  assert.equal(disabled.whatsappUrl, current.whatsappUrl);
  assert.equal((await repository.readDirectory()).settings.whatsappUrl, '');
  assert.equal((await repository.readDirectory(true)).settings.whatsappUrl, current.whatsappUrl);
  const relinked = repository.updateSettings(settingsInput.parse({ ...base, whatsappUrl: 'https://wa.me/60987654321' }));
  assert.equal(relinked.whatsappEnabled, false);
  assert.equal(relinked.whatsappUrl, 'https://wa.me/60987654321');
  const enabled = repository.updateSettings(settingsInput.parse({ ...base, whatsappEnabled: true }));
  assert.equal(enabled.whatsappEnabled, true);
  assert.equal(enabled.whatsappUrl, relinked.whatsappUrl);
  assert.deepEqual([enabled.telegramUrl, enabled.telegramEnabled, enabled.facebookUrl, enabled.facebookEnabled], [current.telegramUrl, current.telegramEnabled, current.facebookUrl, current.facebookEnabled]);
  const blank = repository.updateSettings(settingsInput.parse({ ...base, facebookUrl: '', facebookEnabled: false }));
  assert.equal(blank.facebookUrl, '');
  assert.equal(blank.facebookEnabled, false);
  let failure;
  assert.throws(() => repository.updateSettings(settingsInput.parse({ ...base, name: 'Must not save', facebookEnabled: true })), error => {
    failure = error;
    return error instanceof directory.SettingsValidationError;
  });
  assert.equal(apiError(failure).status, 400, 'merged-state validation must be a client error rather than an internal error');
  const after = (await repository.readDirectory()).settings;
  assert.equal(after.name, base.name, 'invalid merged social state must not save unrelated settings');
  assert.equal(after.facebookEnabled, false);
  assert.equal(after.facebookUrl, '');
});

test('validation accepts only HTTP(S) social URLs, actual booleans, and nonempty links when explicitly enabled', () => {
  const base = oldSettings(directory.defaultSettings);
  for (const platform of platforms) {
    const urlKey = `${platform}Url`;
    const enabledKey = `${platform}Enabled`;
    for (const url of ['', 'https://example.com/contact', 'http://example.com/contact']) {
      assert.equal(settingsInput.safeParse({ ...base, [urlKey]: url, [enabledKey]: false }).success, true);
    }
    const trimmed = settingsInput.parse({ ...base, [urlKey]: '  https://example.com/contact  ', [enabledKey]: true });
    assert.equal(trimmed[urlKey], 'https://example.com/contact');
    for (const url of ['javascript:alert(1)', 'data:text/html,bad', 'ftp://example.com/contact', '//example.com/contact', '/contact', 'not a URL', 'https://user:secret@example.com/contact', 'https://example.com/co\nntact', `https://example.com/${'a'.repeat(2048)}`]) {
      assert.equal(settingsInput.safeParse({ ...base, [urlKey]: url, [enabledKey]: false }).success, false, `${platform} must reject ${url} even while disabled`);
    }
    for (const url of ['', '   ']) assert.equal(settingsInput.safeParse({ ...base, [urlKey]: url, [enabledKey]: true }).success, false);
    for (const enabled of ['true', 'false', 1, 0, null]) assert.equal(settingsInput.safeParse({ ...base, [urlKey]: 'https://example.com/contact', [enabledKey]: enabled }).success, false);
  }
});

test.after(() => {
  for (const db of globalThis.__directorySqlite?.values() || []) db.close();
  if (previousDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDataDir;
  rmSync(fixture, { recursive: true, force: true });
});
