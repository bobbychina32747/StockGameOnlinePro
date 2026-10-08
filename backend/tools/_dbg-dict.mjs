// 排障：线上游戏厅页面的词典到底是哪一份
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('D:/npm-global/node_modules/@playwright/cli/node_modules/playwright');
const browser = await chromium.launch({ executablePath: 'C:\\Users\\lenovo\\AppData\\Local\\Thorium\\Application\\thorium.exe', headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
const reqs = [];
page.on('request', (r) => { if (r.url().includes('/i18n/')) reqs.push(r.url()); });
page.on('response', (r) => { if (r.url().includes('/i18n/')) reqs.push('  -> ' + r.status() + ' ' + r.url()); });
await page.goto('https://bobbycn.cc/games/', { waitUntil: 'load' });
await page.waitForTimeout(3000);
const state = await page.evaluate(async () => {
  const src = Array.from(document.querySelectorAll('script[src*="i18n"]')).map((s) => s.getAttribute('src'));
  const direct = await fetch('/i18n/zh-CN.js?v=20261009b', { cache: 'no-store' }).then((r) => r.text()).catch((e) => 'ERR ' + e.message);
  return {
    scripts: src,
    current: window.I18N ? window.I18N.current() : null,
    tSignOut: window.I18N ? window.I18N.t('games.acct.signOut') : null,
    tSiteLogin: window.I18N ? window.I18N.t('games.acct.siteLogin') : null,
    directHasSignOut: /games\.acct\.signOut/.test(direct),
    directLen: direct.length,
    directHead: direct.slice(0, 60),
  };
});
console.log(JSON.stringify(state, null, 2));
console.log('--- i18n 请求 ---');
console.log(reqs.slice(0, 12).join('\n'));
await browser.close();
