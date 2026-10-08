// 排障：线上游戏厅页面到底怎么了
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('D:/npm-global/node_modules/@playwright/cli/node_modules/playwright');
const browser = await chromium.launch({ executablePath: 'C:\\Users\\lenovo\\AppData\\Local\\Thorium\\Application\\thorium.exe', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const logs = [];
page.on('console', (m) => logs.push('[' + m.type() + '] ' + m.text().slice(0, 160)));
page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message.slice(0, 200)));
page.on('requestfailed', (r) => logs.push('[failed] ' + r.url().slice(0, 120) + ' ' + (r.failure()?.errorText || '')));
page.on('response', (r) => { if (r.url().includes('/api/auth/identity/oauth/')) logs.push('[resp] ' + r.status() + ' ' + r.url().slice(0, 120)); });
await page.goto('https://bobbycn.cc/games/', { waitUntil: 'load' });
await page.waitForTimeout(9000);
const state = await page.evaluate(() => ({
  hasSiteAuth: typeof window.SiteAuth,
  hasSaves: typeof window.SiteSaves,
  status: window.SiteAuth ? window.SiteAuth.status() : null,
  endpoint: window.SiteAuth ? window.SiteAuth._internal.endpoint('/api/auth/identity/oauth/clients') : null,
  btn: (document.getElementById('btn-acct') || {}).textContent || '',
  who: (document.getElementById('acct-who') || {}).textContent || '',
}));
console.log(JSON.stringify(state, null, 2));
console.log('--- logs ---');
console.log(logs.slice(0, 25).join('\n'));
await browser.close();
