import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/front-pause.js', import.meta.url), 'utf8');

function harness(pathname = '/') {
  const location = { pathname }, listeners = [];
  vm.runInNewContext(source, { window: { location, addEventListener: (...args) => listeners.push(args) } });
  assert.equal(listeners.length, 1);
  const [name, onKeyDown, options] = listeners[0];
  assert.equal(name, 'keydown');
  assert.equal(options.capture, true);
  assert.equal(options.passive, false);
  return { location, press(input) {
    const event = { key: '', code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
      cancelled: false, stopped: false, ...input,
      preventDefault() { this.cancelled = true; }, stopImmediatePropagation() { this.stopped = true; } };
    onKeyDown(event);
    return { cancelled: event.cancelled, stopped: event.stopped };
  } };
}

test('homepage cancels F12 and its physical key code, including repeated presses', () => {
  const h = harness();
  for (const event of [{ key: 'F12' }, { key: 'Unidentified', code: 'F12' }, { key: 'F12', repeat: true }, { key: 'F12', ctrlKey: true }]) {
    assert.deepEqual(h.press(event), { cancelled: true, stopped: true });
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

test('normal typing, copying, pasting, searching and keyboard navigation remain available', () => {
  const h = harness();
  for (const event of [{ key: 'i' }, { key: 'u' }, { key: 'Tab' }, { key: 'Escape' }, { key: 'Enter' },
    { key: 'c', ctrlKey: true }, { key: 'c', metaKey: true }, { key: 'v', ctrlKey: true },
    { key: 'f', ctrlKey: true }, { key: 'r', ctrlKey: true }, { key: 'U', ctrlKey: true, shiftKey: true }]) {
    assert.deepEqual(h.press(event), { cancelled: false, stopped: false });
  }
});

test('login, admin, API and other pages retain browser shortcuts after navigation', () => {
  const h = harness();
  for (const pathname of ['/login', '/admin0900daniel', '/api/health', '/brand']) {
    h.location.pathname = pathname;
    assert.deepEqual(h.press({ key: 'F12' }), { cancelled: false, stopped: false });
    assert.deepEqual(h.press({ key: 'I', ctrlKey: true, shiftKey: true }), { cancelled: false, stopped: false });
  }
  h.location.pathname = '/';
  assert.equal(h.press({ key: 'F12' }).cancelled, true);
});

test('script never schedules debugger pauses or blocks unrelated mouse actions', () => {
  assert.doesNotMatch(source, /\bdebugger\s*;|setInterval|setTimeout|contextmenu|while\s*\(/);
  harness();
});
