// 本机同源预览服务器（tools/_local-site.mjs）
//
// 为什么需要它：浏览器对「页面在 localhost:5180、API 在 localhost:8099」这种**跨端口 loopback**
// 请求会走私有网络访问（PNA）限制，请求直接被拦成 "TypeError: Failed to fetch" ——
// 而线上是**同源**（bobbycn.cc 的页面打 bobbycn.cc 的 /api）。为了本机冒烟与线上一致，
// 这里把静态页面与后端代理到**同一个源**：
//
//   http://127.0.0.1:5200/games/…            → E:\Files\bobbychina-pages\games\…
//   http://127.0.0.1:5200/api/…              → http://127.0.0.1:8099/api/…
//   http://127.0.0.1:5200/login/ …           → 静态（登录页）
//
// 用法：node tools/_local-site.mjs [--port 5200] [--backend http://127.0.0.1:8099]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PORT = Number(argOf('--port', '5200'));
const BACKEND = argOf('--backend', 'http://127.0.0.1:8099').replace(/\/+$/, '');
const ROOT = resolve(argOf('--root', 'E:\\Files\\bobbychina-pages'));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.wav': 'audio/wav', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json; charset=utf-8',
};

async function proxy(req, res) {
  const chunks = [];
  for await (const chunk of req)
    chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const target = BACKEND + req.url;
  const headers = { ...req.headers, host: new URL(BACKEND).host };
  // 后端用 x-forwarded-proto 拼绝对跳转地址；本地是 http，不传就会拼出 https://127.0.0.1:5199 → ERR_SSL_PROTOCOL_ERROR
  headers['x-forwarded-proto'] = 'http';
  delete headers['content-length'];
  if (body.length)
    headers['content-length'] = String(body.length);
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
      redirect: 'manual',
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    const out = {};
    upstream.headers.forEach((value, key) => {
      // set-cookie 单独处理（可能多条），交给下面
      if (key.toLowerCase() === 'set-cookie') return;
      // 后端响应头里的 CSP 带 upgrade-insecure-requests —— 那是给 HTTPS 部署用的，
      // 本机是 http，浏览器会把它**升级成 https** 从而 ERR_SSL_PROTOCOL_ERROR。
      // 本机预览只需放开 connect-src，于是这里重写掉（线上不走这个代理，不受影响）。
      if (key.toLowerCase() === 'content-security-policy') {
        out[key] = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";
        return;
      }
      out[key] = value;
    });
    const cookies = typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : [];
    if (cookies.length)
      out['set-cookie'] = cookies;
    res.writeHead(upstream.status, out);
    res.end(buf);
  } catch (e) {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`proxy error: ${e.message}`);
  }
}

async function serveStatic(req, res) {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  try {
    const info = await stat(file);
    if (info.isDirectory()) return serveStatic({ ...req, url: path + '/' }, res);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 ' + path);
  }
}

createServer((req, res) => {
  if (req.url.startsWith('/api/')) return proxy(req, res);
  return serveStatic(req, res);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[local-site] http://127.0.0.1:${PORT}/  root=${ROOT}  /api -> ${BACKEND}`);
});
