import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const project = path.resolve(new URL('..', import.meta.url).pathname);
const brand = (extra = {}) => ({ id: 'alpha', name: 'Alpha Brand', slug: 'alpha-brand', category: 'All',
  promotionDays: null, promotionStartsAt: null, promotionExpiresAt: null, tagline: 'Specific listing summary.',
  description: 'Alpha Brand provides the details shown in this fixture. Read the provider information, eligibility and current conditions before participating.',
  color: '#d3b477', icon: 'sparkles', imageUrl: '/images/alpha.webp', featured: false, published: true,
  sortOrder: 1, link: 'https://provider.example/terms', ...extra });
const settings = (extra = {}) => ({ name: '365 Free Bonus', eyebrow: '', headline: '', description: '', announcement: '', contactUrl: '',
  avatarImageUrl: '/brand/gift-avatar.webp', coverImageUrl: '', telegramEnabled: false, telegramUrl: '', whatsappEnabled: false,
  whatsappUrl: '', facebookEnabled: false, facebookUrl: '', ...extra });

function harness({ brands = [brand()], siteSettings = settings(), loadError, adminPath = '/secret-admin' } = {}) {
  const modules = new Map();
  let reads = 0, authCalls = 0;
  const cached = fn => {
    const values = new Map();
    return (...args) => { const key = JSON.stringify(args); if (!values.has(key)) values.set(key, fn(...args)); return values.get(key); };
  };
  function load(relative) {
    const filename = path.resolve(project, relative);
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} }; modules.set(filename, module);
    const code = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText;
    vm.runInNewContext(code, { module, exports: module.exports, require(name) {
      if (name === 'react') return { ...React, cache: cached };
      if (name === 'react/jsx-runtime') return require(name);
      if (name === 'next/navigation') return {
        notFound() { throw new Error('NOT_FOUND'); }, redirect(to) { throw new Error(`REDIRECT:${to}`); },
      };
      if (name.endsWith('/chatgpt-auth') || name === '../chatgpt-auth') return {
        chatGPTSignInPath: value => `/login?next=${value}`,
        async requireChatGPTUser(value) { authCalls++; assert.equal(value, adminPath); return { displayName: 'Fixture admin' }; },
      };
      if (name.endsWith('/auth-core')) return { getAdminPath: () => adminPath };
      if (name.endsWith('/server-directory')) return { async readDirectory(includeDrafts, now, providedAdminPath) {
        reads++; assert.equal(includeDrafts, false); assert.equal(typeof now, 'number'); assert.equal(providedAdminPath, adminPath);
        if (loadError) throw loadError;
        const { publicBrandDetailPath } = load('app/lib/public-brand-pages.ts');
        return { brands: brands.map(item => ({ ...item, detailPath: publicBrandDetailPath(item, adminPath, now, brands) })), settings: siteSettings };
      } };
      if (name === './AdminWorkspace') return { default: ({ displayName }) => React.createElement('main', { 'data-admin': true }, displayName) };
      if (name.endsWith('.css')) return {};
      if (name.startsWith('.')) return load(path.relative(project, path.resolve(path.dirname(filename), name + (path.extname(name) ? '' : '.ts')))
        .replace(/PublicBrandDetail\.ts$/, 'PublicBrandDetail.tsx'));
      throw new Error(`Unexpected import: ${name}`);
    }, Date, URL, Intl, Map, Set, console });
    return module.exports;
  }
  const route = load('app/[adminPath]/page.tsx');
  const args = slug => ({ params: Promise.resolve({ adminPath: slug }) });
  return { metadata: slug => route.generateMetadata(args(slug)),
    async html(slug) { return renderToStaticMarkup(await route.default(args(slug))); },
    counts: () => ({ reads, authCalls }) };
}

test('an informative public brand has distinct metadata, canonical and actual server-rendered listing content', async () => {
  const h = harness();
  const metadata = await h.metadata('alpha-brand');
  assert.equal(metadata.title, 'Alpha Brand — Brand Information | 365 Free Bonus');
  assert.equal(metadata.alternates.canonical, 'https://365freebonus.com/alpha-brand');
  assert.equal(metadata.robots.index, true);
  assert.equal(metadata.openGraph.siteName, '365 Free Bonus');
  assert.equal(metadata.openGraph.images[0].url, 'https://365freebonus.com/images/alpha.webp');
  const html = await h.html('alpha-brand');
  assert.match(html, /<h1[^>]*>Alpha Brand<\/h1>/);
  assert.ok(html.includes(brand().description));
  assert.match(html, /href="https:\/\/provider\.example\/terms"/);
  assert.match(html, /Visit brand website/);
  assert.match(html, /href="\/#collection"/);
  assert.match(html, /"@type":"BreadcrumbList"/);
  assert.doesNotMatch(html, /secret-admin|Fixture admin|guaranteed payout|Verified offer/);
  assert.deepEqual(h.counts(), { reads: 1, authCalls: 0 }, 'metadata and body share one request snapshot');
});

test('missing and reserved brand paths produce notFound without rendering a successful placeholder', async () => {
  const h = harness();
  await assert.rejects(h.metadata('unknown-brand'), /NOT_FOUND/);
  await assert.rejects(h.html('unknown-brand'), /NOT_FOUND/);
  await assert.rejects(h.html('admin'), /NOT_FOUND/);
  await assert.rejects(h.html('invalid%2Fslug'), /NOT_FOUND/);
  assert.equal(h.counts().authCalls, 0);
});

test('thin and duplicated public listings retain the legacy anchor redirect and cannot be indexed', async () => {
  for (const brands of [[brand({ description: 'Short.' })], [brand(), brand({ id: 'other', slug: 'other-brand', name: 'Other Brand', description: brand().description.replaceAll('Alpha Brand', 'Other Brand') })]]) {
    const h = harness({ brands });
    const metadata = await h.metadata('alpha-brand');
    assert.equal(metadata.robots.index, false);
    await assert.rejects(h.html('alpha-brand'), /REDIRECT:\/#brand-card-alpha/);
  }
});

test('admin route keeps authentication and noindex and never loads public brand data', async () => {
  const h = harness();
  const metadata = await h.metadata('secret-admin');
  assert.equal(metadata.robots.index, false); assert.equal(metadata.robots.follow, false);
  assert.equal(metadata.alternates, undefined);
  assert.match(await h.html('secret-admin'), /Fixture admin/);
  assert.deepEqual(h.counts(), { reads: 0, authCalls: 1 });
});

test('data failures propagate instead of becoming a normal indexable success page', async () => {
  const h = harness({ loadError: new Error('Fixture database failure') });
  await assert.rejects(h.metadata('alpha-brand'), /Fixture database failure/);
  await assert.rejects(h.html('alpha-brand'), /Fixture database failure/);
});

test('outbound controls exist only for configured safe destinations, with Telegram named accurately', async () => {
  for (const link of ['', 'javascript:alert(1)', 'https://user:secret@provider.example']) {
    const html = await harness({ brands: [brand({ link })] }).html('alpha-brand');
    assert.doesNotMatch(html, /class="brand-detail-provider"/);
    assert.doesNotMatch(html, /Join Telegram/);
  }
  const html = await harness({ brands: [brand({ link: 'https://t.me/brand_fixture' })], siteSettings: settings({ telegramEnabled: true, telegramUrl: 'https://t.me/site_fixture' }) }).html('alpha-brand');
  assert.match(html, /Open brand Telegram/);
  assert.match(html, /Join Telegram/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('listing text and breadcrumb JSON-LD remain escaped without inventing a verification date', async () => {
  const name = 'Brand </script><img src=x onerror=alert(1)>';
  const description = 'Literal <script>alert("fixture")</script> text supplied in the listing is displayed as text rather than interpreted as markup.\nSecond original line.';
  const html = await harness({ brands: [brand({ name, description })] }).html('alpha-brand');
  assert.match(html, /Literal &lt;script&gt;/);
  assert.match(html, /Second original line/);
  assert.match(html, /\\u003c\/script>/);
  assert.equal((html.match(/<script /g) || []).length, 1);
  assert.doesNotMatch(html, /Last verified|Verified on|2026\/|onerror="alert/);
});
