#!/usr/bin/env node
/**
 * Phase F-4：浏览器级 E2E 冒烟脚本（tests/e2e/smoke.mjs）
 *
 * 定位（对应 docs/phaseF-plans/01-ai-adaptive-risk-pwa-e2e.md §F-4 与 §团队裁决点 C12）：
 *   1. **可选门禁**：本脚本是唯一入口（`node tests/e2e/smoke.mjs`），**不**被 `npm test` / CI 强依赖；
 *      失败只产出 artifacts 与退出码，不阻断 build/test 通道。`--help` 给用法。
 *   2. **SKIP 语义**：frontend/dist 或 backend/dist 缺失、preview/后端端口不可达、浏览器不可用时，
 *      打印 `SKIP: <原因>` 并 **exit 0**（不假红）；加 `--strict` 时改为 exit 1。
 *   3. **端口与浏览器路径走环境变量**，默认自动挑选空闲端口（后端 / preview 各一个），
 *      preview 端口通过 `vite preview --port <p> --strictPort` 显式传入。
 *   4. **临时库红线**：后端只用临时 SQLite（os.tmpdir()/sgp-e2e-<pid>.db）+ SANDBOX_FAST=true
 *      + TICK_INTERVAL_MS=1000；**绝不触碰** backend/data/stockgame.db。退出时（含异常）
 *      杀掉自己启动的子进程并删除临时库（含 -wal / -shm）。
 *   5. **产物**：tests/e2e/artifacts/<YYYYMMDD-HHmmss>/ 下 NN-<name>.png 截图 + result.json
 *      （步骤名/状态/耗时/断言值，**不写密码**）+ server.log（后端 stdout）。默认保留产物，
 *      `--clean` 才在开始前清理 7 天前的旧目录。
 *   6. **主链路 6 条**：登录/注册（含 Phase E 重名 200+success:false → 转登录）/ 下单 / 撤单 /
 *      排行 / 赛季报名 / 断线→reload→外壳非白屏。单条失败不阻断后续（记录 FAIL 继续），
 *      最终若有 FAIL → exit 1。
 *   7. **无交互阻塞**：每次 playwright-cli 调用都有超时；脚本整体有总超时（默认 300s，--timeout= 可调）。
 *
 * 硬约束：纯 Node 内置模块、零新依赖、中文注释、ESM、UTF-8 无 BOM。
 * 沙箱适配：playwright-cli 的 stdout/stderr 一律用**文件描述符重定向**（stdio: ['ignore', fd, fd]），
 *           禁止管道捕获（沙箱下管道 spawn 会 EPERM，见 ~/.dsh/AGENTS.md run-to-file 规则）。
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// ─────────────────────────── 路径与环境常量 ───────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// 仓库根 = tests/e2e/../..
const ROOT = path.resolve(__dirname, '..', '..');
const BACKEND_DIR = path.join(ROOT, 'backend');
const FRONTEND_DIR = path.join(ROOT, 'frontend');
const ARTIFACTS_ROOT = path.join(ROOT, 'tests', 'e2e', 'artifacts');

const BACKEND_ENTRY = path.join(BACKEND_DIR, 'dist', 'src', 'main.js');
const FRONTEND_INDEX = path.join(FRONTEND_DIR, 'dist', 'index.html');
const VITE_BIN = path.join(FRONTEND_DIR, 'node_modules', 'vite', 'bin', 'vite.js');

// playwright-cli：本机全局安装的 @playwright/cli（.cmd 在沙箱下 spawn 会 EINVAL，故直接用 node 跑其入口 js）
const PW_CLI_CANDIDATES = [
  process.env.SGP_E2E_PLAYWRIGHT_CLI,
  'D:\\npm-global\\node_modules\\@playwright\\cli\\playwright-cli.js',
  path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@playwright', 'cli', 'playwright-cli.js'),
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node_modules', '@playwright', 'cli', 'playwright-cli.js'),
].filter(Boolean);
// 显式指定优先（指错即 SKIP，不静默回退到别的 CLI）；未指定时才按候选顺序探测
const PW_CLI_JS = process.env.SGP_E2E_PLAYWRIGHT_CLI
  || PW_CLI_CANDIDATES.find((p) => fs.existsSync(p))
  || PW_CLI_CANDIDATES[0];
const PW_SCRIPTS_DIR = process.env.SGP_E2E_PLAYWRIGHT_DIR || 'C:\\Users\\lenovo\\.dsh\\scripts';
const PW_CONFIG = process.env.SGP_E2E_PLAYWRIGHT_CONFIG || path.join(PW_SCRIPTS_DIR, 'playwright-cli.json');

const OLD_ARTIFACT_MS = 7 * 24 * 60 * 60 * 1000; // --clean：清理 7 天前的产物目录

// vite.config.ts 的 preview.proxy target 固定为 http://localhost:8000；后端若能占用 8000，
// 浏览器就直连 preview（走真实 preview 代理链），完全不需要内置网关。8000 被占则退回自动挑端口 + 网关。
const PREFERRED_BACKEND_PORT = Number(process.env.SGP_E2E_PREFERRED_BACKEND_PORT || 8000);

// ─────────────────────────── CLI 参数解析 ───────────────────────────

const USAGE = `Phase F-4 E2E 冒烟脚本（可选门禁，非 CI 强依赖）

用法:
  node tests/e2e/smoke.mjs [选项]

选项:
  --help                打印本帮助并退出 0
  --strict              SKIP 情况下也返回退出码 1（默认 SKIP → exit 0）
  --keep                保留产物（默认行为，显式写出便于阅读）
  --clean               开始前清理 artifacts/ 下 7 天前的旧目录（默认不删任何东西）
  --timeout=<毫秒>      脚本总超时，默认 300000（5 分钟）

环境变量:
  SGP_E2E_BACKEND_PORT        指定后端端口（默认自动挑空闲端口；端口被占用即 SKIP）
  SGP_E2E_PREVIEW_PORT        指定 preview 端口（默认自动挑空闲端口）
  SGP_E2E_GATEWAY_PORT        指定内置网关端口（默认自动挑空闲端口）
  SGP_E2E_TICK_MS             后端 TICK_INTERVAL_MS，默认 1000（SANDBOX_FAST 强制 true）
  SGP_E2E_BACKEND_READY_MS    后端就绪等待上限，默认 200000（空临时库需补全生命周期日线 + 30 游戏日
                              warm-up，实测 40~90s；窗口过小会把慢启动误判成 SKIP，最小 60000）
  SGP_E2E_PREVIEW_READY_MS    vite preview 就绪等待上限，默认 60000（最小 10000）
  SGP_E2E_PREVIEW_TARGET_PORT vite preview 代理的目标端口，默认 8000；仅当它等于后端端口时才直连 preview
  SGP_E2E_FORCE_GATEWAY=1     即使 preview 已能代理到本脚本后端也强制走内置网关
  SGP_E2E_NO_GATEWAY=1        禁用内置网关（preview 未代理到本脚本后端时直接 SKIP，便于验证 preview 代理配置）
  SGP_E2E_PLAYWRIGHT_CLI      playwright-cli 入口 js 路径（显式指定即唯一来源，指错就 SKIP）
  SGP_E2E_PLAYWRIGHT_DIR      playwright-cli 工作目录（须含 playwright-cli.json），默认 ~/.dsh/scripts
  SGP_E2E_PLAYWRIGHT_CONFIG   playwright-cli 配置文件路径

产物:
  tests/e2e/artifacts/<YYYYMMDD-HHmmss>/  ← NN-<name>.png 截图 + result.json + server.log

退出码:
  0  全部 PASS，或出现 SKIP（未加 --strict）
  1  存在 FAIL，或加 --strict 时出现 SKIP
`;

function parseArgs(argv) {
  const opts = { strict: false, clean: false, keep: true, timeoutMs: 300000, help: false, unknown: [] };
  for (const a of argv) {
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--clean') opts.clean = true;
    else if (a === '--keep') opts.keep = true;
    else if (a.startsWith('--timeout=')) {
      const n = Number(a.slice('--timeout='.length));
      if (Number.isFinite(n) && n >= 10000) opts.timeoutMs = Math.floor(n);
    } else opts.unknown.push(a);
  }
  return opts;
}

const OPTS = parseArgs(process.argv.slice(2));

// ─────────────────────────── 通用工具 ───────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 打印立即 flush（沙箱下 stdout 重定向到文件时避免缓冲丢失） */
function say(line) {
  process.stdout.write(line + '\n');
}

/** 挑一个空闲端口（listen(0) 由内核分配后立刻释放） */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * 端口占用自检（红线防护）：若端口已被占，脚本的后端会启动失败，而就绪探测却会打到"别人"的后端上
 * —— 那个后端可能连着真实库 backend/data/stockgame.db。宁可 SKIP 也绝不误连。
 */
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/** 极简 HTTP 请求（只用 node:http，避免任何依赖）；返回 {status, text, json} */
function httpRequest(method, url, { token, body, timeoutMs = 10000, accept = 'application/json' } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ status: 0, text: '', json: null, error: String(e.message || e) }); }
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    // accept 必须可控：vite preview 的静态中间件（sirv single 模式）只在 accept 含 text/html 时回退 index.html，
    // 用默认的 application/json 探首页会拿到 404 —— 探测前端壳时必须按浏览器口径发 text/html
    const headers = { accept };
    if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = String(payload.length); }
    if (token) headers.authorization = `Bearer ${token}`;
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers, timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON（如 HTML）保持 null */ }
        resolve({ status: res.statusCode || 0, text, json });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ status: 0, text: '', json: null, error: String(e.message || e) }));
    if (payload) req.write(payload);
    req.end();
  });
}

/** 轮询直到条件满足；返回最后一次结果 */
async function waitUntil(fn, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try { last = await fn(); } catch (e) { last = { ok: false, error: String(e.message || e) }; }
    if (last && last.ok) return last;
    if (Date.now() >= deadline) return last || { ok: false, error: 'timeout' };
    await sleep(intervalMs);
  }
}

// ─────────────────────────── 运行态 / 产物 ───────────────────────────

const RUN_ID = (() => {
  // 同一秒内跑两次（例如 CI 连跑）不能互相覆盖：目录已存在就追加序号
  const base = stamp();
  if (!fs.existsSync(path.join(ARTIFACTS_ROOT, base))) return base;
  for (let i = 2; i < 100; i++) if (!fs.existsSync(path.join(ARTIFACTS_ROOT, `${base}-${i}`))) return `${base}-${i}`;
  return `${base}-${process.pid}`;
})();
const ARTIFACT_DIR = path.join(ARTIFACTS_ROOT, RUN_ID);
const LOG_FILE = path.join(ARTIFACT_DIR, 'run.log');

const state = {
  startedAt: new Date(),
  children: [],            // { name, child, logFile }
  gateway: null,
  session: `sgp-e2e-${process.pid}`,
  tmpDb: path.join(os.tmpdir(), `sgp-e2e-${process.pid}.db`),
  backendPort: 0,
  previewPort: 0,
  gatewayPort: 0,
  frontendUrl: '',
  adminUser: 'e2e_admin',
  adminPass: '',           // 仅内存，绝不落盘
  user: '',
  userPass: '',            // 仅内存，绝不落盘
  chains: [],
  browserOpened: false,
  placedOrderId: '',
  skipReason: '',
  finished: false,
};

let logFd = null;
function log(line) {
  const s = String(line);
  say(s);
  if (logFd != null) { try { fs.writeSync(logFd, s + '\n'); } catch { /* 忽略写入失败 */ } }
}

/** --clean：只删 7 天前、且符合 YYYYMMDD-HHmmss 命名的旧产物目录 */
function cleanOldArtifacts() {
  if (!fs.existsSync(ARTIFACTS_ROOT)) return;
  const now = Date.now();
  let removed = 0;
  for (const name of fs.readdirSync(ARTIFACTS_ROOT)) {
    if (!/^\d{8}-\d{6}$/.test(name)) continue;
    const p = path.join(ARTIFACTS_ROOT, name);
    try {
      const st = fs.statSync(p);
      if (st.isDirectory() && now - st.mtimeMs > OLD_ARTIFACT_MS) { fs.rmSync(p, { recursive: true, force: true }); removed += 1; }
    } catch { /* 单个目录失败不影响整体 */ }
  }
  if (removed) log(`[clean] 清理 7 天前产物目录 ${removed} 个`);
}

function prepareArtifacts() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  logFd = fs.openSync(LOG_FILE, 'a');
}

// ─────────────────────────── 子进程管理（含强制清理） ───────────────────────────

/** 启动子进程并把 stdout/stderr 重定向到文件（禁用管道捕获） */
function spawnToLog(name, cmd, args, { cwd, env }) {
  const file = path.join(ARTIFACT_DIR, `${name}.log`);
  const fd = fs.openSync(file, 'a');
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  child.on('exit', () => { try { fs.closeSync(fd); } catch { /* 已关闭 */ } });
  state.children.push({ name, child });
  log(`[spawn] ${name}: ${cmd} ${args.join(' ')} (cwd=${cwd}) → ${path.relative(ROOT, file)}`);
  return child;
}

/** Windows 上杀进程树（npm/vite 这类包装进程会派生真正的服务进程） */
function killTree(pid) {
  try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); }
  catch { try { process.kill(pid); } catch { /* 已退出 */ } }
}

/**
 * 退出清理：杀子进程 + 删临时库（含 -wal / -shm）。任何异常路径都必须走到这里。
 * 注意：关浏览器会话是异步的（见下方 runPwCli 注释），故 cleanup 也是 async。
 */
async function cleanup() {
  if (state.finished) return;
  state.finished = true;
  // 1) 浏览器会话（必须带 -s=<会话名>，否则 CLI 会去关 'default' 会话并把遗留浏览器留在 profile 上）
  if (state.browserOpened) {
    try { await cli(['close'], { timeoutMs: 30000, quiet: true }); } catch { /* 忽略 */ }
  }
  // 2) 内置网关
  if (state.gateway) { try { state.gateway.close(); } catch { /* 忽略 */ } }
  // 3) 子进程树
  for (const c of state.children) {
    const pid = c.child && c.child.pid;
    if (!pid) continue;
    try { killTree(pid); } catch { /* 忽略 */ }
  }
  state.children = [];
  // 4) 临时 SQLite 红线：只删自己创建的临时库
  await sleep(300); // 给被杀的进程一点时间释放文件句柄（Windows 上文件被占用时 unlink 会失败）
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const f = state.tmpDb + suffix;
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* 忽略 */ }
  }
}

// ─────────────────────────── playwright-cli 驱动 ───────────────────────────

let cliSeq = 0;

/**
 * 调一次 playwright-cli：stdout/stderr 一律重定向到 cli.log 文件描述符再读回（禁用管道捕获）。
 * **必须是异步 spawn**：用 spawnSync 会阻塞本进程事件循环，而本进程同时还在跑内置网关
 * （浏览器要经网关取页面）→ 会自锁到导航超时。这里用 spawn + await exit，事件循环保持可用。
 * 返回 { status, out, error, timedOut }；out 为该次调用新增的 stdout+stderr 文本。
 */
function runPwCli(args, { timeoutMs = 60000, quiet = false } = {}) {
  cliSeq += 1;
  const logFile = path.join(ARTIFACT_DIR, 'cli.log');
  const fd = fs.openSync(logFile, 'a');
  fs.writeSync(fd, `\n===== [${cliSeq}] ${args.join(' ')} =====\n`);
  // 基准必须在写完自己的命令行回显之后取：eval 的 JS 代码里含 __SGP_OK__ 哨兵，
  // 若把回显也读进来，正则先命中回显 → 解析必失败（曾导致整轮断言全挂）
  const before = fs.statSync(logFile).size;
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(process.execPath, [PW_CLI_JS, ...args], {
      cwd: PW_SCRIPTS_DIR, stdio: ['ignore', fd, fd], windowsHide: true,
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { killTree(child.pid); } catch { /* 忽略 */ } }, timeoutMs);
    const done = (code, signal, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { fs.writeSync(fd, `[status=${code} signal=${signal || '-'}${err ? ' err=' + err.message : ''}${timedOut ? ' TIMEOUT' : ''}]\n`); fs.closeSync(fd); } catch { /* 忽略 */ }
      // 落盘后再读回本次新增内容（写读用两个描述符，避免偏移冲突）
      let out = '';
      try {
        const size = Math.max(0, fs.statSync(logFile).size - before);
        const buf = Buffer.alloc(size);
        const rfd = fs.openSync(logFile, 'r');
        fs.readSync(rfd, buf, 0, size, before);
        fs.closeSync(rfd);
        out = buf.toString('utf8');
      } catch { /* 忽略 */ }
      const tag = `${args[0]}${args[1] && !String(args[1]).startsWith('-s=') ? ' ' + args[1] : ''}`;
      if (!quiet) log(`[cli] ${tag} → status=${code}${err ? ' err=' + err.message : ''}${timedOut ? ' TIMEOUT' : ''}`);
      resolve({ status: code, out, error: err || null, timedOut });
    };
    child.on('error', (err) => done(null, null, err));
    child.on('exit', (code, signal) => done(code, signal, null));
  });
}

function cli(args, opts) {
  const full = [`-s=${state.session}`, ...args];
  return runPwCli(full, opts);
}

/**
 * 页面内求值：用哨兵包裹结果，再从原始 stdout 里正则取回（对 CLI 的 update 横幅/日志噪声免疫）。
 * code 为**异步**函数体（可用 await），必须 `return` 一个可 JSON 化的值。
 * playwright-cli 内部是 `page.evaluate('() => (EXPR)')`，Playwright 会自动 await 返回的 Promise。
 */
/**
 * 把"页面内返回 {ok:...} 的断言片段"包成 waitUntil 的探测器。
 * 注意：**不能**直接 `waitUntil(page(code))` —— evalJs 返回的是 {ok:运行成功, value:页面值}，
 * 直接判 ok 会让"页面断言为假"被当成"通过"（曾经导致 5 条链路假绿）。
 */
function page(code, opts) {
  return async () => {
    const r = await evalJs(code, opts);
    if (!r.ok) return { ok: false, error: r.error };
    const v = r.value;
    if (v && typeof v === 'object') return v;
    return { ok: !!v, value: v };
  };
}

async function evalJs(code, { timeoutMs = 30000 } = {}) {
  const wrapped =
    `(async () => { try { return "__SGP_OK__" + JSON.stringify(await (async () => { ${code} })()) + "__SGP_END__"; }` +
    ` catch (e) { return "__SGP_ERR__" + (e && e.message ? e.message : String(e)); } })()`;
  const r = await cli(['eval', wrapped, '--raw'], { timeoutMs, quiet: true });
  const text = r.out || '';
  const ok = text.match(/__SGP_OK__([\s\S]*?)__SGP_END__/);
  if (ok) {
    try {
      // 哨兵内容嵌在 JSON 字符串字面量里 → 先反转义再解析
      const inner = JSON.parse('"' + ok[1] + '"');
      return { ok: true, value: JSON.parse(inner) };
    } catch (e) {
      return { ok: false, error: `解析 eval 结果失败: ${String(e.message || e)}` };
    }
  }
  const err = text.match(/__SGP_ERR__([^\n]*)/);
  if (err) return { ok: false, error: `页面异常: ${err[1]}` };
  return { ok: false, error: `eval 无有效输出（status=${r.status}${r.error ? ' ' + r.error.message : ''}）` };
}

/** goto + 等外壳渲染 */
async function goto(url, { timeoutMs = 45000 } = {}) {
  return cli(['goto', url], { timeoutMs });
}

async function shot(fileName, { timeoutMs = 60000 } = {}) {
  const abs = path.join(ARTIFACT_DIR, fileName);
  await cli(['screenshot', '--filename', abs], { timeoutMs, quiet: true });
  return fs.existsSync(abs) ? fileName : null;
}

// ─────────────────────────── 内置网关（preview 未代理 /api 时的兜底） ───────────────────────────

/**
 * vite preview 的 proxy 默认继承 server.proxy（target 硬编码 http://localhost:8000），
 * 而本脚本按团队要求自动挑空闲端口 → 后端很可能不在 8000，preview 的 /api 会 502/404。
 * 此时起一个纯 node:http 的同源网关：/api 与 /socket.io 转发后端，其余转发 preview。
 * 这样脚本不依赖同事正在改的 vite.config.ts preview 段，也不会与 8000 冲突。
 */
function startGateway({ listenPort, backendPort, previewPort }) {
  const server = http.createServer((req, res) => {
    const toBackend = req.url.startsWith('/api') || req.url.startsWith('/socket.io');
    const port = toBackend ? backendPort : previewPort;
    const upstream = http.request({
      host: '127.0.0.1', port, path: req.url, method: req.method,
      // Host 必须指向目标端口：vite 与 helmet 都会据此校验
      headers: { ...req.headers, host: `127.0.0.1:${port}` },
    }, (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    });
    upstream.on('error', (e) => {
      try { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('gateway error: ' + e.message); } catch { /* 忽略 */ }
    });
    req.pipe(upstream);
  });
  // WebSocket（socket.io 只走 websocket 传输）：裸 socket 双向 pipe
  server.on('upgrade', (req, socket, head) => {
    const up = net.connect(state.backendPort, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        const v = req.rawHeaders[i + 1];
        lines.push(k.toLowerCase() === 'host' ? `Host: 127.0.0.1:${state.backendPort}` : `${k}: ${v}`);
      }
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(listenPort, '127.0.0.1', () => {
      state.gateway = server;
      log(`[gateway] 已启动 127.0.0.1:${listenPort} → /api,/socket.io ⇒ ${backendPort}；其余 ⇒ ${previewPort}`);
      resolve(server);
    });
  });
}

// ─────────────────────────── 链路执行框架 ───────────────────────────

/** 断言收集器：把"断言值"写进 result.json（不含任何密码） */
function makeAssertions() {
  const list = [];
  return {
    list,
    ok(label, value, pass = true) { list.push({ label, ok: !!pass, value: value === undefined ? null : value }); return !!pass; },
    eq(label, actual, expected) { return this.ok(label, actual, actual === expected); },
    truthy(label, actual) { return this.ok(label, actual, !!actual); },
  };
}

/**
 * 跑一条链路：失败只记录 FAIL 并继续后续链路（团队要求"每条链路失败不阻断后续"）。
 * fn 返回 { status?: 'PASS'|'SKIP', skip?: string }，默认 PASS。
 */
async function runChain(index, name, fn) {
  const t0 = Date.now();
  const A = makeAssertions();
  const rec = { index, name, status: 'FAIL', durationMs: 0, screenshot: null, skipReason: null, error: null, assertions: A.list };
  log(`\n──── 链路 ${String(index).padStart(2, '0')} ${name} ────`);
  try {
    const r = await fn(A) || {};
    rec.status = r.status || 'PASS';
    if (r.skip) { rec.status = 'SKIP'; rec.skipReason = r.skip; }
    rec.screenshot = await shot(`${String(index).padStart(2, '0')}-${name}.png`).catch(() => null);
  } catch (e) {
    rec.status = 'FAIL';
    rec.error = String(e && e.message ? e.message : e);
    log(`[FAIL] 链路 ${name}: ${rec.error}`);
    try { rec.screenshot = await shot(`${String(index).padStart(2, '0')}-${name}-fail.png`); } catch { /* 忽略 */ }
  }
  rec.durationMs = Date.now() - t0;
  state.chains.push(rec);
  log(`[${rec.status}] 链路 ${String(index).padStart(2, '0')} ${name}（${rec.durationMs}ms）${rec.skipReason ? ' — ' + rec.skipReason : ''}`);
  return rec;
}

/** 断言失败即抛错（链路内快速失败；截图由 runChain 的 catch 兜住） */
function must(cond, msg) { if (!cond) throw new Error(msg); }

// ─────────────────────────── 主流程 ───────────────────────────

async function preflight() {
  const missing = [];
  if (!fs.existsSync(FRONTEND_INDEX)) missing.push('frontend/dist/index.html（先 cd frontend && npm run build）');
  if (!fs.existsSync(BACKEND_ENTRY)) missing.push('backend/dist/src/main.js（先 cd backend && npm run build）');
  if (!fs.existsSync(VITE_BIN)) missing.push(`frontend/node_modules/vite（先 cd frontend && npm install）`);
  if (missing.length) return `构建产物缺失：${missing.join('；')}`;
  if (!fs.existsSync(PW_CLI_JS)) return `playwright-cli 入口不存在：${PW_CLI_JS}（可用 SGP_E2E_PLAYWRIGHT_CLI 指定）`;
  if (!fs.existsSync(PW_CONFIG)) return `playwright-cli 配置不存在：${PW_CONFIG}`;
  if (!fs.existsSync(BACKEND_DIR)) return 'backend 目录不存在';
  return '';
}

async function startBackend() {
  const tickMs = Number(process.env.SGP_E2E_TICK_MS || 1000);
  state.backendPort = Number(process.env.SGP_E2E_BACKEND_PORT) || await freePort();
  const free = await portFree(state.backendPort);
  if (!free) throw new Error(`后端端口 ${state.backendPort} 已被占用：为免误连他人后端（可能是真实库），请换端口或先停掉该服务`);
  // 每次运行都用独立临时库 + 独立管理员密码（密码只存在于内存，绝不出现在产物里）
  state.adminPass = `E2e_${Math.random().toString(36).slice(2, 12)}Aa1`;
  spawnToLog('server', process.execPath, [BACKEND_ENTRY], {
    cwd: BACKEND_DIR,
    env: {
      PORT: String(state.backendPort),
      SQLITE_PATH: state.tmpDb,       // 红线：绝不指向 backend/data/stockgame.db
      SANDBOX_FAST: 'true',           // 允许 <60000 的 tick
      TICK_INTERVAL_MS: String(tickMs),
      NODE_ENV: 'production',         // 不挂 Swagger，行为更接近生产壳
      ADMIN_USERNAME: state.adminUser,
      ADMIN_PASSWORD: state.adminPass,
    },
  });
  // 空临时库首次启动要把三市场全生命周期日线补齐 + 30 游戏日 warm-up（实测 40~90s，机器忙碌时更久），
  // 窗口默认 200s 且可用 SGP_E2E_BACKEND_READY_MS 覆盖：窗口过小会把"慢启动"误判成 SKIP
  const readyMs = Math.max(60000, Number(process.env.SGP_E2E_BACKEND_READY_MS) || 200000);
  const ready = await waitUntil(async () => {
    const r = await httpRequest('GET', `http://127.0.0.1:${state.backendPort}/api/market/prices`, { timeoutMs: 3000 });
    return { ok: r.status === 200, status: r.status, error: r.error };
  }, readyMs, 700);
  if (!ready.ok) throw new Error(`后端未就绪（:${state.backendPort}，等待上限 ${readyMs}ms，status=${ready.status || 0}${ready.error ? ' ' + ready.error : ''}）`);
  log(`[ready] 后端 http://127.0.0.1:${state.backendPort}（临时库 ${state.tmpDb}，tick=${tickMs}ms）`);
}

async function startPreview() {
  state.previewPort = Number(process.env.SGP_E2E_PREVIEW_PORT) || await freePort();
  const free = await portFree(state.previewPort);
  if (!free) throw new Error(`preview 端口 ${state.previewPort} 已被占用（--strictPort 会直接失败），请换端口或先停掉该服务`);
  // 用本地 vite 入口而非 npx：避免 npx 包装进程导致 kill 不到真正的服务进程
  spawnToLog('preview', process.execPath, [VITE_BIN, 'preview', '--port', String(state.previewPort), '--strictPort', '--host', '127.0.0.1'], {
    cwd: FRONTEND_DIR, env: {},
  });
  const readyMs = Math.max(10000, Number(process.env.SGP_E2E_PREVIEW_READY_MS) || 60000);
  const ready = await waitUntil(async () => {
    const r = await httpRequest('GET', `http://127.0.0.1:${state.previewPort}/`, { timeoutMs: 3000, accept: 'text/html' });
    return { ok: r.status === 200 && r.text.includes('id="root"'), status: r.status, error: r.error };
  }, readyMs, 500);
  if (!ready.ok) throw new Error(`vite preview 未就绪（:${state.previewPort}，等待上限 ${readyMs}ms，status=${ready.status || 0}${ready.error ? ' ' + ready.error : ''}）`);
  log(`[ready] preview http://127.0.0.1:${state.previewPort}（dist 生产壳）`);
}

/**
 * 判定浏览器入口：只有在**能证明** preview 把 /api 转发到"本脚本的后端"时才直连，否则起内置网关。
 * vite preview 的 proxy 继承 server.proxy，target 硬编码 http://localhost:8000 —— 因此仅当
 * backendPort === 该 target 端口时，"探测 preview /api 成功"才等价于"打到我们的临时库后端"；
 * 否则（比如 8000 上跑着别人的真实库后端）直连会把冒烟打到错误的后端，触碰临时库红线。
 */
async function resolveFrontDoor() {
  const direct = `http://127.0.0.1:${state.previewPort}`;
  const assumedTarget = Number(process.env.SGP_E2E_PREVIEW_TARGET_PORT || 8000);
  if (!process.env.SGP_E2E_FORCE_GATEWAY && state.backendPort === assumedTarget) {
    const probe = await httpRequest('GET', `${direct}/api/market/prices`, { timeoutMs: 5000 });
    if (probe.status === 200 && probe.json && typeof probe.json === 'object' && Object.keys(probe.json).length > 0) {
      log(`[front] vite preview 已代理 /api → ${assumedTarget}（= 本脚本后端），浏览器直连 preview`);
      state.frontendUrl = direct;
      return;
    }
  }
  if (process.env.SGP_E2E_NO_GATEWAY) {
    throw new Error('preview 未代理 /api 且已禁用内置网关（SGP_E2E_NO_GATEWAY=1）');
  }
  state.gatewayPort = Number(process.env.SGP_E2E_GATEWAY_PORT) || await freePort();
  await startGateway({ listenPort: state.gatewayPort, backendPort: state.backendPort, previewPort: state.previewPort });
  state.frontendUrl = `http://127.0.0.1:${state.gatewayPort}`;
  log(`[front] preview 未把 /api 指到本脚本后端（preview:${state.previewPort} 的代理 target 默认 8000 ≠ backend:${state.backendPort}），`
    + '已用内置网关兜底（同源 /api + /socket.io 反代；如需直连 preview 可令 SGP_E2E_BACKEND_PORT=8000）');
}

/** 管理员登录并开启"全服休市交易"：休市时段（如深夜/周末）也能跑下单链路 */
async function enableOffHoursTrading() {
  const base = `http://127.0.0.1:${state.backendPort}`;
  const login = await httpRequest('POST', `${base}/api/auth/login`, {
    body: { username: state.adminUser, password: state.adminPass },
  });
  if (login.status !== 200 || !login.json || !login.json.token) {
    return { ok: false, reason: `管理员登录失败（status=${login.status}）` };
  }
  const on = await httpRequest('POST', `${base}/api/admin/debug/global`, { token: login.json.token, body: { on: true } });
  if (on.status !== 200 && on.status !== 201) return { ok: false, reason: `开启全服休市交易失败（status=${on.status}）` };
  log(`[setup] 全服休市交易已开启（offHoursTrading=${on.json && on.json.globalBypass}）`);
  return { ok: true };
}

/** 打开浏览器 + 清掉持久 profile 里的历史登录态/教程态（保证链路从干净状态起步） */
async function openBrowser() {
  // 先置位：无论 open 成功与否，退出清理都要试着关掉这个会话（否则遗留浏览器会占住 playwright profile）
  state.browserOpened = true;
  const r = await runPwCli([`-s=${state.session}`, 'open', `${state.frontendUrl}/login`, '--config', PW_CONFIG], { timeoutMs: 120000 });
  const text = r.out || '';
  if (r.status !== 0 || !/opened/i.test(text)) {
    // 常见环境原因：playwright 持久 profile 被上一个遗留浏览器占住（"--isolated" 提示）
    const detail = (text.match(/Error: ([^\n]+)/) || [])[1] || (r.error ? r.error.message : '');
    return { ok: false, reason: `浏览器打开失败（status=${r.status}${r.timedOut ? ' TIMEOUT' : ''}${detail ? '：' + detail.trim() : ''}）` };
  }
  log(`[browser] 会话 ${state.session} 已打开 → ${state.frontendUrl}`);
  // 教程浮层会遮挡截图且与冒烟无关：置 ss.tutDone=1 抑制；同时清历史 token
  await evalJs(`localStorage.clear(); localStorage.setItem('ss.tutDone','1'); localStorage.setItem('ss.tut','6'); return true;`);
  return { ok: true };
}

// ─────────────────────────── 6 条主链路 ───────────────────────────

/** 页面内通用注入片段：原生 setter 触发 React onChange（直接改 .value 不会触发 React 状态） */
const JS_SET_VALUE = `
  const setVal = (el, v) => {
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
`;

const JS_ORDER_CARD = `
  const card = [...document.querySelectorAll('.card')].find((c) => ((c.querySelector('h3') || {}).textContent || '').includes('下单'));
`;

/** 页面内 fetch（带 JWT）语句片段：产出 status / body 两个局部变量，**不 return**（便于与后续断言拼接） */
function pageFetchStmt(pathAndQuery, init = '{}') {
  return `
    const token = localStorage.getItem('token');
    const resp = await fetch(${JSON.stringify(pathAndQuery)}, Object.assign({ headers: { Authorization: 'Bearer ' + token } }, ${init}));
    const status = resp.status;
    const rawText = await resp.text();
    let body = null; try { body = JSON.parse(rawText); } catch (e) { body = rawText; }
  `;
}

// 链路 ①：打开首页 → 注册（或重名 200+success:false → 转登录）→ 断言进入主界面（DOM 断言）
async function chainAuth(A) {
  state.user = `e2e_${Date.now().toString(36)}`;
  state.userPass = `Pw_${Math.random().toString(36).slice(2, 12)}A9`;

  // a) 登录页可见
  await goto(`${state.frontendUrl}/login`);
  const loginForm = await waitUntil(page(`
    const f = document.querySelector('.login-page form');
    return { ok: !!f && !!f.querySelector('input[type=password]'), hasForm: !!f };
  `), 20000, 500);
  must(loginForm.ok, `登录页未渲染表单：${loginForm.error || ''}`);
  A.ok('登录页表单可见', loginForm.hasForm);

  // b) 切到注册 → 填表 → 注册（新用户名，走成功分支）
  const regFilled = await evalJs(`
    ${JS_SET_VALUE}
    const sw = document.querySelector('.login-page .switch a');
    if (sw) sw.click();
    await new Promise((r) => setTimeout(r, 200));
    const form = document.querySelector('.login-page form');
    setVal(form.querySelector('input[type=text]'), ${JSON.stringify(state.user)});
    setVal(form.querySelector('input[type=password]'), ${JSON.stringify(state.userPass)});
    await new Promise((r) => setTimeout(r, 100));
    const btn = form.querySelector('button[type=submit]');
    return { btnText: (btn || {}).textContent || '', disabled: !!btn.disabled };
  `);
  must(regFilled.ok, `注册表单填充失败：${regFilled.error}`);
  A.eq('切换到注册态按钮文案', regFilled.value.btnText, '注册');
  await evalJs(`document.querySelector('.login-page form button[type=submit]').click(); return true;`);

  const entered = await waitUntil(page(`
    const layout = document.querySelector('.app-layout');
    const dash = document.querySelector('.dashboard');
    return { ok: !!layout && !!dash, hasLayout: !!layout, hasDashboard: !!dash,
             rootText: (document.getElementById('root') || {}).innerText ? document.getElementById('root').innerText.slice(0, 60) : '' };
  `), 25000, 500);
  must(entered.ok, `注册后未进入主界面（layout=${entered && entered.hasLayout} dashboard=${entered && entered.hasDashboard}）`);
  A.ok('注册后进入主界面（.app-layout + .dashboard）', true);
  A.ok('主界面首屏文案', entered.rootText);

  // c) 退出 → 重名注册：Phase E 语义 = HTTP 200 + {success:false}，前端展示错误且不跳转
  await evalJs(`
    const btn = [...document.querySelectorAll('.app-layout button')].find((b) => b.textContent.includes('退出'));
    if (btn) btn.click();
    return true;
  `);
  const backToLogin = await waitUntil(page(`return { ok: !!document.querySelector('.login-page form') };`), 15000, 400);
  must(backToLogin.ok, '退出后未回到登录页');

  const dupFilled = await evalJs(`
    ${JS_SET_VALUE}
    const sw = document.querySelector('.login-page .switch a');
    if (sw) sw.click();
    await new Promise((r) => setTimeout(r, 200));
    const form = document.querySelector('.login-page form');
    setVal(form.querySelector('input[type=text]'), ${JSON.stringify(state.user)});
    setVal(form.querySelector('input[type=password]'), ${JSON.stringify(state.userPass)});
    await new Promise((r) => setTimeout(r, 100));
    form.querySelector('button[type=submit]').click();
    return true;
  `);
  must(dupFilled.ok, `重名注册步骤失败：${dupFilled.error}`);

  const dupShown = await waitUntil(page(`
    const err = document.querySelector('.login-page .error');
    return { ok: !!err && err.textContent.trim().length > 0, text: err ? err.textContent.trim() : '',
             stillOnLogin: !!document.querySelector('.login-page') };
  `), 15000, 400);
  must(dupShown.ok, '重名注册未展示错误提示（Phase E 期望 200+success:false → 展示错误）');
  A.ok('重名注册错误文案（Phase E 200+success:false）', dupShown.text);
  A.ok('重名后仍停留登录页（未误跳转）', dupShown.stillOnLogin);

  // d) 转登录成功 → 再次断言主界面
  await evalJs(`
    ${JS_SET_VALUE}
    const sw = document.querySelector('.login-page .switch a');
    if (sw) sw.click();
    await new Promise((r) => setTimeout(r, 200));
    const form = document.querySelector('.login-page form');
    setVal(form.querySelector('input[type=text]'), ${JSON.stringify(state.user)});
    setVal(form.querySelector('input[type=password]'), ${JSON.stringify(state.userPass)});
    await new Promise((r) => setTimeout(r, 100));
    form.querySelector('button[type=submit]').click();
    return true;
  `);
  const relogin = await waitUntil(page(`
    const layout = document.querySelector('.app-layout');
    const uname = document.querySelector('.app-layout .user-info .username');
    return { ok: !!layout && !!document.querySelector('.dashboard'), username: uname ? uname.textContent : '' };
  `), 25000, 500);
  must(relogin.ok, `转登录后未进入主界面（${relogin.error || ''}）`);
  A.eq('转登录后顶栏用户名', relogin.username, state.user);
  A.ok('转登录进入主界面', true);
  return {};
}

// 链路 ②：下单（选股 → 数量 → 买入）→ 断言成功提示 + 后端 pending 含该单
async function chainPlaceOrder(A) {
  await goto(`${state.frontendUrl}/`);
  const shell = await waitUntil(page(`
    return { ok: !!document.querySelector('.dashboard') && !!document.querySelector('.app-layout') };
  `), 25000, 500);
  must(shell.ok, '主交易页未渲染（可能未登录）');

  // 休市解锁状态：AppLayout 挂载时同步 /market/state 的 offHoursTrading → 确认下单按钮可用
  const unlocked = await waitUntil(page(`
    ${JS_ORDER_CARD}
    const btn = [...card.querySelectorAll('button')].find((b) => b.textContent.includes('确认下单'));
    return { ok: !!btn && !btn.disabled, text: btn ? btn.textContent : '', disabled: btn ? btn.disabled : null };
  `), 30000, 700);
  must(unlocked.ok, `确认下单按钮不可用（休市未解锁？文案="${unlocked && unlocked.text}"）`);
  A.ok('确认下单按钮可用（休市解锁生效）', unlocked.text);

  // 选股：T1（CN 默认标的），并取现价/涨跌幅反推昨收，用于构造「一定留存的挂单」
  const symbol = 'T1';
  const quote = await evalJs(`
    ${pageFetchStmt('/api/market/stocks')}
    return { status, body };
  `);
  must(quote.ok, `取行情失败：${quote.error}`);
  const rows = Array.isArray(quote.value.body) ? quote.value.body : [];
  const st = rows.find((r) => r.symbol === symbol);
  must(!!st, `行情列表缺少 ${symbol}（status=${quote.value.status} count=${rows.length}）`);
  // A 股涨跌停带 = [昨收×0.9, 昨收×1.1]（backend trading-engine.validateOrder 会逐价校验）。
  // 挂单必须"留在挂单簿里"才能被链路 ③ 撤掉，故**挂在离现价更远的那一侧**：
  //   上侧：止损限价单（不进盘口，只有涨到涨停价才触发）
  //   下侧：限价买单（只有跌到跌停价才可能成交）
  // 带内任一点到较远一侧的距离 ≥ 半带宽 ≈ 昨收的 10%，足以覆盖链路 ②→③ 之间的十几秒；
  // 两侧各留 1 分钱余量：昨收是用四舍五入过的 changePct 反推的，边界价可能因误差被判越界
  const prevClose = st.price / (1 + (Number(st.changePct) || 0) / 100);
  const bandUp = Number((Math.floor(prevClose * 1.1 * 100) / 100 - 0.01).toFixed(2));
  const bandDown = Number((Math.ceil(prevClose * 0.9 * 100) / 100 + 0.01).toFixed(2));
  const distUp = bandUp - st.price;
  const distDown = st.price - bandDown;
  const useStop = distUp >= distDown;      // 上侧更远 → 用止损限价；否则用下方限价
  const orderType = useStop ? 'stop-limit' : 'limit';
  const orderPrice = useStop ? bandUp : bandDown;
  const triggerPrice = useStop ? bandUp : null;
  const buffer = useStop ? distUp : distDown;
  A.eq('下单标的', symbol, 'T1');
  A.ok('下单现价', st.price);
  A.ok('挂单类型/价格（挂远端侧以保证留存）', `${orderType} @ ${orderPrice}${triggerPrice ? '（触发价 ' + triggerPrice + '）' : ''}，距现价 ${(buffer / st.price * 100).toFixed(2)}%`);
  must(buffer / st.price >= 0.05, `挂单价距现价仅 ${(buffer / st.price * 100).toFixed(2)}%，无法保证挂单留存`);

  // 选股：点击股票列表行（列表展示 code，故 code/symbol 任一匹配都算命中），
  // 并断言「下单」卡片标题同步到了该标的 —— 证明"选股"这一步真的作用到了下单面板
  const picked = await waitUntil(page(`
    const rows = [...document.querySelectorAll('.stock-list-row')];
    const row = rows.find((r) => {
      const sym = (r.querySelector('.stock-symbol') || {}).textContent || '';
      return sym.trim() === ${JSON.stringify(String(st.code))} || sym.trim() === ${JSON.stringify(symbol)};
    });
    if (row) row.click();
    await new Promise((r) => setTimeout(r, 400));
    const card = [...document.querySelectorAll('.card')].find((c) => ((c.querySelector('h3') || {}).textContent || '').includes('下单'));
    const title = card ? card.querySelector('h3').textContent.trim() : '';
    return { ok: !!row && title.includes(${JSON.stringify(symbol)}), clicked: !!row, title };
  `), 20000, 600);
  must(picked.ok, `选股失败或下单面板未切到 ${symbol}（clicked=${picked && picked.clicked} 标题="${picked && picked.title}"）`);
  A.ok('选股后下单面板标的', picked.title);

  // 选单型 + 买卖方向
  const setType = await evalJs(`
    ${JS_SET_VALUE}${JS_ORDER_CARD}
    const sels = card.querySelectorAll('select');
    setVal(sels[0], ${JSON.stringify(orderType)});
    setVal(sels[1], 'buy');
    await new Promise((r) => setTimeout(r, 300));
    return { type: sels[0].value, side: sels[1].value };
  `);
  must(setType.ok && setType.value.type === orderType && setType.value.side === 'buy', `下单表单切换失败：${setType.error || JSON.stringify(setType.value)}`);

  // 数量 + 价格 +（止损限价单才有的）触发价
  const setNums = await evalJs(`
    ${JS_SET_VALUE}${JS_ORDER_CARD}
    const inputs = [...card.querySelectorAll('input')];
    const qtyWrap = [...card.querySelectorAll('div')].find((d) => (d.textContent || '').startsWith('数量:'));
    const qtyInput = qtyWrap ? qtyWrap.querySelector('input') : null;
    const priceInput = inputs.find((i) => i.placeholder === '价格');
    const trigInput = inputs.find((i) => i.placeholder === '触发价');
    setVal(qtyInput, '100');
    setVal(priceInput, ${JSON.stringify(String(orderPrice))});
    if (trigInput) setVal(trigInput, ${JSON.stringify(String(triggerPrice ?? orderPrice))});
    await new Promise((r) => setTimeout(r, 300));
    return { qty: qtyInput.value, price: priceInput.value, trigger: trigInput ? trigInput.value : null };
  `);
  must(setNums.ok, `下单数值写入失败：${setNums.error}`);
  A.eq('下单数量', setNums.value.qty, '100');
  A.eq('委托价写入', setNums.value.price, String(orderPrice));

  // 买入
  await evalJs(`
    ${JS_ORDER_CARD}
    const btn = [...card.querySelectorAll('button')].find((b) => b.textContent.includes('确认下单'));
    if (btn && btn.disabled) return { clicked: false, disabled: true };
    btn.click();
    return { clicked: true };
  `);
  const toast = await waitUntil(page(`
    const els = [...document.querySelectorAll('.notification-container .notification')];
    const hit = els.find((e) => /下单成功|部分成交/.test(e.textContent));
    const bad = els.find((e) => /下单失败/.test(e.textContent));
    return { ok: !!hit, text: hit ? hit.textContent : (bad ? bad.textContent : '') };
  `), 20000, 400);
  must(toast.ok, `下单未出现成功提示（提示="${toast && toast.text}"）`);
  A.ok('成功提示文案', toast.text);

  // 后端 pending 含该单（页面内 fetch 带 JWT，页面侧直接给出 ok 判定）
  const pending = await waitUntil(page(`
    ${pageFetchStmt('/api/trading/orders/pending?mode=CN')}
    const list = Array.isArray(body) ? body : [];
    const hit = list.find((o) => o.symbol === ${JSON.stringify(symbol)} && Number(o.quantity) === 100);
    const order = hit ? { id: hit.id, symbol: hit.symbol, side: hit.side, quantity: hit.quantity, price: hit.price, status: hit.status } : null;
    return { ok: status === 200 && !!hit, status, count: list.length, order };
  `), 15000, 600);
  const mine = pending.order;
  must(mine, `后端 pending 未包含该单（status=${pending.status} count=${pending.count}${pending.error ? ' ' + pending.error : ''}）`);
  A.ok('pending 含该单', mine);
  state.placedOrderId = mine.id;
  return {};
}

// 链路 ③：撤单 → 断言挂单列表为空
async function chainCancelOrder(A) {
  must(state.placedOrderId, '链路 ② 未留下可撤的挂单');
  await goto(`${state.frontendUrl}/`);
  const cardReady = await waitUntil(page(`
    const card = [...document.querySelectorAll('.card')].find((c) => ((c.querySelector('h3') || {}).textContent || '').includes('当前挂单'));
    return { ok: !!card, text: card ? card.textContent : '' };
  `), 25000, 600);
  must(cardReady.ok, '未找到「当前挂单」卡片');
  must(/撤单/.test(cardReady.text), `挂单卡片内无撤单按钮：${String(cardReady.text).slice(0, 120)}`);

  await evalJs(`
    const card = [...document.querySelectorAll('.card')].find((c) => ((c.querySelector('h3') || {}).textContent || '').includes('当前挂单'));
    const btn = [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === '撤单');
    btn.click();
    await new Promise((r) => setTimeout(r, 200));
    const confirm = [...card.querySelectorAll('button')].find((b) => b.textContent.includes('确认撤单'));
    if (confirm) confirm.click();
    return true;
  `);
  const empty = await waitUntil(page(`
    const card = [...document.querySelectorAll('.card')].find((c) => ((c.querySelector('h3') || {}).textContent || '').includes('当前挂单'));
    return { ok: !!card && card.textContent.includes('无挂单'), text: card ? card.textContent.slice(0, 80) : '' };
  `), 20000, 600);
  must(empty.ok, `撤单后挂单列表未变空（卡片文案="${empty && empty.text}"）`);
  A.ok('挂单列表已空（UI）', true);

  const pending = await waitUntil(page(`
    ${pageFetchStmt('/api/trading/orders/pending?mode=CN')}
    const list = Array.isArray(body) ? body : [];
    return { ok: status === 200 && list.length === 0, status, count: list.length, ids: list.map((o) => o.id) };
  `), 15000, 600);
  A.eq('后端 pending 条数', pending.count, 0);
  must(pending.count === 0, `后端 pending 仍有 ${pending.count} 条（status=${pending.status} ids=${JSON.stringify(pending.ids)}）`);
  return {};
}

// 链路 ④：排行页 → 断言表格行数 > 0
async function chainRanking(A) {
  await goto(`${state.frontendUrl}/ranking`);
  const tabs = await waitUntil(page(`
    const labels = [...document.querySelectorAll('.ranking-tabs button')].map((b) => b.textContent.trim());
    return { ok: labels.length > 0, labels };
  `), 25000, 600);
  must(tabs.ok, '排行榜页未渲染 tab（未登录或路由异常）');
  A.ok('排行榜 tab 文案', tabs.labels.join(' / '));
  A.ok('存在赛季榜/全服榜切换', tabs.labels.some((t) => t.includes('赛季榜')) && tabs.labels.some((t) => t.includes('全服榜')));

  // 先切「全服榜」：赛季榜在无报名者时是空表，全服榜才有稳定行数；
  // 跨服/分市场 + 排序 tab 只在这一视图下渲染，故切换后再断言
  await evalJs(`
    const b = [...document.querySelectorAll('.ranking-tabs button')].find((x) => x.textContent.includes('全服榜'));
    if (b) b.click();
    return true;
  `);
  const allView = await waitUntil(page(`
    const labels = [...document.querySelectorAll('.ranking-tabs button')].map((b) => b.textContent.trim());
    return { ok: labels.some((t) => t.includes('跨服总榜')), labels, sort: labels.filter((t) => ['总收益', '今日', '总资产'].includes(t)) };
  `), 15000, 500);
  A.ok('全服榜视图 tab 文案', allView.labels.join(' / '));
  must(allView.ok, '全服榜视图缺少跨服总榜/分市场切换');
  A.ok('存在排序切换', allView.sort.length > 0);
  const rows = await waitUntil(page(`
    const tables = [...document.querySelectorAll('.ranking-page table')];
    const t = tables[tables.length - 1];
    const trs = t ? [...t.querySelectorAll('tbody tr')] : [];
    const real = trs.filter((tr) => !tr.textContent.includes('暂无排行数据'));
    return { ok: real.length > 0, count: real.length, first: real[0] ? real[0].textContent.replace(/\\s+/g, ' ').trim().slice(0, 60) : '' };
  `), 25000, 700);
  must(rows.ok, `全服排行表行数为 0（count=${rows && rows.count}）`);
  A.ok('全服排行有效行数', rows.count);
  A.ok('首行内容', rows.first);
  return {};
}

// 链路 ⑤：赛季报名区存在（缺失 / 当前不可报名 → SKIP，不 FAIL）
async function chainSeason(A) {
  const url = await evalJs(`return { href: location.pathname };`);
  if (!url.ok || !String(url.value.href).includes('ranking')) await goto(`${state.frontendUrl}/ranking`);
  const banner = await waitUntil(page(`
    const b = document.querySelector('.tournament-banner');
    const title = document.querySelector('.tournament-banner .tournament-title');
    const btn = [...document.querySelectorAll('.tournament-banner button')].find((x) => x.textContent.includes('报名'));
    return { ok: !!b, hasBanner: !!b, title: title ? title.textContent.replace(/\\s+/g, ' ').trim() : '',
             button: btn ? btn.textContent.trim() : '' };
  `), 25000, 600);
  if (!banner.ok) return { skip: '赛季报名区（.tournament-banner）未渲染：赛季模块可能未启用' };
  A.ok('赛季报名区存在', true);
  A.ok('赛季标题/状态文案', banner.title);
  must(banner.title.length > 0, '赛季报名区标题为空');

  if (!banner.button) {
    A.ok('当前无报名按钮（赛季进行中/已结算）', banner.title);
    return { skip: `赛季当前不可报名（状态文案：${banner.title.slice(0, 40)}）` };
  }
  await evalJs(`
    const btn = [...document.querySelectorAll('.tournament-banner button')].find((x) => x.textContent.includes('报名'));
    btn.click();
    return true;
  `);
  const toast = await waitUntil(page(`
    const els = [...document.querySelectorAll('.notification-container .notification')];
    const hit = els.find((e) => /报名成功|已参赛|已报名/.test(e.textContent));
    const bad = els.find((e) => /报名失败/.test(e.textContent));
    return { ok: !!hit, text: hit ? hit.textContent : (bad ? bad.textContent : '') };
  `), 20000, 500);
  A.ok('报名结果提示', toast.text || '(无提示)');
  must(toast.ok, `点击报名未成功（提示="${toast && toast.text}"）`);
  return {};
}

// 链路 ⑥：断线 → 离线横幅 → reload → 外壳非白屏
async function chainOfflineShell(A) {
  await goto(`${state.frontendUrl}/`);
  const shell = await waitUntil(page(`return { ok: !!document.querySelector('.dashboard') };`), 25000, 500);
  must(shell.ok, '主交易页未渲染');

  // WS 必须先是连上的（否则 disconnect 无从谈起）
  const wsUp = await waitUntil(page(`
    const s = window.__wsSocket;
    return { ok: !!s && s.connected === true, connected: !!(s && s.connected) };
  `), 25000, 600);
  must(wsUp.ok, 'WebSocket 未连接（/socket.io 反代不可用？），无法验证断线横幅');
  A.ok('__wsSocket 已连接', true);

  await evalJs(`window.__wsSocket.disconnect(); return true;`);
  // Dashboard 断线判定为 5s 轮询 → 最多等 8s
  const offline = await waitUntil(page(`
    const tip = document.querySelector('.ws-offline-tip');
    return { ok: !!tip, text: tip ? tip.textContent.trim() : '' };
  `), 12000, 500);
  must(offline.ok, '断线后未出现 .ws-offline-tip 离线横幅');
  must(offline.text.includes('断开'), `离线横幅文案不含「断开」："${offline.text}"`);
  A.ok('离线横幅文案', offline.text);
  A.ok('离线横幅截图', await shot('06-offline-banner.png')); // 断线态独立截图（⑥ 链路双证据）

  // reload → 外壳仍要有可见内容（离线壳不得白屏）
  await cli(['reload'], { timeoutMs: 45000 });
  const shellAfter = await waitUntil(page(`
    const root = document.getElementById('root');
    const visible = root ? root.getBoundingClientRect().height > 0 : false;
    const text = root ? (root.innerText || '').replace(/\\s+/g, ' ').trim() : '';
    const nodes = root ? root.querySelectorAll('*').length : 0;
    return { ok: !!root && nodes > 5 && visible && text.length > 10, nodes, height: root ? Math.round(root.getBoundingClientRect().height) : 0, text: text.slice(0, 80) };
  `), 30000, 700);
  must(shellAfter.ok, `reload 后 #root 无可见内容（nodes=${shellAfter && shellAfter.nodes} h=${shellAfter && shellAfter.height}）`);
  A.ok('#root 可见 DOM 节点数', shellAfter.nodes);
  A.ok('#root 高度(px)', shellAfter.height);
  A.ok('#root 首屏文案', shellAfter.text);
  A.ok('reload 后外壳非白屏', true);
  return {};
}

// ─────────────────────────── result.json 落盘与退出 ───────────────────────────

function writeResult(exitCode, note) {  const summary = { PASS: 0, FAIL: 0, SKIP: 0 };
  for (const c of state.chains) summary[c.status] = (summary[c.status] || 0) + 1;
  const result = {
    runId: RUN_ID,
    phase: 'F-4 浏览器级 E2E 冒烟（可选门禁）',
    startedAt: state.startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - state.startedAt.getTime(),
    strict: OPTS.strict,
    skippedAtSetup: state.skipReason || null,
    note: note || null,
    env: {
      frontendUrl: state.frontendUrl,
      backendPort: state.backendPort,
      previewPort: state.previewPort,
      gatewayPort: state.gatewayPort || null,
      previewProxiedApi: !state.gatewayPort,
      tempSqlite: state.tmpDb,               // 只是临时库路径，运行结束后已删除
      realDbTouched: false,                  // 红线声明：全程未触碰 backend/data/stockgame.db
      tickIntervalMs: Number(process.env.SGP_E2E_TICK_MS || 1000),
      sandboxFast: true,
      testUser: state.user || null,          // 仅用户名；密码不落盘
      nodeVersion: process.version,
      platform: `${process.platform} ${os.release()}`,
    },
    summary,
    exitCode,
    chains: state.chains,
  };
  const file = path.join(ARTIFACT_DIR, 'result.json');
  fs.writeFileSync(file, JSON.stringify(result, null, 2), 'utf8');
  return file;
}

async function finish(exitCode, note) {
  try { await cleanup(); } catch { /* 忽略 */ }
  let file = null;
  try { file = writeResult(exitCode, note); } catch (e) { say(`[warn] result.json 写入失败: ${e.message}`); }
  const summary = state.chains.map((c) => `${String(c.index).padStart(2, '0')}=${c.status}`).join(' ');
  log(`\n[summary] ${summary || '(未执行链路)'}`);
  log(`[artifacts] ${path.relative(ROOT, ARTIFACT_DIR)}${file ? ' / result.json' : ''}`);
  log(`[exit] ${exitCode}${note ? ' — ' + note : ''}`);
  try { if (logFd != null) fs.closeSync(logFd); } catch { /* 忽略 */ }
  process.exit(exitCode);
}

async function bailSkip(reason) {
  state.skipReason = reason;
  log(`\nSKIP: ${reason}`);
  await finish(OPTS.strict ? 1 : 0, `SKIP: ${reason}`);
}

// ─────────────────────────── 入口 ───────────────────────────

async function main() {
  if (OPTS.help) { say(USAGE); process.exit(0); }
  if (OPTS.unknown.length) log(`[warn] 忽略未知参数: ${OPTS.unknown.join(' ')}`);

  prepareArtifacts();
  if (OPTS.clean) cleanOldArtifacts();
  log(`=== Phase F-4 E2E 冒烟 ${RUN_ID} ===`);
  log(`[env] root=${ROOT}`);
  log(`[env] strict=${OPTS.strict} keep=${OPTS.keep} timeout=${OPTS.timeoutMs}ms`);
  log(`[env] 临时库=${state.tmpDb}（红线：不使用 backend/data/stockgame.db）`);

  // 总超时保险：到点即清理并退出（避免脚本卡死）
  const hardTimer = setTimeout(() => {
    log(`[timeout] 总超时 ${OPTS.timeoutMs}ms 触发，强制收尾`);
    finish(1, `总超时 ${OPTS.timeoutMs}ms`);
  }, OPTS.timeoutMs);
  hardTimer.unref();

  // 1) 预检（构建产物缺失 → SKIP）
  const pre = await preflight();
  if (pre) return bailSkip(pre);

  // 2) 起后端（临时库 + 沙箱快档）
  try {
    await startBackend();
  } catch (e) {
    return bailSkip(String(e.message || e));
  }
  // 3) 起前端 preview（dist 生产壳）
  try {
    await startPreview();
  } catch (e) {
    return bailSkip(String(e.message || e));
  }
  // 4) 浏览器入口（preview 未代理 /api 时用内置网关兜底）
  try {
    await resolveFrontDoor();
  } catch (e) {
    return bailSkip(String(e.message || e));
  }
  // 5) 用「本次运行独有的管理员口令」证明后端归属，并顺手开启休市交易（深夜/周末也能跑下单链路）。
  //    登录失败 = 这个端口上的后端不是本脚本起的（临时库红线）→ 直接 SKIP，绝不继续操作
  const off = await enableOffHoursTrading();
  if (!off.ok) return bailSkip(`无法确认 :${state.backendPort} 上的后端是本脚本实例（${off.reason}）—— 为避免误操作他人后端/真实库，已中止`);

  // 6) 开浏览器
  const br = await openBrowser();
  if (!br.ok) return bailSkip(br.reason);

  // 7) 6 条主链路（单条失败不阻断后续）
  await runChain(1, 'auth-login', chainAuth);
  await runChain(2, 'place-order', chainPlaceOrder);
  await runChain(3, 'cancel-order', chainCancelOrder);
  await runChain(4, 'ranking', chainRanking);
  await runChain(5, 'season-enroll', chainSeason);
  await runChain(6, 'offline-shell', chainOfflineShell);

  const failed = state.chains.filter((c) => c.status === 'FAIL');
  clearTimeout(hardTimer);
  await finish(failed.length ? 1 : 0, failed.length ? `FAIL ${failed.length} 条：${failed.map((c) => c.name).join(', ')}` : '全部通过');
}

process.on('uncaughtException', (e) => {
  log(`[fatal] uncaughtException: ${e && e.stack ? e.stack : e}`);
  finish(1, '未捕获异常');
});
process.on('unhandledRejection', (e) => {
  log(`[fatal] unhandledRejection: ${e && e.stack ? e.stack : e}`);
  finish(1, '未处理的 Promise 拒绝');
});
// Ctrl+C / 强杀：也要删临时库、杀子进程
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, () => { log(`[signal] ${sig}`); finish(1, `被信号 ${sig} 中断`); });
}

main().catch((e) => {
  log(`[fatal] ${e && e.stack ? e.stack : e}`);
  finish(1, '脚本异常');
});
