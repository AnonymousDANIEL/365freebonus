import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../app/DirectoryClient.tsx', import.meta.url), 'utf8');
const compile = value => ts.transpileModule(value, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const code = compile(source);
const directoryModule = { exports: {} };
vm.runInNewContext(compile(readFileSync(new URL('../app/lib/directory.ts', import.meta.url), 'utf8')), {
  module: directoryModule, exports: directoryModule.exports, Date, URL, Error,
});
const now = Date.parse('2026-11-18T09:00:00Z');
const baseBrand = { id: 'Alpha Id/1', name: 'Alpha', slug: 'alpha', category: 'New', promotionDays: 7,
  promotionStartsAt: now - 1000, promotionExpiresAt: now + 60000, tagline: 'Explore Alpha offers',
  description: 'Read the provider information, eligibility and current offer terms before joining Alpha.',
  color: '#b58a45', icon: 'sparkles', imageUrl: '', featured: true, published: true, sortOrder: 0,
  link: 'https://example.com/alpha', detailPath: '/alpha' };
const initialData = { settings: directoryModule.exports.defaultSettings, brands: [
  baseBrand,
  { ...baseBrand, id: 'beta', name: 'Beta', slug: 'beta', detailPath: undefined, featured: false, category: 'All', description: '' },
  { ...baseBrand, id: 'unsafe', name: 'Unsafe path', slug: 'unsafe', detailPath: '//outside.example', featured: false, category: 'All' },
] };

function load(react, jsxRuntime, icons, document = {}) {
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, Date, Intl, Error, document,
    window: { matchMedia: () => ({ matches: true }) },
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return jsxRuntime;
      if (name === 'lucide-react') return icons;
      if (name === './lib/directory') return directoryModule.exports;
      if (name.endsWith('.css')) return {};
      if (name.startsWith('./components/')) return { default: () => null };
      throw Error(`Unexpected import ${name}`);
    },
  });
  return module.exports.default;
}

function harness() {
  const hooks = []; let index = 0, tree;
  const react = {
    useState(initial) { const slot = index++; if (!(slot in hooks)) hooks[slot] = typeof initial === 'function' ? initial() : initial;
      return [hooks[slot], update => { hooks[slot] = typeof update === 'function' ? update(hooks[slot]) : update; }]; },
    useRef(value) { const slot = index++; if (!(slot in hooks)) hooks[slot] = { current: value }; return hooks[slot]; },
    useMemo(fn) { return fn(); }, useEffect() {},
  };
  const jsx = (type, props = {}) => typeof type === 'function' ? type(props) : { type, props };
  const Component = load(react, { jsx, jsxs: jsx, Fragment: 'fragment' }, new Proxy({}, { get: (_, key) => key }), {
    getElementById: () => ({ scrollIntoView() {} }),
  });
  function render() { index = 0; tree = Component({ initialData, initialTime: now }); }
  function nodes(node, found = []) { if (arguments.length === 0) node = tree; if (node == null || typeof node !== 'object') return found;
    if (Array.isArray(node)) { node.forEach(child => nodes(child, found)); return found; }
    found.push(node); nodes(node.props?.children, found); return found; }
  function text(node) { if (arguments.length === 0) node = tree; if (node == null || typeof node === 'boolean') return ''; if (typeof node !== 'object') return String(node);
    if (Array.isArray(node)) return node.map(text).join(''); return text(node.props?.children); }
  render();
  return { render, nodes, text, action(name) { const value = nodes().find(n => n.type === 'button' && (n.props['aria-label'] === name || text(n) === name)); assert.ok(value, name); return value; } };
}

test('initial server HTML contains approved brand links and clear offer context without JavaScript', () => {
  const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
  const Component = load(React, require('react/jsx-runtime'), require('lucide-react'));
  const html = renderToStaticMarkup(React.createElement(Component, { initialData, initialTime: now }));
  assert.match(html, /href="\/alpha"/);
  assert.doesNotMatch(html, /href="\/beta"|href="\/\/outside\.example"/);
  assert.match(html, /id="brand-card-Alpha%20Id%2F1"/);
  assert.match(html, /Free bonus offers in Malaysia/);
  assert.match(html, /Confirm current availability, eligibility and terms with each provider before joining/);
  assert.match(html, /What does free credit mean in an offer\?/);
  assert.match(html, /Free credit may refer to promotional game credit rather than cash/);
  assert.match(html, /id="faq-3" hidden=""/);
});

test('ordinary brand link clicks open the original modal and expose a real full-details link', () => {
  const h = harness();
  const link = h.nodes().find(n => n.type === 'a' && n.props.className === 'card-action' && n.props.href === '/alpha');
  let prevented = false;
  link.props.onClick({ button: 0, defaultPrevented: false, preventDefault() { prevented = true; } }); h.render();
  assert.equal(prevented, true);
  assert.ok(h.nodes().some(n => n.props?.role === 'dialog'));
  assert.ok(h.nodes().some(n => n.type === 'a' && n.props.className === 'brand-detail-page-link' && n.props.href === '/alpha'));
  assert.ok(h.nodes().some(n => n.type === 'a' && n.props.href === baseBrand.link && n.props.target === '_blank'));
});

test('modified or already-handled clicks retain normal link navigation instead of opening a modal', () => {
  for (const flags of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }]) {
    const h = harness(); const link = h.nodes().find(n => n.type === 'a' && n.props.className === 'card-action');
    let prevented = false;
    link.props.onClick({ button: 0, defaultPrevented: false, ...flags, preventDefault() { prevented = true; } }); h.render();
    assert.equal(prevented, false, JSON.stringify(flags));
    assert.ok(!h.nodes().some(n => n.props?.role === 'dialog'), JSON.stringify(flags));
    assert.equal(link.props.href, '/alpha');
  }
});

test('brands without an approved detail page keep modal access without fake internal links', () => {
  const h = harness();
  h.action('Explore brand Beta').props.onClick(); h.render();
  assert.ok(h.nodes().some(n => n.props?.role === 'dialog'));
  assert.ok(!h.nodes().some(n => n.props?.className === 'brand-detail-page-link'));
  assert.ok(!h.nodes().some(n => n.type === 'a' && n.props.href === '/beta'));
});

test('category filters, saved brands and localized offer information continue to work', () => {
  const h = harness();
  h.action('Save Beta').props.onClick(); h.render();
  h.action('Saved (1)').props.onClick(); h.render();
  assert.equal(h.nodes().filter(n => n.type === 'article' && n.props.className === 'directory-card').length, 1);
  assert.ok(h.nodes().some(n => n.props?.id === 'brand-card-beta'));
  h.action('Saved (1)').props.onClick(); h.render();
  h.action('New').props.onClick(); h.render();
  assert.equal(h.nodes().filter(n => n.type === 'article' && n.props.className === 'directory-card').length, 1);
  h.action('BM').props.onClick(); h.render();
  assert.match(h.text(), /Tawaran bonus percuma di Malaysia/);
  assert.equal(h.nodes().find(n => n.props?.id === 'faq-3').props.hidden, true);
  h.action('Apakah maksud free credit dalam sesuatu tawaran?+').props.onClick(); h.render();
  assert.equal(h.nodes().find(n => n.props?.id === 'faq-3').props.hidden, false);
  assert.match(h.text(), /bukan wang tunai/);
  h.action('中文').props.onClick(); h.render();
  assert.match(h.text(), /探索马来西亚免费优惠/);
  assert.match(h.text(), /推广游戏额度，不等于现金/);
});
