import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../app/[adminPath]/TelegramGroupSettings.tsx', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const at = Date.parse('2026-11-16T12:30:00Z');
function snapshot(relay = {}) {
  const counts = { pending: 0, sending: 0, sent: 1, failed: 0, unknown: 0, cancelled: 0, skipped: 0 };
  return { enabled: false, chatId: '', hasToken: true, promotionMessage: '', counts, lastError: '',
    relay: { enabled: true, chatId: '@fixture_group', ready: true, captionWatchEnabled: true, captionWatchIntervalSeconds: 30,
      captionWatch: { watched: 1, pending: 1, checking: 0, consistent: 0, mismatch: 0, waiting: 0, lastCheckedAt: null, nextCheckAt: at, lastError: '' },
      counts, lastError: '', lastPolledAt: at, ...relay },
    welcome: { enabled: false, chatId: '', message: '', sent: 0, lastPolledAt: null, lastError: '' },
    chatBot: { hasToken: false, keywordEnabled: false, keywordReplies: 0, privateEnabled: false, privateStartMessage: '', privateReplies: 0,
      followup: { enabled: false, message: '', delayMinutes: 60, counts, lastError: '' }, updates: { enabled: false, counts, lastError: '' } },
  };
}

// Exercise the actual settings component with controlled requests and hooks.
// No browser session, Telegram request or production state is involved.
function harness(initial = snapshot()) {
  const hooks = [], effects = [], timers = new Map(), calls = [];
  let index = 0, tree, serial = 0, current = initial, nextGet, nextPut;
  const jsx = (type, props) => ({ type, props: props || {} });
  const react = {
    useState(initialValue) { const slot = index++; if (!hooks[slot]) hooks[slot] = { value: typeof initialValue === 'function' ? initialValue() : initialValue }; return [hooks[slot].value, update => { hooks[slot].value = typeof update === 'function' ? update(hooks[slot].value) : update; }]; },
    useRef(value) { const slot = index++; if (!hooks[slot]) hooks[slot] = { current: value }; return hooks[slot]; },
    useEffect(callback, deps) { const slot = index++, previous = hooks[slot]; if (!previous || deps.some((value, i) => value !== previous.deps[i])) { previous?.cleanup?.(); effects.push(() => { hooks[slot] = { deps, cleanup: callback() }; }); } },
  };
  const request = async (path, method = 'GET', body) => {
    calls.push({ path, method, body });
    if (method === 'GET' && nextGet) { const get = nextGet; nextGet = null; return get(); }
    if (method === 'PUT' && nextPut) { const put = nextPut; nextPut = null; return put(); }
    return current;
  };
  const moduleObject = { exports: {} }, document = { visibilityState: 'visible' };
  vm.runInNewContext(code, { module: moduleObject, exports: moduleObject.exports, require(name) {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === 'lucide-react') return new Proxy({}, { get: (_, key) => String(key) });
    if (name.endsWith('.css')) return {};
    if (name === './TelegramPersonalAccount' || name === './TelegramJoinGate') return { default: name };
    throw Error(`Unexpected import ${name}`);
  }, Date, Error, Intl, document,
    setInterval(fn, ms) { const id = ++serial; timers.set(id, { fn, ms }); return id; }, clearInterval(id) { timers.delete(id); },
  });
  function render() { index = 0; tree = moduleObject.exports.default({ request, signInPath: '/sign-in' }); for (const effect of effects.splice(0)) effect(); }
  function nodes(node, found = []) { if (arguments.length === 0) node = tree; if (node == null || typeof node !== 'object') return found; if (Array.isArray(node)) { node.forEach(child => nodes(child, found)); return found; } found.push(node); nodes(node.props?.children, found); return found; }
  function text(node) { if (node == null || typeof node === 'boolean') return ''; if (typeof node !== 'object') return String(node); if (Array.isArray(node)) return node.map(text).join(''); return text(node.props?.children); }
  function field(label, type = 'input') { const node = nodes().find(n => n.type === 'label' && text(n).startsWith(label)); assert.ok(node, label); const fieldNode = nodes(node).find(n => n.type === type); assert.ok(fieldNode); return fieldNode; }
  render();
  return { calls, document, render, field, text: () => text(tree), form: () => nodes().find(n => n.type === 'form'),
    async ready() { await flush(); render(); },
    setSnapshot(value) { current = value; }, deferGet(fn) { nextGet = fn; }, setPut(fn) { nextPut = fn; },
    async poll() { for (const timer of timers.values()) if (timer.ms === 30000) timer.fn(); await flush(); render(); },
    close() { for (const hook of hooks) hook?.cleanup?.(); },
  };
}

test('observation preferences save their own switch and interval through the existing authenticated settings request', async () => {
  const h = harness();
  try {
    await h.ready();
    assert.equal(h.field('观察并同步来源文案').props.checked, true);
    assert.equal(h.field('文案检查间隔', 'select').props.value, 30);
    h.field('文案检查间隔', 'select').props.onChange({ target: { value: '180' } }); h.render();
    h.field('观察并同步来源文案').props.onChange({ target: { checked: false } }); h.render();
    assert.equal(h.field('文案检查间隔', 'select').props.disabled, true);
    await h.form().props.onSubmit({ preventDefault() {} }); h.render();
    const saved = h.calls.find(call => call.method === 'PUT');
    assert.equal(saved.body.relay.captionWatchEnabled, false);
    assert.equal(saved.body.relay.captionWatchIntervalSeconds, 180);
    assert.equal(saved.body.relay.enabled, true);
    assert.ok(!h.calls.some(call => call.path.includes('send') || call.path.includes('publish')));
  } finally { h.close(); }
});

test('periodic status refresh preserves unsaved copy and preferences while showing verified caption progress', async () => {
  const h = harness();
  try {
    await h.ready();
    const copy = '  Unsaved copy\n\n🎁 Exact draft  ';
    h.field('品牌通知文案', 'textarea').props.onChange({ target: { value: copy } }); h.render();
    h.field('文案检查间隔', 'select').props.onChange({ target: { value: '60' } }); h.render();
    const status = snapshot(); status.relay.captionWatch = { ...status.relay.captionWatch, pending: 0, consistent: 1, lastCheckedAt: at };
    h.setSnapshot(status); await h.poll();
    assert.equal(h.field('品牌通知文案', 'textarea').props.value, copy);
    assert.equal(h.field('文案检查间隔', 'select').props.value, 60);
    assert.match(h.text(), /已核对一致1/);
    assert.match(h.text(), /2026\/11\/16 20:30:00/);
    assert.ok(h.calls.every(call => call.method === 'GET'));
    h.document.visibilityState = 'hidden'; const count = h.calls.length; await h.poll();
    assert.equal(h.calls.length, count);
  } finally { h.close(); }
});

test('a poll started before saving cannot overwrite the confirmed saved observation preferences', async () => {
  const h = harness(); let resolvePoll;
  try {
    await h.ready(); h.deferGet(() => new Promise(resolve => { resolvePoll = resolve; })); await h.poll();
    h.field('观察并同步来源文案').props.onChange({ target: { checked: false } }); h.render();
    h.setPut(() => snapshot({ captionWatchEnabled: false }));
    await h.form().props.onSubmit({ preventDefault() {} }); h.render();
    resolvePoll(snapshot({ captionWatchEnabled: true })); await h.ready();
    assert.equal(h.field('观察并同步来源文案').props.checked, false);
    assert.match(h.text(), /文案一致性观察 · 已暂停/);
  } finally { h.close(); }
});
