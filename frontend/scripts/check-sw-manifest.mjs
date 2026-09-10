/**
 * check-sw-manifest.mjs —— F-3 构建门禁：dist/sw.js 预缓存清单与 dist 真实产物**双向差集**校验
 *
 * 校验项（任一失败 → 打印原因并非零退出，串进 npm run build 即构建失败）：
 *  ① 正向：dist/index.html 引用的每个 /assets/* 必须在 dist/sw.js 清单内（否则发版后离线 = 壳在、入口缺 → 半白屏）
 *  ② 反向：清单每一项必须在 dist 中存在（existsSync，防清单残留已删除的旧 hash 文件）
 *  ③ 红线：清单不得包含任何 /api/ 路径（行情/交易接口离线缓存 = 陈旧数据误导决策）
 *  ④ 附加：VERSION 必须含 8 位内容哈希（C14：内容变则缓存名变，保证 activate 清理旧壳）
 *
 * 零依赖：只用 node:fs / node:path。用法：node scripts/check-sw-manifest.mjs（在 build-sw.mjs 之后）
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // frontend/
const DIST = path.join(ROOT, 'dist');
const SW = path.join(DIST, 'sw.js');
const INDEX = path.join(DIST, 'index.html');
const MAX_TOTAL = 3 * 1024 * 1024; // 与 build-sw.mjs 同口径

const errors = [];
const fail = (msg) => errors.push(msg);

// ── 解析：与 src/pwa/precache-manifest.test.ts 同一约定（CORE_ASSETS 数组内的单引号字符串）──
const extractManifest = (swSource) => {
  const m = /const CORE_ASSETS = \[([\s\S]*?)\];/.exec(swSource);
  if (!m) return null;
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
};
// index.html 里的资源引用（Vite base='/' → /assets/xxx；兼容 ./assets/xxx 写法）
const extractIndexAssets = (html) =>
  [...new Set([...html.matchAll(/(?:^|["'(])(?:\.?\/)?(assets\/[^"'\s>)]+)/g)].map((x) => `/${x[1]}`))];

if (!existsSync(SW)) {
  console.error(`[check-sw] ERROR dist/sw.js 不存在（${SW}）—— 请先 node scripts/build-sw.mjs`);
  process.exit(1);
}
if (!existsSync(INDEX)) {
  console.error(`[check-sw] ERROR dist/index.html 不存在（${INDEX}）—— 构建产物不完整`);
  process.exit(1);
}

const sw = readFileSync(SW, 'utf8');
const manifest = extractManifest(sw);
if (!manifest || manifest.length === 0) {
  console.error('[check-sw] ERROR 未能从 dist/sw.js 解析出 CORE_ASSETS 清单（模板占位未被替换？）');
  process.exit(1);
}

// ── ① 正向：index.html 引用的 /assets/* 必须全部入清单 ──
const indexAssets = extractIndexAssets(readFileSync(INDEX, 'utf8'));
const missing = indexAssets.filter((a) => !manifest.includes(a));
if (missing.length) fail(`① index.html 引用但清单缺失：${missing.join(', ')}`);

// ── ② 反向：清单每项必须在 dist 中存在（'/' = 目录索引 → dist/index.html）──
const resolveFile = (url) => path.join(DIST, url === '/' ? 'index.html' : url.replace(/^\//, ''));
const ghosts = manifest.filter((url) => !existsSync(resolveFile(url)));
if (ghosts.length) fail(`② 清单项在 dist 中不存在（幽灵项）：${ghosts.join(', ')}`);

// ── ③ 红线：不得包含任何 /api/ 路径 ──
const apiHits = manifest.filter((url) => url.includes('/api/'));
if (apiHits.length) fail(`③ 清单含 /api/ 路径（离线缓存接口 = 陈旧数据）：${apiHits.join(', ')}`);

// ── ④ VERSION 内容哈希 ──
const vm = /const VERSION = '([^']+)';/.exec(sw);
if (!vm) fail("④ dist/sw.js 未找到 VERSION 常量");
else if (!/-[0-9a-f]{8}$/.test(vm[1])) fail(`④ VERSION 不含 8 位内容哈希：${vm[1]}`);

// ── 字节统计（去重真实文件；与构建同口径 3MB 上限）──
const seen = new Set();
let totalBytes = 0;
for (const url of manifest) {
  const file = resolveFile(url);
  if (!existsSync(file) || seen.has(file)) continue;
  seen.add(file);
  totalBytes += statSync(file).size;
}
if (totalBytes > MAX_TOTAL) fail(`清单总字节 ${totalBytes} B 超过上限 ${MAX_TOTAL} B`);

if (errors.length) {
  console.error(`[check-sw] FAIL 预缓存清单校验未通过（${errors.length} 项）：`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`[check-sw] PASS 清单 ${manifest.length} 项 / 去重文件 ${seen.size} 个 / 总字节 ${totalBytes} B / VERSION ${vm[1]}`);
console.log(`[check-sw] ① index.html 引用 /assets/* ${indexAssets.length} 项全部入清单`);
console.log('[check-sw] ② 清单项全部存在于 dist；③ 无 /api/ 路径；④ VERSION 含 8 位内容哈希');
