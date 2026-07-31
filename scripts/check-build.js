/**
 * 构建检测：比较 src 与 dist 的时间戳，判断前后端是否需要重新构建。
 * 输出：逗号分隔的 "backend" / "frontend" / "backend,frontend"，均最新则输出空。
 * 用法：node scripts/check-build.js
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function newest(dir, exts) {
  if (!fs.existsSync(dir)) return 0;
  let t = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      t = Math.max(t, newest(p, exts));
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      t = Math.max(t, fs.statSync(p).mtimeMs);
    }
  }
  return t;
}

function needBuild(srcDir, distFile, exts) {
  if (!fs.existsSync(distFile)) return true;
  return newest(srcDir, exts) > fs.statSync(distFile).mtimeMs;
}

const need = [];
if (needBuild(
  path.join(root, 'backend', 'src'),
  path.join(root, 'backend', 'dist', 'src', 'main.js'),
  ['.ts']
)) need.push('backend');

if (needBuild(
  path.join(root, 'frontend', 'src'),
  path.join(root, 'frontend', 'dist', 'index.html'),
  ['.ts', '.tsx', '.css']
)) need.push('frontend');

process.stdout.write(need.join(','));
