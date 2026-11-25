import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as gameTipsCaptions from '../app/lib/telegram-game-tips-captions.ts';
import * as gameTipsTypes from '../app/lib/telegram-game-tips-types.ts';

const source = readFileSync(new URL('../app/[adminPath]/TelegramScheduledMessages.tsx', import.meta.url), 'utf8');
const librarySource = readFileSync(new URL('../app/[adminPath]/TelegramGameTipsLibrary.tsx', import.meta.url), 'utf8');
const compile = (value) => ts.transpileModule(value, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const code = compile(source), libraryCode = compile(librarySource);
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const serverTime = Date.parse('2026-11-15T04:00:00Z');
function snapshot(overrides = {}) {
  return { now: serverTime, timezone: 'Asia/Kuala_Lumpur', hasToken: true,
    targets: ['official', 'group', 'hot'].map(key => ({
      key, title: key, address: `@${key}channel`, chatId: '-1001', revision: `revision-${key}`, builtIn: true, editable: true, ready: true, lastError: '',
    })),
    plans: [], deliveries: [], counts: {},
    messageSummary: { nextRunAt: serverTime + 3600000, counts: {}, lastError: '' },
    gameTipsSummary: { nextRunAt: null, counts: {}, lastError: '' },
    scheduler: { workerHealthy: true, heartbeatAt: serverTime, lastTickAt: serverTime, lastCompletedAt: serverTime, nextRunAt: serverTime + 3600000, lastError: '' }, ...overrides };
}
const plan = (overrides = {}) => ({ id: 'plan-one', revision: 'revision-one', name: 'Daily', text: 'Saved copy', times: ['13:00'], enabled: true, nextRunAt: serverTime + 3600000, lastRunAt: null, createdAt: serverTime, updatedAt: serverTime, ...overrides });

// Run the actual component with isolated React hooks and JSX nodes. Requests,
// document visibility and clocks are controlled; no browser login or Telegram
// network access is involved. Tests exercise user events and async races.
function harness(initial = snapshot(), { library, props = {}, confirm = () => true } = {}) {
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
  vm.runInNewContext(library ? libraryCode : code, { module: moduleObject, exports: moduleObject.exports, require(name) { if (name === 'react') return react; if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }; if (name === 'lucide-react') return new Proxy({}, { get: (_, key) => String(key) }); if (name === './TelegramGameTipsLibrary') return { default: 'GameTipsLibrary' }; if (name === '../lib/telegram-game-tips-types') return gameTipsTypes; if (name === '../lib/telegram-game-tips-captions') return gameTipsCaptions; if (name.endsWith('.css')) return {}; throw Error(`Unexpected import ${name}`); },
    Date: FakeDate, Error, Intl, URLSearchParams, crypto: { randomUUID: () => '1a111111-1111-4111-8111-111111111111' }, document, window: { confirm },
    setInterval(fn, ms) { const id = ++serial; intervals.set(id, { fn, ms }); return id; }, clearInterval(id) { intervals.delete(id); },
  });
  function render() { index = 0; tree = moduleObject.exports.default({ request, signInPath: '/sign-in', ...props }); for (const effect of effects.splice(0)) effect(); return tree; }
  function nodes(node, found = []) { if (arguments.length === 0) node = tree; if (!node || typeof node !== 'object') return found; if (Array.isArray(node)) { node.forEach(item => nodes(item, found)); return found; } found.push(node); nodes(node.props?.children, found); return found; }
  function text(node) { if (node == null || typeof node === 'boolean') return ''; if (typeof node !== 'object') return String(node); if (Array.isArray(node)) return node.map(text).join(''); return text(node.props?.children); }
  function button(label) { const node = nodes().find(n => n.type === 'button' && (text(n) === label || n.props['aria-label'] === label)); assert.ok(node, `button ${label}`); return node; }
  function tab(id) { return nodes().find(node => node.props.id === `scheduled-tab-${id}`); }
  function field(label, type = 'input') { const node = nodes().find(n => n.type === 'label' && text(n).startsWith(label)); assert.ok(node, `label ${label}`); const input = nodes(node).find(n => n.type === type); assert.ok(input); return input; }
  function check(label, checked = true) { field(label).props.onChange({ currentTarget: { checked } }); }
  function form() { return nodes().find(n => n.type === 'form'); }
  render();
  return { calls, document, render, nodes, text: () => text(tree), button, field, form, tab, check,
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
    for (const key of ['official', 'group', 'hot']) assert.equal(h.field(key).props.checked, false);
    await h.form().props.onSubmit({ preventDefault() {} }); h.render();
    assert.match(h.text(), /请至少选择一个发送频道/);
    assert.ok(h.calls.every(call => call.method === 'GET'));
    h.check('official'); h.check('hot'); h.render();
    await h.form().props.onSubmit({ preventDefault() {} }); h.render();
    const call = h.calls.find(c => c.method === 'POST');
    assert.equal(call.body.text, copy); assert.equal(call.body.name, 'Daily copy');
    assert.deepEqual(Array.from(call.body.times), ['09:00', '21:00']);
    assert.equal(call.body.calendarDate, '2026-11-15');
    assert.deepEqual(Array.from(call.body.targetKeys), ['official', 'hot']);
    assert.equal(call.body.enabled, false); assert.equal(h.form(), undefined);
    assert.match(h.text(), /暂停状态/);
  } finally { h.close(); }
});

test('Game Tips creates a disabled Malaysia daily plan with a caption preset and selected channels', async () => {
  const h = harness(snapshot({ gameTipsProviders: [{ name: 'MEGA888', count: 4 }] }), { props: { workspace: 'gameTips' } });
  try {
    await h.ready();
    assert.equal(h.tab('library').props['aria-selected'], true);
    h.tab('plans').props.onClick(); h.render();
    h.button('添加 Game Tips').props.onClick(); h.render();
    assert.equal(h.field('游戏平台', 'select').props.value, 'MEGA888');
    assert.equal(h.field('每天重复').props.checked, true);
    assert.equal(h.field('保存后启用').props.checked, false);
    assert.ok(h.nodes().some(node => node.type === 'a' && node.props.href === '/api/admin/telegram/game-tips?preview=MEGA888'));
    assert.ok(!h.nodes().some(node => node.type === 'textarea'));
    assert.equal(h.field('发送文案', 'select').props.value, gameTipsCaptions.DEFAULT_GAME_TIPS_CAPTION_PRESET_ID);
    h.field('发送文案', 'select').props.onChange({ target: { value: 'bonus-roundup' } }); h.render();
    const bodies = gameTipsCaptions.GAME_TIPS_CAPTION_BODIES;
    assert.equal(bodies.length, 10);
    const preview = () => h.nodes().find(node => node.type === 'p' && node.props['aria-live'] === 'polite').props.children;
    for (const [index, body] of bodies.entries()) {
      assert.match(h.text(), new RegExp(`示例 ${index + 1} / 10`));
      assert.equal(preview(), gameTipsCaptions.gameTipsCaption('MEGA888', 'bonus-roundup', body));
      h.button('下一条示例').props.onClick(); h.render();
    }
    assert.match(h.text(), /示例 1 \/ 10/);
    h.button('下一条示例').props.onClick(); h.render();
    await h.tick(10000);
    assert.equal(preview(), gameTipsCaptions.gameTipsCaption('MEGA888', 'bonus-roundup', bodies[1]));
    assert.equal(h.field('official').props.checked, false);
    h.check('official'); h.render();
    h.field('时间 1').props.onChange({ target: { value: '20:00' } }); h.render();
    h.button('添加时间').props.onClick(); h.render();
    h.field('时间 2').props.onChange({ target: { value: '09:30' } }); h.render();
    assert.match(h.text(), /每天发送 2 次/);
    await h.form().props.onSubmit({ preventDefault() {} }); h.render();
    const call = h.calls.find(entry => entry.method === 'POST');
    assert.equal(call.body.gameTipsProvider, 'MEGA888');
    assert.equal(call.body.gameTipsCaptionPresetId, 'bonus-roundup');
    assert.ok(!Object.keys(call.body).some(key => /example|body|copy|variant/i.test(key)));
    assert.equal(call.body.enabled, false);
    assert.equal(call.body.calendarDate, '');
    assert.equal(call.body.text, '');
    assert.equal(call.body.mediaId, null);
    assert.deepEqual(Array.from(call.body.times), ['09:30', '20:00']);
    assert.deepEqual(Array.from(call.body.targetKeys), ['official']);
  } finally { h.close(); }
});

test('a platform opens its own Game Tips draft even when another platform is also ready', async () => {
  const h = harness(snapshot({ gameTipsProviders: [{ name: 'MEGA888', count: 4 }, { name: '918KISS', count: 3 }] }), { props: { workspace: 'gameTips' } });
  try {
    await h.ready();
    h.nodes().find(node => node.type === 'GameTipsLibrary').props.onSchedule('918KISS');
    h.render();
    assert.equal(h.field('游戏平台', 'select').props.value, '918KISS');
    assert.equal(h.field('后台名称').props.value, 'Game Tips · 918KISS');
  } finally { h.close(); }
});

test('ordinary and Game Tips workspaces separate schedules, history, next times and counts while sharing channels', async () => {
  const normalPlan = plan({ name: 'Daily notice' });
  const gamePlan = plan({ id: 'game-plan', name: 'Pussy poster', text: '', times: ['14:00'], gameTipsProvider: 'PUSSY88' });
  const shared = snapshot({ plans: [normalPlan, gamePlan], deliveries: [
    { id: 'delivery-message', planName: 'Sent notice', targetTitle: 'Shared channel', status: 'sent' },
    { id: 'delivery-game', planName: 'Deleted Game plan delivery', gameTipsProvider: 'PUSSY88', targetTitle: 'Shared channel', status: 'sent' },
  ], messageSummary: { nextRunAt: serverTime + 3_600_000, counts: { sent: 9 }, lastError: '' },
  gameTipsSummary: { nextRunAt: serverTime + 7_200_000, counts: { sent: 2 }, lastError: 'Game Tips pool needs work' } });
  const messages = harness(shared), games = harness(shared, { props: { workspace: 'gameTips' } });
  try {
    await messages.ready(); await games.ready();
    assert.equal(messages.tab('library'), undefined);
    assert.match(messages.text(), /Daily notice/);
    assert.match(messages.text(), /01:00:00/);
    assert.match(messages.text(), /已发送9/);
    assert.match(messages.text(), /Sent notice/);
    assert.doesNotMatch(messages.text(), /Pussy poster|Deleted Game plan delivery|pool needs work|添加 Game Tips/);

    assert.match(games.text(), /Pussy poster/);
    assert.match(games.text(), /02:00:00/);
    assert.match(games.text(), /已发送2/);
    assert.match(games.text(), /Deleted Game plan delivery/);
    assert.match(games.text(), /pool needs work/);
    assert.doesNotMatch(games.text(), /Daily notice|Sent notice|添加文案/);
    for (const view of [messages, games]) {
      view.tab('channels').props.onClick(); view.render();
      assert.equal(view.tab('channels').props['aria-selected'], true);
      assert.ok(view.button('添加频道'));
    }
  } finally { messages.close(); games.close(); }
});

test('platform cards show only their own games and schedule and keep pending files on a cancelled switch', async () => {
  const scheduled = [plan({ name: 'Morning', gameTipsProvider: 'MEGA888' }), plan({ name: 'Evening', gameTipsProvider: 'PUSSY88' })];
  const calls = [];
  const asset = { id: 'image-one', provider: ' mega888 ', game: 'Dolphin Reef', enabled: true, updatedAt: 9 };
  const h = harness({ assets: [asset],
    providers: [{ name: 'MEGA888', count: 1, logoId: 'logo-one' }, { name: 'PUSSY88', count: 0, logoId: 'logo-two' }],
  }, { library: true, confirm: () => false, props: { active: true, plans: scheduled, today: '2026-11-15',
    onProvidersChanged() {}, onSchedule: provider => calls.push(provider), onEditSchedule: item => calls.push(item.name) } });
  try {
    await h.ready();
    assert.ok(h.nodes().some(node => node.type === 'img' && node.props.src === '/api/admin/telegram/game-tips/logo?id=logo-one'));
    assert.match(h.text(), /Dolphin Reef/); assert.match(h.text(), /Morning/); assert.doesNotMatch(h.text(), /Evening/);
    h.button('编辑排期 Morning').props.onClick();
    h.button('添加此平台排期').props.onClick();
    const newImage = { name: 'Ice Land.png', type: 'image/png', size: 512 };
    const fileField = h.nodes().find(node => node.props['aria-label'] === '选择 Game Tips 图片');
    fileField.props.onChange({ target: { files: [newImage] } }); h.render();
    h.button('PUSSY880 款游戏可用').props.onClick(); h.render();
    assert.equal(h.field('游戏名称').props.value, 'Ice Land');
    assert.match(h.text(), /Dolphin Reef/); assert.doesNotMatch(h.text(), /Evening/);
    h.button('移除待上传图片 Ice Land.png').props.onClick(); h.render();
    h.button('PUSSY880 款游戏可用').props.onClick(); h.render();
    assert.match(h.text(), /Evening/); assert.doesNotMatch(h.text(), /Dolphin Reef|Morning/);
    h.button('添加此平台排期').props.onClick();
    assert.deepEqual(calls, ['Morning', 'MEGA888', 'PUSSY88']);
  } finally { h.close(); }
});

test('creating a platform posts one logo and replacing it submits the displayed logo revision', async () => {
  const h = harness({ assets: [], providers: [] }, { library: true, props: { active: true, plans: [], today: '2026-11-15',
    onProvidersChanged() {}, onSchedule() {}, onEditSchedule() {},
  } });
  const file = { name: '918kiss.png', type: 'image/png', size: 512 };
  const current = { assets: [], providers: [{ name: '918KISS', count: 0, logoId: 'logo-old' }] };
  try {
    await h.ready();
    h.button('新增平台').props.onClick(); h.render();
    h.field('平台名称').props.onChange({ target: { value: '918KISS' } }); h.render();
    const selectLogo = () => h.nodes().find(node => node.props['aria-label'] === '选择平台 Logo');
    assert.equal(selectLogo().props.multiple, undefined);
    selectLogo().props.onChange({ target: { files: [file] } }); h.render();
    h.mutation(() => current);
    await h.form().props.onSubmit({ preventDefault() {} }); h.render();
    const create = h.calls.find(call => call.method === 'POST');
    assert.equal(create.body, file);
    assert.match(create.path, /^\/api\/admin\/telegram\/game-tips\/logo\?id=.+&provider=918KISS$/);
    assert.match(h.text(), /918KISS 还没有游戏图片/);
    h.button('更换平台 Logo').props.onClick(); h.render();
    assert.equal(h.field('平台名称').props.readOnly, true);
    selectLogo().props.onChange({ target: { files: [file] } }); h.render();
    h.mutation(() => ({ ...current, providers: [{ ...current.providers[0], logoId: 'logo-new' }] }));
    await h.form().props.onSubmit({ preventDefault() {} }); h.render();
    const replace = h.calls.filter(call => call.method === 'POST').at(-1);
    const query = new URL(replace.path, 'https://example.com').searchParams;
    assert.equal(query.get('previousId'), 'logo-old');
    assert.equal(query.get('previousProvider'), '918KISS');
    assert.ok(h.nodes().some(node => node.type === 'img' && node.props.src === '/api/admin/telegram/game-tips/logo?id=logo-new'));
  } finally { h.close(); }
});

test('a platform name can be saved without uploading a logo and a later rename can include a new logo', async () => {
  const first = { name: 'MEGA888', count: 0 };
  const other = { name: 'PUSSY88', count: 0 };
  const h = harness({ assets: [], providers: [first, other] }, {
    library: true, props: { active: true, plans: [], today: '2026-11-15',
      onProvidersChanged() {}, onSchedule() {}, onEditSchedule() {},
    },
  });
  try {
    await h.ready();
    h.button('编辑平台名称').props.onClick(); h.render();
    assert.equal(h.field('平台名称').props.readOnly, false);
    assert.equal(h.button('保存平台资料').props.disabled, true);
    h.field('平台名称').props.onChange({ target: { value: 'Zed Game' } }); h.render();
    h.mutation(() => ({ assets: [], providers: [other, { ...first, name: 'Zed Game' }] }));
    await h.form().props.onSubmit({ preventDefault() {} }); h.render();
    const put = h.calls.find(call => call.method === 'PUT');
    assert.equal(put.path, '/api/admin/telegram/game-tips/logo');
    assert.deepEqual({ ...put.body }, { provider: 'MEGA888', name: 'Zed Game', previousId: '' });
    assert.equal(h.button('Zed Game0 款游戏可用').props['aria-pressed'], true);
    assert.equal(h.button('PUSSY880 款游戏可用').props['aria-pressed'], false);
    assert.ok(h.button('上传平台 Logo'));

    h.button('编辑平台名称').props.onClick(); h.render();
    h.field('平台名称').props.onChange({ target: { value: 'Mega New' } }); h.render();
    const file = { name: 'new.png', type: 'image/png', size: 512 };
    h.nodes().find(node => node.props['aria-label'] === '选择平台 Logo').props.onChange({ target: { files: [file] } }); h.render();
    h.mutation(() => ({ assets: [], providers: [other, { ...first, name: 'Mega New', logoId: 'new-logo' }] }));
    await h.form().props.onSubmit({ preventDefault() {} }); h.render();
    const post = h.calls.find(call => call.method === 'POST');
    const query = new URL(post.path, 'https://example.com').searchParams;
    assert.equal(post.body, file);
    assert.equal(query.get('provider'), 'Mega New');
    assert.equal(query.get('previousProvider'), 'Zed Game');
    assert.equal(h.button('Mega New0 款游戏可用').props['aria-pressed'], true);
  } finally { h.close(); }
});

test('Game Tips can remove only a logo or delete the selected platform with explicit confirmation', async () => {
  const first = { name: 'MEGA888', count: 0, logoId: 'logo-one' };
  const other = { name: 'PUSSY88', count: 0 };
  const confirmations = [];
  const h = harness({ assets: [], providers: [first, other] }, {
    library: true, confirm: text => { confirmations.push(text); return confirmations.length > 1; },
    props: { active: true, plans: [], today: '2026-11-15', onProvidersChanged() {}, onSchedule() {}, onEditSchedule() {} },
  });
  try {
    await h.ready();
    h.button('删除平台').props.onClick(); await h.ready();
    assert.match(confirmations[0], /尚未执行的计划/);
    assert.ok(!h.calls.some(call => call.method === 'DELETE'));
    h.mutation(() => ({ assets: [], providers: [{ name: 'MEGA888', count: 0 }, other] }));
    h.button('移除 Logo').props.onClick(); await h.ready();
    assert.equal(h.button('MEGA8880 款游戏可用').props['aria-pressed'], true);
    assert.ok(h.button('上传平台 Logo'));

    h.mutation(() => ({ assets: [], providers: [other] }));
    h.button('删除平台').props.onClick(); await h.ready();
    const deletes = h.calls.filter(call => call.method === 'DELETE');
    assert.deepEqual(deletes.map(({ path, body }) => ({ path, body: { ...body } })), [
      { path: '/api/admin/telegram/game-tips/logo', body: { provider: 'MEGA888', previousId: 'logo-one', action: 'removeLogo' } },
      { path: '/api/admin/telegram/game-tips/logo', body: { provider: 'MEGA888', previousId: '', action: 'deletePlatform' } },
    ]);
    assert.equal(h.button('PUSSY880 款游戏可用').props['aria-pressed'], true);
    assert.equal(h.nodes().find(node => node.type === 'button' && node.props['aria-pressed'] === true).props.disabled, false);
  } finally { h.close(); }
});

test('active and disabled Game Tips images expose Delete and only send a revision-checked request after confirmation', async () => {
  const active = { id: 'active-image', provider: 'MEGA888', game: 'Dolphin Reef', enabled: true, updatedAt: 17 };
  const disabled = { id: 'disabled-image', provider: 'MEGA888', game: 'Iceland', enabled: false, updatedAt: 11 };
  const confirmation = [];
  const providerUpdates = [];
  const h = harness({ assets: [active, disabled], providers: [{ name: 'MEGA888', count: 1, logoId: 'logo-one' }] }, {
    library: true,
    confirm: message => { confirmation.push(message); return confirmation.length > 1; },
    props: { active: true, plans: [], today: '2026-11-15',
      onProvidersChanged: providers => providerUpdates.push(providers), onSchedule() {}, onEditSchedule() {},
    },
  });
  try {
    await h.ready();
    const removeActive = h.button('删除图片 Dolphin Reef');
    assert.ok(removeActive.props.children.includes('删除'));
    assert.ok(h.button('删除图片 Iceland').props.children.includes('删除'));
    removeActive.props.onClick(); await h.ready();
    assert.deepEqual(confirmation, ['删除「Dolphin Reef」的游戏图片？']);
    assert.ok(!h.calls.some(call => call.method === 'DELETE'));
    h.mutation(() => ({ assets: [disabled], providers: [{ name: 'MEGA888', count: 0, logoId: 'logo-one' }] }));
    h.button('删除图片 Dolphin Reef').props.onClick(); await h.ready();
    const deletes = h.calls.filter(call => call.method === 'DELETE');
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0].path, '/api/admin/telegram/game-tips');
    assert.deepEqual({ ...deletes[0].body }, { id: 'active-image', updatedAt: 17 });
    assert.equal(providerUpdates[0][0].count, 0);
    assert.match(h.text(), /游戏图片已删除/);
    assert.doesNotMatch(h.text(), /Dolphin Reef/);
    assert.ok(h.button('删除图片 Iceland'));
  } finally { h.close(); }
});

test('Game Tips gallery bounds rendered cards, searches across the platform and refreshes after deletion', async () => {
  const mainAssets = Array.from({ length: 60 }, (_, index) => ({
    id: `mega-${index}`, provider: 'MEGA888', game: `Game ${String(index + 1).padStart(3, '0')}`, enabled: true, updatedAt: 1,
  }));
  const otherAsset = { id: 'other-image', provider: 'PUSSY88', game: 'Game 060', enabled: true, updatedAt: 2 };
  const initial = { assets: [...mainAssets, otherAsset], providers: [{ name: 'MEGA888', count: 60 }, { name: 'PUSSY88', count: 1 }] };
  const h = harness(initial, { library: true, props: {
    active: true, plans: [], today: '2026-11-15', onProvidersChanged() {}, onSchedule() {}, onEditSchedule() {},
  } });
  const cards = () => h.nodes().filter(node => node.type === 'article' && node.props.className.includes('cms-game-tips-image'));
  try {
    await h.ready();
    assert.equal(cards().length, 48);
    assert.match(h.text(), /显示 48 \/ 60 张/);
    h.button('加载更多').props.onClick(); h.render();
    assert.equal(cards().length, 60);
    assert.match(h.text(), /显示 60 \/ 60 张/);

    h.field('搜索游戏名称').props.onChange({ target: { value: '  ＧＡＭＥ　０６０ ' } }); h.render();
    assert.deepEqual(cards().map(card => h.nodes(card).find(node => node.type === 'img').props.alt), ['MEGA888 · Game 060']);
    assert.match(h.text(), /显示 1 \/ 1 张 · 该平台共 60 张/);
    h.mutation(() => ({ assets: [...mainAssets.slice(0, -1), otherAsset], providers: [{ name: 'MEGA888', count: 59 }, initial.providers[1]] }));
    h.button('删除图片 Game 060').props.onClick(); await h.ready();
    assert.equal(cards().length, 0);
    assert.match(h.text(), /显示 0 \/ 0 张 · 该平台共 59 张/);
    assert.match(h.text(), /没有找到符合名称的游戏图片/);

    h.button('PUSSY881 款游戏可用').props.onClick(); h.render();
    assert.equal(h.field('搜索游戏名称').props.value, '');
    assert.equal(cards().length, 1);
    h.button('MEGA88859 款游戏可用').props.onClick(); h.render();
    assert.equal(cards().length, 48);
    assert.match(h.text(), /显示 48 \/ 59 张/);
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
    h.check('official'); h.render();
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

test('built-in channels use the shared edit/delete flow without adding a check to a Game Tips draft', async () => {
  const initial = snapshot({ gameTipsProviders: [{ name: 'MEGA888', count: 4 }] });
  const h = harness(initial, { props: { workspace: 'gameTips' } });
  try {
    await h.ready(); h.tab('plans').props.onClick(); h.render();
    h.button('添加 Game Tips').props.onClick(); h.render();
    h.check('group'); h.check('hot'); h.render();
    assert.equal(h.field('group').props.checked, true);
    assert.equal(h.field('hot').props.checked, true);
    h.tab('channels').props.onClick(); h.render();
    h.button('编辑频道 official').props.onClick(); h.render();
    assert.equal(h.field('Telegram 频道地址').props.value, '@officialchannel');
    h.field('频道名称').props.onChange({ target: { value: 'Renamed official' } }); h.render();
    const renamed = { ...initial.targets[0], title: 'Renamed official', revision: 'updated-official-revision' };
    const channelForm = () => h.nodes(h.nodes().find(node => node.props.id === 'scheduled-panel-channels')).find(node => node.type === 'form');
    h.mutation(() => ({ ...initial, targets: [renamed, ...initial.targets.slice(1)] }));
    await channelForm().props.onSubmit({ preventDefault() {} }); h.render();
    const edit = h.calls.find(call => call.body?.action === 'upsertTarget');
    assert.equal(edit.body.key, 'official');
    assert.equal(edit.body.revision, 'revision-official');
    h.tab('plans').props.onClick(); h.render();
    assert.equal(h.field('Renamed official').props.checked, false);
    assert.equal(h.field('group').props.checked, true);
    assert.equal(h.field('hot').props.checked, true);

    h.tab('channels').props.onClick(); h.render();
    h.mutation(() => ({ ...initial, targets: [renamed, initial.targets[1]] }));
    h.button('删除频道 hot').props.onClick(); await h.ready();
    const remove = h.calls.find(call => call.method === 'DELETE');
    assert.deepEqual({ ...remove.body }, { targetKey: 'hot', revision: 'revision-hot' });
    h.tab('plans').props.onClick(); h.render();
    assert.match(h.text(), /此计划选择了 1 个已删除的频道/);
    assert.equal(h.button('保存 Game Tips 排期').props.disabled, true);
    h.button('从计划移除已删除频道').props.onClick(); h.render();
    assert.equal(h.field('Renamed official').props.checked, false);
    assert.equal(h.field('group').props.checked, true);
    assert.equal(h.button('保存 Game Tips 排期').props.disabled, false);
    h.field('时间 1').props.onChange({ target: { value: '13:00' } }); h.render();
    await h.form().props.onSubmit({ preventDefault() {} }); h.render();
    const create = h.calls.find(call => call.method === 'POST' && call.body?.gameTipsProvider);
    assert.deepEqual(Array.from(create.body.targetKeys), ['group']);
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
    h.check('official'); h.render();
    await h.form().props.onSubmit({ preventDefault() {} });
    const post = h.calls.find(call => call.method === 'POST' && !call.path.includes('/upload?'));
    assert.equal(post.body.calendarDate, '2026-11-16');
    assert.equal(post.body.mediaId, uploaded[0].id);
    assert.equal(post.body.text, 'Video caption');
  } finally { h.close(); }
});
test('Game Tips saves a background with three slot positions and edits the current template without replacing its image', async () => {
  const provider = { name: 'MEGA888', count: 3 };
  const current = { assets: [], providers: [{ ...provider, backgroundId: 'background-one', backgroundSlots: gameTipsTypes.GAME_TIPS_DEFAULT_SLOTS }] };
  const h = harness({ assets: [], providers: [provider] }, {
    library: true, props: { active: true, plans: [], today: '2026-11-15', onProvidersChanged() {} },
  });
  try {
    await h.ready();
    h.button('上传模板').props.onClick(); h.render();
    assert.equal(h.button('保存背景模板').props.disabled, true);
    const file = { name: 'background.png', type: 'image/png', size: 9000 };
    h.nodes().find(node => node.props['aria-label'] === '选择背景模板图片').props.onChange({ target: { files: [file] } });
    h.render();
    const submit = () => h.nodes().find(node => node.type === 'form' && node.props.className.includes('cms-game-tips-background-editor')).props.onSubmit({ preventDefault() {} });
    h.mutation(() => current);
    await submit(); h.render();
    const upload = h.calls.find(call => call.method === 'POST');
    assert.equal(upload.body, file);
    const query = new URL(upload.path, 'https://example.com').searchParams;
    assert.equal(query.get('provider'), 'MEGA888');
    assert.deepEqual(JSON.parse(query.get('slots')), gameTipsTypes.GAME_TIPS_DEFAULT_SLOTS);
    assert.ok(h.nodes().some(node => node.type === 'img' && node.props.src.endsWith('id=background-one')));
    assert.ok(h.nodes().some(node => node.type === 'a' && node.props.href.endsWith('preview=MEGA888')));

    h.button('更换模板或调整位置').props.onClick(); h.render();
    const changeX = value => h.nodes().find(node => node.props['aria-label'] === '位置 1 距左边（%）').props.onChange({ target: { value } });
    changeX('100'); h.render();
    assert.equal(h.button('保存背景模板').props.disabled, true);
    changeX('5'); h.render();
    h.mutation(() => current);
    await submit(); h.render();
    const edit = h.calls.find(call => call.method === 'PUT');
    assert.equal(edit.path, '/api/admin/telegram/game-tips/background');
    assert.equal(edit.body.previousId, 'background-one');
    assert.equal(edit.body.slots[0].x, 5);
  } finally { h.close(); }
});
