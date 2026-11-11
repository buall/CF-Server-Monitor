import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { requireShellAtlasAccess } from '../src/integrations/access.js';
import { embedContext, renderEmbed, rewriteEmbedStyles, resolveEmbedTheme, LUMINA_THEME, handleShellAtlas } from '../src/integrations/shellatlas.js';
import { publicMetrics } from '../src/integrations/fields.js';
import { MetricsBroadcaster } from '../src/durable/MetricsBroadcaster.js';
import { Miniflare } from 'miniflare';
import { initDatabase } from '../src/database/schema.js';
import { clearServersListCache } from '../src/utils/cache.js';
import { clearSiteSettingsCache, clearAppearanceSettingsCache } from '../src/utils/settings.js';

const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const env = { SHELLATLAS_ACCESS_TEAM_DOMAIN: 'https://test.cloudflareaccess.com', SHELLATLAS_ACCESS_AUD: 'application-a', SHELLATLAS_ACCESS_CLIENT_ID: 'shellatlas.access' };
const JUNIMO_THEME = 'https://github.com/huilang-me/cfsm-junimo/tree/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

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
      if (url.includes('raw.githubusercontent.com/volcano-1025/')) return new Response('<html><head><script type="module" src="/assets/original.js"></script></head><body><div id="root"></div></body></html>');
      if (url.includes('raw.githubusercontent.com/huilang-me/cfsm-junimo/')) {
        return url.endsWith('.css')
          ? new Response('@font-face{src:url("/assets/fonts/pixel.woff2")}')
          : new Response('<html><head><script type="module" src="/assets/junimo.js"></script></head><body><div id="root"></div></body></html>');
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
    const page = await call(`nodes/${a}/embed/`,'GET',null,{'X-ShellAtlas-Embed-Base':`/api/v1/servers/${b}/monitor/embed/`,'X-ShellAtlas-Parent-Origin':'https://atlas.example'});
    assert.equal(page.status,200);
    assert.equal(page.headers.get('X-Frame-Options'),null);
    assert.ok(page.headers.get('Content-Security-Policy').includes("frame-ancestors 'self' https://atlas.example"));
    assert.ok((await page.text()).includes(`/api/v1/servers/${b}/monitor/embed/assets/original.js`));
    await selectTheme(JUNIMO_THEME);
    const embedHeaders = { 'X-ShellAtlas-Embed-Base': `/api/v1/servers/${b}/monitor/embed/`, 'X-ShellAtlas-Parent-Origin': 'https://atlas.example' };
    const junimo = await call(`nodes/${a}/embed/`, 'GET', null, embedHeaders);
    const junimoHtml = await junimo.text();
    assert.equal(junimo.status, 200);
    assert.ok(junimoHtml.includes(`/api/v1/servers/${b}/monitor/embed/assets/junimo.js`));
    assert.ok(junimoHtml.includes('"theme":"junimo"'));
    assert.ok(!junimoHtml.includes('assets/original.js'));
    const css = await call(`nodes/${a}/embed/assets/junimo.css`, 'GET', null, embedHeaders);
    assert.equal(css.status, 200);
    assert.ok((await css.text()).includes(`/api/v1/servers/${b}/monitor/embed/assets/fonts/pixel.woff2`));
    await selectTheme(`https://github.com/finch-xu/CF-Server-Monitor-theme-win2000/tree/${'a'.repeat(40)}`);
    const win2000 = await call(`nodes/${a}/embed/`, 'GET', null, embedHeaders);
    assert.equal(win2000.status, 200);
    assert.ok((await win2000.text()).includes(`/api/v1/servers/${b}/monitor/embed/assets/win2000.js`));
    await selectTheme(`https://github.com/missing/theme/tree/${'a'.repeat(40)}`);
    const missing = await call(`nodes/${a}/embed/`, 'GET', null, embedHeaders);
    assert.equal(missing.status, 502);
    assert.equal((await missing.json()).code, 'CFSM_THEME_LOAD_FAILED');
    await selectTheme(JUNIMO_THEME);
    const dashboard = (suffix = '', method = 'GET') => handleShellAtlas(new Request(`https://monitor.example/integrations/shellatlas/dashboard/embed/${suffix}`, {
      method, headers: {'Cf-Access-Jwt-Assertion': jwt, 'X-ShellAtlas-Embed-Base':'/api/v1/monitor/dashboard/embed/', 'X-ShellAtlas-Parent-Origin':'https://atlas.example'}
    }), runtime, {});
    const fullPage = await dashboard();
    assert.equal(fullPage.status, 200);
    const fullHtml = await fullPage.text();
    assert.ok(fullHtml.includes('"mode":"dashboard"'));
    assert.ok(fullHtml.includes('/api/v1/monitor/dashboard/embed/assets/junimo.js'));
    assert.ok(!fullHtml.includes('agent-only-secret'));
    assert.ok(fullPage.headers.get('Content-Security-Policy').includes('frame-ancestors'));
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
