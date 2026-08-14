const { MarketDataService } = require('../dist/src/core/market-data/market-data.service');

describe('MarketDataService 行情引擎核心逻辑', () => {
  let svc;

  beforeEach(() => {
    // 构造器只初始化内存结构，不访问 repository；market='CN'
    svc = new MarketDataService(null, null, null, 'CN');
  });

  describe('clamp 边界钳制', () => {
    test('区间内原样返回', () => {
      expect(svc.clamp(5, 0, 10)).toBe(5);
    });
    test('小于下界 → 下界', () => {
      expect(svc.clamp(-5, 0, 10)).toBe(0);
    });
    test('大于上界 → 上界', () => {
      expect(svc.clamp(15, 0, 10)).toBe(10);
    });
  });

  describe('updateVolatility GARCH 波动率', () => {
    test('负收益的杠杆效应：波动率大于正收益', () => {
      const up = { volatility: 0.02, lastReturn: 0.05 };
      const down = { volatility: 0.02, lastReturn: -0.05 };
      svc.updateVolatility(up);
      svc.updateVolatility(down);
      expect(down.volatility).toBeGreaterThan(up.volatility);
    });

    test('波动率始终钳制在 [0.008, 0.8]', () => {
      const stock = { volatility: 0.5, lastReturn: -0.2 };
      svc.updateVolatility(stock);
      expect(stock.volatility).toBeGreaterThanOrEqual(0.008);
      expect(stock.volatility).toBeLessThanOrEqual(0.8);
    });
  });

  describe('updateTrend 趋势检测', () => {
    test('连续 3 根同向大波动 → isTrending=true', () => {
      const st = { trendDirection: 0, trendCounter: 0, trendAccumulated: 0, isTrending: false };
      svc.updateTrend(st, 0.01);
      svc.updateTrend(st, 0.01);
      svc.updateTrend(st, 0.01);
      expect(st.isTrending).toBe(true);
    });

    test('小波动 → 趋势重置', () => {
      const st = { trendDirection: 1, trendCounter: 5, trendAccumulated: 0.05, isTrending: true };
      svc.updateTrend(st, 0.001);
      expect(st.isTrending).toBe(false);
      expect(st.trendDirection).toBe(0);
      expect(st.trendCounter).toBe(0);
    });
  });

  describe('tradingTime 时段映射', () => {
    test('minute=0 → 9:30', () => {
      const t = svc.tradingTime(0, 0);
      expect(t.getHours()).toBe(9);
      expect(t.getMinutes()).toBe(30);
    });
    test('minute=120 → 13:00（午休后）', () => {
      const t = svc.tradingTime(0, 120);
      expect(t.getHours()).toBe(13);
      expect(t.getMinutes()).toBe(0);
    });
  });

  describe('calcFactorImpact 宏观因子 × 行业敏感度', () => {
    test('半导体对行业景气敏感度 1.6', () => {
      svc.factors = { 行业景气: 0.1 };
      expect(svc.calcFactorImpact({ industry: '半导体' })).toBeCloseTo(0.16, 6);
    });

    test('银行对宏观经济敏感度 1.8', () => {
      svc.factors = { 宏观经济: 0.1 };
      expect(svc.calcFactorImpact({ industry: '银行' })).toBeCloseTo(0.18, 6);
    });
  });

  describe('computeIndustryBubble 行业泡沫度', () => {
    test('泡沫度 = 均价 / 内在价值', () => {
      svc.stocks.set('A', { industry: '半导体', price: 100, intrinsic: 50 });
      svc.computeIndustryBubble();
      expect(svc.industryBubbleMap['半导体']).toBeCloseTo(2, 6);
    });
  });

  describe('P1 复权因子', () => {
    test('分红除权后累计复权因子并记录事件序列', () => {
      svc.stocks.set('A', { symbol: 'A', price: 10 });
      svc.recordDividend('A', 2, 5);
      expect(svc.stocks.get('A').price).toBe(8);
      const adj = svc.adjFactors.get('A');
      expect(adj.factor).toBeCloseTo(0.8, 6);
      expect(adj.series.length).toBe(1);
      expect(adj.series[0].day).toBe(5);
      expect(adj.series[0].factor).toBeCloseTo(0.8, 6);
    });

    test('多次分红因子累乘', () => {
      svc.stocks.set('B', { symbol: 'B', price: 10 });
      svc.recordDividend('B', 1, 3);   // 9/10 = 0.9
      svc.recordDividend('B', 4.5, 9); // 4.5/9 = 0.5 → 0.45
      const adj = svc.adjFactors.get('B');
      expect(adj.factor).toBeCloseTo(0.45, 6);
      expect(adj.series.length).toBe(2);
    });
  });

  describe('getIndices 指数实时计算', () => {
    test('上证指数随成分股涨跌计算', () => {
      svc.stocks.set('T1', { symbol: 'T1', code: '688001', market: 'CN', price: 110, prevClose: 100 });
      const indices = svc.getIndices();
      const sh = indices.find((i) => i.code === '000001');
      expect(sh.changePct).toBeCloseTo(10, 2);
      expect(sh.value).toBeCloseTo(3410, 2);
    });
  });
});
