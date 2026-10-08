// i18n 真机自检：在真浏览器里把语言切一遍，抓"词条没生效"的两类症状
//   ① 文案显示成 key 本身（例如 "account.h1"）——词典没加载/被缓存成旧版/漏词条
//   ② 语言切换后页面没跟着变（静态文案没接 i18n，或动态块没订阅 I18n.onChange）
//
// 用法：node tools/_i18n-browser-check.mjs                 （打线上）
//       $env:SITE='http://127.0.0.1:5199'; node tools/_i18n-browser-check.mjs   （打本机预览）
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PROBE_PW || 'D:/npm-global/node_modules/@playwright/cli/node_modules/playwright');

const SITE = process.env.SITE || 'https://bobbycn.cc';
const SHOTS = 'E:\\Files\\Games\\stockGameOnlinePro\\.local-oauth\\i18n-shots';
mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  - ' + String(detail).slice(0, 240) : ''));
}

// 页面里出现这种形状 = 词条没生效（显示成了 key）
const KEY_LEAK = /\b(?:account|games|home|nav|site|thanks|i18n)\.[a-zA-Z][a-zA-Z0-9._-]{2,}\b/;

const browser = await chromium.launch({
  executablePath: process.env.PROBE_BROWSER || 'C:\\Users\\lenovo\\AppData\\Local\\Thorium\\Application\\thorium.exe',
  headless: true,
});

const PAGES = [
  { name: '游戏厅', path: '/games/', expectZh: /游戏厅/, expectEn: /Arcade|Games/i },
  { name: '账号页', path: '/account/', expectZh: /账号/, expectEn: /Account/ },
];

try {
  for (const spec of PAGES) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
    const page = await ctx.newPage();
    const consoleWarns = [];
    page.on('console', (m) => { if (m.type() === 'warning') consoleWarns.push(m.text()); });

    await page.goto(SITE + spec.path, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);

    // ① 中文（默认）：正文里不应出现 key 形状的文案
    const zhText = await page.evaluate(() => document.body.innerText);
    const zhLeak = (zhText.match(new RegExp(KEY_LEAK.source, 'g')) || []).filter((s) => !/^https?:/.test(s));
    check(`${spec.name} zh-CN：没有词条显示成 key`, zhLeak.length === 0 && spec.expectZh.test(zhText),
      zhLeak.length ? '泄漏: ' + zhLeak.slice(0, 5).join(',') : 'ok');
    const missing = consoleWarns.filter((w) => /缺词条/.test(w));
    check(`${spec.name} zh-CN：控制台无"缺词条"告警`, missing.length === 0, missing.slice(0, 3).join(' | '));
    await page.screenshot({ path: SHOTS + '\\' + spec.name + '-zh.png' });

    // ② 切到英文：静态文案与运行时拼的块都要跟着变
    const switched = await page.evaluate(() => {
      if (!window.I18N || !window.I18N.set) return false;
      window.I18N.set('en');
      return true;
    });
    await page.waitForTimeout(1200);
    const enText = await page.evaluate(() => document.body.innerText);
    const enLeak = (enText.match(new RegExp(KEY_LEAK.source, 'g')) || []).filter((s) => !/^https?:/.test(s));
    // 账号条/面板这类 JS 重画的块：切语言后不能再出现中文主文案（否则就是"没跟着切"）
    const dynamicOk = await page.evaluate(() => {
      const btn = (document.getElementById('btn-acct') || {}).textContent || '';
      const who = (document.getElementById('acct-who') || {}).textContent || '';
      const out = (document.getElementById('btnOut') || {}).textContent || '';
      const bad = /站点账号|未登录|已登录|账号与云存档|注册|退出登录|正在读取|已授权的应用|退出$/.test(btn + who + out);
      return { ok: !bad, btn: btn.trim(), who: who.trim(), out: out.trim() };
    });
    check(`${spec.name} en：切换后文案是英文且无 key 泄漏`,
      switched && enLeak.length === 0 && spec.expectEn.test(enText),
      enLeak.length ? '泄漏: ' + enLeak.slice(0, 5).join(',') : '');
    check(`${spec.name} en：JS 重画的块也跟着切了（账号条/按钮不留中文）`,
      !!dynamicOk.ok, 'btn="' + dynamicOk.btn + '" who="' + dynamicOk.who + '" out="' + dynamicOk.out + '"');
    await page.screenshot({ path: SHOTS + '\\' + spec.name + '-en.png' });

    // ③ 切回中文
    await page.evaluate(() => { if (window.I18N && window.I18N.set) window.I18N.set('zh-CN'); });
    await page.waitForTimeout(800);
    const backText = await page.evaluate(() => document.body.innerText);
    check(`${spec.name}：切回 zh-CN 正常`, spec.expectZh.test(backText) && !KEY_LEAK.test(backText), '');

    await ctx.close();
  }
} catch (e) {
  check('i18n 真机自检未抛异常', false, e.message);
} finally {
  const failed = results.filter((r) => !r.ok);
  writeFileSync(SHOTS + '\\report.json', JSON.stringify({ at: new Date().toISOString(), site: SITE, results }, null, 2), 'utf8');
  console.log('\n===== ' + (results.length - failed.length) + '/' + results.length + ' 通过 =====');
  for (const f of failed) console.log('FAILED: ' + f.name + ' - ' + f.detail);
  console.log('截图：' + SHOTS);
  await browser.close();
  process.exit(failed.length ? 1 : 0);
}
