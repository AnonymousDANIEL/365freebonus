import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { scryptSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const project = fileURLToPath(new URL('..', import.meta.url));
const fixture = mkdtempSync(path.join(tmpdir(), 'directory-security-'));
writeFileSync(path.join(fixture, 'package.json'), '{"type":"commonjs"}');
symlinkSync(path.join(project, 'node_modules'), path.join(fixture, 'node_modules'), 'dir');
for (const source of [
  'app/lib/sqlite.ts', 'app/lib/directory.ts', 'app/lib/auth-core.ts', 'app/lib/session-store.ts', 'app/lib/admin-credentials.ts',
  'app/api/admin/_security.ts', 'app/api/auth/login/route.ts', 'app/api/health/route.ts',
]) {
  const target = path.join(fixture, source.replace(/\.ts$/, '.js'));
  mkdirSync(path.dirname(target), { recursive: true });
  const { outputText } = ts.transpileModule(readFileSync(path.join(project, source), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  writeFileSync(target, outputText);
}
// Cookie context is irrelevant to these login/body/health handlers. All actual
// origin checks, password verification, rate limits and database reads run.
writeFileSync(path.join(fixture, 'app/chatgpt-auth.js'), 'exports.getChatGPTUser = async () => null;');
const require = createRequire(import.meta.url);
const { jsonBody } = require(path.join(fixture, 'app/api/admin/_security.js'));
const login = require(path.join(fixture, 'app/api/auth/login/route.js'));
const health = require(path.join(fixture, 'app/api/health/route.js'));
const sessions = require(path.join(fixture, 'app/lib/session-store.js'));
const { getSqlite } = require(path.join(fixture, 'app/lib/sqlite.js'));
const envNames = ['DATA_DIR', 'APP_URL', 'ADMIN_USERNAME', 'ADMIN_PASSWORD_HASH', 'SESSION_SECRET'];
const previousEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
const origin = 'https://security-fixture.example';

test.beforeEach(() => {
  process.env.DATA_DIR = mkdtempSync(path.join(fixture, 'case-'));
  process.env.APP_URL = origin;
});
test.afterEach(() => {
  const filename = path.join(process.env.DATA_DIR, 'directory.sqlite');
  globalThis.__directorySqlite?.get(filename)?.close();
  globalThis.__directorySqlite?.delete(filename);
});
test.after(() => {
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(fixture, { recursive: true, force: true });
});

function streamedRequest(chunks, headers = {}) {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream({
    pull(controller) {
      if (state.pulled >= chunks.length) controller.close();
      else controller.enqueue(chunks[state.pulled++]);
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return { state, request: new Request(`${origin}/api/auth/login`, { method: 'POST', headers, body, duplex: 'half' }) };
}

test('JSON body limit cancels an unknown or underreported stream immediately after crossing 30 KB', async () => {
  for (const headers of [{}, { 'content-length': '1' }]) {
    const chunks = Array.from({ length: 20 }, () => new Uint8Array(16_384));
    const { request, state } = streamedRequest(chunks, headers);
    await assert.rejects(jsonBody(request), { status: 413 });
    assert.equal(state.cancelled, true);
    assert.equal(state.pulled, 2, 'must stop at the first over-limit chunk');
    assert.equal(request.body.locked, false);
  }
});

test('declared oversized JSON is rejected and cancelled without consuming the body', async () => {
  const { request, state } = streamedRequest([new Uint8Array(40_000)], { 'content-length': '40000' });
  await assert.rejects(jsonBody(request), { status: 413 });
  assert.equal(state.cancelled, true);
  assert.equal(state.pulled, 0);
});

test('JSON accepts the exact byte boundary and UTF-8 characters split across chunks', async () => {
  for (const value of ['a'.repeat(29_998), `${'你'.repeat(9_999)}a`]) {
    const bytes = Buffer.from(JSON.stringify(value));
    assert.equal(bytes.length, 30_000);
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += 4_096) chunks.push(bytes.subarray(offset, offset + 4_096));
    const { request } = streamedRequest(chunks);
    assert.equal(await jsonBody(request), value);
  }
  const { request } = streamedRequest([Buffer.from(JSON.stringify('a'.repeat(29_999)))]);
  await assert.rejects(jsonBody(request), { status: 413 });
});

test('JSON rejects empty, malformed and invalid UTF-8 payloads with a safe validation error', async () => {
  const noBody = new Request(`${origin}/api/auth/login`, { method: 'POST' });
  await assert.rejects(jsonBody(noBody), { status: 400 });
  for (const bytes of [Buffer.alloc(0), Buffer.from('{'), Buffer.from([0x22, 0xff, 0x22])]) {
    await assert.rejects(jsonBody(streamedRequest([bytes]).request), { status: 400 });
  }
});

test('health checks real application table access and never caches success or failure', async () => {
  const healthy = await health.GET();
  assert.equal(healthy.status, 200);
  assert.equal(healthy.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await healthy.json(), { status: 'ok' });
  const db = getSqlite();
  db.exec('DROP TABLE site_settings');
  assert.equal(db.prepare('SELECT 1 AS alive').get().alive, 1, 'a trivial query would miss the broken application table');
  const failed = await health.GET();
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await failed.json(), { status: 'unavailable' });
});

test('failed and rate-limited logins emit only redacted structured security events', async t => {
  const username = 'fixture-admin-private';
  const password = 'fixture-wrong-password-private';
  const ip = '203.0.113.27';
  const cookie = 'fixture-cookie-private';
  const secret = 'fixture-session-secret-never-log-this-value';
  const salt = '0123456789abcdef0123456789abcdef';
  process.env.ADMIN_USERNAME = username;
  process.env.ADMIN_PASSWORD_HASH = `scrypt$${salt}$${scryptSync('fixture-real-password', Buffer.from(salt, 'hex'), 64).toString('hex')}`;
  process.env.SESSION_SECRET = secret;
  const output = [];
  t.mock.method(console, 'warn', (...args) => output.push(args));
  const request = () => new Request(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'x-forwarded-for': ip, cookie },
    body: JSON.stringify({ username, password }),
  });
  const failed = await login.POST(request());
  assert.equal(failed.status, 401);
  const ipHash = sessions.clientIpKey(request());
  for (let index = 0; index < 7; index++) sessions.consumeLoginAttempt(ipHash);
  const limited = await login.POST(request());
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal(output.length, 2);
  for (const [index, args] of output.entries()) {
    assert.equal(args.length, 1);
    const event = JSON.parse(args[0]);
    assert.deepEqual(Object.keys(event).sort(), ['clientIpHash', 'event', 'status', 'timestamp', 'type']);
    assert.equal(event.type, 'security_event');
    assert.equal(event.event, index === 0 ? 'admin_login_failed' : 'admin_login_rate_limited');
    assert.equal(event.status, index === 0 ? 401 : 429);
    assert.equal(event.clientIpHash, ipHash);
    assert.match(event.clientIpHash, /^[a-f0-9]{64}$/);
    assert.ok(Math.abs(Date.now() - Date.parse(event.timestamp)) < 10_000);
    for (const privateValue of [username, password, ip, cookie, secret, salt, process.env.ADMIN_PASSWORD_HASH]) {
      assert.equal(args[0].includes(privateValue), false, 'logs must not include request or secret values');
    }
  }
});
