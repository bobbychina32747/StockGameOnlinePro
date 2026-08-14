#!/usr/bin/env node
/**
 * StockSim Pro 量化交易示例（纯 API 接入）
 * 策略：MA5 上穿 MA10 买入 / 下穿卖出（1min K 线），全市场轮询
 * 演示：独立 AI/脚本如何完全通过 REST API 获取行情并下单
 *
 * 运行：node backend/scripts/quant-bot.js [username] [password] [mode]
 * 参数：username 默认 Bobbychina，password 必填（环境变量 API_PASSWORD 或命令行第2参数），mode 默认 US
 * 注意：这是教学示例，不构成投资建议；真实策略请先做回测。请勿在文档/脚本中存放真实口令。
 */
const http = require('http');
const BASE = process.env.API_BASE || 'http://localhost:8000/api';
const USERNAME = process.argv[2] || 'Bobbychina';
const PASSWORD = process.argv[3] || process.env.API_PASSWORD || ''; // 必填：登录密码（不提供默认值）
const MODE = process.argv[4] || 'US';
const ORDER_QTY = 100;
const LOOP_SEC = 5;

function api(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + path);
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('bad json: ' + buf.slice(0, 120))); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── 指标：简单移动平均 ───
function sma(closes, period) {
  if (closes.length < period) return null;
  let s = 0;
  for (let i = closes.length - period; i < closes.length; i++) s += closes[i];
  return s / period;
}

async function main() {
  console.log(`[quant-bot] 连接 ${BASE}，模式 ${MODE}，策略 MA5/MA10 交叉`);
  const login = await api('POST', '/auth/login', { username: USERNAME, password: PASSWORD });
  if (!PASSWORD) { console.error('[quant-bot] 请传入密码: node quant-bot.js [用户名] [密码] [模式] 或设置环境变量 API_PASSWORD'); process.exit(1); }
  if (!login.token) { console.error('[quant-bot] 登录失败'); process.exit(1); }
  const token = login.token;
  console.log('[quant-bot] 登录成功');

  // 每次循环：全市场扫描信号 → 下单
  while (true) {
    try {
      const stocks = await api('GET', '/market/stocks', null, token);
      const positions = (await api('GET', '/account?mode=' + MODE, null, token)).positions || [];

      for (const s of stocks) {
        const klines = await api('GET', `/market/klines?symbol=${s.symbol}&timeframe=1min`, null, token);
        const closes = klines.map((k) => Number(k.close));
        if (closes.length < 12) continue;

        const ma5 = sma(closes, 5);
        const ma10 = sma(closes, 10);
        const prevMa5 = sma(closes.slice(0, -1), 5);
        const prevMa10 = sma(closes.slice(0, -1), 10);
        if (ma5 == null || ma10 == null || prevMa5 == null || prevMa10 == null) continue;

        const pos = positions.find((p) => p.symbol === s.symbol);
        const holdLong = pos ? (pos.longQty || 0) > 0 : false;

        // 金叉（上穿）：买入
        if (prevMa5 <= prevMa10 && ma5 > ma10 && !holdLong) {
          const res = await api('POST', `/trading/order?mode=${MODE}`, {
            symbol: s.symbol, type: 'market', side: 'buy', quantity: ORDER_QTY,
          }, token);
          console.log(`[quant-bot] 🟢 金叉买入 ${s.code} ${s.name} @ ${ma5.toFixed(2)} → ${res.success ? '成交' : '失败:' + (res.error || '')}`);
        }
        // 死叉（下穿）：卖出
        else if (prevMa5 >= prevMa10 && ma5 < ma10 && holdLong) {
          const res = await api('POST', `/trading/order?mode=${MODE}`, {
            symbol: s.symbol, type: 'market', side: 'sell', quantity: ORDER_QTY,
          }, token);
          console.log(`[quant-bot] 🔴 死叉卖出 ${s.code} ${s.name} → ${res.success ? '成交' : '失败:' + (res.error || '')}`);
        }
      }

      const acct = await api('GET', '/account?mode=' + MODE, null, token);
      console.log(`[quant-bot] 扫描完成 | 总资产 ${Number(acct.account.cash).toFixed(2)} | ${new Date().toLocaleTimeString()}`);
    } catch (e) {
      console.error('[quant-bot] 扫描出错:', e.message);
    }
    await sleep(LOOP_SEC * 1000);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
