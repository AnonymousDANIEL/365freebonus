import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

const root = new URL('..', import.meta.url);
const fixture = mkdtempSync(path.join(tmpdir(), 'website-logins-'));
writeFileSync(path.join(fixture, 'package.json'), '{"type":"commonjs"}');
symlinkSync(new URL('node_modules', root).pathname, path.join(fixture, 'node_modules'), 'dir');
for (const name of ['app/lib/sqlite', 'app/lib/directory', 'app/lib/auth-core', 'app/lib/website-login-client', 'app/lib/website-logins', 'app/lib/website-login-worker', 'app/api/admin/_security', 'app/api/admin/websites/_response', 'app/api/admin/websites/route', 'app/api/admin/websites/[id]/route', 'app/api/admin/websites/[id]/login/route']) {
  const target = path.join(fixture, name === 'app/lib/website-login-worker' ? 'app/lib/website-login-worker-core.js' : `${name}.js`);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, ts.transpileModule(readFileSync(new URL(`${name}.ts`, root), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText);
}
writeFileSync(path.join(fixture, 'app/chatgpt-auth.js'), 'exports.authorized=true;exports.getChatGPTUser=async()=>exports.authorized?{userId:"fixture-admin"}:null;');
writeFileSync(path.join(fixture, 'app/lib/website-login-worker.js'), 'exports.startWebsiteLoginWorker=()=>{};');
const require = createRequire(import.meta.url);
const auth = require(path.join(fixture, 'app/chatgpt-auth.js'));
const store = require(path.join(fixture, 'app/lib/website-logins.js'));
const { getSqlite } = require(path.join(fixture, 'app/lib/sqlite.js'));
const { processWebsiteLogins } = require(path.join(fixture, 'app/lib/website-login-worker-core.js'));
const client = require(path.join(fixture, 'app/lib/website-login-client.js'));
const routes = require(path.join(fixture, 'app/api/admin/websites/route.js'));
const item = require(path.join(fixture, 'app/api/admin/websites/[id]/route.js'));
const run = require(path.join(fixture, 'app/api/admin/websites/[id]/login/route.js'));
const origin = 'https://cms-fixture.example';
const names = ['DATA_DIR', 'APP_URL', 'SESSION_SECRET'];
const env = Object.fromEntries(names.map(k => [k, process.env[k]]));
const input = (extra = {}) => ({ name: 'Fixture ordinary website', loginUrl: 'https://accounts.acme.com/login', verifyUrl: 'https://accounts.acme.com/private', successText: 'Private sign out', username: 'fixture-user', password: 'private-fixture-password', enabled: false, intervalMinutes: 30, ...extra });
const request = (method, body = {}, extra = {}) => new Request(`${origin}/api/admin/websites`, { method, headers: { origin, 'content-type': 'application/json', ...extra }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
const params = id => ({ params: Promise.resolve({ id: String(id) }) });

test.beforeEach(() => {
  process.env.DATA_DIR = mkdtempSync(path.join(fixture, 'case-'));
  process.env.APP_URL = origin;
  process.env.SESSION_SECRET = 'fixture-website-secret-with-more-than-32-characters';
  auth.authorized = true;
});
test.afterEach(() => {
  const filename = path.join(process.env.DATA_DIR, 'directory.sqlite');
  globalThis.__directorySqlite?.get(filename)?.close();
  globalThis.__directorySqlite?.delete(filename);
});
test.after(() => {
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(fixture, { recursive: true, force: true });
});

test('admin routes require authentication, same-origin JSON, and never expose passwords or sessions', async () => {
  auth.authorized = false;
  assert.equal((await routes.GET(request('GET'))).status, 401);
  assert.equal((await routes.POST(request('POST', input()))).status, 401);
  assert.equal((await item.DELETE(request('DELETE'), params(1))).status, 401);
  assert.equal((await run.POST(request('POST'), params(1))).status, 401);
  auth.authorized = true;
  assert.equal((await routes.POST(request('POST', input(), { origin: 'https://other.example' }))).status, 403);
  assert.equal((await routes.POST(request('POST', input(), { 'content-type': 'text/plain' }))).status, 415);
  const created = await routes.POST(request('POST', input()));
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  const website = (await created.json()).website;
  assert.equal(website.hasPassword, true);
  assert.equal(website.password, undefined);
  const saved = store.getWebsite(website.id);
  assert.notEqual(saved.password_ciphertext, input().password);
  assert.equal(store.readWebsitePassword(saved), input().password);
  const list = await routes.GET(request('GET'));
  const data = await list.json();
  assert.equal(data.websites.length, 1);
  assert.equal(JSON.stringify(data).includes(input().password), false);
  assert.equal(JSON.stringify(data).includes(saved.password_ciphertext), false);
});

test('updates preserve blank passwords only for the same account and origin; invalid URLs and missing fields fail closed', () => {
  const saved = store.saveWebsite(input());
  store.saveWebsite(input({ password: '', name: 'Updated name' }), saved.id);
  assert.equal(store.readWebsitePassword(store.getWebsite(saved.id)), input().password);
  assert.throws(() => store.saveWebsite(input({ password: '', username: 'different-account' }), saved.id), { status: 400 });
  assert.throws(() => store.saveWebsite(input({ password: '', loginUrl: 'https://different.acme.com/login', verifyUrl: 'https://different.acme.com/private' }), saved.id), { status: 400 });
  for (const extra of [{ loginUrl: 'http://accounts.acme.com/login' }, { loginUrl: 'https://127.0.0.1/login' }, { loginUrl: 'https://syabas99.com/login' }, { verifyUrl: 'https://other.acme.com/private' }, { successText: '' }, { intervalMinutes: 1 }]) assert.throws(() => store.saveWebsite(input(extra)), { status: 400 });
  const swapped = { ...store.getWebsite(saved.id), username: 'different-account' };
  assert.throws(() => store.readWebsitePassword(swapped), { status: 503 });
});

test('records paginate without an application record cap and lease-protected jobs cannot be edited or deleted', () => {
  for (let i = 0; i < 23; i++) store.saveWebsite(input({ name: `Website ${i}` }));
  assert.equal(store.listWebsites(1).websites.length, 20);
  assert.equal(store.listWebsites(2).websites.length, 3);
  assert.equal(store.listWebsites(999).page, 2);
  const row = store.listWebsites(1).websites[0];
  getSqlite().prepare("UPDATE website_logins SET lease_until=? WHERE id=?").run(Date.now() + 60_000, row.id);
  for (const action of [() => store.saveWebsite(input(), row.id), () => store.deleteWebsite(row.id), () => store.queueWebsiteLogin(row.id)]) assert.throws(action, { status: 409 });
});

test('manual login is queued, verifies through the worker once, and retains only encrypted reusable session data', async () => {
  const saved = store.saveWebsite(input());
  assert.equal((await run.POST(request('POST'), params(saved.id))).status, 202);
  assert.equal(store.getWebsite(saved.id).message, '等待登录');
  const calls = [];
  const execute = async config => { calls.push(config); await new Promise(resolve => setTimeout(resolve, 5)); return { session: 'fixture-cookie-session-private' }; };
  await Promise.all([processWebsiteLogins(3, execute), processWebsiteLogins(3, execute)]);
  assert.equal(calls.length, 1);
  const row = store.getWebsite(saved.id);
  assert.equal(row.status, 'success');
  assert.ok(row.last_success_at);
  assert.equal(row.enabled, 0);
  assert.equal(store.readWebsiteSession(row), 'fixture-cookie-session-private');
  assert.notEqual(row.session_ciphertext, 'fixture-cookie-session-private');
  assert.equal(JSON.stringify(store.listWebsites(1)).includes('fixture-cookie-session-private'), false);
  assert.throws(() => store.queueWebsiteLogin(saved.id), { status: 429 });
  getSqlite().prepare("UPDATE website_logins SET enabled=1,next_attempt_at=0 WHERE id=?").run(saved.id);
  await processWebsiteLogins(1, execute);
  assert.equal(calls[1].existingSession, 'fixture-cookie-session-private');
});

test('failed or interrupted attempts pause automation and cannot falsely report success or loop passwords', async () => {
  const saved = store.saveWebsite(input({ enabled: true }));
  await processWebsiteLogins(3, async () => { throw new client.WebsiteLoginError('需要人工验证'); });
  let row = store.getWebsite(saved.id);
  assert.equal(row.status, 'error');
  assert.equal(row.enabled, 0);
  assert.equal(row.last_success_at, null);
  assert.equal(row.session_ciphertext, '');
  await processWebsiteLogins(3, async () => { throw Error('must not retry'); });
  getSqlite().prepare("UPDATE website_logins SET status='running',lease_until=?,requested=0 WHERE id=?").run(Date.now() - 1, saved.id);
  await processWebsiteLogins(3, async () => { throw Error('must not retry'); });
  row = store.getWebsite(saved.id);
  assert.equal(row.status, 'error');
  assert.equal(row.enabled, 0);
  assert.match(row.message, /中断/);
});
