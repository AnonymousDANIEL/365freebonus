import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../app/[adminPath]/TelegramPersonalAccount.tsx', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const channel = (id, title, username, selected = false) => ({ id, title, username, selected, joined: true });
const initial = {
  connected: true, stage: 'connected', hasApiCredentials: true, lastError: '',
  lastPolledAt: null, syncedAt: 1000, refreshPending: false,
  channels: [
    channel('1', 'Saved Wallet', 'savedwallet', true),
    channel('2', 'Ｓｕｐｅｒ Wallet', 'SuperWallet319'),
    channel('3', '品牌频道', 'brand_channel'),
  ],
};

function harness() {
  const hooks = [], effects = [], timers = new Map(), listeners = new Map(), calls = [];
  let index = 0, timerId = 0, tree, saved = initial, refreshResponse;
  const jsx = (type, props) => ({ type, props: props || {} });
  const react = {
    useState(initialValue) {
      const slot = index++;
      if (!hooks[slot]) hooks[slot] = { value: typeof initialValue === 'function' ? initialValue() : initialValue };
      return [hooks[slot].value, next => { hooks[slot].value = typeof next === 'function' ? next(hooks[slot].value) : next; }];
    },
    useRef(value) {
      const slot = index++;
      if (!hooks[slot]) hooks[slot] = { current: value };
      return hooks[slot];
    },
    useEffect(callback, dependencies) {
      const slot = index++;
      const previous = hooks[slot];
      if (previous && !dependencies.some((value, i) => value !== previous.dependencies[i])) return;
      previous?.cleanup?.();
      effects.push(() => { hooks[slot] = { dependencies, cleanup: callback() }; });
    },
  };
  const module = { exports: {} };
  const request = async (path, method = 'GET', body) => {
    calls.push({ path, method, body });
    if (method === 'GET') return saved;
    assert.equal(body.action, 'refresh');
    return refreshResponse;
  };
  vm.runInNewContext(code, {
    module, exports: module.exports, require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === 'lucide-react') return new Proxy({}, { get: (_, key) => String(key) });
      if (name.endsWith('.css')) return {};
      throw Error(`Unexpected import ${name}`);
    },
    document: {
      visibilityState: 'visible',
      addEventListener(name, listener) { listeners.set(name, listener); },
      removeEventListener(name) { listeners.delete(name); },
      getElementById() { return null; },
    },
    setInterval(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearInterval(id) { timers.delete(id); },
  });
  function render() {
    index = 0;
    tree = module.exports.default({ request, signInPath: '/sign-in' });
    for (const effect of effects.splice(0)) effect();
  }
  async function flush() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    render();
  }
  function nodes(node) {
    if (arguments.length === 0) node = tree;
    if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node)) return node.flatMap(child => nodes(child));
    return [node, ...(node.props?.children == null ? [] : nodes(node.props.children))];
  }
  function text(node) {
    if (arguments.length === 0) node = tree;
    if (node == null || typeof node === 'boolean') return '';
    if (typeof node !== 'object') return String(node);
    if (Array.isArray(node)) return node.map(child => text(child)).join('');
    return node.props?.children == null ? '' : text(node.props.children);
  }
  const find = predicate => nodes().find(predicate);
  const button = name => find(n => n.type === 'button' && (n.props['aria-label'] === name || text(n) === name));
  const lookup = id => find(n => n.props.id === id);
  const search = () => lookup('telegram-source-search');
  const results = () => nodes(find(n => n.props['aria-label'] === '未勾选的来源频道'))
    .filter(n => n.type === 'input').map(n => n.props.id);
  render();
  return {
    button, lookup, search, results, text, find, calls, render, flush,
    changeQuery(value) { search().props.onChange({ target: { value } }); render(); },
    acceptRefresh(response) { refreshResponse = response; },
    poll(status) {
      saved = status;
      for (const timer of [...timers.values()]) if (timer.delay === 2000) timer.callback();
      return flush();
    },
    close() { for (const hook of hooks) hook?.cleanup?.(); },
  };
}

test('the dedicated search field filters unselected sources by normalized words, usernames and public links', async () => {
  const h = harness();
  try {
    await h.flush();
    assert.equal(h.find(n => n.type === 'label' && n.props.htmlFor === h.search().props.id) != null, true);
    assert.deepEqual(h.results(), ['telegram-source-2', 'telegram-source-3']);
    for (const query of [' Wallet   SUPER ', '@SUPERWALLET319', 'https://t.me/s/SuperWallet319/17']) {
      h.changeQuery(query);
      assert.deepEqual(h.results(), ['telegram-source-2']);
      assert.match(h.text(), /找到 1 个 · 未勾选共 2 个/);
      assert.equal(h.lookup('telegram-source-1').props.checked, true);
    }
    h.changeQuery('找不到');
    assert.deepEqual(h.results(), []);
    assert.match(h.text(), /没有找到匹配的频道/);
    let focused = false;
    h.search().props.ref.current = { focus() { focused = true; } };
    h.button('清除频道搜索').props.onClick();
    h.render();
    assert.equal(h.search().props.value, '');
    assert.equal(focused, true);
    assert.deepEqual(h.results(), ['telegram-source-2', 'telegram-source-3']);
    assert.ok(h.calls.every(call => call.method === 'GET'));
  } finally { h.close(); }
});

test('a queued refresh preserves in-progress selections and search until a real sync completes', async () => {
  const h = harness();
  try {
    await h.flush();
    h.acceptRefresh({ ...initial, refreshPending: true });
    h.button('刷新频道列表').props.onClick();
    await h.flush();
    assert.equal(h.button('正在刷新频道列表…').props.disabled, true);
    assert.equal(h.find(n => n.type === 'fieldset').props.disabled, false);
    assert.doesNotMatch(h.text(), /频道列表已更新/);

    h.changeQuery('wallet');
    h.lookup('telegram-source-2').props.onChange({ target: { checked: true } });
    h.render();
    assert.equal(h.lookup('telegram-source-2').props.checked, true);
    assert.equal(h.button('保存来源频道').props.disabled, true);
    assert.match(h.text(), /列表同步后可保存/);
    await h.poll({ ...initial, refreshPending: false, syncedAt: 2000,
      channels: [...initial.channels, channel('4', 'New Wallet', 'new_wallet')] });
    assert.equal(h.search().props.value, 'wallet');
    assert.equal(h.lookup('telegram-source-2').props.checked, true);
    assert.deepEqual(h.results(), ['telegram-source-4']);
    assert.equal(h.button('保存来源频道').props.disabled, false);
    assert.match(h.text(), /频道列表已更新/);
    assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
  } finally { h.close(); }
});

test('a refresh failure retains searchable results and does not announce an update', async () => {
  const h = harness();
  try {
    await h.flush();
    h.changeQuery('super');
    h.acceptRefresh({ ...initial, refreshPending: true });
    h.button('刷新频道列表').props.onClick();
    await h.flush();
    await h.poll({ ...initial, lastError: '同步频道失败，请稍后重试。' });
    assert.equal(h.button('刷新频道列表').props.disabled, false);
    assert.deepEqual(h.results(), ['telegram-source-2']);
    assert.match(h.text(), /同步频道失败/);
    assert.doesNotMatch(h.text(), /频道列表已更新/);
  } finally { h.close(); }
});
