import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../public/front-pause.js', import.meta.url), 'utf8');

function harness(pathname = '/', publicPage = false) {
  const navigations = [], listeners = [];
  const location = { pathname, assign: path => navigations.push(path), replace: path => navigations.push(path),
    reload: () => navigations.push('reload'), set href(path) { navigations.push(path); } };
  const document = { querySelector: selector => publicPage && selector === '.public-site' ? {} : null };
  vm.runInNewContext(source, { document, window: { location, addEventListener: (...args) => listeners.push(args) } });
  assert.equal(listeners.length, 1);
  const [name, onKeyDown, options] = listeners[0];
  assert.equal(name, 'keydown');
  assert.equal(options.capture, true);
  assert.equal(options.passive, false);
  return { navigations, navigate(path, isPublicPage) { location.pathname = path; publicPage = isPublicPage; }, press(input) {
    const event = { key: '', code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
      cancelled: false, stopped: false, ...input,
      preventDefault() { this.cancelled = true; }, stopImmediatePropagation() { this.stopped = true; } };
    onKeyDown(event);
    return { cancelled: event.cancelled, stopped: event.stopped };
  } };
}

test('home and published brand pages cancel F12 while staying on the same document', () => {
  for (const [pathname, publicPage] of [['/', false], ['/sample-brand', true], ['/another-brand', true]]) {
    const h = harness(pathname, publicPage);
    for (const event of [{ key: 'F12' }, { key: 'Unidentified', code: 'F12' }, { key: 'F12', repeat: true }, { key: 'F12', ctrlKey: true }]) {
      assert.deepEqual(h.press(event), { cancelled: true, stopped: true });
    }
    assert.deepEqual(h.press({ key: 'Enter' }), { cancelled: false, stopped: false });
    assert.deepEqual(h.navigations, []);
  }
});

test('homepage cancels common Windows, Linux and Mac developer shortcuts', () => {
  const h = harness();
  for (const key of ['i', 'I', 'j', 'c', 'k']) {
    assert.equal(h.press({ key, ctrlKey: true, shiftKey: true }).cancelled, true);
    assert.equal(h.press({ key, metaKey: true, altKey: true }).cancelled, true);
  }
  assert.equal(h.press({ key: 'c', metaKey: true, shiftKey: true }).cancelled, true);
  for (const event of [{ key: 'u', ctrlKey: true }, { key: 'u', metaKey: true }, { key: 'u', metaKey: true, altKey: true }]) {
    assert.equal(h.press(event).cancelled, true);
  }
  assert.deepEqual(h.navigations, []);
});

test('ordinary typing, copy, paste, search, reload and navigation do not pause a public brand page', () => {
  const h = harness('/sample-brand', true);
  for (const event of [{ key: 'i' }, { key: 'u' }, { key: 'Tab' }, { key: 'Escape' }, { key: 'Enter' },
    { key: 'c', ctrlKey: true }, { key: 'c', metaKey: true }, { key: 'v', ctrlKey: true },
    { key: 'f', ctrlKey: true }, { key: 'r', ctrlKey: true }, { key: 'U', ctrlKey: true, shiftKey: true }]) {
    assert.deepEqual(h.press(event), { cancelled: false, stopped: false });
  }
  assert.deepEqual(h.navigations, []);
});

test('shortcut scope follows the active page across brand, login and admin navigation', () => {
  const h = harness('/sample-brand', true);
  assert.equal(h.press({ key: 'F12' }).cancelled, true);
  for (const pathname of ['/login', '/private-studio', '/api/health', '/missing-brand']) {
    h.navigate(pathname, false);
    assert.deepEqual(h.press({ key: 'F12' }), { cancelled: false, stopped: false });
    assert.deepEqual(h.press({ key: 'I', ctrlKey: true, shiftKey: true }), { cancelled: false, stopped: false });
  }
  h.navigate('/another-brand', true);
  assert.equal(h.press({ key: 'F12' }).cancelled, true);
  assert.deepEqual(h.navigations, []);
});

test('old links to the retired pause document return to the directory', () => {
  assert.equal(existsSync(new URL('../public/page-paused.html', import.meta.url)), false);
  const route = readFileSync(new URL('../app/page-paused.html/route.ts', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(route, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
  const exports = {};
  vm.runInNewContext(outputText, { exports, Response });
  for (const method of ['GET', 'HEAD']) {
    const response = exports[method]();
    assert.equal(response.status, 307);
    assert.equal(response.headers.get('location'), '/');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

test('script never schedules debugger pauses or blocks unrelated mouse actions', () => {
  assert.doesNotMatch(source, /\bdebugger\s*;|setInterval|setTimeout|contextmenu|while\s*\(/);
  harness();
});
