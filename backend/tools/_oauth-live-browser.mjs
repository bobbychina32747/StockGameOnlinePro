// 线上真浏览器冒烟（只读 + 一步跳转，不做任何写操作）
// 验的是"玩家打开 bobbycn.cc/games 看到什么、点登录会走到哪"。
// 用法：node tools/_oauth-live-browser.mjs
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PROBE_PW || 'D:/npm-global/node_modules/@playwright/cli/node_modules/playwright');

const SITE = process.env.PROBE_SITE || 'https://bobbycn.cc';
const SHOTS = 'E:\\Files\\Games\\stockGameOnlinePro\\.local-oauth\\live-shots';
mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  - ' + String(detail).slice(0, 200) : ''));
}

const browser = await chromium.launch({
  executablePath: process.env.PROBE_BROWSER || 'C:\\Users\\lenovo\\AppData\\Local\\Thorium\\Application\\thorium.exe',
  headless: true,
});
const ctx = await browser.newContext({ viewport: { width: 1340, height: 900 }, locale: 'zh-CN' });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const shot = async (n) => { try { await page.screenshot({ path: SHOTS + '\\' + n + '.png' }); } catch (e) { /* ignore */ } };

try {
  // ① 游戏厅首页：SDK 探测到线上授权服务，账号条显示「用站点账号登录」
  await page.goto(SITE + '/games/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.SiteAuth && window.SiteAuth.status().probed), null, { timeout: 30000 });
  await page.waitForFunction(() => /站点账号/.test(((document.getElementById('btn-acct') || {}).textContent) || ''), null, { timeout: 30000 });
  const st = await page.evaluate(() => ({
    status: window.SiteAuth.status(),
    btn: (document.getElementById('btn-acct') || {}).textContent || '',
    who: (document.getElementById('acct-who') || {}).textContent || '',
    regHidden: !!document.getElementById('btnReg')?.hasAttribute('hidden'),
    savesLoaded: typeof window.SiteSaves === 'object',
  }));
  check('线上：SDK 探测到授权服务可用', st.status.available === true, 'clientId=' + st.status.clientId);
  check('线上：账号条显示「用站点账号登录」', /站点账号/.test(st.btn), st.btn + ' / ' + st.who);
  check('线上：顶部重复的注册/登录入口已隐藏', st.regHidden === true, '');
  check('线上：云存档 SDK 已加载', st.savesLoaded === true, '');
  await shot('live-01-games-anon');

  // ② 点登录 → 授权端点 → 未登录 → 站点登录页（带 next 回跳）
  await page.click('#btn-acct');
  await page.waitForURL(/\/login\/\?next=/, { timeout: 30000 });
  const loginUrl = page.url();
  check('线上：点击登录 → 授权端点把未登录用户送到站点登录页（带 next）',
    decodeURIComponent(loginUrl).indexOf('/api/auth/identity/oauth/authorize') >= 0, loginUrl.slice(0, 140));
  const loginBody = await page.evaluate(() => document.body.innerText.slice(0, 120).replace(/\s+/g, ' '));
  check('线上：登录页提示了"正在授权哪个应用"', /授权|bobbycn-games/.test(loginBody), loginBody.slice(0, 90));
  await shot('live-02-login');

  // ③ 不带凭据直接访问授权端点：应当渲染同意页 or 302 登录（不能 500/白屏）
  const probe = await ctx.newPage();
  const resp = await probe.goto(SITE + '/api/auth/identity/oauth/authorize?client_id=bobbycn-games&redirect_uri=' +
    encodeURIComponent('https://bobbycn.cc/games/oauth-callback.html') +
    '&response_type=code&scope=openid+profile+saves&state=live&code_challenge=' + 'a'.repeat(43) + '&code_challenge_method=S256',
    { waitUntil: 'domcontentloaded' }).catch((e) => ({ status: () => 'err:' + e.message }));
  const probeUrl = probe.url();
  check('线上：授权端点行为正确（302 到登录页，不是 5xx/白屏）',
    probeUrl.indexOf('/login/') >= 0, 'status=' + (resp && resp.status ? resp.status() : '?') + ' url=' + probeUrl.slice(0, 100));
  await probe.close();

  const realErrors = errors.filter((e) => !/favicon|401 \(Unauthorized\)/.test(e));
  check('线上：页面无 JS 运行时错误', realErrors.length === 0, realErrors.slice(0, 2).join(' | '));
} catch (e) {
  check('线上冒烟未抛异常', false, e.message);
  await shot('live-99-failure');
} finally {
  const failed = results.filter((r) => !r.ok);
  writeFileSync(SHOTS + '\\report.json', JSON.stringify({ at: new Date().toISOString(), site: SITE, results, errors }, null, 2), 'utf8');
  console.log('\n===== ' + (results.length - failed.length) + '/' + results.length + ' 通过 =====');
  for (const f of failed) console.log('FAILED: ' + f.name + ' - ' + f.detail);
  console.log('截图：' + SHOTS);
  await browser.close();
  process.exit(failed.length ? 1 : 0);
}
