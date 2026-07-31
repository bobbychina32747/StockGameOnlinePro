#!/usr/bin/env node
/**
 * StockSim Pro 策略回测工具（B2）
 * 用历史 1min K 线回测 MA 交叉策略，输出收益摘要（不含手续费）
 * 运行：node backend/scripts/backtest.js [symbol] [fast] [slow]
 */
const http = require('http');
const BASE = process.env.API_BASE || 'http://localhost:8000/api';

function api(path) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + path);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

const smaArr = (closes, period) => {
  const out = new Array(closes.length).fill(null);
  let s = 0;
  for (let i = 0; i < closes.length; i++) {
    s += closes[i];
    if (i >= period) s -= closes[i - period];
    if (i >= period - 1) out[i] = s / period;
  }
  return out;
};

async function main() {
  const symbol = process.argv[2] || 'T1';
  const fast = Number(process.argv[3] || 5);
  const slow = Number(process.argv[4] || 20);
  const klines = await api(`/market/klines?symbol=${symbol}&timeframe=1min`);
  const closes = klines.map((k) => Number(k.close));
  if (closes.length < slow + 5) { console.log('历史数据不足'); return; }
  const maF = smaArr(closes, fast);
  const maS = smaArr(closes, slow);

  let cash = 100000;
  let shares = 0;
  let buyPrice = 0;
  let trades = 0;
  let wins = 0;

  for (let i = slow; i < closes.length; i++) {
    const prevF = maF[i - 1], prevS = maS[i - 1];
    const f = maF[i], s = maS[i];
    if (prevF == null || prevS == null) continue;
    // 金叉买入
    if (prevF <= prevS && f > s && shares === 0) {
      shares = Math.floor(cash / closes[i] / 100) * 100;
      if (shares > 0) { cash -= shares * closes[i]; buyPrice = closes[i]; }
    }
    // 死叉卖出
    else if (prevF >= prevS && f < s && shares > 0) {
      const profit = (closes[i] - buyPrice) / buyPrice;
      if (profit > 0) wins++;
      trades++;
      cash += shares * closes[i];
      shares = 0;
    }
  }
  if (shares > 0) { cash += shares * closes[closes.length - 1]; trades++; }
  const totalReturn = (cash - 100000) / 100000 * 100;
  console.log(`[回测] ${symbol} MA${fast}/MA${slow} · ${klines.length} 根 1min`);
  console.log(`  期末资金: ${cash.toFixed(2)} | 总收益: ${totalReturn.toFixed(2)}%`);
  console.log(`  交易次数: ${trades} | 胜率: ${trades ? (wins / trades * 100).toFixed(0) : 0}%`);
  console.log(`  建议: ${totalReturn > 0 ? '策略有效，可实盘验证' : '策略跑输，考虑改参数或换策略'}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
