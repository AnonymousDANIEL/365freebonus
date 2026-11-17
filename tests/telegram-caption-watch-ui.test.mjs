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
function harness(initial = snapshot(), initialView = 'all') {
  const hooks = [], effects = [], timers = new Map(), calls = [];
  let index = 0, tree, serial = 0, current = initial, nextGet, nextPut, view = initialView;
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
  function render() { index = 0; tree = moduleObject.exports.default({ request, signInPath: '/sign-in', view }); for (const effect of effects.splice(0)) effect(); }
  function nodes(node, found = []) { if (arguments.length === 0) node = tree; if (node == null || typeof node !== 'object') return found; if (Array.isArray(node)) { node.forEach(child => nodes(child, found)); return found; } found.push(node); nodes(node.props?.children, found); return found; }
  function text(node) { if (node == null || typeof node === 'boolean') return ''; if (typeof node !== 'object') return String(node); if (Array.isArray(node)) return node.map(text).join(''); return text(node.props?.children); }
  function field(label, type = 'input') { const node = nodes().find(n => n.type === 'label' && text(n).startsWith(label)); assert.ok(node, label); const fieldNode = nodes(node).find(n => n.type === type); assert.ok(fieldNode); return fieldNode; }
  render();
  return { calls, document, render, field, nodes, text: () => text(tree), form: () => nodes().find(n => n.type === 'form'),
    async ready() { await flush(); render(); },
    setView(value) { view = value; render(); },
    setSnapshot(value) { current = value; }, deferGet(fn) { nextGet = fn; }, setPut(fn) { nextPut = fn; },
    async poll() { for (const timer of timers.values()) if (timer.ms === 30000) timer.fn(); await flush(); render(); },
    close() { for (const hook of hooks) hook?.cleanup?.(); },
  };
}

test('overlapping observation saves its switch without changing source capture frequency or sending a message', async () => {
  const h = harness();
  try {
    await h.ready();
    assert.equal(h.field('观察并同步来源文案').props.checked, true);
    assert.match(h.text(), /每条独立检查 20 分钟 · 每 1 分钟核对一次/);
    assert.match(h.text(), /A 仍在检查时出现 B，B 会立即加入/);
    assert.doesNotMatch(h.text(), /当前条确认一致后才检查下一条|60 分钟循环|本轮已通过/);
    h.field('观察并同步来源文案').props.onChange({ target: { checked: false } }); h.render();
    await h.form().props.onSubmit({ preventDefault() {} }); h.render();
    const saved = h.calls.find(call => call.method === 'PUT');
    assert.equal(saved.body.relay.captionWatchEnabled, false);
    assert.equal(saved.body.relay.captionWatchIntervalSeconds, 30);
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
    h.field('观察并同步来源文案').props.onChange({ target: { checked: false } }); h.render();
    const status = snapshot(); status.relay.captionWatch = { ...status.relay.captionWatch, pending: 0, consistent: 1, lastCheckedAt: at,
      cycle:{enabled:true,mode:'overlapping',windowMinutes:20,checkIntervalSeconds:60,active:2,completed:1,verifiedChecks:7,expiredUnverified:1,superseded:0,
        nextExpiryAt:at+600000,cycleNumber:2,position:2,total:4,currentStartedAt:at,cycleStartedAt:at-30000,nextCycleAt:at+60000,nextAttemptAt:at,currentState:'waiting',lastReason:'waiting'} };
    h.setSnapshot(status); await h.poll();
    assert.equal(h.field('品牌通知文案', 'textarea').props.value, copy);
    assert.equal(h.field('观察并同步来源文案').props.checked, false);
    assert.match(h.text(), /上次核对一致1/);
    assert.match(h.text(), /独立观察中2/);
    assert.match(h.text(), /已结束观察1/);
    assert.match(h.text(), /核对通过次数7/);
    assert.match(h.text(), /到期仍未核实1/);
    assert.match(h.text(), /观察时间结束仅表示本条计时结束，不代表所有检查都通过/);
    assert.match(h.text(), /下个观察到期（MYT）2026\/11\/16 20:40:00/);
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

test('Telegram submenu views isolate settings and standalone source, keyword and gate tools', async () => {
  const h = harness(snapshot(), 'notifications');
  const panelIds = {
    notifications: ['telegram-promotion-title'], relay: ['telegram-relay-title'], chatbot: ['telegram-welcome-title'],
    private: ['telegram-chat-connection-title', 'telegram-private-title'],
    updates: ['telegram-chat-connection-title', 'telegram-private-updates-title'],
    followup: ['telegram-chat-connection-title', 'telegram-followup-title'],
  };
  const featurePanels = new Set(Object.values(panelIds).flat());
  try {
    await h.ready();
    for (const [view, expected] of Object.entries(panelIds)) {
      h.setView(view);
      assert.deepEqual(h.nodes().filter(n => n.type === 'section' && featurePanels.has(n.props['aria-labelledby'])).map(n => n.props['aria-labelledby']), expected, view);
      assert.ok(!h.nodes().some(n => n.type === './TelegramPersonalAccount' || n.type === './TelegramJoinGate'));
    }
    h.setView('sources');
    assert.ok(h.nodes().some(n => n.type === './TelegramPersonalAccount'));
    assert.equal(h.form(), undefined);
    h.setView('joinGate');
    assert.ok(h.nodes().some(n => n.type === './TelegramJoinGate'));
    assert.equal(h.form(), undefined);
    h.setView('keywords');
    assert.ok(h.nodes().some(n => typeof n.type === 'function' && n.type.name === 'TelegramKeywordRules'));
    assert.equal(h.form(), undefined);
    assert.ok(h.calls.every(call => call.method === 'GET'), 'opening sections cannot change configuration or send messages');
  } finally { h.close(); }
});

test('saving notifications preserves an unsaved invalid relay draft through submenu switches', async () => {
  const h = harness(snapshot(), 'notifications');
  try {
    await h.ready();
    h.field('品牌通知文案', 'textarea').props.onChange({ target: { value: 'Saved brand copy' } }); h.render();
    h.setView('relay'); h.field('转发目标群组或频道').props.onChange({ target: { value: '' } }); h.render();
    h.setView('sources'); h.setView('notifications');
    assert.equal(h.field('品牌通知文案', 'textarea').props.value, 'Saved brand copy');
    const saved = snapshot(); saved.promotionMessage = 'Saved brand copy'; h.setPut(() => saved);
    await h.form().props.onSubmit({ preventDefault() {} }); h.render();
    const put = h.calls.find(call => call.method === 'PUT');
    assert.deepEqual(Object.keys(put.body).sort(), ['chatId', 'enabled', 'promotionMessage']);
    assert.equal(put.body.promotionMessage, 'Saved brand copy');
    h.setView('relay'); assert.equal(h.field('转发目标群组或频道').props.value, '');
    h.setView('notifications'); assert.equal(h.field('品牌通知文案', 'textarea').props.value, 'Saved brand copy');
  } finally { h.close(); }
});

test('saving relay uses saved notification fields and keeps its unsaved notification draft', async () => {
  const h = harness(snapshot(), 'notifications');
  try {
    await h.ready();
    h.field('启用品牌通知').props.onChange({ target: { checked: true } }); h.render();
    h.setView('relay');
    h.field('观察并同步来源文案').props.onChange({ target: { checked: false } }); h.render();
    h.setPut(() => snapshot({ captionWatchEnabled: false }));
    await h.form().props.onSubmit({ preventDefault() {} }); h.render();
    const put = h.calls.find(call => call.method === 'PUT');
    assert.deepEqual(Object.keys(put.body).sort(), ['chatId', 'enabled', 'relay']);
    assert.equal(put.body.enabled, false, 'API-required notification flag uses current saved value');
    assert.equal(put.body.relay.captionWatchEnabled, false);
    h.setView('notifications'); assert.equal(h.field('启用品牌通知').props.checked, true);
    assert.equal(h.field('通知群组或频道').props.value, '', 'hidden unsaved invalid target remains a draft');
    assert.ok(!h.calls.some(call => call.path.includes('send') || call.path.includes('publish')));
  } finally { h.close(); }
});

test('private view saves only private preferences and its shared chatbot credential', async () => {
  const h = harness(snapshot(), 'private');
  try {
    await h.ready();
    h.field('@FreeBonus365ChatBot Token').props.onChange({ target: { value: 'fixture-chat-token' } }); h.render();
    h.field('启用 1 对 1 私聊').props.onChange({ target: { checked: true } }); h.render();
    h.field('私聊 Start 问候语', 'textarea').props.onChange({ target: { value: 'Private welcome' } }); h.render();
    const saved = snapshot(); saved.chatBot = { ...saved.chatBot, hasToken: true, privateEnabled: true, privateStartMessage: 'Private welcome' }; h.setPut(() => saved);
    await h.form().props.onSubmit({ preventDefault() {} }); h.render();
    const put = h.calls.find(call => call.method === 'PUT');
    assert.deepEqual(Object.keys(put.body).sort(), ['chatBot', 'chatId', 'enabled']);
    assert.deepEqual(Object.keys(put.body.chatBot).sort(), ['keywordEnabled', 'privateEnabled', 'privateStartMessage', 'token']);
    assert.equal(put.body.chatBot.privateEnabled, true);
    assert.equal(put.body.chatBot.privateStartMessage, 'Private welcome');
    assert.equal(h.field('@FreeBonus365ChatBot Token').props.value, '');
  } finally { h.close(); }
});

test('relay refresh and a rejected save keep unsaved target and monitoring preferences for correction', async () => {
  const h = harness(snapshot(), 'relay');
  try {
    await h.ready();
    h.field('转发目标群组或频道').props.onChange({ target: { value: '@edited_target' } }); h.render();
    h.field('观察并同步来源文案').props.onChange({ target: { checked: false } }); h.render();
    const update = snapshot({ chatId: '@server_target' });
    update.relay.captionWatch = { ...update.relay.captionWatch, lastCheckedAt: at, consistent: 1, pending: 0 };
    h.setSnapshot(update); await h.poll();
    assert.equal(h.field('转发目标群组或频道').props.value, '@edited_target');
    assert.equal(h.field('观察并同步来源文案').props.checked, false);
    assert.ok(h.calls.every(call => call.method === 'GET'), 'editing and polling must not save or post content');
    h.setPut(() => { throw Error('目标权限暂时无法确认'); });
    await h.form().props.onSubmit({ preventDefault() {} }); h.render();
    const put = h.calls.find(call => call.method === 'PUT');
    assert.equal(put.body.relay.chatId, '@edited_target');
    assert.equal(put.body.relay.captionWatchEnabled, false);
    assert.equal(put.body.relay.captionWatchIntervalSeconds, 30);
    assert.ok(h.nodes().some(node => node.props?.notice?.message === '目标权限暂时无法确认' && node.props.notice.error), 'rejected save remains available to the existing error notice');
    assert.equal(h.field('转发目标群组或频道').props.value, '@edited_target');
    assert.equal(h.field('观察并同步来源文案').props.checked, false);
    assert.ok(!h.calls.some(call => call.path.includes('send') || call.path.includes('publish')));
  } finally { h.close(); }
});
