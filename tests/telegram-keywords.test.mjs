import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { DatabaseSync } from 'node:sqlite';

const fixture = mkdtempSync(path.join(tmpdir(), 'telegram-keywords-'));
const origin = 'https://directory.example';
const endpoint = `${origin}/api/admin/telegram/keywords`;
const previousEnv = { APP_URL: process.env.APP_URL, DATA_DIR: process.env.DATA_DIR };

writeFileSync(path.join(fixture, 'package.json'), '{"type":"commonjs"}');
symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(fixture, 'node_modules'), 'dir');
for (const relative of [
  'app/api/admin/_security', 'app/api/admin/_validation', 'app/api/admin/telegram/keywords/route',
  ...['auth-core', 'directory', 'image-url', 'sqlite', 'telegram-keywords'].map(name => `app/lib/${name}`),
]) {
  const source = readFileSync(new URL(`../${relative}.ts`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const target = path.join(fixture, `${relative}.js`);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, outputText);
}
writeFileSync(path.join(fixture, 'app/chatgpt-auth.js'), `
exports.signedIn = true;
exports.getChatGPTUser = async () => exports.signedIn ? { username: 'fixture-admin' } : null;
`);

const require = createRequire(import.meta.url);
const routes = require(path.join(fixture, 'app/api/admin/telegram/keywords/route.js'));
const session = require(path.join(fixture, 'app/chatgpt-auth.js'));
const { getSqlite } = require(path.join(fixture, 'app/lib/sqlite.js'));
let db;
let databaseIndex = 0;

test.beforeEach(() => {
  process.env.APP_URL = origin;
  process.env.DATA_DIR = path.join(fixture, `db-${++databaseIndex}`);
  session.signedIn = true;
  db = getSqlite();
});

test.afterEach(() => db.close());
test.after(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(fixture, { recursive: true, force: true });
});

async function request(method, payload, expected, requestOrigin = origin) {
  const response = await routes[method](new Request(endpoint, {
    method, headers: { origin: requestOrigin, 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  }));
  const data = await response.json();
  assert.equal(response.status, expected, data.error);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return data;
}

const ruleInput = { keyword: 'Help', matchMode: 'exact', response: '请联系管理员。' };

test('keyword CRUD returns public rules in ID order and reports missing records', async () => {
  assert.deepEqual(await request('GET', undefined, 200), { rules: [] });
  const { rule: first } = await request('POST', { ...ruleInput, keyword: '  Ｈｅｌｐ  ', response: '  请联系管理员。  ' }, 201);
  assert.deepEqual(first, { id: first.id, ...ruleInput, keyword: 'Ｈｅｌｐ', showButton: true });
  assert.ok(Number.isSafeInteger(first.id) && first.id > 0);
  assert.equal(db.prepare('SELECT keyword_key FROM telegram_keyword_rules WHERE id = ?').get(first.id).keyword_key, 'help');

  const { rule: second } = await request('POST', { ...ruleInput, keyword: 'Support', matchMode: 'contains' }, 201);
  const { rule: updated } = await request('PUT', { ...first, keyword: 'Assistance', response: 'Updated reply' }, 200);
  assert.deepEqual(await request('GET', undefined, 200), { rules: [updated, second] });
  assert.equal(db.prepare('SELECT keyword_key FROM telegram_keyword_rules WHERE id = ?').get(updated.id).keyword_key, 'assistance');

  assert.deepEqual(await request('DELETE', { id: first.id }, 200), { id: first.id });
  assert.match((await request('DELETE', { id: first.id }, 404)).error, /找不到/);
  assert.match((await request('PUT', updated, 404)).error, /找不到/);
  assert.deepEqual(await request('GET', undefined, 200), { rules: [second] });

  await request('DELETE', { id: second.id }, 200);
  const { rule: replacement } = await request('POST', ruleInput, 201);
  assert.ok(replacement.id > second.id);
  await request('DELETE', { id: second.id }, 404);
  assert.deepEqual(await request('GET', undefined, 200), { rules: [replacement] });
});

test('duplicates compare normalized keywords within the same match mode', async () => {
  const { rule: exact } = await request('POST', ruleInput, 201);
  assert.match((await request('POST', { ...ruleInput, keyword: '  ＨＥＬＰ  ' }, 409)).error, /已存在/);
  const { rule: contains } = await request('POST', { ...ruleInput, keyword: 'help', matchMode: 'contains' }, 201);
  assert.match((await request('PUT', { ...contains, matchMode: 'exact' }, 409)).error, /已存在/);
  assert.deepEqual(await request('GET', undefined, 200), { rules: [exact, contains] });
});

test('keyword operations require an admin session and mutations validate origin and input', async () => {
  session.signedIn = false;
  await request('GET', undefined, 401);
  await request('POST', ruleInput, 401);
  session.signedIn = true;
  await request('POST', ruleInput, 403, 'https://other.example');
  for (const invalid of [
    { keyword: '   ' }, { keyword: 'a'.repeat(121) }, { response: ' ' },
    { response: 'a'.repeat(2_001) }, { matchMode: 'prefix' }, { unknown: true },
    { showButton: 0 }, { showButton: 'false' }, { showButton: null },
  ]) await request('POST', { ...ruleInput, ...invalid }, 400);
  for (const id of [0, -1, 1.2, '1', Number.MAX_SAFE_INTEGER + 1]) {
    await request('DELETE', { id }, 400);
    await request('PUT', { ...ruleInput, id }, 400);
  }
  await request('DELETE', { id: 1, unknown: true }, 400);
  assert.deepEqual(await request('GET', undefined, 200), { rules: [] });
});

test('keyword button modes persist as booleans; old-client updates preserve text-only rules', async () => {
  const { rule: textOnly } = await request('POST', { ...ruleInput, showButton: false }, 201);
  assert.equal(textOnly.showButton, false);
  assert.equal(db.prepare('SELECT show_button FROM telegram_keyword_rules WHERE id=?').get(textOnly.id).show_button, 0);
  const { rule: preserved } = await request('PUT', { id: textOnly.id, ...ruleInput, response: 'Changed text' }, 200);
  assert.equal(preserved.showButton, false);
  const { rule: shown } = await request('PUT', { ...preserved, showButton: true }, 200);
  assert.equal(shown.showButton, true);
  const { rule: hidden } = await request('PUT', { ...shown, showButton: false }, 200);
  assert.equal(hidden.showButton, false);
  await request('PUT', { ...hidden, showButton: 'false' }, 400);
  assert.deepEqual((await request('GET', undefined, 200)).rules, [hidden]);
});

test('migration15 preserves existing keyword rules as visible buttons', () => {
  const originalDataDir = process.env.DATA_DIR;
  const legacyDataDir = path.join(fixture, 'legacy-version14');
  mkdirSync(legacyDataDir);
  const filename = path.join(legacyDataDir, 'directory.sqlite');
  const legacy = new DatabaseSync(filename);
  legacy.exec(`CREATE TABLE telegram_keyword_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT, keyword TEXT NOT NULL, keyword_key TEXT NOT NULL,
    match_mode TEXT NOT NULL, response TEXT NOT NULL, UNIQUE(keyword_key, match_mode)
  ); INSERT INTO telegram_keyword_rules VALUES(7,'Existing keyword','existing keyword','contains','Existing reply');
  PRAGMA user_version=14;`);
  legacy.close();
  try {
    process.env.DATA_DIR = legacyDataDir;
    const upgraded = getSqlite();
    assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 15);
    assert.deepEqual({ ...upgraded.prepare('SELECT * FROM telegram_keyword_rules WHERE id=7').get() }, {
      id: 7, keyword: 'Existing keyword', keyword_key: 'existing keyword', match_mode: 'contains', response: 'Existing reply', show_button: 1,
    });
    upgraded.close();
    globalThis.__directorySqlite?.delete(filename);
  } finally { process.env.DATA_DIR = originalDataDir; }
});
