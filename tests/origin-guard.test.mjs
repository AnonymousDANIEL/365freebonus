import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { NextRequest, NextResponse } from 'next/server.js';
import ts from 'typescript';
import nextConfig from '../next.config.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));
const fixture = mkdtempSync(path.join(tmpdir(), 'directory-origin-guard-'));
writeFileSync(path.join(fixture, 'package.json'), '{"type":"commonjs"}');
symlinkSync(path.join(project, 'node_modules'), path.join(fixture, 'node_modules'), 'dir');
for (const source of ['proxy.ts', 'app/lib/origin-guard.ts', 'app/lib/session-store.ts', 'app/lib/auth-core.ts', 'app/lib/sqlite.ts']) {
  const target = path.join(fixture, source.replace(/\.ts$/, '.js'));
  mkdirSync(path.dirname(target), { recursive: true });
  const { outputText } = ts.transpileModule(readFileSync(path.join(project, source), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  writeFileSync(target, outputText);
}
const require = createRequire(import.meta.url);
const { proxy, config } = require(path.join(fixture, 'proxy.js'));
const { hasVerifiedOrigin, ORIGIN_VERIFY_HEADER } = require(path.join(fixture, 'app/lib/origin-guard.js'));
const { clientIpKey } = require(path.join(fixture, 'app/lib/session-store.js'));
const { sessionIdHash } = require(path.join(fixture, 'app/lib/auth-core.js'));
const previousSecret = process.env.ORIGIN_VERIFY_SECRET;
const proof = 'fixture_origin_verification_token_'.repeat(2);
const origin = 'https://origin-guard-fixture.example';

test.beforeEach(() => { process.env.ORIGIN_VERIFY_SECRET = proof; });
test.after(() => {
  if (previousSecret === undefined) delete process.env.ORIGIN_VERIFY_SECRET;
  else process.env.ORIGIN_VERIFY_SECRET = previousSecret;
  rmSync(fixture, { recursive: true, force: true });
});

function request(pathname, headers = {}, method = 'GET') {
  return new NextRequest(`${origin}${pathname}`, { method, headers });
}

test('catch-all Proxy blocks direct API, admin, public and Next asset requests without reflecting proof', async () => {
  assert.equal(config.matcher, '/:path*');
  for (const pathname of ['/', '/admin0900daniel', '/api/auth/login', '/api/admin/notes', '/_next/static/chunks/app.js', '/brand/avatar.webp']) {
    for (const supplied of [undefined, 'wrong_token_with_valid_shape_123456789', `${proof}, ${proof}`, `${proof} invalid`, 'x'.repeat(257)]) {
      const response = proxy(request(pathname, supplied ? { [ORIGIN_VERIFY_HEADER]: supplied } : {}));
      assert.ok(response instanceof NextResponse);
      assert.equal(response.status, 404, pathname);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(await response.text(), 'Not Found');
      assert.ok(!JSON.stringify([...response.headers]).includes(proof));
    }
  }
  const duplicates = new Headers();
  duplicates.append(ORIGIN_VERIFY_HEADER, proof);
  duplicates.append(ORIGIN_VERIFY_HEADER, proof);
  assert.equal(proxy(request('/', duplicates)).status, 404);
});

test('verified edge requests continue without publishing or replacing request headers', () => {
  for (const pathname of ['/', '/api/admin/notes', '/_next/static/chunks/app.js']) {
    const response = proxy(request(pathname, { [ORIGIN_VERIFY_HEADER]: proof, cookie: 'session=fixture' }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-middleware-next'), '1');
    assert.equal(response.headers.get(ORIGIN_VERIFY_HEADER), null);
    assert.equal(response.headers.get('cookie'), null);
    assert.ok(!JSON.stringify([...response.headers]).includes(proof));
  }
});

test('only exact GET and HEAD health requests bypass origin proof', () => {
  for (const method of ['GET', 'HEAD']) {
    assert.equal(proxy(request('/api/health', {}, method)).headers.get('x-middleware-next'), '1');
    assert.equal(proxy(request('/api/health?monitor=1', {}, method)).headers.get('x-middleware-next'), '1');
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    assert.equal(proxy(request('/api/health', {}, method)).status, 404);
  }
  for (const pathname of ['/api/health/evil', '/api/health/', '/api/healthcheck', '/api/health%2Fevil']) {
    assert.equal(proxy(request(pathname)).status, 404, pathname);
  }
});

test('unset guard preserves development behavior while malformed configured secrets fail closed', () => {
  for (const secret of [undefined, '']) {
    if (secret === undefined) delete process.env.ORIGIN_VERIFY_SECRET;
    else process.env.ORIGIN_VERIFY_SECRET = secret;
    assert.equal(proxy(request('/api/admin/notes')).headers.get('x-middleware-next'), '1');
    assert.equal(hasVerifiedOrigin(request('/', { [ORIGIN_VERIFY_HEADER]: proof })), false);
  }
  for (const secret of ['short', `${proof},${proof}`, `${proof} invalid`]) {
    process.env.ORIGIN_VERIFY_SECRET = secret;
    assert.equal(proxy(request('/', { [ORIGIN_VERIFY_HEADER]: secret })).status, 404);
    assert.equal(proxy(request('/api/health')).headers.get('x-middleware-next'), '1');
  }
});

test('rate keys trust valid Cloudflare client IPs only with the verified origin proof', () => {
  const fallback = '198.51.100.42';
  const headers = { 'x-forwarded-for': `192.0.2.99, ${fallback}`, 'cf-connecting-ip': '203.0.113.10' };
  assert.equal(clientIpKey(request('/api/auth/login', headers)), sessionIdHash(fallback));
  assert.equal(clientIpKey(request('/api/auth/login', { ...headers, [ORIGIN_VERIFY_HEADER]: 'wrong_token_with_valid_shape_123456789' })), sessionIdHash(fallback));
  for (const ip of ['203.0.113.10', '2001:db8::1234']) {
    assert.equal(clientIpKey(request('/api/auth/login', { ...headers, 'cf-connecting-ip': ip, [ORIGIN_VERIFY_HEADER]: proof })), sessionIdHash(ip));
  }
  for (const ip of ['', 'not-an-ip', '203.0.113.10, 192.0.2.12']) {
    assert.equal(clientIpKey(request('/api/auth/login', { ...headers, 'cf-connecting-ip': ip, [ORIGIN_VERIFY_HEADER]: proof })), sessionIdHash(fallback));
  }
  delete process.env.ORIGIN_VERIFY_SECRET;
  assert.equal(clientIpKey(request('/api/auth/login', { ...headers, [ORIGIN_VERIFY_HEADER]: proof })), sessionIdHash(fallback));
  assert.equal(clientIpKey(request('/api/auth/login')), sessionIdHash('unknown-client'));
});

test('security policy blocks plugins, framing and off-site forms without restricting existing scripts or media', async () => {
  const headers = (await nextConfig.headers())[0].headers;
  const policy = headers.find(header => header.key === 'Content-Security-Policy')?.value;
  assert.equal(policy, "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  assert.ok(!/script-src|media-src|img-src/.test(policy));
  const railway = JSON.parse(readFileSync(path.join(project, 'railway.json'), 'utf8'));
  assert.equal(railway.deploy.restartPolicyType, 'ALWAYS');
  assert.equal(railway.deploy.restartPolicyMaxRetries, undefined);
  assert.equal(railway.deploy.healthcheckPath, '/api/health');
});
