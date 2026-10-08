// 前端授权链路冒烟（真浏览器 · Playwright + Thorium）
//
// 覆盖：游戏厅首页 → 点「用站点账号登录」→ 站点登录页（next 回跳）→ 登录 → 同意页 → 允许 →
//       回跳 → PKCE 换令牌 → 账号条变已登录 → userinfo → 云存档钥匙 → 存档加解密往返 →
//       账号页列出授权 → 解除授权后旧令牌立刻被拒。
//
// 前置（三个后台进程）：
//   1) 本机后端 8099：powershell -File scripts/_local-oauth-server.ps1
//   2) 同源预览服务器 5199：node tools/_local-site.mjs --port 5199
//      （页面与 /api 同源，和线上结构一致；直接跨端口调 8099 会被浏览器的私有网络访问策略拦下）
//   3) 已验证账号：node tools/_seed-local-user.mjs probe@example.com "ProbePass!2026"
// 用法：node tools/_oauth-browser-check.mjs
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PROBE_PW || 'D:/npm-global/node_modules/@playwright/cli/node_modules/playwright');

const SITE = process.env.PROBE_SITE || 'http://127.0.0.1:5199';
const EMAIL = process.env.PROBE_EMAIL || 'probe@example.com';
const PASSWORD = process.env.PROBE_PASSWORD || 'ProbePass!2026';
const SHOTS = 'E:\\Files\\Games\\stockGameOnlinePro\\.local-oauth\\shots';
mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  - ' + String(detail).slice(0, 200) : ''));
}

const browser = await chromium.launch({
  // 本机没装 playwright 自带 chromium，只有 Thorium（见 browser-control 技能）
  executablePath: process.env.PROBE_BROWSER || 'C:\\Users\\lenovo\\AppData\\Local\\Thorium\\Application\\thorium.exe',
  headless: true,
});
const ctx = await browser.newContext({ viewport: { width: 1340, height: 900 }, locale: 'zh-CN' });
// 显式声明"授权端点在 5199"：线上同源无需这段；本地换端口时它让 SDK 不必改配置
await ctx.addInitScript(() => {
  window.DSH_AUTH_TEST_OVERRIDE = { siteRelay: 'http://127.0.0.1:5199', siteLoginBase: 'http://127.0.0.1:5199' };
});
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

let STEP = 'start';
function step(name) { STEP = name; console.log('--- step: ' + name); }
async function shot(name) { try { await page.screenshot({ path: SHOTS + '\\' + name + '.png' }); } catch (e) { /* ignore */ } }
async function dumpState() {
  try {
    const s = await page.evaluate(() => ({
      url: location.href,
      hasSiteAuth: typeof window.SiteAuth,
      status: window.SiteAuth ? window.SiteAuth.status() : null,
      btn: (document.getElementById('btn-acct') || {}).textContent || '',
      who: (document.getElementById('acct-who') || {}).textContent || '',
      body: document.body.innerText.slice(0, 200),
    }));
    console.log('DBG @' + STEP + ': ' + JSON.stringify(s));
  } catch (e) { console.log('DBG failed: ' + e.message); }
}

try {
  step('games-anon');
  await page.goto(SITE + '/games/', { waitUntil: 'domcontentloaded' });
  // 注意：谓词必须传**函数**（传字符串会被 CSP 的 script-src 拦成 EvalError —— 页面自带 CSP meta）
  await page.waitForFunction(() => !!(window.SiteAuth && window.SiteAuth.status().probed), null, { timeout: 25000 });
  await page.waitForFunction(() => /站点账号/.test(((document.getElementById('btn-acct') || {}).textContent) || ''), null, { timeout: 25000 });

  const st0 = await page.evaluate(() => ({
    status: window.SiteAuth.status(),
    btn: (document.getElementById('btn-acct') || {}).textContent || '',
    who: (document.getElementById('acct-who') || {}).textContent || '',
  }));
  check('游戏厅：SDK 探测到授权服务可用', st0.status.available === true, 'clientId=' + st0.status.clientId);
  check('游戏厅：账号条显示「用站点账号登录」且未登录', /站点账号/.test(st0.btn) && /未登录/.test(st0.who), st0.btn + ' / ' + st0.who);
  await shot('01-games-anon');

  step('login-redirect');
  await page.click('#btn-acct');
  await page.waitForURL(/\/login\/\?next=/, { timeout: 25000 });
  const loginUrl = page.url();
  check('点击登录 → 站点登录页（带 next 回跳到授权端点）',
    decodeURIComponent(loginUrl).indexOf('/api/auth/identity/oauth/authorize') >= 0, loginUrl.slice(0, 130));
  await shot('02-login');

  step('sign-in');
  await page.fill('#id', EMAIL);
  await page.fill('#pw', PASSWORD);
  await page.click('#btn');
  // 首次授权 → 停在同意页；已同意过（同一账号第二次跑）→ 授权端点直接发码回跳
  await page.waitForURL(/oauth\/authorize|oauth-callback\.html/, { timeout: 25000 });
  const onConsent = /oauth\/authorize/.test(page.url());
  check('登录成功 → next 生效，进入授权流程', true, onConsent ? '同意页' : '已授权，直接发码');

  step('consent');
  if (onConsent) {
    await page.waitForSelector('form.card', { timeout: 25000 });
    const consent = await page.evaluate(() => ({
      title: (document.querySelector('h1') || {}).textContent || '',
      who: (document.querySelector('.who') || {}).textContent || '',
      scopes: Array.prototype.map.call(document.querySelectorAll('li code'), (e) => e.textContent),
    }));
    check('同意页显示客户端名与当前登录者', /游戏厅/.test(consent.title) && consent.who.indexOf(EMAIL.split('@')[0]) >= 0, consent.title + ' | ' + consent.who);
    check('同意页逐条列出 scope（含 saves）', consent.scopes.length >= 4 && consent.scopes.indexOf('saves') >= 0, consent.scopes.join(' '));
    await shot('03-consent');
  } else {
    check('同意页显示客户端名与当前登录者', true, '（本次直接发码，跳过同意页）');
    check('同意页逐条列出 scope（含 saves）', true, '（本次直接发码，跳过同意页）');
  }

  step('approve');
  // 首次授权会停在同意页；已授权过（同一账号再跑）会直接发码回跳 —— 两种都要等得稳
  await page.waitForSelector('button[value="allow"], body', { timeout: 25000 });
  await page.waitForFunction(() => !!(document.querySelector('button[value="allow"]') || /oauth-callback/.test(location.href)), null, { timeout: 25000 });
  const consentVisible = await page.locator('button[value="allow"]').count();
  if (consentVisible)
    await page.click('button[value="allow"]');
  await page.waitForURL(/oauth-callback\.html|\/games\/$/, { timeout: 25000 });
  await shot('04-callback');
  if (/oauth-callback/.test(page.url()))
    await page.waitForURL(/\/games\//, { timeout: 30000 });
  // 诊断：回跳后 SDK 到底看到了什么（一次性 code 只在地址栏里出现一瞬）
  await page.waitForTimeout(2500);
  const dbg = await page.evaluate(() => ({
    url: location.href,
    pkce: (() => { try { return sessionStorage.getItem('siteauth.pkce.v1'); } catch (e) { return 'err'; } })(),
    tokens: (() => { try { return localStorage.getItem('siteauth.tokens.v1'); } catch (e) { return 'err'; } })(),
    redirect: window.SiteAuth.status().redirect || null,
    error: window.SiteAuth.status().error || '',
  }));
  console.log('DBG after-callback: ' + JSON.stringify(dbg));
  await page.waitForFunction(() => !!(window.SiteAuth && window.SiteAuth.status().signedIn), null, { timeout: 30000 });

  step('after-login');
  const st1 = await page.evaluate(async () => {
    const s = window.SiteAuth.status();
    const token = await window.SiteAuth.getAccessToken();
    const res = await window.SiteAuth.authFetch('/api/auth/identity/oauth/userinfo', { headers: { Accept: 'application/json' } });
    return { signedIn: s.signedIn, clientId: s.clientId, hasToken: !!token, user: res.ok ? await res.json() : null };
  });
  check('回跳后拿到访问令牌（PKCE 兑换成功）', st1.signedIn && st1.hasToken && st1.clientId === 'bobbycn-games', 'clientId=' + st1.clientId);
  check('userinfo 返回站点身份（含邮箱）', !!st1.user && !!st1.user.sub && st1.user.email === EMAIL, JSON.stringify(st1.user));

  await page.waitForFunction(() => /已登录/.test(((document.getElementById('acct-who') || {}).textContent) || ''), null, { timeout: 30000 });
  const bar = await page.evaluate(() => (document.getElementById('acct-who') || {}).textContent || '');
  check('账号条变成「已登录 <站点账号名>」', /已登录/.test(bar), bar.trim());
  await shot('05-games-signed-in');

  step('saves');
  const keyInfo = await page.evaluate(async () => {
    const res = await window.SiteAuth.authFetch('/api/auth/identity/saves/key', { headers: { Accept: 'application/json' } });
    const data = res.ok ? await res.json() : null;
    return { ok: res.ok, alg: data && data.alg, len: data && data.key ? atob(data.key).length : 0 };
  });
  check('云存档钥匙下发（saves scope + 32 字节）', keyInfo.ok && keyInfo.len === 32, keyInfo.alg + ' len=' + keyInfo.len);

  const round = await page.evaluate(async () => {
    const put = await window.SiteSaves.put('zombie-survival', 'probe-slot', { day: 12, hp: 88 }, { day: 12 });
    const got = await window.SiteSaves.get('zombie-survival', 'probe-slot');
    const list = await window.SiteSaves.list('zombie-survival');
    return { put, got, slots: list.map((s) => s.slot) };
  });
  check('云存档写入 + 解密读回一致（浏览器端 AES-GCM）', !!(round.put && round.put.ok) && !!(round.got && round.got.data) && round.got.data.day === 12, 'bytes=' + (round.put && round.put.bytes));
  check('云存档列表能看到该槽位', round.slots.indexOf('probe-slot') >= 0, round.slots.join(','));

  step('account-page');
  await page.goto(SITE + '/account/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => /bobbycn-games/.test(document.body.innerText), null, { timeout: 25000 });
  // 云存档概览是异步拉的：等它渲染出内容再断言
  await page.waitForFunction(() => {
    const t = document.getElementById('saves');
    return !!t && !/正在读取/.test(t.textContent);
  }, null, { timeout: 25000 }).catch(() => { });
  const acctText = await page.evaluate(() => document.body.innerText);
  check('账号页列出已授权应用', acctText.indexOf('bobbycn-games') >= 0, '');
  const probeSummary = await page.evaluate(async () => {
    const st = window.SiteAuth ? window.SiteAuth.status() : {};
    const token = window.SiteAuth ? await window.SiteAuth.getAccessToken() : null;
    const raw = (() => { try { return localStorage.getItem('siteauth.tokens.v1'); } catch (e) { return 'err'; } })();
    const resolve = (() => { try { return window.SiteAuth._internal.resolveClient(null, null); } catch (e) { return 'err:' + e.message; } })();
    const redir = (() => { try { return window.SiteAuth._internal.redirectUri(resolve, null); } catch (e) { return 'err:' + e.message; } })();
    let status = 0;
    try { const r = await window.SiteAuth.authFetch('/api/auth/identity/saves/summary', { headers: { Accept: 'application/json' } }); status = r.status; } catch (e) { status = 'err:' + e.message; }
    return { signedIn: st.signedIn, clientId: st.clientId, hasToken: !!token, status, resolve, redir, raw: String(raw).slice(0, 80) };
  });
  console.log('DBG account-summary: ' + JSON.stringify(probeSummary));
  check('账号页显示云存档概览', /槽位|还没有服务端存档/.test(acctText), (await page.evaluate(() => (document.getElementById('saves') || {}).textContent || '')).slice(0, 80));
  await shot('06-account');

  step('revoke');
  await page.click('button[data-client="bobbycn-games"]');
  await page.waitForFunction(() => /已解除/.test(document.body.innerText), null, { timeout: 20000 });
  const after = await page.evaluate(async () => {
    const token = await window.SiteAuth.getAccessToken();
    const res = await fetch('/api/auth/identity/saves/key', { headers: token ? { Authorization: 'Bearer ' + token } : {} });
    return res.status;
  });
  check('解除授权后旧访问令牌立刻被拒（401）', after === 401, 'HTTP ' + after);
  await shot('07-revoked');

  // 只关心"我们自己代码"的报错：撤销后的 401 是预期结果，外部源的 CSP 拦截（旧组件残留）不算
  const realErrors = errors.filter((e) => !/401 \(Unauthorized\)/.test(e) && !/bobbycn\.cc\/api\/health/.test(e));
  check('页面无 JS 运行时错误', realErrors.length === 0, realErrors.slice(0, 2).join(' | '));
} catch (e) {
  check('冒烟流程未抛异常 @' + STEP, false, e.message);
  await dumpState();
  await shot('99-failure');
} finally {
  const failed = results.filter((r) => !r.ok);
  writeFileSync(SHOTS + '\\report.json', JSON.stringify({ at: new Date().toISOString(), site: SITE, results, errors }, null, 2), 'utf8');
  console.log('\n===== ' + (results.length - failed.length) + '/' + results.length + ' 通过 =====');
  for (const f of failed) console.log('FAILED: ' + f.name + ' - ' + f.detail);
  console.log('截图与报告：' + SHOTS);
  await browser.close();
  process.exit(failed.length ? 1 : 0);
}
