import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../app/[adminPath]/NotesActivity.tsx', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

// Execute the real component effect with isolated event targets and a clock.
// No DOM, network, administrator credentials, PIN or note contents are involved.
function harness({ hidden = false, deferred = false } = {}) {
  let now = 0, nextTimer = 0, cleanup;
  const timers = new Map(), windowEvents = new Map(), documentEvents = new Map();
  const calls = [], published = [], resolutions = [];
  const events = map => ({
    addEventListener(name, handler) { if (!map.has(name)) map.set(name, new Set()); map.get(name).add(handler); },
    removeEventListener(name, handler) { map.get(name)?.delete(handler); },
  });
  const document = { hidden, ...events(documentEvents) };
  const window = {
    ...events(windowEvents),
    setTimeout(handler, ms) { const id = ++nextTimer; timers.set(id, { at: now + ms, handler }); return id; },
    clearTimeout(id) { timers.delete(id); },
    dispatchEvent(event) { published.push(event); },
  };
  const moduleObject = { exports: {} };
  vm.runInNewContext(code, {
    module: moduleObject, exports: moduleObject.exports, window, document,
    require(name) { assert.equal(name, 'react'); return { useEffect(effect) { cleanup = effect(); } }; },
    Date: { now: () => now },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
  });
  moduleObject.exports.default({ request(path, method, payload) {
    calls.push({ at: now, path, method, payload });
    const status = { configured: true, unlocked: true, expiresAt: now + 12 * 60 * 60 * 1000, ignored: 'server-only metadata' };
    return deferred ? new Promise(resolve => resolutions.push(() => resolve(status))) : Promise.resolve(status);
  } });
  async function advance(ms) {
    const target = now + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      timers.delete(id); now = timer.at; timer.handler(); await flush();
    }
    now = target; await flush();
  }
  function fire(name, isTrusted = true, target = windowEvents) {
    for (const handler of target.get(name) || []) handler({ type: name, isTrusted });
  }
  return { calls, published, resolutions, timers, windowEvents, documentEvents, document, advance, fire, cleanup: () => cleanup() };
}

test('real dashboard input renews once immediately and batches only actual trailing input', async () => {
  const h = harness();
  try {
    await flush();
    assert.equal(h.calls.length, 1, 'visible dashboard visit is activity');
    await h.advance(2 * 60 * 60 * 1000);
    assert.equal(h.calls.length, 1, 'time alone never renews');
    h.fire('pointerdown'); await flush();
    assert.equal(h.calls.length, 2);
    await h.advance(10_000);
    h.fire('keydown'); h.fire('input'); await flush();
    assert.equal(h.calls.length, 2);
    await h.advance(49_999);
    assert.equal(h.calls.length, 2, 'burst respects the minute throttle');
    await h.advance(1);
    assert.equal(h.calls.length, 3, 'one trailing request represents pending input');
    await h.advance(12 * 60 * 60 * 1000);
    assert.equal(h.calls.length, 3, 'no passive periodic heartbeat remains');
    assert.ok(h.calls.every(call => call.path === '/api/admin/notes/vault' && call.method === 'POST' && JSON.stringify(call.payload) === '{"action":"activity"}'));
    assert.ok(h.published.every(event => event.type === '365-notes-vault-activity' && Object.keys(event.detail).join(',') === 'configured,unlocked,expiresAt'));
  } finally { h.cleanup(); }
});

test('synthetic input cannot keep an unattended page unlocked', async () => {
  const h = harness();
  try {
    await flush();
    await h.advance(60_000);
    for (const event of ['pointerdown', 'keydown', 'input', 'wheel', 'touchstart', 'focus']) h.fire(event, false);
    await h.advance(13 * 60 * 60 * 1000);
    assert.equal(h.calls.length, 1);
    assert.equal(h.timers.size, 0);
  } finally { h.cleanup(); }
});

test('hiding the tab cancels queued renewal and hidden input sends nothing', async () => {
  const h = harness();
  try {
    await flush(); await h.advance(10_000);
    h.fire('keydown');
    assert.equal(h.timers.size, 1);
    h.document.hidden = true; h.fire('visibilitychange', true, h.documentEvents);
    await h.advance(60_000);
    h.fire('pointerdown'); h.fire('focus'); await flush();
    assert.equal(h.calls.length, 1);
    assert.equal(h.timers.size, 0);
    h.document.hidden = false; h.fire('focus'); await flush();
    assert.equal(h.calls.length, 2, 'returning to the dashboard is activity');
  } finally { h.cleanup(); }
});

test('a page mounted in the background sends no activity until a real visible return', async () => {
  const h = harness({ hidden: true });
  try {
    await h.advance(13 * 60 * 60 * 1000);
    assert.equal(h.calls.length, 0);
    h.document.hidden = false; h.fire('visibilitychange', true, h.documentEvents); await flush();
    assert.equal(h.calls.length, 1);
  } finally { h.cleanup(); }
});

test('unmount discards pending responses, listeners and trailing work', async () => {
  const h = harness({ deferred: true });
  assert.equal(h.calls.length, 1);
  h.fire('keydown');
  h.cleanup();
  h.resolutions[0](); await flush();
  await h.advance(13 * 60 * 60 * 1000);
  assert.equal(h.calls.length, 1);
  assert.equal(h.published.length, 0);
  assert.equal(h.timers.size, 0);
  assert.ok([...h.windowEvents.values(), ...h.documentEvents.values()].every(handlers => handlers.size === 0));
});
