# Phase D-02：PWA 离线支持方案（StockSim Pro 前端）

- 状态：方案（未改码）
- 范围：`frontend/` 仅前端；后端零改动
- 实现耗时预估：30–45 分钟
- 关键裁定：任务书原话「NetworkFirst 对 /api 不缓存」存在歧义。仓库内未检索到 Phase D 任务书原文（全库 grep `NetworkFirst|/api|PWA|离线` 仅命中 `README.md:220`「移动端 PWA 打包（离线可用、添加到主屏）」checkbox 与 CHANGELOG），故按**最安全解释**执行：**`/api` 与 `/socket.io` 一律不缓存、纯直连**（见 §5.2 权衡）。

---

## 0. 现状实读依据（方案全部结论的来源）

| 事实 | 依据 |
|---|---|
| 前端技术栈 React 18 + Vite 5 + TS；build=`tsc -b && vite build` | `frontend/package.json:7-10`；devDeps 有 jest 29 / jest-environment-jsdom / babel-jest（:26-47） |
| 默认深色主题：品牌主色 `#2f6fed`（--color-brand），页面背景 `#0e1013`（--bg-primary），顶栏渐变约 `rgba(20,21,30,0.95)` | `frontend/src/styles/global.css:7`、`:12`、`:141`；浅色主题为 `body.theme-light` 可切换（:1167） |
| `main.tsx` 仅 13 行：createRoot + StrictMode + BrowserRouter + App，无任何副作用注册代码，适合模块顶层插入 SW 注册 | `frontend/src/main.tsx:1-13` |
| `index.html` 13 行：有 `<link rel="icon" href="/vite.svg">`（:7），无 manifest link / theme-color / apple-touch-icon | `frontend/index.html:1-13` |
| 前端 API 走**同源相对路径** `API_BASE = '/api'`（axios），token 在 localStorage | `frontend/src/services/api.client.ts:3`、`:12-18` |
| WebSocket 走同源 `/market` namespace（`io('/market')`），transports 仅 websocket，断线无限重连 | `frontend/src/services/ws.client.ts:10-17` |
| Vite dev 代理 `/api`、`/socket.io`（含 ws）→ localhost:8000；build 无 base（默认 `/`）、无 sourcemap、echarts 手动分包 → **产物文件名带 hash** | `frontend/vite.config.ts:12-24`、`:25-36` |
| 生产部署 nginx：同源 serve `dist`（root /usr/share/nginx/html），`/api/`、`/socket.io/` 反代后端，SPA `try_files` 回退 /index.html；**仅 HTTP:80** | `infra/nginx/sites/default.conf:1-47` |
| 可复用图标：`public/` 仅有 `vite.svg`（深底 `#1e222d` + 蓝「S」，SVG 非 PNG）；`src/` 无 assets 目录 → **无现成 192/512 PNG 可复用**，按任务清单走脚本生成 | `frontend/public/vite.svg:1-4`；目录实测 |
| jest 配置：`testEnvironment: 'jsdom'`（全局）、`roots: ['<rootDir>/src']`、`testMatch: **/*.test.ts(x)`、babel-jest 转译、setup 挂 RTL；测试风格为 `describe/it/expect` 中文用例 | `frontend/jest.config.cjs:8-20`；`frontend/src/utils/adjust.test.ts:9-15` |
| tsconfig strict 全家桶（noUnusedLocals/Parameters），include 仅 `src`，`import.meta.env` 需 `vite/client` 类型（现有先例 `ws.client.ts:1` triple-slash） | `frontend/tsconfig.json:15-17`、`:23`；`frontend/src/services/ws.client.ts:1` |
| CI 前端顺序：npm ci → eslint → tsc → jest → vite build → **jest 跑在 build 之前，测试不得依赖 dist 产物** | `CHANGELOG.md:168` |

---

## 1. 改动清单

| # | 文件 | 动作 | 内容 |
|---|---|---|---|
| 1 | `frontend/public/manifest.webmanifest` | 新增 | PWA manifest 全文（§2） |
| 2 | `frontend/public/sw.js` | 新增 | 手写原生 Service Worker（§3） |
| 3 | `frontend/index.html` | 修改 | +4 行：manifest link / theme-color / apple-touch-icon（§4） |
| 4 | `frontend/src/main.tsx` | 修改 | +6 行：仅生产注册 SW（§5） |
| 5 | `frontend/public/icons/icon-192.png` / `icon-512.png` / `apple-touch-icon.png` | 新增 | 脚本生成产物（§6） |
| 6 | `scripts/gen-icons.mjs` | 新增 | Node 内置 zlib 手写 PNG 编码器（§6） |
| 7 | `frontend/src/pwa/offline-assets.test.ts` | 新增 | phase10 前端静态断言测试（§7） |

Vite 会把 `public/` 原样拷到 `dist/` 根，故 manifest/SW/icons 均以 `/` 开头路径可达；`index.html` 无 `<base>`，绝对路径安全。

---

## 2. `frontend/public/manifest.webmanifest`（全文）

```json
{
  "name": "StockSim Pro",
  "short_name": "StockSim",
  "description": "专业炒股模拟交易平台",
  "lang": "zh-CN",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#0e1013",
  "theme_color": "#0e1013",
  "icons": [
    {
      "src": "/icons/icon-192.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "/icons/icon-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any"
    }
  ]
}
```

色值依据与说明：

- `theme_color` / `background_color` 取 **`#0e1013`**：与默认深色主题 `--bg-primary` 完全同值（`global.css:12`），启动闪屏 → 首屏背景无缝；顶栏本体是更浅的 `rgba(20,21,30,…)` 毛玻璃（`global.css:141`），深一档底色更贴近窗口化外观。备选品牌方案是 `#2f6fed`（`global.css:7`，Android 任务栏更醒目），但会与启动闪屏背景产生跳色，故主推 `#0e1013`。
- `short_name` 取 "StockSim"（主屏标题 12 字符内不截断）。
- `icons` 不用 `maskable` purpose：自绘为满幅圆角方图，未预留 20% 安全区，声明 maskable 会被部分启动器裁切。
- 桌面 Chrome「添加到主屏」现使用 `sizes: "192x192"` 图标 + `sizes: "any"`；iOS 见 §4 apple-touch-icon（180px 固定尺寸）。

---

## 3. `frontend/public/sw.js`（全文草案）

手写原生 SW，无构建插件、无 `importScripts`（不引 workbox）。注意：`public/` 下的文件会被 Vite 原样拷贝、**不做任何打包/变量替换**，因此版本号只能是文件内常量——升级流程 = 改常量 + 重新部署。

```js
/* StockSim Pro Service Worker（手写原生，无插件）
 *
 * 缓存策略总览：
 *  1) CORE_ASSETS 预缓存（install 时 addAll）：离线壳固定清单
 *  2) 同源 GET 静态资源（/assets/* 等 Vite hash 产物 + /icons/*）：stale-while-revalidate
 *     —— 先回缓存即时渲染，同时后台请求网络更新缓存；离线则用缓存兜底
 *  3) 导航请求：network-first，离线回退预缓存 '/index.html'（React Router 接管前端路由）
 *  4) /api 与 /socket.io：一律不缓存、纯直连（return 不 respondWith，浏览器原生网络行为）
 *
 * 升级规则：改 VERSION → 新 install 装新壳 → activate 清理旧版本缓存。
 * hash 资产与旧壳：发版后导航走网络优先，保证壳/入口恒新；静态资源按 §8.1 边界兜底。
 */
const VERSION = '1.0.0';
const CACHE = `stocksim-pro-${VERSION}`;
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
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
  // /api 与 /socket.io 纯直连：不缓存、不离线兜底（理由见方案 §8.1）
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
```

设计要点：

- **单一版本化缓存名**（`CACHE`）而非「壳缓存 + 运行时缓存」分离：activate 清旧只需一次遍历，无跨缓存一致性负担（运行时入缓存路径与 addAll 同桶，天然共享激活清理）。
- **skipWaiting + claim**：发版后首个在线访问即装新壳并清理旧缓存，避免「旧壳驻留 + 新缓存文件」长期并存（§9 风险一的对策）。claim 只影响控制权，不重载已渲染页面，业务无感知。
- **导航单独走 network-first** 而不是也走 SWR：`/` 与 `/index.html` 虽已预缓存，但发版后 HTML 内的 `<script src="/assets/index-xxxx.js">` 会指向新 hash——若导航命中旧缓存 HTML，会加载「可能尚未缓存」的新资产，离线时半白屏。网络优先保证在线时入口永远是最新版。
- **`NEVER_CACHE_PREFIXES` 用常量数组**：§7 测试即断言该常量与两个前缀字面量，作为「/api 不缓存」的防回归锚点。

---

## 4. `frontend/index.html` 修改（+4 行）

`index.html:7` 的 icon 行之后插入：

```html
<link rel="manifest" href="/manifest.webmanifest" />
<meta name="theme-color" content="#0e1013" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
```

- iOS 忽略 manifest 的 display/theme，靠 `apple-mobile-web-app-capable`（全屏）+ `apple-touch-icon`（180px，`<head>` 中不带 sizes 时 iOS 自动取 180 或按需缩放）进入主屏体验。
- 修改后 head 仍无外部 CSS/字体，无渲染阻塞增量。

---

## 5. `frontend/src/main.tsx` 注册片段（+6 行）

在 import 区（`main.tsx:5` 的 CSS import 之后）与 `createRoot`（:7）之间插入：

```ts
/// <reference types="vite/client" />
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles/global.css';

// ── PWA：仅生产构建注册 SW；dev（vite dev server）PROD=false 恒不注册，零影响 ──
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* 静默：非 localhost 的 http 环境（生产仅 http:80，见 §9 风险三）注册失败不影响应用 */
    });
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  ...
);
```

- 结构依据：`main.tsx` 无 useEffect/组件边界（13 行纯入口），模块顶层副作用是既有风格内最简落点；`load` 后注册避免与首屏 JS 分块加载抢带宽。
- `import.meta.env` 需 `vite/client` 类型声明——沿用仓库先例在文件顶加 triple-slash reference（同 `ws.client.ts:1` 写法），否则 `tsc -b` 在 `strict`（`tsconfig.json:14`）下报 TS2739/2339。
- `'serviceWorker' in navigator` 双保险（非安全上下文 `navigator.serviceWorker` 为 undefined）：HTTP 非 localhost 环境注册抛错被 catch 吞掉，dev 模式 PROD=false 直接短路——两路都不会在控制台制造噪音。

---

## 6. 图标生成方案（`scripts/gen-icons.mjs`）

**复用裁定**：`public/vite.svg` 是 SVG 且为 32px 演示图标，不能作为 manifest PNG；仓库无图片处理依赖（package.json 无 sharp/canvas），因此按任务书自研生成器，**零依赖**：Node 内置 `node:zlib` 手写 PNG。

### 6.1 图形设计（与主题一致）

- 底：`#16181e → #0e1013` 对角渐变圆角方块（圆角 ≈ 22% 边长），呼应深色主题卡片 `--bg-card #21242b → --bg-primary`（`global.css:13/:12`）。
- 前景：白色 `#e6e8eb`（`--text-primary`，global.css:19）折线「上升箭头」——两段上升折线 + 上箭头，是行情图的通用隐喻；任务书点名「白色折线上升箭头」。
- 绘制精度：每像素 4×4 超采样（每个采样点做几何含判断后平均），输出抗锯齿边缘。

### 6.2 PNG 编码核心（零依赖要点）

```js
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

// CRC32（PNG chunk 校验；标准查表法）
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
// chunk = 长度(4BE) + 类型(4) + 数据 + CRC32(类型+数据)
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
// 每行：1 字节 filter=0（None）+ width*4 字节 RGBA → deflateSync（zlib 默认）
// IHDR：width(4BE) height(4BE) bitDepth=8 colorType=6(RGBA) compression=0 filter=0 interlace=0
```

文件骨架：`signature(8B: 89 50 4E 47 0D 0A 1A 0A)` + `IHDR(13B)` + `IDAT(deflateSync(raw))` + `IEND(空)`。尺寸 192 / 512 / 180（apple-touch-icon 按 Apple 规格 180×180）分别走一遍同一光栅化函数。

### 6.3 光栅化器骨架（绘制几何判定）

```js
// 单位空间 [0,1]² 内判定：圆角方块底 + 白色上升折线；返回 [r,g,b,a]
function sample(ux, uy, S) {
  const inset = 0.05;                       // 折线不贴边
  const dx = S * (ux - 0.5), dy = S * (uy - 0.5), r = S * 0.5 * 0.78; // 圆角（取 22% 内切）
  if (!(Math.abs(dx) <= r && Math.abs(dy) <= r ||
        Math.hypot(Math.abs(dx) - r, Math.abs(dy) - r) <= S * 0.22)) return [0, 0, 0, 0]; // 圆角外透明
  // 底色：对角渐变 #16181e → #0e1013
  const t = (ux + uy) / 2;
  const bg = [lerp(0x16, 0x0e, t), lerp(0x18, 0x10, t), lerp(0x1e, 0x13, t), 255];
  const segs = [                                    // 折线段：底左 → 中 → 右上顶
    [[0.18, 0.62], [0.44, 0.40]],
    [[0.44, 0.40], [0.62, 0.52]],                   // 第二段稍回落后再上冲（行情形态）
    [[0.62, 0.52], [0.80, 0.28]],
  ];
  const lw = 0.055 * 1.5;                           // 笔画半宽（超采样下近似抗锯齿）
  for (const [[x1, y1], [x2, y2]] of segs)
    if (distToSegment(ux, uy, x1, y1, x2, y2) < lw) return [0xe6, 0xe8, 0xeb, 255]; // --text-primary
  return bg;
}
// 渲染：for y,x → 4x4 均匀子采样 sample() 平均 → alpha 预乘无关（PNG 直存 RGBA）→ 行缓冲
```

`distToSegment` 为标准点到线段距离；输出每像素 4×4 采样均值可得到平滑斜线。

### 6.4 运行与产物校验

- 命令：`node scripts/gen-icons.mjs`（脚本自建 `frontend/public/icons/`），产物三文件合计 < 20KB。
- 自校验：脚本结尾用同一 chunk 解析读回 IHDR 尺寸断言 192/512/180，防手误。
- 产物**提交入库**（生成器为一次性/复跑工具，CI 无需执行）；§7 测试会从磁盘校验 PNG 魔数与 IHDR 尺寸，双保险。
- 不引入新 npm 依赖、不改 package.json scripts（可加 `"icons": "node scripts/gen-icons.mjs"` 作为可选便利，非必需）。

---

## 7. phase10 前端测试设计

### 7.1 位置与配置裁定

新测试放 **`frontend/src/pwa/offline-assets.test.ts`**，理由：

- `jest.config.cjs:9` `roots` 仅 `<rootDir>/src`，文件放 src 内即自动纳入 `npm test` 与 CI（`CHANGELOG.md:168` jest 步骤），无需改 jest 配置——**全局 jsdom 环境（`jest.config.cjs:8`）对纯 `fs` 字符串断言无副作用**，不需要按文件覆盖 testEnvironment。
- tsconfig include 仅 `src`（`tsconfig.json:23`），文件在 src 内才会被 `tsc -b` 检查（CI tsc 先于 jest）；`@types/node` 已在 devDeps（`package.json:33`），`fs/path` 直用。注意 strict（noUnusedLocals 等，`tsconfig.json:15-17`）：测试内不留未用变量。
- 风格对齐：`describe('…', () => { it('中文用例', …) })`，同 `adjust.test.ts:9-15`。
- **CI 顺序 jest 在 vite build 之前（`CHANGELOG.md:168`）→ 全部断言针对源文件（`public/`、`index.html`、`src/main.tsx`），绝不读 `dist/`**。静态字符串断言不需要 mock 浏览器。

路径基准：测试位于 `src/pwa/`，`const ROOT = path.resolve(__dirname, '..', '..')`（= frontend/），随后 `public/manifest.webmanifest`、`../main.tsx`、`index.html` 等皆以其为锚。文案断言全部锚定「语义常量/字面量」，避免脆断。

### 7.2 用例清单

```ts
// frontend/src/pwa/offline-assets.test.ts
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

describe('PWA manifest（public/manifest.webmanifest）', () => {
  const manifest = JSON.parse(read('public/manifest.webmanifest'));
  it('可 JSON.parse 且核心字段齐全', () => {
    expect(manifest.name).toBe('StockSim Pro');
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
  it('icons 为 192/512 的真实 PNG 声明', () => {
    const sizes = (manifest.icons as { sizes: string; type: string }[]).map((i) => i.sizes);
    expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
    for (const icon of manifest.icons) expect(icon.type).toBe('image/png');
  });
});

describe('Service Worker（public/sw.js）', () => {
  const sw = read('public/sw.js');
  it('/api、/socket.io 不缓存守卫存在（最安全解释）', () => {
    expect(sw).toContain("'/api'");
    expect(sw).toContain("'/socket.io'");
    expect(sw).toContain('NEVER_CACHE_PREFIXES');   // 语义常量锚点，防止守卫被拆散
  });
  it('预缓存离线壳清单完整', () => {
    for (const p of ["'/'", "'/index.html'", "'/manifest.webmanifest'",
                     "'/icons/icon-192.png'", "'/icons/icon-512.png'"])
      expect(sw).toContain(p);
  });
  it('含版本化缓存名与 activate 清理逻辑', () => {
    expect(sw).toContain('VERSION');
    expect(sw).toContain('caches.delete');
    expect(sw).toMatch(/activate/);
  });
  it('非 GET / 跨源直接放行', () => {
    expect(sw).toContain("req.method !== 'GET'");
    expect(sw).toContain("url.origin !== self.location.origin");
  });
});

describe('index.html 挂载', () => {
  const html = read('index.html');
  it('含 manifest link / theme-color / apple-touch-icon', () => {
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('href="/manifest.webmanifest"');
    expect(html).toContain('name="theme-color"');
    expect(html).toContain('apple-touch-icon');
  });
});

describe('main.tsx 仅生产注册', () => {
  const main = read('src/main.tsx');
  it('PROD 守卫 + navigator 探测 + /sw.js 注册点', () => {
    expect(main).toContain('import.meta.env.PROD');
    expect(main).toContain("'serviceWorker' in navigator");
    expect(main).toContain("register('/sw.js')");
  });
});

describe('图标产物为真实 PNG 且尺寸正确', () => {
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrSize = (p: string) => {
    const b = readFileSync(path.join(ROOT, p));
    expect(b.subarray(0, 8)).toEqual(PNG_MAGIC);            // 魔数校验
    return b.readUInt32BE(16);                              // IHDR width（height 紧随）
  };
  it.each([
    ['public/icons/icon-192.png', 192],
    ['public/icons/icon-512.png', 512],
    ['public/icons/apple-touch-icon.png', 180],
  ])('%s 是 %i×%i PNG', (p, s) => {
    const b = readFileSync(path.join(ROOT, p));
    expect(ihdrSize(p)).toBe(s);
    expect(b.readUInt32BE(20)).toBe(s);                     // height
  });
});
```

新增后 jest 用例数 41 → 47；`npm test` 与 CI jest 步骤自动覆盖，dev 无感知。

---

## 8. 取舍说明

### 8.1 /api 与 /socket.io 为什么不缓存（含歧义裁定）

任务书原话「NetworkFirst 对 /api 不缓存」在语义上自相矛盾（NetworkFirst 的默认实现必然含「离线回退缓存」，若完全不缓存则退化为纯 fetch 直连），仓库内亦无任务书原文可考证（§0 检索记录）。按**最安全解释**执行：**`/api`、`/socket.io` 一律不缓存、纯直连**（SW fetch 直接 return，不 respondWith）。理由与本项目业务事实吻合：

1. **数据强时效 + 陈旧即误导**：报价/账户/持仓是玩家的决策与资金依据；模拟炒股 UI 上，离线回退的陈旧行情会被误读为实时价（尤其 `/market/prices`、`/market/orderbook`，`api.client.ts:88-101`）。
2. **缓存会掩盖「假在线」**：若 /api 离线可命中缓存，而 socket.io 行情流必然断线（`ws.client.ts:10-17`），界面将出现「页面像活着、行情像死了」的割裂态，比明确的网络错误更难排查。
3. **鉴权副作用面**：/api 混有大量 POST/交易写操作（`api.client.ts:49-121`），任何对 GET 的缓存豁免都无法对写请求脱敏，规则复杂化不值当；axios 层 401 全局登出（`api.client.ts:27-38`）若命中断线前的缓存响应还会绕过应有的登出路径。
4. **业务价值低**：断网时本产品不可交易（所有交易动作走 /api POST），SW 的离线价值在「壳 + 静态资源」，不在数据接口；离线兜底交给 HTTP 层以外的应用状态即可。

而「NetworkFirst + 仅缓存 GET + 短 TTL」的中间态方案被否：本任务为离线壳/静态资源加速，非数据层改造；引入 TTL 后同源 GET 的 SW 缓存与 axios 现有错误路径（15s 超时 `api.client.ts:7`）交互未知，超出 Phase D 范围。此为显式取舍，可作后续 Phase 议题（数据层 PWA 化需配 IndexedDB 快照 + 断线横幅 UX）。

### 8.2 预缓存边界与「首次访问后离线可用」折衷

- **问题**：Vite build 产物 hash 寻址（`vite.config.ts:25-36`，如 `/assets/index-<hash>.js`），`CORE_ASSETS` 无法静态穷举；若在 build 时动态生成 SW（workbox 式），需引入构建插件/双阶段产物重写——任务书明确手写 SW、不引插件。
- **折衷**：预缓存只装固定离线壳（5 项），**运行时缓存兜底全部同源静态资源**：用户在线正常使用过一轮（进入主界面、切过页），所有用到的 hash chunk/图/字体已入缓存，此后断网重载即可完整离线打开壳与已访问过的路由视图。
- **升级边界**（发版后离线）：导航 network-first 保证在线时入口恒新；离线时若缓存中是最新版入口但新 hash 资产尚未被访问缓存过 → 该次离线缺新资产，刷新回退旧缓存资产？不会——hash 资产名随内容变，旧资产仍在缓存且仍可被旧 index.html 引用，但新 index.html 引新资产 → miss → 局部白屏风险。缓解（按序）：① 激活时机在用户在线时，新壳 addAll 只装壳不装 asset；② 实际影响面 = 「发版后、用户尚未再访问、恰逢离线重载」的用户，属小概率瞬时窗口；③ 完整解法（build 时注入 precache-manifest）留待后续 Phase（P2 债，需引 workbox-build 或自写 vite 插件，超出「手写 SW」约束）。方案内已把窗口缩到最小：SWR 让用户每次在线浏览都持续补全缓存。

### 8.3 静态资源为何选 stale-while-revalidate 而非 cache-first

hash 资产内容不可变，cache-first 其实足够且省一次网络往返；但 index.html 引用的入口 chunk 变化时 SWR 能保证「常用资产持续保持最新可离线」，且对无 hash 的常规资源（如以后新增的非 hash 静态文件）语义正确。成本仅一次后台网络，收益覆盖 8.2 的边界窗口，选 SWR。

---

## 9. 风险与回归点

| # | 风险 | 分析 | 对策 |
|---|---|---|---|
| 1 | **SW 更新导致旧壳缓存滞留**：旧壳引用旧 hash asset，与新缓存交错 | SW 默认 waiting 态会让新旧壳长期并存，activate 若不清理会无限累积 | 版本化单缓存名 + activate 遍历删除非当前版本（sw.js `CACHE`/`keys().filter`）+ skipWaiting 立即接管；升级流程唯一动作 = 改 `VERSION` 常量重新部署 |
| 2 | **dev 影响为零** | dev server（vite.config.ts:12 端口 3000）下 `import.meta.env.PROD === false` 注册代码短路；且 dev 3000 与生产 nginx 80/将来 https 443 不同源，缓存互不污染 | main.tsx PROD 守卫（§5）；无需在 dev 做任何 SW 处理 |
| 3 | **生产仅 http:80，SW 注册受限** | `nginx/sites/default.conf:1` listen 80；SW 仅在 secure context 可用：localhost 例外，非 localhost 的 http（如内网 IP、域名裸 http）注册抛错 | 注册 catch 静默（§5）；方案文档明示：PWA 完整生效需 nginx 上 TLS（后续配套项，Phase D 不阻塞——开发/验收走 localhost 即可触发 SW） |
| 4 | **Vite 对 public/ 的处理** | `public/` 文件原样拷入 dist 根（manifest、sw.js、icons 均以 `/` 可达）；dev 下同样以 `/sw.js` 提供，但无注册即无干扰；若未来给 index.html 加 `<base>` 或 build.base 非 `/`，所有绝对路径会失效 | 现状 base 未配置（vite.config.ts 无 base 字段 = `/`），风险仅在未来改造时出现；测试锚定字符串路径，base 变更会直接红测 |
| 5 | **导航离线回退串页**：离线时任意前端路由（如 /ranking）回退 '/index.html' 壳 | 属预期行为：React Router 前端路由在壳内按 location 渲染对应页面；若该页依赖未缓存数据则展示现有加载/错误态（axios 15s 超时 `api.client.ts:7` 与 store 错误处理既有），不白屏 | 无 SW 改动；验收清单含离线冒烟 |
| 6 | **socket.io 离线行为**：`transports: ['websocket']` + 无限重连（`ws.client.ts:11-15`）断网时持续重试 | 与 SW 无关的既有行为；SW 不缓存 /socket.io 后离线时握手直连失败 → 走既有 connect_error 处理（`ws.client.ts:28-35`） | 无需改动；风险登记仅为回归提示——不得为「省重连」把 socket.io 纳入 SW 缓存（轮询帧是 POST/GET 混合且带 session 状态，缓存必然错乱） |
| 7 | **jest 断言与 CI 顺序**：测试读源文件、不读 dist；tsc strict 检查新测试文件 | `CHANGELOG.md:168` CI = tsc → jest → build；新测试必须在 tsc 严格模式（`tsconfig.json:14-17`）下编译通过 | 测试只用 fs/path（`@types/node` 已在 devDeps `package.json:33`）；文案断言避免锚定注释与排版空白 |
| 8 | **SW 一旦部署难以撤回**：老客户端可能长驻旧 SW（若未来关闭 PWA，需再发一版清缓存 SW 或用 max-age 强制更新） | 属 PWA 平台固有生命周期 | 本方案版本号常量 + activate 清理即更新通道；关闭 PWA 属反向决策，风险登记不处理 |

### 9.1 验收清单（实现后人工冒烟，不改码）

1. `npm run build`（frontend/）成功；确认 `dist/` 含 manifest.webmanifest / sw.js / icons/ 三件。
2. `npm test` 全绿（41 → 47 例）。
3. `vite preview`（或 nginx）于 localhost 打开 → DevTools → Application → Service Workers 显示已注册（production 分支才注册，preview 走生产模式判断成立）；Manifest 面板无校验警告。
4. DevTools Network 勾 Offline → 刷新：壳渲染（断网横幅/加载失败属既有错误态），离线重载第二次亦稳定；切已访问过的路由不白屏。
5. Lighthouse PWA 单项（installable）≥ 90 分为参考，不作为门禁。

---

## 10. 遗留项（P2 债登记，不阻塞本方案）

- 构建期动态 precache-manifest（消除 §8.2 升级边界窗口）：需 workbox-build 或自写 vite 插件，与「手写 SW」约束冲突，后续 Phase 单独立项。
- nginx TLS：PWA 在非 localhost http 环境不可用（§9 风险三），TLS 上线后可全网络生效。
- 数据层离线（IndexedDB 行情快照 + 断线横幅）：见 §8.1 第 4 点，属数据层 PWA 化，非本任务。
