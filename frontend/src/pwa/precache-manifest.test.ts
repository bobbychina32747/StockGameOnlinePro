// Phase F-3 构建期 precache manifest 收口验收：dist/sw.js 清单与 dist 真实产物双向一致
//
// 硬约束（CLAUDE 已记录）：CI/jest 在 vite build **之前**跑 → dist 缺失时必须整块 describe.skip，
// 否则首次构建前的测试必红；dist 存在时（本地 npm run build 之后）新例不得 skip。
// 只读文件，不起服务、不发请求。
import { existsSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

const DIST = path.resolve(__dirname, '..', '..', 'dist'); // = frontend/dist
const SW_PATH = path.join(DIST, 'sw.js');
const INDEX_PATH = path.join(DIST, 'index.html');
const MAX_TOTAL = 3 * 1024 * 1024; // 与 scripts/build-sw.mjs、check-sw-manifest.mjs 同口径

// dist 未产出（jest 早于 vite build）→ 整块跳过；读出的是文件内容，不做任何网络/进程操作
const distReady = existsSync(SW_PATH) && existsSync(INDEX_PATH);
const suite = distReady ? describe : describe.skip;

// 注意：describe.skip 的回调仍会在收集阶段执行 → 这里必须把读文件做成「未就绪则读空串」，否则 dist 缺失时先崩在收集期
const readIfReady = (p: string) => (distReady ? readFileSync(p, 'utf8') : '');

suite('构建期 precache manifest（dist/sw.js ↔ dist 真实产物）', () => {
  const sw = readIfReady(SW_PATH);
  const html = readIfReady(INDEX_PATH);

  // 解析约定与 scripts/check-sw-manifest.mjs 一致：CORE_ASSETS 数组内的单引号字符串
  const manifest = ([...((/const CORE_ASSETS = \[([\s\S]*?)\];/.exec(sw)?.[1] ?? '').matchAll(/'([^']+)'/g))]).map(
    (m) => m[1],
  );
  // index.html 引用的 /assets/*（Vite base='/'）；兼容 ./assets/* 写法
  const indexAssets = [
    ...new Set([...html.matchAll(/(?:^|["'(])(?:\.?\/)?(assets\/[^"'\s>)]+)/g)].map((m) => `/${m[1]}`)),
  ];
  // '/' 与 '/index.html' 是同一文件（目录索引）→ 去重后做字节统计
  const resolveFile = (url: string) => path.join(DIST, url === '/' ? 'index.html' : url.replace(/^\//, ''));

  it('清单可解析且覆盖固定离线壳 5 项', () => {
    expect(manifest.length).toBeGreaterThan(5);
    for (const p of ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png']) {
      expect(manifest).toContain(p);
    }
  });

  it('① dist/index.html 引用的每个 /assets/* 都在清单内（离线不得半白屏）', () => {
    expect(indexAssets.length).toBeGreaterThan(0);
    for (const asset of indexAssets) {
      expect(manifest).toContain(asset);
      // 构建期注入的 hash 产物必须真实存在（构建脚本已扫过 dist，这里再钉一次）
      expect(existsSync(resolveFile(asset))).toBe(true);
    }
  });

  it('② 清单每一项都在 dist 中存在（无幽灵项）', () => {
    const ghosts = manifest.filter((url) => !existsSync(resolveFile(url)));
    expect(ghosts).toEqual([]);
  });

  it('③ 清单不含任何 /api/ 路径（行情/交易接口离线缓存红线）', () => {
    expect(manifest.filter((url) => url.includes('/api/'))).toEqual([]);
  });

  it('④ VERSION 含 8 位内容哈希 + ⑤ 清单总字节 ≤ 3MB', () => {
    const version = /const VERSION = '([^']+)';/.exec(sw)?.[1] ?? '';
    expect(version).toMatch(/-[0-9a-f]{8}$/); // `${pkg.version}-${sha256(内容).slice(0,8)}`

    const seen = new Set<string>();
    let total = 0;
    for (const url of manifest) {
      const file = resolveFile(url);
      if (!existsSync(file) || seen.has(file)) continue;
      seen.add(file);
      total += statSync(file).size;
    }
    expect(total).toBeLessThanOrEqual(MAX_TOTAL);
  });
});
