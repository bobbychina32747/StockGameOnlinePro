// 排障：游戏厅页面在真浏览器里到底加载了什么
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('D:/npm-global/node_modules/@playwright/cli/node_modules/playwright');

const SITE = 'http://127.0.0.1:5199';
const browser = await chromium.launch({
  executablePath: 'C:\\Users\\lenovo\\AppData\\Local\\Thorium\\Application\\thorium.exe',
  headless: true,
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addInitScript(() => { window.DSH_AUTH_TEST_OVERRIDE = { siteRelay: 'http://127.0.0.1:5199', siteLoginBase: 'http://127.0.0.1:5199' }; });
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));
page.on('requestfailed', (r) => logs.push(`[failed] ${r.url()} ${r.failure()?.errorText}`));
await page.goto(`${SITE}/games/`, { waitUntil: 'load' });
await page.waitForTimeout(6000);
const state = await page.evaluate(() => ({
  hasSiteAuth: typeof window.SiteAuth,
  hasAccount: typeof window.DSHAccount,
  hasConfig: typeof window.DSH_AUTH_CONFIG,
  siteOverride: window.DSH_AUTH_TEST_OVERRIDE || null,
  status: window.SiteAuth ? window.SiteAuth.status() : null,
  endpoint: window.SiteAuth ? window.SiteAuth._internal.endpoint('/api/auth/identity/oauth/clients') : null,
  probe: window.SiteAuth ? window.SiteAuth._internal.probe() : null,
  btn: document.getElementById('btn-acct')?.textContent,
  who: document.getElementById('acct-who')?.textContent,
  scripts: Array.from(document.querySelectorAll('script[src]')).map((s) => s.getAttribute('src')),
}));
console.log(JSON.stringify(state, null, 2));
console.log('--- console/network ---');
console.log(logs.slice(0, 20).join('\n'));
await browser.close();
