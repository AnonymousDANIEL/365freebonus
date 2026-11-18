import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/front-pause.js', import.meta.url), 'utf8');
const pausedHtml = readFileSync(new URL('../public/page-paused.html', import.meta.url), 'utf8');
const pausedPath = '/page-paused.html';

function harness(pathname = '/', publicPage = false) {
  const navigations = [], listeners = [];
  const location = { pathname, assign: path => navigations.push(path) };
  const document = { querySelector: selector => publicPage && selector === '.public-site' ? {} : null };
  vm.runInNewContext(source, { document, window: { location, addEventListener: (...args) => listeners.push(args) } });
  assert.equal(listeners.length, 1);
  const [name, onKeyDown, options] = listeners[0];
  assert.equal(name, 'keydown');
  assert.equal(options.capture, true);
  assert.equal(options.passive, false);
  return { navigations, press(input) {
    const event = { key: '', code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
      cancelled: false, stopped: false, ...input,
      preventDefault() { this.cancelled = true; }, stopImmediatePropagation() { this.stopped = true; } };
    onKeyDown(event);
    return { cancelled: event.cancelled, stopped: event.stopped };
  } };
}

test('home and published brand pages leave the active document on F12, including the physical key code', () => {
  for (const [pathname, publicPage] of [['/', false], ['/sample-brand', true], ['/another-brand', true]]) {
    for (const event of [{ key: 'F12' }, { key: 'Unidentified', code: 'F12' }, { key: 'F12', repeat: true }, { key: 'F12', ctrlKey: true }]) {
      const h = harness(pathname, publicPage);
      assert.deepEqual(h.press(event), { cancelled: true, stopped: true });
      assert.deepEqual(h.navigations, [pausedPath]);
    }
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

test('login, admin, API and missing pages keep shortcuts and never navigate to the pause page', () => {
  for (const pathname of ['/login', '/private-studio', '/api/health', '/missing-brand']) {
    const h = harness(pathname);
    assert.deepEqual(h.press({ key: 'F12' }), { cancelled: false, stopped: false });
    assert.deepEqual(h.press({ key: 'I', ctrlKey: true, shiftKey: true }), { cancelled: false, stopped: false });
    assert.deepEqual(h.navigations, []);
  }
});

test('standalone pause document loads only the shortcut guard and allows returning to the directory', () => {
  assert.match(pausedHtml, /<meta\s+name="robots"\s+content="noindex,\s*nofollow"/);
  assert.match(pausedHtml, /<a\s+href="\/"/);
  const scripts = [...pausedHtml.matchAll(/<script\b[^>]*>/g)].map(match => match[0]);
  assert.equal(scripts.length, 1);
  assert.match(scripts[0], /src="\/front-pause\.js(?:\?[^"]*)?"/);

  const paused = harness(pausedPath);
  assert.deepEqual(paused.press({ key: 'F12' }), { cancelled: true, stopped: true });
  assert.deepEqual(paused.press({ key: 'r', ctrlKey: true }), { cancelled: false, stopped: false });
  assert.deepEqual(paused.navigations, []);
  const reopened = harness('/', true);
  assert.deepEqual(reopened.press({ key: 'Enter' }), { cancelled: false, stopped: false });
  assert.deepEqual(reopened.navigations, []);
});

test('script never schedules debugger pauses or blocks unrelated mouse actions', () => {
  assert.doesNotMatch(source, /\bdebugger\s*;|setInterval|setTimeout|contextmenu|while\s*\(/);
  harness();
});
