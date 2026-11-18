import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../app/[adminPath]/TelegramScheduledMessages.tsx', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const serverTime = Date.parse('2026-11-15T04:00:00Z');
function snapshot(overrides = {}) {
  return { now: serverTime, timezone: 'Asia/Kuala_Lumpur', hasToken: true,
    targets: ['official', 'group', 'hot'].map(key => ({ key, title: key, chatId: '-1001', ready: true, lastError: '' })),
    plans: [], deliveries: [], counts: {}, scheduler: { workerHealthy: true, heartbeatAt: serverTime, lastTickAt: serverTime, lastCompletedAt: serverTime, nextRunAt: serverTime + 3600000, lastError: '' }, ...overrides };
}
const plan = (overrides = {}) => ({ id: 'plan-one', revision: 'revision-one', name: 'Daily', text: 'Saved copy', times: ['13:00'], enabled: true, nextRunAt: serverTime + 3600000, lastRunAt: null, createdAt: serverTime, updatedAt: serverTime, ...overrides });

// Run the actual component with isolated React hooks and JSX nodes. Requests,
// document visibility and clocks are controlled; no browser login or Telegram
// network access is involved. Tests exercise user events and async races.
function harness(initial = snapshot()) {
  const hooks = [], effects = [], intervals = new Map(), listeners = new Map(), calls = [];
  let index = 0, tree, time = serverTime + 7200000, serial = 0, getValue = initial, nextGet, nextMutation, upload;
  const jsx = (type, props) => ({ type, props: props || {} });
  const react = {
    useState(value) { const slot = index++; if (!hooks[slot]) hooks[slot] = { value: typeof value === 'function' ? value() : value }; return [hooks[slot].value, update => { hooks[slot].value = typeof update === 'function' ? update(hooks[slot].value) : update; }]; },
    useRef(value) { const slot = index++; if (!hooks[slot]) hooks[slot] = { current: value }; return hooks[slot]; },
    useEffect(callback, deps) { const slot = index++; const previous = hooks[slot]; if (!previous || deps.some((value, i) => value !== previous.deps[i])) { previous?.cleanup?.(); effects.push(() => { hooks[slot] = { deps, cleanup: callback() }; }); } },
  };
  const moduleObject = { exports: {} };
  const document = { visibilityState: 'visible', addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const request = async (path, method = 'GET', body) => {
    calls.push({ path, method, body });
    if (path.includes('/upload?')) return upload(path, body);
    if (method === 'GET') { if (nextGet) { const fn = nextGet; nextGet = null; return fn(); } return getValue; }
    if (nextMutation) { const fn = nextMutation; nextMutation = null; return fn(); }
    return getValue;
  };
  class FakeDate extends Date { constructor(...args) { super(...(args.length ? args : [time])); } static now() { return time; } }
  vm.runInNewContext(code, { module: moduleObject, exports: moduleObject.exports, require(name) { if (name === 'react') return react; if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }; if (name === 'lucide-react') return new Proxy({}, { get: (_, key) => String(key) }); if (name.endsWith('.css')) return {}; throw Error(`Unexpected import ${name}`); },
    Date: FakeDate, Error, Intl, crypto: { randomUUID: () => '1a111111-1111-4111-8111-111111111111' }, document, window: { confirm: () => true },
    setInterval(fn, ms) { const id = ++serial; intervals.set(id, { fn, ms }); return id; }, clearInterval(id) { intervals.delete(id); },
  });
  function render() { index = 0; tree = moduleObject.exports.default({ request, signInPath: '/sign-in' }); for (const effect of effects.splice(0)) effect(); return tree; }
  function nodes(node, found = []) { if (arguments.length === 0) node = tree; if (!node || typeof node !== 'object') return found; if (Array.isArray(node)) { node.forEach(item => nodes(item, found)); return found; } found.push(node); nodes(node.props?.children, found); return found; }
  function text(node) { if (node == null || typeof node === 'boolean') return ''; if (typeof node !== 'object') return String(node); if (Array.isArray(node)) return node.map(text).join(''); return text(node.props?.children); }
  function button(label) { const node = nodes().find(n => n.type === 'button' && (text(n) === label || n.props['aria-label'] === label)); assert.ok(node, `button ${label}`); return node; }
  function field(label, type = 'input') { const node = nodes().find(n => n.type === 'label' && text(n).startsWith(label)); assert.ok(node, `label ${label}`); const input = nodes(node).find(n => n.type === type); assert.ok(input); return input; }
  function form() { return nodes().find(n => n.type === 'form'); }
  render();
  return { calls, document, render, nodes, text: () => text(tree), button, field, form,
    async ready() { await flush(); render(); },
    setGet(value) { getValue = value; }, deferGet(fn) { nextGet = fn; }, mutation(fn) { nextMutation = fn; }, upload(fn) { upload = fn; },
    async tick(ms) { time += ms; for (const timer of intervals.values()) if (timer.ms === ms) timer.fn(); await flush(); render(); },
    close() { for (const hook of hooks) hook?.cleanup?.(); },
  };
}

test('background refresh preserves unsaved exact copy and daily times', async () => {
  const h = harness();
  try {
    await h.ready(); h.button('添加文案').props.onClick(); h.render();
    h.field('后台名称').props.onChange({ target: { value: 'Draft' } }); h.render();
    const copy = '  First line\n\n🎁 Last line  ';
    h.field('发送文案', 'textarea').props.onChange({ target: { value: copy } }); h.render();
    h.field('时间 1').props.onChange({ target: { value: '18:30' } }); h.render();
    h.setGet(snapshot({ plans: [plan()] })); await h.tick(10000);
    assert.equal(h.field('发送文案', 'textarea').props.value, copy);
    assert.equal(h.field('时间 1').props.value, '18:30');
    assert.equal(h.field('后台名称').props.value, 'Draft');
    assert.match(h.text(), /Saved copy/);
    assert.ok(h.calls.every(call => call.method === 'GET'));
  } finally { h.close(); }
});

test('saving sends unchanged text and an explicit Malaysia date rather than a browser timer', async () => {
  const h = harness();
  try {
    await h.ready(); h.button('添加文案').props.onClick(); h.render();
    h.field('后台名称').props.onChange({ target: { value: '  Daily copy  ' } }); h.render();
    const copy = ' Leading\n\n中文 🎁 trailing ';
    h.field('发送文案', 'textarea').props.onChange({ target: { value: copy } }); h.render();
    h.field('时间 1').props.onChange({ target: { value: '21:00' } }); h.render();
    h.button('添加时间').props.onClick(); h.render();
    h.field('时间 2').props.onChange({ target: { value: '09:00' } }); h.render();
    await h.form().props.onSubmit({ preventDefault() {} }); h.render();
    const call = h.calls.find(c => c.method === 'POST');
    assert.equal(call.body.text, copy); assert.equal(call.body.name, 'Daily copy');
    assert.deepEqual(Array.from(call.body.times), ['09:00', '21:00']);
    assert.equal(call.body.calendarDate, '2026-11-15');
    assert.deepEqual(Array.from(call.body.targetKeys), ['official', 'group', 'hot']);
    assert.equal(call.body.enabled, false); assert.equal(h.form(), undefined);
    assert.match(h.text(), /暂停状态/);
  } finally { h.close(); }
});

test('clock and countdown follow server time even when the browser clock differs', async () => {
  const h = harness();
  try {
    await h.ready(); assert.match(h.text(), /2026\/11\/15 12:00:00/); assert.match(h.text(), /01:00:00/);
    await h.tick(1000); assert.match(h.text(), /2026\/11\/15 12:00:01/); assert.match(h.text(), /00:59:59/);
  } finally { h.close(); }
});

test('a stale poll cannot overwrite the result of a completed mutation', async () => {
  const h = harness(snapshot({ plans: [plan()] })); let resolvePoll;
  try {
    await h.ready(); h.deferGet(() => new Promise(resolve => { resolvePoll = resolve; }));
    await h.tick(10000);
    h.mutation(() => snapshot({ plans: [plan({ enabled: false, revision: 'new-revision' })] }));
    await h.button('暂停').props.onClick(); await flush(); h.render();
    resolvePoll(snapshot({ plans: [plan()] })); await h.ready();
    assert.match(h.text(), /已暂停/); assert.ok(h.button('启用'));
  } finally { h.close(); }
});

test('a revision conflict keeps the owner draft and offers the new saved version', async () => {
  const h = harness(snapshot({ plans: [plan()] }));
  try {
    await h.ready(); h.button('编辑').props.onClick(); h.render();
    h.field('发送文案', 'textarea').props.onChange({ target: { value: 'Unsaved owner draft' } }); h.render();
    h.setGet(snapshot({ plans: [plan({ revision: 'changed', text: 'Other saved version' })] }));
    h.mutation(() => { const error = new Error('Conflict'); error.status = 409; throw error; });
    await h.form().props.onSubmit({ preventDefault() {} }); h.render();
    assert.equal(h.field('发送文案', 'textarea').props.value, 'Unsaved owner draft');
    assert.match(h.text(), /草稿已保留/); assert.ok(h.button('加载最新版本'));
    assert.equal(h.button('保存文案与时间').props.disabled, true);
  } finally { h.close(); }
});

test('an interrupted create keeps the same request id for a safe retry', async () => {
  const h = harness();
  try {
    await h.ready(); h.button('添加文案').props.onClick(); h.render();
    h.field('后台名称').props.onChange({ target: { value: 'Retry daily copy' } }); h.render();
    h.field('发送文案', 'textarea').props.onChange({ target: { value: 'Exactly once plan' } }); h.render();
    h.field('时间 1').props.onChange({ target: { value: '18:00' } }); h.render();
    h.mutation(() => { throw new Error('Response interrupted'); });
    await h.form().props.onSubmit({ preventDefault() {} }); h.render();
    assert.equal(h.field('发送文案', 'textarea').props.value, 'Exactly once plan');
    await h.form().props.onSubmit({ preventDefault() {} }); h.render();
    const creates = h.calls.filter(c => c.method === 'POST');
    assert.equal(creates.length, 2); assert.match(creates[0].body.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(creates[1].body.requestId, creates[0].body.requestId);
    assert.equal(h.form(), undefined);
  } finally { h.close(); }
});

test('the date view rolls over at Malaysia midnight and keeps an open draft intact', async () => {
  const now = Date.parse('2026-11-15T15:59:59Z');
  const h = harness(snapshot({ now, plans: [
    plan({ id: 'today', calendarDate: '2026-11-15', text: 'Before midnight' }),
    plan({ id: 'tomorrow', calendarDate: '2026-11-16', text: 'After midnight' }),
    plan({ id: 'later', calendarDate: '2026-11-22', text: 'Next week' }),
  ] }));
  try {
    await h.ready();
    assert.match(h.text(), /Before midnight.*After midnight.*Next week/);
    h.button('添加文案').props.onClick(); h.render();
    h.field('发送文案', 'textarea').props.onChange({ target: { value: 'Unfinished draft' } }); h.render();
    assert.equal(h.field('发送日期').props.value, '2026-11-15');
    await h.tick(1000);
    assert.doesNotMatch(h.text(), /Before midnight/);
    assert.match(h.text(), /2026-11-16今天.*After midnight.*Next week/);
    assert.equal(h.field('发送日期').props.value, '2026-11-15');
    assert.equal(h.field('发送文案', 'textarea').props.value, 'Unfinished draft');
    h.button('显示过往日期').props.onClick(); h.render();
    assert.match(h.text(), /Before midnight/);
  } finally { h.close(); }
});

test('channel management sends stable creation IDs and revision-checked edits', async () => {
  const h = harness();
  const target = { key: 'custom:channel', title: 'Daily offers', address: '@dailyoffers', chatId: '-1002', revision: 'channel-version', editable: true, ready: true, lastError: '' };
  try {
    await h.ready(); h.button('频道管理').props.onClick(); h.render();
    h.button('添加频道').props.onClick(); h.render();
    h.field('频道名称').props.onChange({ target: { value: target.title } }); h.render();
    h.field('Telegram 频道地址').props.onChange({ target: { value: ` ${target.address} ` } }); h.render();
    h.mutation(() => snapshot({ targets: [...snapshot().targets, target] }));
    await h.form().props.onSubmit({ preventDefault() {} }); h.render();
    const create = h.calls.find(call => call.body?.action === 'upsertTarget');
    assert.equal(create.body.address, target.address);
    assert.match(create.body.requestId, /^[0-9a-f-]{36}$/);
    h.button('编辑频道 Daily offers').props.onClick(); h.render();
    h.field('频道名称').props.onChange({ target: { value: 'Revised' } }); h.render();
    await h.form().props.onSubmit({ preventDefault() {} }); h.render();
    const edit = h.calls.filter(call => call.body?.action === 'upsertTarget').at(-1);
    assert.equal(edit.body.key, target.key);
    assert.equal(edit.body.revision, target.revision);
    assert.equal(edit.body.title, 'Revised');
  } finally { h.close(); }
});

test('a video is uploaded in replayable chunks and its ID is associated only when the post is saved', async () => {
  const h = harness();
  const chunkBytes = 4 * 1024 * 1024;
  const size = chunkBytes + 77;
  const filename = 'Offer & date.mp4';
  const file = { name: filename, type: 'video/mp4', size, slice: (start, end, type) => ({ start, end, type }) };
  const uploaded = [];
  try {
    await h.ready(); h.button('添加文案').props.onClick(); h.render();
    h.upload((path, chunk) => {
      const params = new URL(path, 'https://365freebonus.com/').searchParams;
      const id = params.get('uploadId');
      uploaded.push({ id, offset: params.get('offset'), chunk });
      assert.equal(params.get('size'), String(size));
      assert.equal(params.get('name'), filename);
      if (uploaded.length === 1) throw new Error('Network interrupted');
      return chunk.end === size ? { id, kind: 'video', name: filename, bytes: size } : { id, received: chunk.end };
    });
    h.field('上传附件').props.onChange({ target: { files: [file], value: filename } });
    await h.ready();
    assert.deepEqual(uploaded.map(row => row.offset), ['0', '0', String(chunkBytes)]);
    assert.equal(new Set(uploaded.map(row => row.id)).size, 1);
    assert.equal(h.field('发送文案', 'textarea').props.maxLength, 1024);
    assert.equal(h.calls.filter(call => call.method === 'POST' && !call.path.includes('/upload?')).length, 0);
    h.field('后台名称').props.onChange({ target: { value: 'Tomorrow video' } }); h.render();
    h.field('发送文案', 'textarea').props.onChange({ target: { value: 'Video caption' } }); h.render();
    h.field('发送日期').props.onChange({ target: { value: '2026-11-16' } }); h.render();
    h.field('时间 1').props.onChange({ target: { value: '21:00' } }); h.render();
    await h.form().props.onSubmit({ preventDefault() {} });
    const post = h.calls.find(call => call.method === 'POST' && !call.path.includes('/upload?'));
    assert.equal(post.body.calendarDate, '2026-11-16');
    assert.equal(post.body.mediaId, uploaded[0].id);
    assert.equal(post.body.text, 'Video caption');
  } finally { h.close(); }
});
