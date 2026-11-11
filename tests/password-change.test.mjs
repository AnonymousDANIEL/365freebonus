import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { scryptSync } from 'node:crypto';
import ts from 'typescript';

const root = new URL('..', import.meta.url);
const fixture = mkdtempSync(path.join(tmpdir(), 'password-change-'));
writeFileSync(path.join(fixture, 'package.json'), '{"type":"commonjs"}');
symlinkSync(new URL('node_modules', root).pathname, path.join(fixture, 'node_modules'), 'dir');
const contextFile = path.join(fixture, 'cookie-context.js');
writeFileSync(contextFile, 'exports.token = undefined; exports.cookies = async () => ({ get: () => exports.token ? { value: exports.token } : undefined });');
for (const file of [
  'app/chatgpt-auth', 'app/lib/auth-core', 'app/lib/admin-credentials', 'app/lib/session-store', 'app/lib/sqlite', 'app/lib/directory',
  'app/api/admin/_security', 'app/api/admin/password/route', 'app/api/auth/login/route',
]) {
  const target = path.join(fixture, `${file}.js`);
  mkdirSync(path.dirname(target), { recursive: true });
  const source = readFileSync(new URL(`${file}.ts`, root), 'utf8').replaceAll('"next/headers"', JSON.stringify(contextFile));
  writeFileSync(target, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText);
}
const require = createRequire(import.meta.url);
const context = require(contextFile);
const auth = require(path.join(fixture, 'app/lib/auth-core.js'));
const credentials = require(path.join(fixture, 'app/lib/admin-credentials.js'));
const sessions = require(path.join(fixture, 'app/lib/session-store.js'));
const sqlite = require(path.join(fixture, 'app/lib/sqlite.js'));
const route = require(path.join(fixture, 'app/api/admin/password/route.js'));
const login = require(path.join(fixture, 'app/api/auth/login/route.js'));
const envNames = ['DATA_DIR', 'APP_URL', 'ADMIN_USERNAME', 'ADMIN_PASSWORD_HASH', 'SESSION_SECRET'];
const previousEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
const origin = 'https://password-fixture.example';
const oldPassword = 'fixture-original-password';
const nextPassword = 'fixture-changed-password';
const secret = 'fixture-session-secret-preserve-for-telegram';
let originalConfig;
let activeSession;

test.beforeEach(() => {
  process.env.DATA_DIR = mkdtempSync(path.join(fixture, 'case-'));
  process.env.APP_URL = origin;
  process.env.ADMIN_USERNAME = 'fixture-admin';
  const salt = '0123456789abcdef0123456789abcdef';
  process.env.ADMIN_PASSWORD_HASH = `scrypt$${salt}$${scryptSync(oldPassword, Buffer.from(salt, 'hex'), 64).toString('hex')}`;
  process.env.SESSION_SECRET = secret;
  originalConfig = credentials.getAdminAuthConfig();
  activeSession = auth.issueSession(originalConfig);
  context.token = activeSession.token;
  sessions.saveSession(activeSession.payload);
});
test.afterEach(() => {
  const filename = path.join(process.env.DATA_DIR, 'directory.sqlite');
  globalThis.__directorySqlite.get(filename)?.close();
  globalThis.__directorySqlite.delete(filename);
});
test.after(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(fixture, { recursive: true, force: true });
});
const input = (extra = {}) => ({ currentPassword: oldPassword, newPassword: nextPassword, confirmPassword: nextPassword, ...extra });
function request(body = input(), extraHeaders = {}) {
  return new Request(`${origin}/api/admin/password`, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...extraHeaders }, body: JSON.stringify(body) });
}

test('password endpoint rejects unauthenticated, revoked and cross-origin requests without changing credentials', async () => {
  context.token = undefined;
  assert.equal((await route.POST(request())).status, 401);
  context.token = activeSession.token;
  assert.equal((await route.POST(request(input(), { origin: 'https://attacker.example' }))).status, 403);
  assert.equal((await route.POST(request(input(), { 'content-type': 'text/plain' }))).status, 415);
  sessions.revokeSession(activeSession.payload);
  assert.equal((await route.POST(request())).status, 401);
  assert.equal(credentials.getAdminAuthConfig().passwordHash, originalConfig.passwordHash);
});

test('wrong current password and invalid new passwords preserve credentials and sessions', async () => {
  for (const body of [input({ currentPassword: 'incorrect-current-password' }), input({ confirmPassword: 'different-password' }), input({ newPassword: 'short', confirmPassword: 'short' }), input({ newPassword: 'x'.repeat(129), confirmPassword: 'x'.repeat(129) }), input({ newPassword: oldPassword, confirmPassword: oldPassword })]) {
    assert.equal((await route.POST(request(body))).status, 400);
    assert.equal(credentials.getAdminAuthConfig().passwordHash, originalConfig.passwordHash);
    assert.equal(sessions.sessionIsActive(activeSession.payload), true);
  }
});

test('successful change persists only a salted hash, revokes all devices and requires the new password after process restart', async t => {
  const otherSession = auth.issueSession(originalConfig);
  sessions.saveSession(otherSession.payload);
  const db = sqlite.getSqlite();
  db.prepare("INSERT INTO telegram_promotion_settings(id,enabled,chat_id,token_ciphertext) VALUES ('primary',0,'','fixture-ciphertext')").run();
  const events = [];
  t.mock.method(console, 'info', value => events.push(value));
  const response = await route.POST(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, redirect: '/login' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(sessions.sessionIsActive(activeSession.payload), false);
  assert.equal(sessions.sessionIsActive(otherSession.payload), false);
  const effective = credentials.getAdminAuthConfig();
  assert.notEqual(effective.passwordHash, originalConfig.passwordHash);
  assert.notEqual(effective.secret, originalConfig.secret);
  assert.equal(process.env.SESSION_SECRET, secret);
  assert.equal(db.prepare('SELECT token_ciphertext FROM telegram_promotion_settings').get().token_ciphertext, 'fixture-ciphertext');
  assert.equal(await auth.verifyCredentials(effective.username, oldPassword, effective), false);
  assert.equal(await auth.verifyCredentials(effective.username, nextPassword, effective), true);
  assert.equal(auth.verifySession(activeSession.token, effective), null);
  // A login that finished with the old config after the commit must also fail.
  const late = auth.issueSession(originalConfig);
  sessions.saveSession(late.payload);
  assert.equal(auth.verifySession(late.token, credentials.getAdminAuthConfig()), null);
  const persisted = execFileSync(process.execPath, ['-e', `const c=require(${JSON.stringify(path.join(fixture, 'app/lib/admin-credentials.js'))}).getAdminAuthConfig();const a=require(${JSON.stringify(path.join(fixture, 'app/lib/auth-core.js'))});Promise.all([a.verifyCredentials(c.username,${JSON.stringify(oldPassword)},c),a.verifyCredentials(c.username,${JSON.stringify(nextPassword)},c)]).then(x=>process.stdout.write(JSON.stringify(x)))`], { env: process.env, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(persisted), [false, true]);
  for (const password of [oldPassword, nextPassword, effective.passwordHash, secret]) assert.equal(events.join('').includes(password), false);
  assert.equal((await route.POST(request())).status, 401, 'old cookie cannot change the password again');
  const signIn = password => login.POST(new Request(`${origin}/api/auth/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: effective.username, password }) }));
  t.mock.method(console, 'warn', () => {});
  assert.equal((await signIn(oldPassword)).status, 401);
  assert.equal((await signIn(nextPassword)).status, 200);
});

test('concurrent changes cannot overwrite the first completed change', async () => {
  const results = await Promise.allSettled([
    credentials.changeAdminPassword(input(), activeSession.payload, originalConfig),
    credentials.changeAdminPassword(input({ newPassword: 'another-new-password', confirmPassword: 'another-new-password' }), activeSession.payload, originalConfig),
  ]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.find(x => x.status === 'rejected').reason.status, 401);
});

test('a session revoked during password verification cannot commit a change', async () => {
  const changing = credentials.changeAdminPassword(input(), activeSession.payload, originalConfig);
  sessions.revokeSession(activeSession.payload);
  await assert.rejects(changing, { status: 401 });
  assert.equal(credentials.getAdminAuthConfig().passwordHash, originalConfig.passwordHash);
});

test('a failed session revocation rolls back the credential change', async () => {
  const db = sqlite.getSqlite();
  db.exec("CREATE TRIGGER fixture_revoke_failure BEFORE DELETE ON admin_sessions BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END");
  await assert.rejects(credentials.changeAdminPassword(input(), activeSession.payload, originalConfig), /fixture rollback/);
  assert.equal(credentials.getAdminAuthConfig().passwordHash, originalConfig.passwordHash);
  assert.equal(sessions.sessionIsActive(activeSession.payload), true);
});

test('password-change guesses are rate limited independently from login', async () => {
  for (let i = 0; i < 8; i++) assert.equal((await route.POST(request(input({ currentPassword: 'incorrect-current-password' })))).status, 400);
  const limited = await route.POST(request());
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal(sessions.consumeLoginAttempt(sessions.clientIpKey(request())).allowed, true);
});
