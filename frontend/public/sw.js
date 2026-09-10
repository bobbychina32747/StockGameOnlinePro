/* StockSim Pro Service Worker（手写原生，无插件 · 零外部依赖）
 *
 * 缓存策略总览：
 *  1) CORE_ASSETS 预缓存（install 时 addAll）：离线壳固定清单 + **构建期注入的 hash 产物清单**
 *  2) 同源 GET 静态资源（/assets/* 等 Vite hash 产物 + /icons/*）：stale-while-revalidate
 *     —— 先回缓存即时渲染，同时后台请求网络更新缓存；离线则用缓存兜底
 *  3) 导航请求：network-first，离线回退预缓存 '/index.html'（React Router 接管前端路由）
 *  4) /api 与 /socket.io：一律不缓存、纯直连（return 不 respondWith，浏览器原生网络行为）
 *
 * 升级规则：改 VERSION → 新 install 装新壳 → activate 清理旧版本缓存。
 * hash 资产与旧壳：发版后导航走网络优先，保证壳/入口恒新。
 *
 * ⚠ 本文件是**构建期模板**（双态）：
 *   - public/sw.js（本文件）= 模板态：只含 5 项固定离线壳 + 两个注入占位块；
 *   - dist/sw.js = 产物态：`vite build` 之后由 scripts/build-sw.mjs 扫描 dist 真实产物，
 *     把下方清单占位块替换成 hash 资产清单（/assets/*.js|css、/icons/*.png），
 *     并把 VERSION 占位替换成 `${pkg.version}-${sha256(清单文件内容).slice(0,8)}`；
 *   - scripts/check-sw-manifest.mjs 与 src/pwa/precache-manifest.test.ts 对 dist/sw.js 做双向差集门禁。
 *   （F-3 团队定稿 C13/C14：方案 A 构建后改写模板；零依赖红线，只用 Node 内置模块。）
 * 改本文件后必须重跑 `npm run build`，占位块缺失会让 build 直接失败（防静默降级）。
 */
const VERSION = '__SW_VERSION__';
const CACHE = `stocksim-pro-${VERSION}`;
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  // ↓ 构建期注入位（build-sw.mjs 在此追加 dist 真实 hash 产物，勿手改）
  /* __PRECACHE_ASSETS__ */
];
const NEVER_CACHE_PREFIXES = ['/api', '/socket.io'];

// ── 安装：预缓存离线壳；addAll 中任一失败则本次 install 失败（自动重试于下次访问），不拖垮运行中的旧 SW ──
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting()), // 跳过 waiting，新版立即接管（下次加载即为新壳）
  );
});

// ── 激活：删除非当前版本的旧缓存；claim 让当前已开页面立刻受控 ──
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// ── 请求分发 ──
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 只处理同源 GET（跨源字体/CDN/后端直连一律放行，不 respondWith）
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // /api 与 /socket.io 纯直连：不缓存、不离线兜底（行情陈旧=误导决策，且不掩盖断线状态）
  if (NEVER_CACHE_PREFIXES.some((p) => url.pathname.startsWith(p))) return;

  if (req.mode === 'navigate') {
    // 导航 network-first：在线恒取最新 index.html（入口引用最新 hash 资产），离线回退预缓存壳
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match('/index.html')),
    );
    return;
  }

  // 静态资源 stale-while-revalidate
  event.respondWith(
    caches.match(req).then((cached) => {
      const refreshed = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached); // 网络失败：回退已有缓存（无缓存则 undefined → 交给浏览器报错）
      return cached || refreshed;
    }),
  );
});
