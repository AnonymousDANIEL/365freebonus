import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

const fixture = mkdtempSync(path.join(tmpdir(), 'website-login-client-'));
writeFileSync(path.join(fixture, 'package.json'), '{"type":"commonjs"}');
symlinkSync(new URL('../node_modules', import.meta.url).pathname, path.join(fixture, 'node_modules'), 'dir');
const source = readFileSync(new URL('../app/lib/website-login-client.ts', import.meta.url), 'utf8');
writeFileSync(path.join(fixture, 'client.js'), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText);
const require = createRequire(import.meta.url);
const { validateWebsiteUrl, resolvePublicWebsiteHost, executeWebsiteLogin, parseWebsiteLoginForm, WebsiteLoginError } = require(path.join(fixture, 'client.js'));
const input = { loginUrl: 'https://accounts.fixture-company.com/signin', verifyUrl: 'https://accounts.fixture-company.com/private', successText: 'Private account overview', username: 'fixture-user', password: 'fixture-password' };
const form = '<form method="post" action="/session"><input type="hidden" name="csrf" value="a&amp;b"><input name="username"><input name="password" type="password"><button name="action" value="signin">Sign in</button></form>';
const ok = body => ({ status: 200, headers: {}, body });

test('only public HTTPS hostname URLs and the explicit ordinary-site scope are accepted', () => {
  assert.equal(validateWebsiteUrl(input.loginUrl).origin, 'https://accounts.fixture-company.com');
  for (const value of ['http://accounts.fixture-company.com/', 'https://accounts.fixture-company.com:444/', 'https://user:secret@accounts.fixture-company.com/', 'https://127.0.0.1/', 'https://2130706433/', 'https://[::1]/', 'https://localhost/', 'https://service.internal/', 'https://service.local/', 'https://service.invalid/', 'https://accounts.fixture-company.com/#secret', 'https://syabas99.com/', 'https://sub.bintang44.com/']) assert.throws(() => validateWebsiteUrl(value), WebsiteLoginError, value);
});

test('DNS validation rejects mixed answers, rebinding targets and non-unicast IPv4/IPv6 before connection', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.0.1', '169.254.169.254', '100.100.100.200', '0.0.0.0', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    await assert.rejects(resolvePublicWebsiteHost('fixture-company.com', async () => [{ address, family: address.includes(':') ? 6 : 4 }]), WebsiteLoginError, address);
  }
  await assert.rejects(resolvePublicWebsiteHost('fixture-company.com', async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]), WebsiteLoginError);
  assert.deepEqual(await resolvePublicWebsiteHost('fixture-company.com', async () => [{ address: '8.8.8.8', family: 4 }]), [{ address: '8.8.8.8', family: 4 }]);
});

test('standard form extraction preserves hidden CSRF and the submit name without sending credentials in a URL', () => {
  const parsed = parseWebsiteLoginForm(form, new URL(input.loginUrl), input);
  assert.equal(parsed.action.href, 'https://accounts.fixture-company.com/session');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(parsed.body)), { csrf: 'a&b', username: input.username, password: input.password, action: 'signin' });
  assert.throws(() => parseWebsiteLoginForm(form.replace('method="post"', 'method="get"'), new URL(input.loginUrl), input), WebsiteLoginError);
  assert.throws(() => parseWebsiteLoginForm(form.replace('action="/session"', 'action="https://attacker.company.net/session"'), new URL(input.loginUrl), input), WebsiteLoginError);
});

test('captcha, two-factor and ambiguous/missing forms stop before a login POST', async () => {
  for (const html of [form + '<div data-sitekey="fixture"></div>', form + '<input name="totp">', form + form, '<div id="client-only-app"></div>']) {
    let calls = 0;
    await assert.rejects(executeWebsiteLogin(input, async (_url, method) => { calls++; assert.equal(method, 'GET'); return ok(html); }), WebsiteLoginError);
    assert.ok(calls <= 2);
  }
});

test('successful login carries scoped cookies and CSRF through redirects, then checks the private page', async () => {
  const calls = [];
  const transport = async (url, method, body, headers) => {
    calls.push({ url: url.href, method, body, headers });
    if (calls.length === 1) return { ...ok(form), headers: { 'set-cookie': ['anonymous=must-not-leak; Path=/'] } };
    if (calls.length === 2) { assert.equal(headers.Cookie, undefined); return { ...ok(form), headers: { 'set-cookie': ['csrf_session=first; Path=/; Secure', 'wrong_path=private; Path=/unrelated; Secure'] } }; }
    if (calls.length === 3) {
      assert.equal(headers.Cookie, 'csrf_session=first');
      assert.equal(headers.Origin, new URL(input.loginUrl).origin);
      assert.equal(new URLSearchParams(body).get('csrf'), 'a&b');
      return { status: 303, headers: { location: '/home', 'set-cookie': ['session=authenticated; Path=/; Secure'] }, body: '' };
    }
    assert.equal(method, 'GET');
    assert.equal(body, undefined);
    assert.equal(headers.Cookie, 'csrf_session=first; session=authenticated');
    return ok('<h1>Private account overview</h1>');
  };
  await executeWebsiteLogin(input, transport);
  assert.equal(calls.length, 5);
  assert.equal(calls.at(-1).url, input.verifyUrl);
  assert.equal(calls[2].method, 'POST');
});

test('HTTP 200 or a matching marker hidden in scripts never counts as authenticated', async () => {
  for (const html of ['<h1>Sign in failed</h1>', '<script>"Private account overview"</script><p>Public page</p>', '<h1>Private account overview</h1><input type="password" name="password">']) {
    let calls = 0;
    await assert.rejects(executeWebsiteLogin(input, async () => ++calls <= 2 ? ok(form) : ok(html)), WebsiteLoginError);
  }
});

test('cross-origin redirects never receive a request, cookies or credentials', async () => {
  let calls = 0;
  await assert.rejects(executeWebsiteLogin(input, async () => {
    calls++;
    return { status: 307, headers: { location: 'https://attacker.company.net/' }, body: '' };
  }), WebsiteLoginError);
  assert.equal(calls, 1);
  await assert.rejects(executeWebsiteLogin({ ...input, verifyUrl: 'https://another.company.com/private' }, async () => { throw Error('must not request'); }), WebsiteLoginError);
});

test('redirect loops, excessive responses and transport exceptions fail with safe errors', async () => {
  let calls = 0;
  await assert.rejects(executeWebsiteLogin(input, async () => { calls++; return { status: 302, headers: { location: '/loop' }, body: '' }; }), WebsiteLoginError);
  assert.equal(calls, 6);
  await assert.rejects(executeWebsiteLogin(input, async () => ok('a'.repeat(4 * 1024 * 1024 + 1))), error => error instanceof WebsiteLoginError && error.message.includes('4 MB'));
  const secret = 'fixture-secret-never-in-public-error';
  await assert.rejects(executeWebsiteLogin(input, async () => { throw Error(secret); }), error => error instanceof WebsiteLoginError && !error.message.includes(secret));
});

test('ordinary login HTML larger than the former512KiB limit can complete authentication', async () => {
  const largeForm = form + '<!--' + 'a'.repeat(768 * 1024) + '-->';
  let posts = 0;
  await executeWebsiteLogin(input, async (_url, method) => {
    if (method === 'POST') posts++;
    return ok(posts ? '<h1>Private account overview</h1>' : largeForm);
  });
  assert.equal(posts, 1);
});

test('response safety limit measures UTF8 bytes and rejects oversized HTML before credentials are sent', async () => {
  const oversized = '界'.repeat(Math.ceil(4 * 1024 * 1024 / 3));
  assert.ok(oversized.length < 4 * 1024 * 1024);
  assert.ok(Buffer.byteLength(oversized) > 4 * 1024 * 1024);
  let calls = 0;
  await assert.rejects(executeWebsiteLogin(input, async (_url, method) => {
    calls++;
    assert.equal(method, 'GET');
    return ok(oversized);
  }), error => error instanceof WebsiteLoginError && error.message.includes('4 MB'));
  assert.equal(calls, 1);
});

test('anonymous verification may return401, while authenticated verification still requires a successful response', async () => {
  for (const authenticatedStatus of [200, 401]) {
    let calls = 0;
    let posts = 0;
    const run = executeWebsiteLogin(input, async (_url, method, _body, headers) => {
      calls++;
      if (calls === 1) {
        assert.equal(method, 'GET');
        assert.equal(headers.Cookie, undefined);
        return { status: 401, headers: { 'set-cookie': ['anonymous=isolated; Path=/'] }, body: '<p>Sign in required</p>' };
      }
      if (calls === 2) { assert.equal(headers.Cookie, undefined); return ok(form); }
      if (method === 'POST') { posts++; return ok('<p>Private account overview</p>'); }
      return { status: authenticatedStatus, headers: {}, body: '<p>Private account overview</p>' };
    });
    if (authenticatedStatus === 200) assert.equal(typeof (await run).session, 'string');
    else await assert.rejects(run, WebsiteLoginError);
    assert.equal(posts, 1);
    assert.equal(calls, 4);
  }
});

test('public success markers are rejected before credentials are sent', async () => {
  let calls = 0;
  await assert.rejects(executeWebsiteLogin(input, async () => { calls++; return ok('<h1>Private account overview</h1>'); }), error => error instanceof WebsiteLoginError && error.message.includes('未登录'));
  assert.equal(calls, 1);
});

test('a saved session is verified without another credential POST and anonymous cookies stay isolated', async () => {
  const existingSession = JSON.stringify({ origin: new URL(input.loginUrl).origin, username: input.username, cookies: [{ name: 'session', value: 'saved-fixture', path: '/', expires: Date.now() + 60000 }] });
  let calls = 0;
  const result = await executeWebsiteLogin({ ...input, existingSession }, async (url, method, body, headers) => {
    calls++;
    assert.equal(url.href, input.verifyUrl);
    assert.equal(method, 'GET');
    assert.equal(body, undefined);
    if (calls === 1) {
      assert.equal(headers.Cookie, undefined);
      return { ...ok(form), headers: { 'set-cookie': ['anonymous=must-not-leak; Path=/'] } };
    }
    assert.equal(headers.Cookie, 'session=saved-fixture');
    return ok('<h1>Private account overview</h1>');
  });
  assert.equal(calls, 2);
  const saved = JSON.parse(result.session);
  assert.equal(saved.origin, new URL(input.loginUrl).origin);
  assert.equal(saved.username, input.username);
  assert.equal(saved.cookies[0].value, 'saved-fixture');
  assert.equal(saved.cookies.some(cookie => cookie.name === 'anonymous'), false);
});

test('expired or differently scoped saved sessions cannot authenticate and fall back to normal login', async () => {
  for (const existingSession of [JSON.stringify({ origin: 'https://other.company.net', username: input.username, cookies: [{ name: 'session', value: 'private', path: '/', expires: Date.now() + 60000 }] }), JSON.stringify({ origin: new URL(input.loginUrl).origin, username: 'another-user', cookies: [{ name: 'session', value: 'private', path: '/', expires: Date.now() + 60000 }] }), JSON.stringify({ origin: new URL(input.loginUrl).origin, username: input.username, cookies: [{ name: 'session', value: 'private', path: '/', expires: 0 }] })]) {
    let posts = 0;
    await executeWebsiteLogin({ ...input, existingSession }, async (url, method, _body, headers) => {
      assert.equal(headers.Cookie, undefined);
      if (method === 'POST') { posts++; return ok('<h1>Private account overview</h1>'); }
      return ok(posts ? '<h1>Private account overview</h1>' : form);
    });
    assert.equal(posts, 1);
  }
});

test.after(() => rmSync(fixture, { recursive: true, force: true }));
