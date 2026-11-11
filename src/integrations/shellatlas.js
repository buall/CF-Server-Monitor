import { publicMetrics } from './fields.js';
import { IntegrationError, requireShellAtlasAccess } from './access.js';
import { embedBootstrap } from './embedBootstrap.js';
import { serveFrontend } from '../handlers/frontend.js';
import { buildDashboardResponse } from '../handlers/dashboard.js';
import { loadSettings } from '../utils/settings.js';
import { getServerDetail, clearServersListCache } from '../utils/cache.js';
import { insertServerWithPartition } from '../database/indexOptimization.js';
import { CURRENT_VERSION } from '../utils/config.js';
import { markFrontendRealtimeActive } from '../utils/realtimeBroadcastGate.js';

export const LUMINA_THEME = 'https://github.com/volcano-1025/CFSM-Theme-LuminaPlus/tree/7833a6075ea95fa429f9af794b036156579615f8';
const EMBED_THEME_REPOS = new Map([
  ['volcano-1025/cfsm-theme-luminaplus', 'luminaplus'],
  ['huilang-me/cfsm-junimo', 'junimo']
]);
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const NODE_ROUTE = new RegExp(`^/integrations/shellatlas/nodes/(${UUID})(?:/(.*))?$`, 'i');
const PROXY_BASE = new RegExp(`^/api/v1/servers/${UUID}/monitor/embed/$`, 'i');

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'
  } });
}

export function resolveEmbedTheme(settings, env = {}) {
  const mode = env.SHELLATLAS_EMBED_THEME || 'site';
  if (mode === 'builtin') return { theme: 'builtin', themeUrl: '' };
  if (mode === 'luminaplus') return { theme: 'luminaplus', themeUrl: LUMINA_THEME };
  if (mode !== 'site') throw new IntegrationError('Unsupported embed theme', 503);
  const themeUrl = String(settings.theme_url || '').trim();
  if (!themeUrl) return { theme: 'builtin', themeUrl: '' };
  let url;
  try { url = new URL(themeUrl); } catch { throw new IntegrationError('当前主题地址无效', 503); }
  const parts = url.pathname.split('/').filter(Boolean);
  const theme = EMBED_THEME_REPOS.get(`${parts[0]}/${parts[1]}`.toLowerCase());
  if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash ||
      parts.length !== 4 || parts[2] !== 'tree' || !/^[a-f0-9]{40}$/i.test(parts[3]) || !theme) {
    throw new IntegrationError('当前主题暂不支持单卡嵌入，请在 CFSM 中选择 Junimo、LuminaPlus 或内置主题', 503);
  }
  return { theme, themeUrl };
}


export function embedContext(request, nodeId) {
  const ownBase = `/integrations/shellatlas/nodes/${nodeId}/embed/`;
  const supplied = request.headers.get('X-ShellAtlas-Embed-Base');
  if (supplied && !PROXY_BASE.test(supplied)) throw new IntegrationError('Invalid embed base');
  let parentOrigin = '';
  const parent = request.headers.get('X-ShellAtlas-Parent-Origin');
  if (parent) {
    let parsed;
    try { parsed = new URL(parent); } catch { throw new IntegrationError('Invalid parent origin'); }
    if (parsed.origin !== parent || parsed.username || parsed.password ||
        (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname)))) {
      throw new IntegrationError('Invalid parent origin');
    }
    parentOrigin = parsed.origin;
  }
  return { base: supplied || ownBase, parentOrigin, serverId: supplied?.split('/')[4] || nodeId };
}

export function renderEmbed(html, context) {
  html = html.replace(/<meta\b[^>]*name=["']apiBase["'][^>]*>/gi, '');
  html = html.replace(/\b(src|href)=(["'])(?:\.\/|\/)?((?:assets|static|flags|os-icons|files)\/)/gi,
    (_, attr, quote, path) => `${attr}=${quote}${context.base}${path}`);
  const serialized = JSON.stringify(context).replace(/</g, '\\u003c');
  // Wrangler's keep-names transform adds __name calls inside this function.
  // The serialized client script needs its own helper scope, separate from Worker globals.
  const bootstrap = `<script>(()=>{const __name=(value)=>value;(${embedBootstrap.toString()})(${serialized});})();</script>`;
  return html.replace(/<head\b[^>]*>/i, match => `${match}${bootstrap}`);
}

export function rewriteEmbedStyles(css, base) {
  return css.replace(/url\(\s*(["']?)\/(assets|static|flags|os-icons|files)\//gi,
    (_, quote, directory) => `url(${quote}${base}${directory}/`);
}

function scopedConfig(settings) {
  const config = {
    version: CURRENT_VERSION, is_public: true, authorization: false,
    turnstile_enabled: false, turnstile_login_enabled: false,
    site_title: settings.site_title || 'ShellAtlas', default_language: settings.default_language || 'zh',
    preferred_theme: settings.preferred_theme || 'auto', display_mode: 'bar',
    theme_options: { showConnections: true, ...settings.theme_options },
    frontend_ws_timeout_minutes: 0, latency_window: { points: 20, hours: 2 }
  };
  for (const name of ['custom_ct_name', 'custom_cu_name', 'custom_cm_name', 'custom_bd_name', 'node_1_name', 'node_2_name', 'node_3_name', 'node_4_name']) {
    if (settings[name]) config[name] = settings[name];
  }
  return config;
}

export async function handleShellAtlas(request, env, ctx) {
  try {
    await requireShellAtlasAccess(request, env);
    const url = new URL(request.url);
    if (url.pathname === '/integrations/shellatlas/health' && request.method === 'GET') {
      return json({ ok: true, version: CURRENT_VERSION, integration: 'shellatlas' });
    }
    const route = url.pathname.match(NODE_ROUTE);
    if (!route) throw new IntegrationError('Integration route not found', 404);
    const [, nodeId, suffix = ''] = route;

    // Caller-owned UUID is the idempotency key. Never overwrite an existing node.
    if (suffix === '' && request.method === 'PUT') {
      if (Number(request.headers.get('Content-Length') || 0) > 4096) throw new IntegrationError('Request too large', 413);
      const text = await request.text();
      if (text.length > 4096) throw new IntegrationError('Request too large', 413);
      let input;
      try { input = JSON.parse(text); } catch { throw new IntegrationError('Invalid JSON'); }
      const name = String(input.name || '').trim();
      if (!name || name.length > 100 || /[\x00-\x1f]/.test(name)) throw new IntegrationError('Invalid server name');
      if (!await getServerDetail(env.DB, nodeId, true)) {
        try { await insertServerWithPartition(env.DB, { id: nodeId, name, group: 'ShellAtlas' }); }
        catch (error) {
          // Concurrent retries with the same id can race at the unique constraint.
          clearServersListCache();
          if (!await getServerDetail(env.DB, nodeId, true)) throw error;
        }
        clearServersListCache();
      }
      return json({ nodeId });
    }
    if (request.method !== 'GET') throw new IntegrationError('Method not allowed', 405);
    const server = await getServerDetail(env.DB, nodeId, true);
    if (!server) throw new IntegrationError('Server not found', 404);
    if (suffix === 'install') {
      if (!env.API_SECRET) throw new IntegrationError('Agent secret is not configured', 503);
      const settings = await loadSettings(env.DB);
      return json({ nodeId, reportUrl: `${url.origin}/update`, secret: env.API_SECRET,
        userAgent: settings.ua || '', installer: 'https://raw.githubusercontent.com/huilang-me/cfsm-agent/main/install.sh' });
    }
    const settings = await loadSettings(env.DB);
    if (suffix === '' || suffix === 'embed/api/servers') {
      const response = await buildDashboardResponse(env, settings, nodeId);
      if (!response.ok) return response;
      const data = await response.json();
      data.servers = data.servers.map(server => ({ ...publicMetrics(server), is_hidden: '0' }));
      data.latestReportUpdates = data.latestReportUpdates.map(update => ({
        ...update, samples: update.samples.map(sample => ({ ...sample, data: publicMetrics(sample.data) }))
      }));
      markFrontendRealtimeActive();
      return json(data);
    }
    if (suffix === 'embed/api/config') return json(scopedConfig(settings));
    if (suffix === 'embed/api/ws') {
      if (!env.METRICS_BROADCASTER) throw new IntegrationError('Realtime is unavailable', 503);
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new IntegrationError('WebSocket upgrade required', 426);
      const headers = new Headers();
      headers.set('Upgrade', 'websocket');
      headers.set('X-CFSM-Allowed-Server-Ids', JSON.stringify([nodeId]));
      const stub = env.METRICS_BROADCASTER.get(env.METRICS_BROADCASTER.idFromName('global'));
      markFrontendRealtimeActive();
      return stub.fetch(new Request('http://internal/ws?subscribe=all', { headers }));
    }

    const { theme, themeUrl } = resolveEmbedTheme(settings, env);
    const embedSettings = { ...settings, theme_url: themeUrl,
      custom_head: '', custom_script: '', custom_bg: '', custom_bg_mobile: '', favicon: '' };
    const embedEnv = { ...env, API_BASE: '' };
    if (suffix === 'embed/' || suffix === 'embed') {
      const context = { ...embedContext(request, nodeId), theme };
      const response = await serveFrontend(new Request(`${url.origin}/`), embedEnv, embedSettings);
      if (!response.ok) return response;
      const headers = new Headers(response.headers);
      headers.delete('X-Frame-Options');
      headers.set('Content-Security-Policy', `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'self'${context.parentOrigin ? ` ${context.parentOrigin}` : ''}; object-src 'none'; base-uri 'self'; form-action 'none'`);
      headers.set('Cache-Control', 'private, no-store');
      return new Response(renderEmbed(await response.text(), context), { headers });
    }
    const asset = suffix.match(/^embed\/((?:assets|static|flags|os-icons|files)\/[A-Za-z0-9_./@-]+)$/);
    if (asset && !asset[1].split('/').some(part => part === '.' || part === '..' || !part)) {
      const assetRequest = new Request(`${url.origin}/${asset[1]}`);
      const response = asset[1].startsWith('assets/')
        ? await serveFrontend(assetRequest, embedEnv, embedSettings)
        : await env.ASSETS.fetch(assetRequest);
      const headers = new Headers(response.headers);
      headers.delete('X-CFSM-Theme-Asset');
      headers.set('Cache-Control', 'private, max-age=3600');
      if (headers.get('Content-Type')?.includes('text/html')) throw new IntegrationError('Asset not found', 404);
      if (headers.get('Content-Type')?.includes('text/css')) {
        const context = embedContext(request, nodeId);
        return new Response(rewriteEmbedStyles(await response.text(), context.base), { status: response.status, headers });
      }
      return new Response(response.body, { status: response.status, headers });
    }
    throw new IntegrationError('Integration route not found', 404);
  } catch (error) {
    if (error instanceof IntegrationError) return json({ error: error.message }, error.status);
    console.error('[ShellAtlas] Integration request failed:', error.message);
    return json({ error: 'Monitor integration request failed' }, 500);
  }
}
