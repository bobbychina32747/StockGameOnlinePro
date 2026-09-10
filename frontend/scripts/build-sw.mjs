/**
 * build-sw.mjs —— F-3 构建期 precache manifest 收口（方案 A：build 后改写 sw.js 模板）
 *
 * 链路：public/sw.js（模板态）→ 扫 dist 真实产物 → 注入清单与内容哈希 → 写出 dist/sw.js（产物态）
 *
 * 零依赖红线（团队定稿 C13/C14）：只用 node:fs / node:path / node:crypto，禁止 workbox 等外部依赖。
 * 清单覆盖：`/`、`/index.html`、`/manifest.webmanifest`、`/icons/*.png`、`/assets/*.js`、`/assets/*.css`。
 *
 * 硬规则：
 *  - 单文件 > 2MB → **显式跳过并打日志**（禁止静默；若入口 chunk 被跳过，check-sw-manifest 的①会拦下构建）
 *  - 清单总字节 > 3MB → **直接失败（非零退出）**
 *  - 必须打印总字节数与最大单文件字节数
 *  - VERSION = `${pkg.version}-${sha256(清单文件内容).slice(0,8)}`：同内容同缓存名、改内容必换名，
 *    配合 sw.js 既有 activate 清理（caches.delete 非当前 CACHE）天然失效旧壳。
 *  - 占位块缺失即失败：防模板被改坏后静默产出「清单为空」的假壳。
 *
 * 用法：node scripts/build-sw.mjs（须在 vite build 之后；package.json 的 build 脚本已串好）
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // frontend/
const DIST = path.join(ROOT, 'dist');
const TEMPLATE = path.join(ROOT, 'public', 'sw.js');
const OUT = path.join(DIST, 'sw.js');

const MANIFEST_MARKER = '/* __PRECACHE_ASSETS__ */'; // 清单注入位（在 CORE_ASSETS 数组内）
const VERSION_MARKER = "'__SW_VERSION__'"; // VERSION 注入位
const MAX_SINGLE_FILE = 2 * 1024 * 1024; // 2MB：超限单文件跳过（显式日志，不静默）
const MAX_TOTAL = 3 * 1024 * 1024; // 3MB：清单总量上限，超限构建失败

const fail = (msg) => {
  console.error(`[build-sw] ERROR ${msg}`);
  process.exit(1);
};
const mb = (b) => `${(b / 1024 / 1024).toFixed(2)} MB`;

if (!existsSync(DIST)) fail(`dist/ 不存在，请先 vite build（期望路径：${DIST}）`);
if (!existsSync(TEMPLATE)) fail(`sw.js 模板不存在：${TEMPLATE}`);

// ── 1. 收集候选清单：固定壳入口 + dist 真实产物（目录扫描即 bundle 真源，等价 vite 插件方案）──
const candidates = ['/', '/index.html', '/manifest.webmanifest'];
const listDir = (sub, filter, label) => {
  const dir = path.join(DIST, sub);
  if (!existsSync(dir)) fail(`dist/${sub} 不存在（${label} 缺失）：构建产物不完整`);
  return readdirSync(dir).filter(filter).sort();
};
for (const f of listDir('icons', (f) => f.endsWith('.png'), '图标')) candidates.push(`/icons/${f}`);
for (const f of listDir('assets', (f) => /\.(js|css)$/.test(f), 'Vite hash 资产')) candidates.push(`/assets/${f}`);

// URL → dist 内真实文件：'/' 与 '/index.html' 是同一文件（目录索引）
const resolveFile = (url) => path.join(DIST, url === '/' ? 'index.html' : url.replace(/^\//, ''));

const items = []; // 入选清单项（URL）
const files = new Map(); // 去重后的真实文件：relPath → 绝对路径（字节统计与内容哈希都按文件算）
const skipped = []; // 被跳过的超限文件
let maxFile = { url: '(none)', bytes: 0 };

for (const url of candidates) {
  if (items.includes(url)) continue;
  const file = resolveFile(url);
  if (!existsSync(file)) {
    // 不静默：清单项指向不存在的产物说明构建产物不完整（check-sw-manifest 的②同款语义，前移到构建期）
    fail(`清单项 ${url} 在 dist 中不存在（${file}）`);
  }
  const size = statSync(file).size;
  if (size > MAX_SINGLE_FILE) {
    // 显式跳过并打日志：>2MB 单文件不塞进 install 的 addAll（否则首次安装/更新代价过大）
    skipped.push({ url, size });
    console.warn(`[build-sw] SKIP 单文件超 ${mb(MAX_SINGLE_FILE)}：${url}（${size} B / ${mb(size)}）`);
    continue;
  }
  items.push(url);
  files.set(url === '/' ? 'index.html' : url.replace(/^\//, ''), file);
  if (size > maxFile.bytes) maxFile = { url, bytes: size };
}

// ── 2. 字节核算与门禁 ──
let totalBytes = 0;
for (const [, file] of files) totalBytes += statSync(file).size;

console.log(`[build-sw] 清单文件数 ${items.length}（去重后真实文件 ${files.size} 个，跳过超限 ${skipped.length} 个）`);
console.log(`[build-sw] 清单总字节 ${totalBytes} B（${mb(totalBytes)}）`);
console.log(`[build-sw] 最大单文件 ${maxFile.bytes} B（${mb(maxFile.bytes)}）→ ${maxFile.url}`);

if (totalBytes > MAX_TOTAL) {
  fail(`清单总字节 ${totalBytes} B 超过上限 ${MAX_TOTAL} B（${mb(MAX_TOTAL)}）—— 请检查是否误纳入非壳资源（如 sourcemap / 媒体文件）`);
}

// ── 3. 内容哈希 → VERSION（清单文件内容决定缓存名：改内容必换缓存名，activate 清理旧壳）──
const hash = createHash('sha256');
for (const rel of [...files.keys()].sort()) {
  hash.update(rel).update('\0').update(readFileSync(files.get(rel)));
}
const contentHash = hash.digest('hex').slice(0, 8);
const pkgVersion = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const version = `${pkgVersion}-${contentHash}`;

// ── 4. 注入模板 → dist/sw.js（占位块计数必须精确为 1，防模板漂移导致注入到注释里）──
const template = readFileSync(TEMPLATE, 'utf8');
const countOf = (hay, needle) => hay.split(needle).length - 1;
if (countOf(template, MANIFEST_MARKER) !== 1) fail(`模板 ${TEMPLATE} 中清单占位 ${MANIFEST_MARKER} 出现 ${countOf(template, MANIFEST_MARKER)} 次（要求恰好 1 次）`);
if (countOf(template, VERSION_MARKER) !== 1) fail(`模板中 VERSION 占位 ${VERSION_MARKER} 出现 ${countOf(template, VERSION_MARKER)} 次（要求恰好 1 次）`);

// 只注入模板未覆盖的项（'/'、'/index.html' 等已在模板里，避免重复项）；
// 第一行沿用占位块自身的缩进，后续行补同款两空格缩进（保持产物源码可读）
const injected = items.filter((u) => !template.includes(`'${u}'`));
const injectedBlock = injected.map((u) => `'${u}',`).join('\n  ');
const out = template.replace(MANIFEST_MARKER, injectedBlock).replace(VERSION_MARKER, `'${version}'`);

writeFileSync(OUT, out, 'utf8'); // UTF-8 无 BOM
console.log(`[build-sw] VERSION = ${version}（新增注入 ${injected.length} 项）`);
console.log(`[build-sw] 已写出 ${OUT}`);
