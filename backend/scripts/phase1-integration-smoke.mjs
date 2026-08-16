// P1 集成冒烟（开发用，不参与 CI）：用 null 依赖构造行情引擎实例，
// 验证 generateTick（厚尾跳跃）与 endOfDay（隔夜跳空）新逻辑在真实对象中不崩溃、数值合理。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { MarketDataService } = require('../dist/src/core/market-data/market-data.service');

const s = new MarketDataService(null, null, null, 'CN');
s.poolBySymbol.set('T1', { mu: 10, sigma: 0.02, theta: 0.15, market: 'CN' });
s.stocks.set('T1', {
  symbol: 'T1', industry: '半导体', price: 10, intrinsic: 10, volatility: 0.02, lastReturn: 0,
  prevClose: 10, dayOpen: 10, dayHigh: 10, dayLow: 10, dayVolume: 0, minuteCounter: 0,
  baseVolume: 10000, avgVolume: 10000, prevVolume: 10000, lastVolume: 0,
  kline1min: [], kline5min: [], klineDaily: [],
  current1min: null, current5min: null, currentDaily: null,
  trendCounter: 0, trendDirection: 0, trendAccumulated: 0, isTrending: false,
});
s.factors = { '宏观经济': 0, '行业景气': 0, '公司特质': 0, '市场情绪': 0, '国际环境': 0, '政策风险': 0, '消费景气': 0 };
s.marketRegime = 'sideways';

(async () => {
  const r = await s.generateTick();
  if (!r || !r.length || !Number.isFinite(r[0].price) || r[0].price <= 0) {
    console.error('FAIL generateTick', r);
    process.exit(1);
  }
  console.log('generateTick OK, price =', r[0].price.toFixed(4));
  const beforeClose = s.stocks.get('T1').price;
  await s.endOfDay();
  const st = s.stocks.get('T1');
  if (!Number.isFinite(st.price) || st.price <= 0 || !Number.isFinite(st.dayOpen)) {
    console.error('FAIL endOfDay', st);
    process.exit(1);
  }
  console.log(`endOfDay OK: 昨收=${beforeClose.toFixed(4)} → 今开=${st.dayOpen.toFixed(4)}（隔夜缺口 ${(st.lastReturn * 100).toFixed(2)}%，prevClose=${st.prevClose.toFixed(4)}）`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
