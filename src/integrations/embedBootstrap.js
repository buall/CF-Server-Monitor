// Serialized into embed HTML before the untouched theme modules run.
export function embedBootstrap(context) {
  const base = context.base;
  const rootSelector = context.theme === 'builtin' ? '#app' : '#root';
  const cardSelector = context.theme === 'builtin' ? '.servers-grid > .server-card' : 'article.server-card';
  const cardInset = context.theme === 'junimo' ? 8 : 0;
  const nativeFetch = window.fetch.bind(window);
  const NativeWebSocket = window.WebSocket;
  const mapUrl = value => {
    const url = new URL(String(value), location.href);
    if (url.host === location.host && /^\/api\//.test(url.pathname)) {
      url.pathname = `${base}${url.pathname.slice(1)}`;
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
        url.pathname = `${base}${url.pathname.slice(1)}`;
        element.setAttribute(attribute, url.toString());
      }
    }
  };
  window.fetch = (input, init) => nativeFetch(
    input instanceof Request ? new Request(mapUrl(input.url), input) : mapUrl(input), init
  );
  window.WebSocket = class extends NativeWebSocket {
    constructor(url, protocols) {
      const mapped = mapUrl(url);
      if (protocols === undefined) super(mapped);
      else super(mapped, protocols);
    }
  };
  // Embed preferences are isolated in this iframe's storage facade. Existing
  // dashboard preferences and administrator credentials are not changed/read.
  const local = new Map([['monitor_preferred_view', 'bar']]);
  const session = new Map([
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
  const style = document.createElement('style');
  style.textContent = `html,body{margin:0!important;background:transparent!important}
    ${rootSelector}{visibility:hidden;padding:${cardInset}px!important;box-sizing:border-box}html[data-embed-ready] ${rootSelector}{visibility:visible}
    [data-embed-path]{display:block!important;min-height:0!important;height:auto!important;max-width:none!important;padding:0!important;margin:0!important;grid-template-columns:1fr!important;gap:0!important}
    [data-embed-path]>:not([data-embed-path]):not(.server-card){display:none!important}
    .server-card{width:100%!important;box-sizing:border-box!important;margin:0!important}
    .server-card-detail-link{display:none!important}
    #embed-status{padding:16px;font:14px system-ui;color:#64748b}`;
  document.head.appendChild(style);
  const postHeight = () => {
    const card = document.querySelector(cardSelector);
    if (!card || !context.parentOrigin) return;
    parent.postMessage({ type: 'shellatlas:monitor-height', height: Math.ceil(card.getBoundingClientRect().height + cardInset * 2), serverId: context.serverId }, context.parentOrigin);
  };
  document.addEventListener('DOMContentLoaded', () => {
    const root = document.querySelector(rootSelector);
    const status = document.createElement('div');
    status.id = 'embed-status';
    status.textContent = '正在加载探针…';
    document.body.appendChild(status);
    let card = null;
    const resize = new ResizeObserver(postHeight);
    const adapt = () => {
      document.querySelectorAll('img[src],link[href],script[src]').forEach(mapAsset);
      const cards = document.querySelectorAll(cardSelector);
      if (cards.length !== 1 || document.documentElement.dataset.embedFailed) return;
      for (let node = cards[0].parentElement; node && node !== document.body; node = node.parentElement) {
        if (!node.hasAttribute('data-embed-path')) node.setAttribute('data-embed-path', '');
      }
      if (card !== cards[0]) { resize.disconnect(); card = cards[0]; resize.observe(card); }
      document.documentElement.setAttribute('data-embed-ready', '');
      status.hidden = true;
      postHeight();
    };
    if (root) {
      const observer = new MutationObserver(adapt);
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'href'] });
      addEventListener('pagehide', () => { observer.disconnect(); resize.disconnect(); }, { once: true });
    }
    adapt();
    setTimeout(() => {
      if (!card) {
        const message = '探针暂时无法加载，请检查节点状态或主题兼容性后重试。';
        status.textContent = message;
        if (context.parentOrigin) parent.postMessage({ type: 'shellatlas:monitor-error', message, serverId: context.serverId }, context.parentOrigin);
      }
    }, 15000);
  });
  document.addEventListener('click', event => {
    if (event.target.closest('a')) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  addEventListener('hashchange', () => { if (location.hash !== '#/') location.replace(`${location.pathname}${location.search}#/`); });
  if (location.hash !== '#/') history.replaceState(null, '', `${location.pathname}${location.search}#/`);
}
