// Phase D PWA 图标生成器（零依赖：Node 内置 zlib 手写 PNG 编码）
// 产物：frontend/public/icons/icon-192.png / icon-512.png / apple-touch-icon.png(180)
// 图形：深色主题圆角方块（#16181e→#0e1013 对角渐变，呼应 global.css --bg-card/--bg-primary）
//       + 白色（--text-primary #e6e8eb）上升折线与箭头（行情隐喻）
// 用法：node scripts/gen-icons.mjs（产物提交入库；脚本为一次性/复跑工具）
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'frontend', 'public', 'icons');

// ── PNG 编码核心 ──
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
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // 每行：1 字节 filter=0（None）+ width*4 字节 RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── 图形采样（单位空间 [0,1]²，返回 [r,g,b,a]）──
const lerp = (a, b, t) => Math.round(a + (b - a) * t);
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
const SEGMENTS = [
  [[0.18, 0.62], [0.44, 0.40]],
  [[0.44, 0.40], [0.62, 0.52]], // 第二段稍回落后再上冲（行情形态）
  [[0.62, 0.52], [0.80, 0.28]],
  [[0.746, 0.352], [0.86, 0.325]], // 箭头两翼
  [[0.746, 0.352], [0.74, 0.235]],
];
const LINE_HALF = 0.041;
const CORNER_R = 0.22;
function sample(ux, uy) {
  // 圆角方块（SDF）：外 → 透明
  const cx = Math.abs(ux - 0.5), cy = Math.abs(uy - 0.5);
  const qx = Math.max(cx - (0.5 - CORNER_R), 0), qy = Math.max(cy - (0.5 - CORNER_R), 0);
  if (Math.hypot(qx, qy) > CORNER_R) return [0, 0, 0, 0];
  // 底色：对角渐变 #16181e → #0e1013
  const t = (ux + uy) / 2;
  let col = [lerp(0x16, 0x0e, t), lerp(0x18, 0x10, t), lerp(0x1e, 0x13, t), 255];
  for (const [[x1, y1], [x2, y2]] of SEGMENTS) {
    if (distToSegment(ux, uy, x1, y1, x2, y2) < LINE_HALF) return [0xe6, 0xe8, 0xeb, 255]; // --text-primary
  }
  return col;
}
function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 4; // 4×4 超采样抗锯齿
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [pr, pg, pb, pa] = sample((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
          r += pr; g += pg; b += pb; a += pa;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      // 输出为直通 RGBA（非预乘），背景像素 a=255
      rgba[i] = Math.round(r / n);
      rgba[i + 1] = Math.round(g / n);
      rgba[i + 2] = Math.round(b / n);
      rgba[i + 3] = Math.round(a / n);
    }
  }
  return encodePng(size, size, rgba);
}

// ── 生成与自校验 ──
mkdirSync(OUT_DIR, { recursive: true });
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  const buf = render(size);
  writeFileSync(join(OUT_DIR, name), buf);
  // 读回 IHDR 自校验
  const back = readFileSync(join(OUT_DIR, name));
  if (back.readUInt32BE(16) !== size || back.readUInt32BE(20) !== size) {
    throw new Error(`${name} IHDR 尺寸校验失败`);
  }
  console.log(`${name}: ${size}x${size}, ${buf.length} bytes`);
}
