// Serialized into embed HTML before the untouched theme modules run.
export function embedBootstrap(context) {
  const base = context.base;
  const assetBase = context.assetBase || base;
  const dashboard = context.mode === 'dashboard';
  let card = null;
  const cardInset = context.theme === 'junimo' ? 8 : context.theme === 'generic' ? 12 : 0;
  const nativeFetch = window.fetch.bind(window);
  const NativeWebSocket = window.WebSocket;
  const mapUrl = value => {
    const url = new URL(String(value), location.href);
    if (url.host === location.host && /^\/api\//.test(url.pathname)) {
      url.pathname = `${base}${url.pathname.slice(1)}`;
    } else if (url.host === location.host && /^\/(assets|static|flags|os-icons|files)\//.test(url.pathname)) {
      url.pathname = `${assetBase}${url.pathname.slice(1)}`;
    }
    return url.toString();
  };
  const mapAsset = element => {
    for (const attribute of ['src', 'href']) {
      const raw = element.getAttribute(attribute);
      if (!raw) continue;
      let url;
      try { url = new URL(raw, location.href); } catch { continue; }
      if (url.origin === location.origin && /^\/(assets|static|flags|os-icons|files)\//.test(url.pathname)) {
        url.pathname = `${assetBase}${url.pathname.slice(1)}`;
        element.setAttribute(attribute, url.toString());
      }
    }
  };
  const postDashboard = (type, message) => {
    if (context.parentOrigin) parent.postMessage({ type: `shellatlas:dashboard-${type}`, ...(message ? { message } : {}) }, context.parentOrigin);
  };
  window.fetch = async (input, init) => {
    const mapped = input instanceof Request ? new Request(mapUrl(input.url), input) : mapUrl(input);
    const response = await nativeFetch(mapped, init);
    if (dashboard && new URL(input instanceof Request ? input.url : String(input), location.href).pathname.endsWith('/api/servers')) {
      if (response.ok) response.clone().json().then(() => requestAnimationFrame(() => requestAnimationFrame(() => postDashboard('ready')))).catch(() => postDashboard('error', '监控面板数据读取失败，请刷新重试。'));
      else postDashboard('error', '监控面板数据加载失败，请检查主控连接后重试。');
    }
    return response;
  };
  window.WebSocket = class extends NativeWebSocket {
    constructor(url, protocols) {
      const mapped = mapUrl(url);
      if (protocols === undefined) super(mapped);
      else super(mapped, protocols);
    }
  };
  // Embed preferences are isolated in this iframe's storage facade. Existing
  // dashboard preferences and administrator credentials are not changed/read.
  const local = new Map(dashboard ? [] : [['monitor_preferred_view', 'bar']]);
  const session = new Map(dashboard ? [] : [
    ['cfsm-luminaplus:node-view-mode-session:desktop', 'large'],
    ['cfsm-luminaplus:node-view-mode-session:mobile', 'large'],
    ['cfsm-junimo:node-view-mode-session:desktop', 'large'],
    ['cfsm-junimo:node-view-mode-session:mobile', 'large']
  ]);
  const storage = values => ({
    getItem: key => values.get(String(key)) ?? null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: key => values.delete(String(key)), clear: () => values.clear(),
    key: index => [...values.keys()][index] ?? null,
    get length() { return values.size; }
  });
  try {
    Object.defineProperty(window, 'localStorage', { value: storage(local), configurable: true });
    Object.defineProperty(window, 'sessionStorage', { value: storage(session), configurable: true });
  } catch { /* Fail closed rather than using credentials from the parent origin. */
    document.documentElement.dataset.embedFailed = 'true';
  }
  if (dashboard) {
    const adaptAssets = () => document.querySelectorAll('img[src],link[href],script[src]').forEach(mapAsset);
    const start = () => {
      if (document.documentElement.dataset.embedFailed) {
        postDashboard('error', '无法初始化监控面板，请刷新重试。');
        return;
      }
      const observer = new MutationObserver(adaptAssets);
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'href'] });
      addEventListener('pagehide', () => observer.disconnect(), { once: true });
      adaptAssets();
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
    document.addEventListener('click', event => {
      const anchor = event.target.closest('a[href]');
      if (!anchor) return;
      const target = new URL(anchor.getAttribute('href'), location.href);
      if (target.origin !== location.origin) return;
      if (/^\/(admin|login)(\/|$)/.test(target.pathname) || /^#\/?(admin|login)(\/|$)/.test(target.hash)) {
        event.preventDefault();
        window.open(new URL('/admin', context.siteUrl).toString(), '_blank', 'noopener,noreferrer');
      } else if (target.pathname === '/' && target.hash) {
        event.preventDefault();
        location.hash = target.hash;
      }
    }, true);
    return;
  }
  const home = new URL(location.href);
  home.hash = '/';
  const nativePushState = history.pushState.bind(history);
  const nativeReplaceState = history.replaceState.bind(history);
  let status = null;
  let recovering = false;
  const isHome = value => {
    try {
      const target = new URL(String(value), location.href);
      const route = target.hash.slice(1).split('?')[0];
      return target.origin === home.origin && target.pathname === home.pathname && (!route || route === '/');
    } catch { return false; }
  };
  const restoreHome = () => {
    if (recovering) return;
    recovering = true;
    document.documentElement.removeAttribute('data-embed-ready');
    if (status) {
      status.textContent = '正在返回实时监控…';
      status.hidden = false;
    }
    // SPA routers can change their internal view even when a History call is
    // ignored. Reload the permitted homepage rather than leave an empty view.
    nativeReplaceState(history.state, '', home.href);
    setTimeout(() => location.reload(), 0);
  };
  history.pushState = (data, unused, url) => {
    if (url != null && !isHome(url)) return restoreHome();
    return nativePushState(data, unused, url);
  };
  history.replaceState = (data, unused, url) => {
    if (url != null && !isHome(url)) return restoreHome();
    return nativeReplaceState(data, unused, url);
  };
  const navigationKind = element => {
    if (!element) return '';
    if (element === card) {
      return element.matches('a,button,[role="button"],[role="link"]') ? 'card' : '';
    }
    const labels = ['aria-label', 'title'].map(name => element.getAttribute(name) || '');
    labels.push(element.textContent || '');
    const title = labels.some(label => context.nodeName && label.replace(/[↗↪→➜›»]/g, '').trim() === context.nodeName);
    if (title) return 'title';
    if (element.matches('a[href],[role="link"]') ||
        ['href', 'to', 'data-href', 'data-to', 'formaction'].some(name => element.getAttribute(name))) return 'action';
    return labels.some(label => /详情|详细|翻页|历史曲线|查看(?:节点|服务器|历史)|进入(?:节点|服务器)|\b(?:details?|history|view (?:node|server)|open (?:node|server))\b|^[\s↗↪→➜›»]+$/i.test(label)) ? 'action' : '';
  };
  const markNavigation = () => {
    for (const element of [card, ...card.querySelectorAll('a[href],button,[role="button"],[role="link"]')]) {
      const kind = navigationKind(element);
      if (!kind) continue;
      element.setAttribute('data-embed-navigation', kind);
      element.setAttribute('tabindex', '-1');
      if (kind !== 'card') element.setAttribute('aria-disabled', 'true');
    }
  };
  const blockNavigation = event => {
    if (event.type === 'keydown' && !['Enter', ' ', 'Spacebar'].includes(event.key)) return;
    const control = event.target?.closest?.('a,button,[role="button"],[role="link"]');
    if (!control || !card?.contains(control) || !navigationKind(control)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  for (const type of ['click', 'auxclick', 'keydown']) document.addEventListener(type, blockNavigation, true);
  const findCard = () => {
    const visible = nodes => [...nodes].filter(node => node.getBoundingClientRect().width > 0);
    // Themes use anchors, articles, divs and table rows for the same node.
    // The API still scopes the data; these selectors only isolate its display.
    for (const selector of ['.server-card', '.srv-card', '.node-card', '[data-server-id]', '[data-node-id]', '[data-node-uuid]', '.server-item', '.node-item']) {
      const all = [...document.querySelectorAll(selector)];
      // A theme may replace the card after rendering. The path filter briefly
      // hides that new element until it receives the embed marker again.
      if (all.length === 1) return all[0];
      const candidates = visible(all);
      if (candidates.length === 1) return candidates[0];
    }
    if (context.nodeName) {
      const articles = [...document.querySelectorAll('article')].filter(node => node.textContent.includes(context.nodeName));
      if (articles.length === 1) return articles[0];
    }
    if (context.nodeId) {
      const link = [...document.querySelectorAll('a[href]')].find(node => {
        try {
          const url = new URL(node.getAttribute('href'), location.href);
          return url.origin === location.origin && `${url.pathname}${url.hash}`.includes(context.nodeId);
        } catch { return false; }
      });
      if (link) {
        const semantic = link.closest('.server-card,.node-card,article,li,tr,[data-server-id],[data-node-id]');
        if (semantic) return semantic;
        for (let node = link; node && node !== document.body; node = node.parentElement) {
          const text = node.textContent || '';
          if (/CPU/i.test(text) && /RAM|Memory|内存/i.test(text) && /Disk|磁盘/i.test(text)) return node;
        }
      }
    }
    const rows = visible(document.querySelectorAll('tbody > tr'));
    return rows.length === 1 ? rows[0] : null;
  };
  const style = document.createElement('style');
  style.textContent = `html,body{margin:0!important;background:transparent!important}
    html:not([data-embed-ready]) body>:not(#embed-status){visibility:hidden}
    #app,#root{padding:${cardInset}px!important;box-sizing:border-box}
    [data-embed-path]{display:block!important;min-height:0!important;height:auto!important;max-width:none!important;padding:0!important;margin:0!important;grid-template-columns:1fr!important;gap:0!important;border:0!important;border-radius:0!important;box-shadow:none!important;background:transparent!important}
    [data-embed-path]>:not([data-embed-path]):not([data-embed-card]):not(#embed-status){display:none!important}
    [data-embed-card]{width:100%!important;max-width:none!important;box-sizing:border-box!important;margin:0!important;visibility:visible;box-shadow:none!important}
    [data-embed-navigation="action"]{display:none!important}
    [data-embed-navigation="title"],[data-embed-navigation="card"]{cursor:default!important}
    [data-embed-navigation="title"] svg[aria-hidden="true"]{display:none!important}
    .server-card-detail-link{display:none!important}
    #embed-status{padding:16px;font:14px system-ui;color:#64748b}`;
  document.head.appendChild(style);
  const postHeight = () => {
    if (!card?.isConnected || !context.parentOrigin) return;
    parent.postMessage({ type: 'shellatlas:monitor-height', height: Math.ceil(card.getBoundingClientRect().height + cardInset * 2), serverId: context.serverId }, context.parentOrigin);
  };
  document.addEventListener('DOMContentLoaded', () => {
    status = document.createElement('div');
    status.id = 'embed-status';
    status.textContent = '正在加载探针…';
    document.body.appendChild(status);
    const resize = new ResizeObserver(postHeight);
    const adapt = () => {
      if (recovering) return;
      document.querySelectorAll('img[src],link[href],script[src]').forEach(mapAsset);
      const nextCard = findCard();
      if (!nextCard) {
        if (card && !card.isConnected) restoreHome();
        return;
      }
      if (document.documentElement.dataset.embedFailed) return;
      if (card !== nextCard) {
        document.querySelectorAll('[data-embed-card],[data-embed-path]').forEach(node => {
          node.removeAttribute('data-embed-card'); node.removeAttribute('data-embed-path');
        });
        nextCard.setAttribute('data-embed-card', '');
      }
      for (let node = nextCard.parentElement; node; node = node.parentElement) {
        if (!node.hasAttribute('data-embed-path')) node.setAttribute('data-embed-path', '');
        if (node === document.body) break;
      }
      if (card !== nextCard) { resize.disconnect(); card = nextCard; resize.observe(card); }
      markNavigation();
      document.documentElement.setAttribute('data-embed-ready', '');
      status.hidden = true;
      postHeight();
    };
    const observer = new MutationObserver(adapt);
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'href'] });
    addEventListener('pagehide', () => { observer.disconnect(); resize.disconnect(); }, { once: true });
    adapt();
    setTimeout(() => {
      if (!card) {
        const message = '探针暂时无法加载，请检查节点状态或主题兼容性后重试。';
        status.textContent = message;
        if (context.parentOrigin) parent.postMessage({ type: 'shellatlas:monitor-error', message, serverId: context.serverId }, context.parentOrigin);
      }
    }, 15000);
  });
  for (const type of ['hashchange', 'popstate']) addEventListener(type, () => { if (!isHome(location.href)) restoreHome(); });
  if (!isHome(location.href)) nativeReplaceState(null, '', home.href);
}
