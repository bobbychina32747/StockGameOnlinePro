// Phase D PWA 静态验收：manifest / sw.js / index.html 挂载 / 仅生产注册 / 图标产物
// 注意 CI 顺序 jest 在 vite build 之前 → 全部断言针对源文件（public/、index.html、src/main.tsx），不读 dist
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..'); // = frontend/
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

describe('PWA manifest（public/manifest.webmanifest）', () => {
  const manifest = JSON.parse(read('public/manifest.webmanifest')) as {
    name: string; short_name: string; start_url: string; display: string; theme_color: string;
    background_color: string; icons: { src: string; sizes: string; type: string }[];
  };

  it('可 JSON.parse 且核心字段齐全', () => {
    expect(manifest.name).toBe('StockSim Pro');
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(manifest.background_color).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it('icons 为 192/512 的真实 PNG 声明', () => {
    const sizes = manifest.icons.map((i) => i.sizes);
    expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
    for (const icon of manifest.icons) expect(icon.type).toBe('image/png');
  });
});

describe('Service Worker（public/sw.js）', () => {
  const sw = read('public/sw.js');

  it('/api、/socket.io 不缓存守卫存在（teams 最安全解释）', () => {
    expect(sw).toContain("'/api'");
    expect(sw).toContain("'/socket.io'");
    expect(sw).toContain('NEVER_CACHE_PREFIXES'); // 语义常量锚点，防止守卫被拆散
  });

  it('预缓存离线壳清单完整', () => {
    for (const p of ["'/'", "'/index.html'", "'/manifest.webmanifest'", "'/icons/icon-192.png'", "'/icons/icon-512.png'"]) {
      expect(sw).toContain(p);
    }
  });

  it('含版本化缓存名与 activate 清理逻辑', () => {
    expect(sw).toContain('VERSION');
    expect(sw).toContain('caches.delete');
    expect(sw).toMatch(/activate/);
    expect(sw).toContain('skipWaiting');
  });

  it('非 GET / 跨源直接放行；导航 network-first', () => {
    expect(sw).toContain("req.method !== 'GET'");
    expect(sw).toContain('url.origin !== self.location.origin');
    expect(sw).toContain("req.mode === 'navigate'");
    expect(sw).toContain('caches.match(\'/index.html\')');
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
    expect(b.subarray(0, 8)).toEqual(PNG_MAGIC); // 魔数校验
    return b.readUInt32BE(16); // IHDR width（height 紧随）
  };

  it.each([
    ['public/icons/icon-192.png', 192],
    ['public/icons/icon-512.png', 512],
    ['public/icons/apple-touch-icon.png', 180],
  ] as const)('%s 是 %ix%i PNG', (p, s) => {
    const b = readFileSync(path.join(ROOT, p));
    expect(ihdrSize(p)).toBe(s);
    expect(b.readUInt32BE(20)).toBe(s); // height
  });
});
