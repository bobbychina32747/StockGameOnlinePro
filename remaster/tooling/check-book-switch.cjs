// Optional browser regression for the built workbench. Run with Playwright and a Chromium browser.
// PLAYWRIGHT_MODULE and CHROMIUM_PATH can point to an existing local installation.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
require('./runtime.cjs');
const { createApplication } = require('../dist/apps/game-api/main.js');

async function checkSwitch(browser, url, viewport) {
  const page = await browser.newPage({ viewport, locale: 'zh-CN' });
  const mobile = viewport.width <= 768;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    await page.goto(url);
    await page.locator('.login-form .primary-button').click();
    const heading = page.locator('.instrument-heading h2');
    const book = page.locator('.order-book');
    const quote = book.locator('.book-row').first();
    if (mobile) await page.locator('.mobile-trade-bar .buy-button').click();
    await quote.waitFor();
    if (mobile) {
      await page.locator('.ticket-panel .mobile-only.icon-button').click();
      await page.locator('.instrument-picker').click();
    }
    const next = page.locator('.watch-select').nth(1);
    const company = await next.locator('strong').first().textContent();

    // The fixture's second CN stock is T2. Delay its first response, then fail that request once.
    let attempts = 0;
    await page.route('**/book/T2', async route => {
      if (++attempts > 1) return route.continue();
      await gate;
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    });
    await next.click();
    if (mobile) await page.locator('.mobile-trade-bar .buy-button').click();
    await book.getByText(/正在加载盘口/).waitFor();
    assert.equal(await heading.textContent(), company);
    assert.equal(await book.locator('.book-row').count(), 0, 'old prices must disappear on switch');
    const quantity = page.getByLabel('订单数量');
    await quantity.fill('137');
    release();
    await book.getByText(/盘口暂不可用/).waitFor();
    assert.equal(await book.locator('.book-row').count(), 0, 'a failed load must not expose previous quotes');
    await quote.waitFor();
    const price = await quote.locator('b').textContent();
    await quote.click();
    assert.equal(await page.getByLabel('订单限价').inputValue(), price.replaceAll(',', ''));
    assert.equal(await quantity.inputValue(), '137');
  } finally {
    release();
    await page.close();
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
  try {
    const server = await createApplication({
      port: Number(process.env.TEST_PORT || 19729), database: ':memory:', sandbox: true, authSandbox: true,
    });
    try {
      for (const viewport of [{width: 1440, height: 900}, {width: 390, height: 844}]) {
        await checkSwitch(browser, server.url, viewport);
        console.log('Book switch passed', viewport.width, viewport.height);
      }
    } finally {
      await server.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
