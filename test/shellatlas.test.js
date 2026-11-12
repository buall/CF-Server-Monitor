import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { requireShellAtlasAccess } from '../src/integrations/access.js';
import { embedContext, renderEmbed, rewriteEmbedStyles, resolveEmbedTheme, LUMINA_THEME, handleShellAtlas } from '../src/integrations/shellatlas.js';
import { publicMetrics } from '../src/integrations/fields.js';
import { MetricsBroadcaster } from '../src/durable/MetricsBroadcaster.js';
import { Miniflare } from 'miniflare';
import { initDatabase } from '../src/database/schema.js';
import { clearServersListCache } from '../src/utils/cache.js';
import { clearSiteSettingsCache, clearAppearanceSettingsCache } from '../src/utils/settings.js';
import { embedBootstrap } from '../src/integrations/embedBootstrap.js';

const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const env = { SHELLATLAS_ACCESS_TEAM_DOMAIN: 'https://test.cloudflareaccess.com', SHELLATLAS_ACCESS_AUD: 'application-a', SHELLATLAS_ACCESS_CLIENT_ID: 'shellatlas.access' };
const JUNIMO_THEME = 'https://github.com/huilang-me/cfsm-junimo/tree/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

// Exercise the serialized browser script with DOM/events and History as its
// boundaries. Theme controls are ordinary elements, not framework internals.
function embedBrowser(mode) {
  class Element {
    constructor(tag, text = '', attributes = {}) { this.tagName = tag.toUpperCase(); this.textContent = text; this.attributes = new Map(Object.entries(attributes)); this.children = []; this.isConnected = true; }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    removeAttribute(name) { this.attributes.delete(name); }
    hasAttribute(name) { return this.attributes.has(name); }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    getBoundingClientRect() { return { width: 600, height: 500 }; }
    matches(selector) {
      return selector.split(',').some(part => {
        if (part.startsWith('.')) return (this.getAttribute('class') || '').split(/\s+/).includes(part.slice(1));
        const match = part.match(/^(\w+)?(?:\[([\w-]+)(?:="([^"]+)")?\])?$/);
        return match && (!match[1] || this.tagName === match[1].toUpperCase()) && (!match[2] || this.hasAttribute(match[2]) && (match[3] === undefined || this.getAttribute(match[2]) === match[3]));
      });
    }
    closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
    contains(element) { for (let node = element; node; node = node.parentElement) if (node === this) return true; return false; }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }
  const events = new Map();
  const timers = [];
  const listen = (type, handler) => { if (!events.has(type)) events.set(type, []); events.get(type).push(handler); };
  const root = new Element('html'); root.dataset = {};
  const body = root.appendChild(new Element('body'));
  const card = body.appendChild(new Element('article'));
  const title = card.appendChild(new Element('button', '测试节点'));
  const icon = title.appendChild(new Element('svg', '', { 'aria-hidden': 'true' }));
  const detail = card.appendChild(new Element('button', '翻页 ↗'));
  const line = card.appendChild(new Element('button', '切换线路'));
  const anchor = card.appendChild(new Element('a', '详情', { href: '#/server/node-1' }));
  const os = card.appendChild(new Element('span', '', { class: 'server-card-detail-link', role: 'img', title: 'Ubuntu · 点击查看详情', 'aria-label': '测试节点，系统 Ubuntu' }));
  const osLogo = os.appendChild(new Element('img', '', { alt: 'Ubuntu', title: 'Ubuntu', src: '/os-icons/os-ubuntu.svg' }));
  const detailIcon = card.appendChild(new Element('span', '', { class: 'server-card-detail-link', title: '查看详情' }));
  detailIcon.appendChild(new Element('svg', '', { 'aria-hidden': 'true' }));
  const document = {
    documentElement: root, body, head: new Element('head'), readyState: 'loading',
    createElement: tag => new Element(tag), addEventListener: listen,
    querySelectorAll: selector => selector === '.server-card' ? [card] : root.querySelectorAll(selector),
  };
  let reloads = 0;
  const location = new URL('https://atlas.example/api/v1/servers/server-1/monitor/embed/?parentOrigin=https%3A%2F%2Fatlas.example#/');
  location.reload = () => { reloads++; };
  const historyCalls = [];
  const history = { state: null };
  for (const method of ['pushState', 'replaceState']) history[method] = (data, unused, url) => { historyCalls.push({ method, url }); history.state = data; if (url != null) location.href = new URL(url, location.href).href; };
  const originalPushState = history.pushState;
  const window = { fetch: async () => new Response('{}'), WebSocket: class {} };
  const messages = [];
  runInNewContext(`(${embedBootstrap.toString()})(context)`, {
    context: { base: '/api/v1/servers/server-1/monitor/embed/', parentOrigin: 'https://atlas.example', serverId: 'server-1', nodeId: 'node-1', nodeName: '测试节点', theme: 'generic', mode },
    window, document, location, history, URL, Request, parent: { postMessage: value => messages.push(value) },
    addEventListener: listen, setTimeout: (callback, delay) => timers.push({ callback, delay }),
    MutationObserver: class { constructor(callback) { this.callback = callback; } observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
  });
  for (const handler of events.get('DOMContentLoaded') || []) handler();
  const dispatch = (type, target, key) => {
    const event = { type, target, key, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
    for (const handler of events.get(type) || []) { handler(event); if (event.stopped) break; }
    return event;
  };
  return { root, body, card, title, icon, detail, line, anchor, os, osLogo, detailIcon, document, location, history, historyCalls, timers, dispatch, originalPushState, get reloads() { return reloads; } };
}

test('single-card embeds hide detail actions and block button, icon and keyboard navigation without blocking metric controls', () => {
  const browser = embedBrowser();
  assert.equal(browser.detail.getAttribute('data-embed-navigation'), 'action');
  assert.equal(browser.title.getAttribute('data-embed-navigation'), 'title');
  assert.equal(browser.title.getAttribute('aria-disabled'), 'true');
  assert.equal(browser.anchor.getAttribute('tabindex'), '-1');
  assert.equal(browser.line.hasAttribute('data-embed-navigation'), false);
  for (const control of [browser.detail, browser.title, browser.icon, browser.anchor]) {
    assert.equal(browser.dispatch('click', control).prevented, true);
    assert.equal(browser.dispatch('keydown', control, 'Enter').stopped, true);
  }
  assert.equal(browser.dispatch('auxclick', browser.anchor).prevented, true);
  assert.equal(browser.dispatch('keydown', browser.detail, ' ').prevented, true);
  assert.equal(browser.dispatch('keydown', browser.title, 'ArrowDown').prevented, false);
  assert.equal(browser.dispatch('click', browser.line).prevented, false);
  assert.equal(browser.dispatch('keydown', browser.line, 'Enter').prevented, false);
});

test('single-card embeds retain OS logos inside detail controls while blocking their navigation', () => {
  const browser = embedBrowser();
  assert.equal(browser.os.getAttribute('data-embed-navigation'), 'icon');
  assert.equal(browser.os.getAttribute('title'), 'Ubuntu');
  assert.equal(browser.os.getAttribute('aria-label'), '测试节点，系统 Ubuntu');
  assert.equal(browser.osLogo.getAttribute('alt'), 'Ubuntu');
  assert.ok(browser.osLogo.getAttribute('src').endsWith('/monitor/embed/os-icons/os-ubuntu.svg'));
  assert.equal(browser.detailIcon.getAttribute('data-embed-navigation'), 'action');
  for (const control of [browser.os, browser.osLogo, browser.detailIcon]) {
    for (const type of ['click', 'auxclick']) assert.equal(browser.dispatch(type, control).prevented, true);
    assert.equal(browser.dispatch('keydown', control, 'Enter').stopped, true);
  }
  assert.equal(browser.location.hash, '#/');
  assert.equal(browser.dispatch('click', browser.line).prevented, false);
});

test('single-card embeds recover safely from SPA history, hash and back-button detail routes', () => {
  for (const method of ['pushState', 'replaceState']) {
    const browser = embedBrowser();
    browser.history[method]({ page: 1 }, '', '#/?filter=online');
    assert.equal(browser.historyCalls.at(-1).method, method);
    browser.history[method]({ page: 2 }, '', '#/server/node-1?apiIndex=0');
    assert.equal(browser.location.hash, '#/');
    assert.equal(browser.root.hasAttribute('data-embed-ready'), false);
    assert.ok(browser.body.children.some(child => child.id === 'embed-status' && child.textContent === '正在返回实时监控…' && !child.hidden));
    for (const timer of browser.timers.filter(timer => timer.delay === 0)) timer.callback();
    assert.equal(browser.reloads, 1);
  }
  for (const type of ['hashchange', 'popstate']) {
    const browser = embedBrowser();
    browser.location.hash = '/server/node-1';
    browser.dispatch(type);
    assert.equal(browser.location.hash, '#/');
    assert.equal(browser.timers.filter(timer => timer.delay === 0).length, 1);
  }
});

test('full-dashboard embeds keep theme detail buttons and SPA navigation available', () => {
  const browser = embedBrowser('dashboard');
  assert.equal(browser.history.pushState, browser.originalPushState);
  assert.equal(browser.detail.hasAttribute('data-embed-navigation'), false);
  assert.equal(browser.os.hasAttribute('data-embed-navigation'), false);
  assert.equal(browser.os.getAttribute('title'), 'Ubuntu · 点击查看详情');
  assert.equal(browser.dispatch('click', browser.osLogo).prevented, false);
  assert.equal(browser.dispatch('click', browser.detail).prevented, false);
  browser.history.pushState(null, '', '#/server/node-1');
  assert.equal(browser.location.hash, '#/server/node-1');
  assert.equal(browser.timers.length, 0);
});

test('embed follows the configured theme by default and retains explicit overrides', () => {
  assert.deepEqual(resolveEmbedTheme({ theme_url: JUNIMO_THEME }), { theme: 'junimo', themeUrl: JUNIMO_THEME });
  assert.deepEqual(resolveEmbedTheme({ theme_url: LUMINA_THEME }), { theme: 'luminaplus', themeUrl: LUMINA_THEME });
  assert.deepEqual(resolveEmbedTheme({ theme_url: '' }), { theme: 'builtin', themeUrl: '' });
  assert.deepEqual(resolveEmbedTheme({ theme_url: JUNIMO_THEME }, { SHELLATLAS_EMBED_THEME: 'luminaplus' }), { theme: 'luminaplus', themeUrl: LUMINA_THEME });
  assert.deepEqual(resolveEmbedTheme({ theme_url: JUNIMO_THEME }, { SHELLATLAS_EMBED_THEME: 'builtin' }), { theme: 'builtin', themeUrl: '' });
  for (const repository of ['finch-xu/CF-Server-Monitor-theme-win2000', 'Tokinx/cf-server-monitor-theme-emerald', 'loongkong/cf-server-monitor-theme-pulse', 'akasls/Horizon-CF-Server-Monitor', 'LanHuangJG/cf-server-monitor-theme-shadcn', 'allury/CFSM-Glassmorphism', 'WAOR/CFSM-SAO', 'Vegas7/CFSM-Theme-AnotherLuminaPlus', 'ayingQAQ/cf-monitor-theme-hahaha', 'huilang-me/CFSM-CRT', 'custom-owner/custom-theme']) {
    const themeUrl = `https://github.com/${repository}/tree/${'a'.repeat(40)}`;
    assert.deepEqual(resolveEmbedTheme({ theme_url: themeUrl }), { theme: 'generic', themeUrl });
  }
  for (const theme_url of ['https://github.com/huilang-me/cfsm-junimo/tree/main', 'https://evil.example/huilang-me/cfsm-junimo/tree/' + 'a'.repeat(40)]) {
    assert.throws(() => resolveEmbedTheme({ theme_url }), /GitHub 发布版本/);
  }
});

test('embedded theme fonts use the scoped asset path without rewriting data or external URLs', () => {
  const base = `/api/v1/servers/${b}/monitor/embed/`;
  const css = '@font-face{src:url("/assets/fonts/pixel.woff2")} .icon{mask:url(/assets/icon.svg)} .relative{background:url(./file.svg)} .external{background:url(https://static.example/file.svg)} .inline{background:url("data:image/svg+xml,a")}';
  const result = rewriteEmbedStyles(css, base);
  assert.ok(result.includes(`url("${base}assets/fonts/pixel.woff2")`));
  assert.ok(result.includes(`url(${base}assets/icon.svg)`));
  assert.ok(result.includes('url(./file.svg)'));
  assert.ok(result.includes('url(https://static.example/file.svg)'));
  assert.ok(result.includes('url("data:image/svg+xml,a")'));
});

test('Access validates signature, issuer, audience, expiry and service identity', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  const keys = createLocalJWKSet({ keys: [{ ...jwk, kid: 'test', alg: 'RS256' }] });
  const token = async (claims = {}, options = {}) => new SignJWT({ sub: '', common_name: 'shellatlas.access', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuedAt().setIssuer(options.issuer || env.SHELLATLAS_ACCESS_TEAM_DOMAIN)
    .setAudience(options.audience || env.SHELLATLAS_ACCESS_AUD).setExpirationTime(options.expiry || '5m').sign(privateKey);
  const request = jwt => new Request('https://monitor.example/integrations/shellatlas/health', { headers: { 'Cf-Access-Jwt-Assertion': jwt } });
  assert.equal((await requireShellAtlasAccess(request(await token()), env, keys)).common_name, 'shellatlas.access');
  for (const jwt of [await token({ common_name: 'other.access' }), await token({ common_name: undefined, email: 'admin@example.com' }), await token({}, { audience: 'other' }), await token({}, { issuer: 'https://other.cloudflareaccess.com' }), await token({}, { expiry: 1 })]) {
    await assert.rejects(requireShellAtlasAccess(request(jwt), env, keys));
  }
  await assert.rejects(requireShellAtlasAccess(request((await token()).slice(0, -8) + 'invalid'), env, keys));
  const missing = await handleShellAtlas(new Request('https://monitor.example/integrations/shellatlas/health'), env, {});
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get('Cache-Control'), 'private, no-store');
});

test('embed routing cannot reflect arbitrary paths or script origins', () => {
  const make = base => new Request('https://monitor.example/', { headers: { 'X-ShellAtlas-Embed-Base': base, 'X-ShellAtlas-Parent-Origin': 'https://atlas.example' } });
  const base = `/api/v1/servers/${b}/monitor/embed/`;
  const context = embedContext(make(base), a);
  assert.equal(context.serverId, b);
  for (const path of ['/admin/', '//evil.example/', `${base}../`, `${base}?x="<script>`]) {
    assert.throws(() => embedContext(make(path), a));
  }
  const html = renderEmbed('<head><meta name="apiBase" content="https://original.example"><script type="module" src="/assets/main.js"></script></head>', { ...context, theme: 'luminaplus' });
  assert.ok(html.indexOf('embedBootstrap') < html.indexOf('type="module"'));
  assert.ok(html.includes(`${base}assets/main.js`));
  assert.ok(!html.includes('https://original.example'));
  assert.deepEqual(publicMetrics({ cpu: 10, note: 'secret', secret: 'key', custom_ct: 'private-host', api_secret: 'key' }), { cpu: 10 });
  const dashboardBase = '/api/v1/monitor/dashboard/embed/';
  assert.equal(embedContext(make(dashboardBase), 'dashboard').base, dashboardBase);
  assert.throws(() => embedContext(make(dashboardBase), a));
});

test('restricted subscriptions reject escalation, preserve authorization and filter broadcasts', async () => {
  let attachment = { scope: 'all', serverIds: [a], allowedServerIds: [a] };
  const messages = [];
  const closes = [];
  const socket = { deserializeAttachment: () => attachment, serializeAttachment: value => { attachment = value; }, send: value => messages.push(JSON.parse(value)), close: (...args) => closes.push(args) };
  const broadcaster = Object.create(MetricsBroadcaster.prototype);
  broadcaster.state = { getWebSockets: () => [socket] };
  broadcaster._hintAgentRealtimeIntervals = async () => {};
  await broadcaster.webSocketMessage(socket, JSON.stringify({ type: 'subscribe', scope: 'all', ids: [b] }));
  assert.equal(closes[0][0], 1008);
  assert.deepEqual(attachment.allowedServerIds, [a]);
  await broadcaster.webSocketMessage(socket, JSON.stringify({ type: 'subscribe', scope: 'all', ids: [a] }));
  assert.deepEqual(attachment.allowedServerIds, [a]);
  // Even a corrupted client-selected subscription cannot widen the server grant.
  attachment.serverIds = [a, b];
  broadcaster._broadcastBatch([a, b].map(serverId => ({ serverId, samples: [{ ts: 1, data: { cpu: 12, note: 'private', secret: 'key' } }] })), 1);
  const updates = messages.find(message => message.type === 'batchUpdate').updates;
  assert.deepEqual(updates.map(update => update.serverId), [a]);
  assert.deepEqual(updates[0].samples[0].data, { cpu: 12 });
});

test('authenticated integration provisions idempotently and returns only one D1 node', async () => {
  const miniflare = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("OK")}}', d1Databases: {DB: 'shellatlas-integration-test'} });
  const originalFetch = globalThis.fetch;
  try {
    const db = await miniflare.getD1Database('DB');
    await initDatabase(db);
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = {...await exportJWK(publicKey), kid:'integration',alg:'RS256'};
    globalThis.fetch = async value => {
      const url = String(value);
      if (url === `${env.SHELLATLAS_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`) return Response.json({keys:[jwk]});
      if (url.includes('raw.githubusercontent.com/volcano-1025/')) {
        if (url.endsWith('/index.html')) return new Response('<html><head><script type="module" src="/assets/original.js"></script><link rel="stylesheet" href="/assets/original.css"></head><body><div id="root"></div></body></html>');
        if (url.endsWith('/assets/original.js')) return new Response('import "./shared.js"; export const theme = "lumina";');
        if (url.endsWith('/assets/shared.js')) return new Response('export const shared = "lumina";');
        if (url.endsWith('/assets/original.css')) return new Response('@font-face{src:url("/assets/fonts/lumina.woff2")}');
        if (url.endsWith('/assets/fonts/lumina.woff2')) return new Response('lumina-font');
        return new Response('Theme file not found', { status: 404 });
      }
      if (url.includes('raw.githubusercontent.com/huilang-me/cfsm-junimo/')) {
        if (url.endsWith('/index.html')) return new Response('<html><head><script type="module" src="/assets/junimo.js"></script></head><body><div id="root"></div></body></html>');
        if (url.endsWith('/assets/junimo.js')) return new Response('export const theme = "junimo";');
        if (url.endsWith('/assets/junimo.css')) return new Response('@font-face{src:url("/assets/fonts/pixel.woff2")}');
        return new Response('Theme file not found', { status: 404 });
      }
      if (url.includes('raw.githubusercontent.com/finch-xu/')) return new Response('<html><head><script type="module" src="/assets/win2000.js"></script></head><body><div id="app"></div></body></html>');
      if (url.includes('raw.githubusercontent.com/missing/')) return new Response('not found', { status: 404 });
      throw new Error(`Unexpected outbound request: ${url}`);
    };
    const jwt = await new SignJWT({sub:'',common_name:'shellatlas.access'}).setProtectedHeader({alg:'RS256',kid:'integration'})
      .setIssuedAt().setIssuer(env.SHELLATLAS_ACCESS_TEAM_DOMAIN).setAudience(env.SHELLATLAS_ACCESS_AUD).setExpirationTime('5m').sign(privateKey);
    const runtime = {...env, DB: db, API_SECRET: 'agent-only-secret'};
    const call = (path, method='GET', body, extra={}) => handleShellAtlas(new Request(`https://monitor.example/integrations/shellatlas/${path}`, {
      method, headers: {'Cf-Access-Jwt-Assertion':jwt,...extra}, ...(body ? {body:JSON.stringify(body)} : {})
    }), runtime, {});
    assert.equal((await call('health')).status,200);
    for (const node of [a,a,b]) assert.equal((await call(`nodes/${node}`,'PUT',{name:node===a?'allowed':'other-node-private-name'})).status,200);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM servers').first()).count,2);
    await db.prepare('UPDATE servers SET note = ?, is_hidden = ? WHERE id = ?').bind('private-note','1',a).run();
    clearServersListCache();
    const response = await call(`nodes/${a}/embed/api/servers`);
    const text = await response.text();
    assert.ok(!text.includes('other-node-private-name'));
    assert.ok(!text.includes(b));
    assert.ok(!text.includes('private-note'));
    assert.ok(!text.includes('agent-only-secret'));
    const data = JSON.parse(text);
    assert.equal(data.servers.length,1);
    assert.equal(data.servers[0].is_hidden,'0');
    assert.equal(data.stats.total,1);
    assert.equal((await call(`nodes/${a}/embed/api/history/all`)).status,404);
    assert.equal((await call(`nodes/${a}/embed/admin/api`,'POST',{})).status,405);
    const selectTheme = async theme_url => {
      await db.prepare("INSERT INTO settings (key,value) VALUES ('site_options',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify({theme_url})).run();
      clearSiteSettingsCache();
      clearAppearanceSettingsCache();
    };
    await selectTheme(LUMINA_THEME);
    const legacyPage = await call(`nodes/${a}/embed/`,'GET',null,{'X-ShellAtlas-Embed-Base':`/api/v1/servers/${b}/monitor/embed/`,'X-ShellAtlas-Parent-Origin':'https://atlas.example'});
    assert.ok((await legacyPage.text()).includes(`src="/api/v1/servers/${b}/monitor/embed/assets/original.js"`), 'Older Managers must keep their supported unversioned paths');
    const page = await call(`nodes/${a}/embed/`,'GET',null,{'X-ShellAtlas-Embed-Base':`/api/v1/servers/${b}/monitor/embed/`,'X-ShellAtlas-Parent-Origin':'https://atlas.example','X-ShellAtlas-Theme-Assets':'versioned-v1'});
    assert.equal(page.status,200);
    assert.equal(page.headers.get('X-Frame-Options'),null);
    assert.ok(page.headers.get('Content-Security-Policy').includes("frame-ancestors 'self' https://atlas.example"));
    const luminaHtml = await page.text();
    assert.ok(luminaHtml.includes(`/api/v1/servers/${b}/monitor/embed/themes/`));
    assert.ok(luminaHtml.includes('/assets/original.js'));
    await selectTheme(JUNIMO_THEME);
    const embedHeaders = { 'X-ShellAtlas-Embed-Base': `/api/v1/servers/${b}/monitor/embed/`, 'X-ShellAtlas-Parent-Origin': 'https://atlas.example', 'X-ShellAtlas-Theme-Assets':'versioned-v1' };
    // The old document must keep its own release after the configured theme changes.
    const oldScript = luminaHtml.match(/src="([^"]*\/assets\/original\.js)"/)[1];
    const oldResource = pathname => call(`nodes/${a}/embed/${pathname.slice(embedHeaders['X-ShellAtlas-Embed-Base'].length)}`, 'GET', null, embedHeaders);
    const oldModule = await oldResource(oldScript);
    assert.equal(oldModule.status, 200, 'Switching themes must not invalidate the old document modules');
    assert.ok((await oldModule.text()).includes('theme = "lumina"'));
    const sharedPath = new URL('./shared.js', `https://atlas.example${oldScript}`).pathname;
    assert.ok((await (await oldResource(sharedPath)).text()).includes('shared = "lumina"'));
    const oldStyle = luminaHtml.match(/href="([^"]*\/assets\/original\.css)"/)[1];
    const oldCss = await oldResource(oldStyle);
    assert.equal(oldCss.status, 200);
    const fontPath = (await oldCss.text()).match(/url\("([^"]+)"\)/)[1];
    assert.equal(fontPath, oldScript.replace('original.js', 'fonts/lumina.woff2'));
    assert.equal(await (await oldResource(fontPath)).text(), 'lumina-font');
    const revision = oldScript.slice(embedHeaders['X-ShellAtlas-Embed-Base'].length).split('/')[1];
    const invalidRevisions = ['bad!', 'a'.repeat(1025), Buffer.from('https://evil.example/repo/tree/' + 'a'.repeat(40)).toString('base64url')];
    for (const invalid of invalidRevisions) {
      assert.equal((await call(`nodes/${a}/embed/themes/${invalid}/assets/original.js`, 'GET', null, embedHeaders)).status, 404);
    }
    assert.equal((await call(`nodes/${a}/embed/themes/${revision}/api/servers`, 'GET', null, embedHeaders)).status, 404);
    const missingAsset = await oldResource(oldScript.replace('original.js', 'missing.js'));
    assert.equal(missingAsset.status, 404);
    assert.equal((await missingAsset.json()).code, 'CFSM_THEME_ASSET_NOT_FOUND');
    const junimo = await call(`nodes/${a}/embed/`, 'GET', null, embedHeaders);
    const junimoHtml = await junimo.text();
    assert.equal(junimo.status, 200);
    assert.ok(junimoHtml.includes(`/api/v1/servers/${b}/monitor/embed/themes/`));
    assert.ok(junimoHtml.includes('/assets/junimo.js'));
    assert.ok(junimoHtml.includes('"theme":"junimo"'));
    assert.ok(!junimoHtml.includes('assets/original.js'));
    const css = await call(`nodes/${a}/embed/assets/junimo.css`, 'GET', null, embedHeaders);
    assert.equal(css.status, 200);
    assert.ok((await css.text()).includes(`/api/v1/servers/${b}/monitor/embed/assets/fonts/pixel.woff2`));
    await selectTheme(`https://github.com/finch-xu/CF-Server-Monitor-theme-win2000/tree/${'a'.repeat(40)}`);
    const win2000 = await call(`nodes/${a}/embed/`, 'GET', null, embedHeaders);
    assert.equal(win2000.status, 200);
    assert.ok((await win2000.text()).includes('/assets/win2000.js'));
    await selectTheme(`https://github.com/missing/theme/tree/${'a'.repeat(40)}`);
    const missing = await call(`nodes/${a}/embed/`, 'GET', null, embedHeaders);
    assert.equal(missing.status, 502);
    assert.equal((await missing.json()).code, 'CFSM_THEME_LOAD_FAILED');
    await selectTheme(JUNIMO_THEME);
    const dashboard = (suffix = '', method = 'GET', versioned = true) => handleShellAtlas(new Request(`https://monitor.example/integrations/shellatlas/dashboard/embed/${suffix}`, {
      method, headers: {'Cf-Access-Jwt-Assertion': jwt, 'X-ShellAtlas-Embed-Base':'/api/v1/monitor/dashboard/embed/', 'X-ShellAtlas-Parent-Origin':'https://atlas.example', ...(versioned ? {'X-ShellAtlas-Theme-Assets':'versioned-v1'} : {})}
    }), runtime, {});
    const legacyDashboard = await dashboard('', 'GET', false);
    assert.ok((await legacyDashboard.text()).includes('src="/api/v1/monitor/dashboard/embed/assets/junimo.js"'));
    const fullPage = await dashboard();
    assert.equal(fullPage.status, 200);
    const fullHtml = await fullPage.text();
    assert.ok(fullHtml.includes('"mode":"dashboard"'));
    assert.ok(fullHtml.includes('/api/v1/monitor/dashboard/embed/themes/'));
    assert.ok(fullHtml.includes('/assets/junimo.js'));
    assert.ok(!fullHtml.includes('agent-only-secret'));
    assert.ok(fullPage.headers.get('Content-Security-Policy').includes('frame-ancestors'));
    const dashboardScript = fullHtml.match(/src="([^"]*\/assets\/junimo\.js)"/)[1];
    const dashboardResource = dashboardScript.slice('/api/v1/monitor/dashboard/embed/'.length);
    for (const themeUrl of [LUMINA_THEME, '']) {
      await selectTheme(themeUrl);
      const previousModule = await dashboard(dashboardResource);
      assert.equal(previousModule.status, 200, 'Dashboard assets must also remain on their original theme release');
      assert.ok((await previousModule.text()).includes('theme = "junimo"'));
      const previousNodeModule = await oldResource(oldScript);
      assert.equal(previousNodeModule.status, 200);
      assert.ok((await previousNodeModule.text()).includes('theme = "lumina"'));
    }
    await selectTheme(JUNIMO_THEME);
    const dashboardNodes = await (await dashboard('api/servers')).json();
    assert.equal(dashboardNodes.servers.length, 1);
    assert.equal(dashboardNodes.servers[0].id, b);
    assert.ok(!JSON.stringify(dashboardNodes).includes('private-note'));
    const fullConfig = await (await dashboard('api/config')).json();
    assert.equal(fullConfig.authorization, false);
    assert.ok(!JSON.stringify(fullConfig).includes('agent-only-secret'));
    const detail = await (await dashboard(`api/server?id=${b}`)).json();
    assert.equal(detail.id, b);
    assert.equal((await dashboard('admin/api')).status, 404);
    assert.equal((await dashboard('api/config', 'POST')).status, 405);
    assert.equal((await dashboard('api/history/all?id='+b+'&hours=999')).status, 400);
    assert.equal((await dashboard('api/history/all')).status, 400);
    assert.equal((await dashboard('api/ws')).status, 503);
  } finally {
    globalThis.fetch = originalFetch;
    clearServersListCache();
    clearSiteSettingsCache();
    clearAppearanceSettingsCache();
    await miniflare.dispose();
  }
});
