import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const project = fileURLToPath(new URL('..', import.meta.url));
const fixture = mkdtempSync(path.join(tmpdir(), 'directory-popup-notices-'));
writeFileSync(path.join(fixture, 'package.json'), '{"type":"commonjs"}');
symlinkSync(path.join(project, 'node_modules'), path.join(fixture, 'node_modules'), 'dir');
for (const source of [
  'app/lib/sqlite.ts', 'app/lib/directory.ts', 'app/lib/auth-core.ts', 'app/lib/image-url.ts',
  'app/lib/popup-notices.ts', 'app/api/admin/_security.ts', 'app/api/admin/_validation.ts',
  'app/api/admin/notices/route.ts',
]) {
  const target = path.join(fixture, source.replace(/\.ts$/, '.js'));
  mkdirSync(path.dirname(target), { recursive: true });
  const { outputText } = ts.transpileModule(readFileSync(path.join(project, source), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  writeFileSync(target, outputText);
}
// The route uses real authorization and CSRF checks. Only the framework's
// cookie/session context is replaced so the handlers run without Next.
writeFileSync(path.join(fixture, 'app/chatgpt-auth.js'), `exports.getChatGPTUser = async () => globalThis.popupNoticeTestUser;`);
const require = createRequire(import.meta.url);
const route = require(path.join(fixture, 'app/api/admin/notices/route.js'));
const { readPublicPopupNotices } = require(path.join(fixture, 'app/lib/popup-notices.js'));
const { getSqlite } = require(path.join(fixture, 'app/lib/sqlite.js'));
const previousEnv = { DATA_DIR: process.env.DATA_DIR, APP_URL: process.env.APP_URL };
const origin = 'https://notices.example';

function closeDatabase() {
  const filename = path.join(process.env.DATA_DIR, 'directory.sqlite');
  const databases = globalThis.__directorySqlite;
  databases?.get(filename)?.close();
  databases?.delete(filename);
}

test.beforeEach(() => {
  process.env.DATA_DIR = mkdtempSync(path.join(fixture, 'case-'));
  process.env.APP_URL = origin;
  globalThis.popupNoticeTestUser = { id: 'fixture-admin', name: 'Fixture admin' };
});
test.afterEach(() => {
  closeDatabase();
  delete globalThis.popupNoticeTestUser;
});
test.after(() => {
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(fixture, { recursive: true, force: true });
});

const example = {
  title: 'New announcement', imageUrl: '/images/popup.webp', enabled: true, sortOrder: 10,
};

function request(method, body, { from = origin, contentType = 'application/json', raw = false } = {}) {
  const headers = new Headers();
  if (from !== null) headers.set('origin', from);
  if (body !== undefined) headers.set('content-type', contentType);
  return new Request(`${origin}/api/admin/notices`, {
    method, headers, body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
}

async function responseBody(response, status) {
  assert.equal(response.status, status);
  return response.json();
}

test('popup notices persist through admin CRUD and public reads show only enabled rows in stable order', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Notice writes must not fetch remote images'));
  assert.deepEqual(await responseBody(await route.GET(request('GET')), 200), { notices: [] });
  const inputs = [
    { ...example, title: 'Last', sortOrder: 20, link: 'http://example.com/notice' },
    { ...example, title: 'Earlier ID' },
    { ...example, title: 'Later ID', imageUrl: 'https://images.example/popup.gif' },
    { ...example, title: 'Disabled', enabled: false, sortOrder: 0 },
  ];
  const created = [];
  for (const input of inputs) {
    const payload = await responseBody(await route.POST(request('POST', input)), 201);
    const id = payload.notice.id;
    assert.ok(Number.isSafeInteger(id) && id > 0);
    assert.deepEqual(payload, { notice: { id, link: '', ...input } });
    created.push(payload.notice);
  }
  const [last, first, second, disabled] = created;
  assert.deepEqual(await readPublicPopupNotices(), [first, second, last]);
  const admin = await responseBody(await route.GET(request('GET')), 200);
  assert.deepEqual(admin.notices.toSorted((a, b) => a.id - b.id), created);

  const changed = { ...disabled, title: 'Enabled now', enabled: true };
  assert.deepEqual(await responseBody(await route.PUT(request('PUT', changed)), 200), { notice: changed });
  closeDatabase();
  assert.deepEqual(await readPublicPopupNotices(), [changed, first, second, last]);
  assert.deepEqual(await responseBody(await route.DELETE(request('DELETE', { id: first.id })), 200), { id: first.id });
  assert.deepEqual(await readPublicPopupNotices(), [changed, second, last]);
  assert.equal((await route.PUT(request('PUT', first))).status, 404);
  assert.equal((await route.DELETE(request('DELETE', { id: first.id }))).status, 404);
});

test('invalid popup payloads cannot save broken content or unsafe URLs', async () => {
  for (const [label, overrides] of [
    ['blank title', { title: '   ' }],
    ['embedded line break', { title: 'First\nSecond' }],
    ['title too long', { title: 'a'.repeat(101) }],
    ['missing image', { imageUrl: undefined }],
    ['HTTP image', { imageUrl: 'http://images.example/popup.webp' }],
    ['protocol-relative image', { imageUrl: '//images.example/popup.webp' }],
    ['path traversal image', { imageUrl: '/images/../private.webp' }],
    ['JavaScript link', { link: 'javascript:alert(1)' }],
    ['data link', { link: 'data:text/html,example' }],
    ['nonboolean visibility', { enabled: 'true' }],
    ['negative order', { sortOrder: -1 }],
    ['fractional order', { sortOrder: 2.5 }],
    ['order too large', { sortOrder: 100_000 }],
    ['unknown property', { unexpected: true }],
  ]) {
    assert.equal((await route.POST(request('POST', { ...example, ...overrides }))).status, 400, label);
  }
  assert.equal((await route.POST(request('POST', '{invalid', { raw: true }))).status, 400);
  assert.equal((await route.DELETE(request('DELETE', { id: 0 }))).status, 400);
  assert.deepEqual(await responseBody(await route.GET(request('GET')), 200), { notices: [] });
});

test('admin notice routes reject expired sessions and enforce write origin and JSON content type', async () => {
  const writes = [['POST', example], ['PUT', { ...example, id: 1 }], ['DELETE', { id: 1 }]];
  globalThis.popupNoticeTestUser = null;
  assert.equal((await route.GET(request('GET'))).status, 401);
  for (const [method, payload] of writes) {
    assert.equal((await route[method](request(method, payload))).status, 401);
  }

  globalThis.popupNoticeTestUser = { id: 'fixture-admin' };
  for (const [method, payload] of writes) {
    assert.equal((await route[method](request(method, payload, { from: 'https://another.example' }))).status, 403);
  }
  assert.equal((await route.POST(request('POST', example, { from: null }))).status, 403);
  assert.equal((await route.POST(request('POST', example, { contentType: 'text/plain' }))).status, 415);
  assert.deepEqual(await readPublicPopupNotices(), []);
});

test('upgrading a v9 database adds an empty notices table while preserving existing settings', async () => {
  const before = getSqlite();
  // Removing the additive table recreates the schema immediately before v10.
  before.exec(`DROP TABLE popup_notices;
    DROP TABLE admin_credentials;
    DROP TABLE website_logins;
    INSERT INTO site_settings (id, name, eyebrow, headline, description, announcement)
      VALUES ('primary', 'Existing site', 'Existing eyebrow', 'Existing headline', 'Existing copy', 'Existing notice');
    INSERT INTO telegram_promotion_settings (id, enabled, chat_id, token_ciphertext)
      VALUES ('primary', 1, '-10012345', 'fixture-ciphertext');
    PRAGMA user_version = 9;`);
  closeDatabase();

  assert.deepEqual(await readPublicPopupNotices(), []);
  const after = getSqlite();
  assert.equal(after.prepare('PRAGMA user_version').get().user_version, 12);
  assert.equal(after.prepare("SELECT announcement FROM site_settings WHERE id = 'primary'").get().announcement, 'Existing notice');
  assert.equal(after.prepare("SELECT token_ciphertext FROM telegram_promotion_settings WHERE id = 'primary'").get().token_ciphertext, 'fixture-ciphertext');
  const created = await responseBody(await route.POST(request('POST', example)), 201);
  assert.deepEqual(await readPublicPopupNotices(), [created.notice]);
});
