#!/usr/bin/env node
/**
 * StockSim Pro 策略回测工具（Phase 6）
 * 真实手续费 + 滑点模型 + 多策略 + 基准对比，与前端回测页同一引擎（/market/backtest）
 * 运行：node backend/scripts/backtest.js [symbol] [strategy] [p1] [p2] [timeframe]
 *   strategy: ma_cross(快/慢线) | rsi_reversal(RSI周期) | momentum(回看天数)
 *   例：node scripts/backtest.js T1 rsi_reversal 14 60min
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

const STRATEGIES = ['ma_cross', 'rsi_reversal', 'momentum'];

async function main() {
  const symbol = process.argv[2] || 'T1';
  const strategy = STRATEGIES.includes(process.argv[3] || '') ? process.argv[3] : 'ma_cross';
  const timeframe = process.argv[6] || '1min';
  // p1/p2 语义随策略：ma_cross=fast/slow，rsi_reversal=period（p2 忽略），momentum=N（p2 忽略）
  const p1 = process.argv[4];
  const p2 = process.argv[5];
  const qs = new URLSearchParams({ symbol, strategy, timeframe });
  if (p1) qs.set(strategy === 'ma_cross' ? 'fast' : strategy === 'rsi_reversal' ? 'period' : 'momentumN', p1);
  if (p2 && strategy === 'ma_cross') qs.set('slow', p2);
  const r = await api(`/market/backtest?${qs.toString()}`);
  if (r.error) { console.log(r.error); return; }

  const paramsText = strategy === 'ma_cross' ? `MA${r.params.fast}/${r.params.slow}`
    : strategy === 'rsi_reversal' ? `RSI${r.params.rsiPeriod} 超卖30/超买70`
    : `动量${r.params.momentumN}日`;
  console.log(`[回测] ${r.symbol} ${paramsText} · ${r.timeframe} · ${r.bars} 根 · 市场${r.feeMode} · 滑点${r.slippageBps}bp`);
  console.log(`  总收益: ${r.totalReturn.toFixed(2)}% | 年化: ${r.annualizedReturn.toFixed(2)}% | 基准(买入持有): ${r.benchmarkReturn.toFixed(2)}%`);
  console.log(`  期末资金: ${r.finalEquity.toFixed(2)} | 最大回撤: ${r.maxDrawdown}% | 夏普: ${r.sharpe}${r.profitFactor ? ` | 盈亏因子: ${r.profitFactor}` : ''}`);
  console.log(`  交易: ${r.trades} 笔 | 胜率: ${r.winRate}% | 手续费: ${r.fees.toFixed(2)} | 滑点成本: ${r.slippageCost.toFixed(2)}`);
  const beat = r.totalReturn > r.benchmarkReturn;
  console.log(`  建议: ${r.totalReturn > 0 && beat ? '策略有效且跑赢基准，可实盘验证' : r.totalReturn > 0 ? '策略盈利但跑输买入持有' : '策略跑输，考虑改参数或换策略'}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
