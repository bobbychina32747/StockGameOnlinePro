// P3 基本面与新闻引擎：行业周期 / 财报预期差 / PEAD / 宏观日历 / 新闻衰减曲线
const F = require('../dist/src/core/market-data/fundamentals');
const { MarketDataService } = require('../dist/src/core/market-data/market-data.service');

function seqRand(values) {
  let i = 0;
  return () => values[i++ % values.length];
}
const randnZero = () => 0;

describe('P3 行业景气周期（马尔可夫）', () => {
  test('转移矩阵确定性', () => {
    expect(F.nextCyclePhase('expansion', () => 0.3)).toBe('expansion');
    expect(F.nextCyclePhase('expansion', () => 0.85)).toBe('peak');
    expect(F.nextCyclePhase('peak', () => 0.95)).toBe('contraction');
    expect(F.nextCyclePhase('contraction', () => 0.99)).toBe('trough');
    expect(F.nextCyclePhase('trough', () => 0.1)).toBe('expansion');
  });

  test('阶段效应：收缩期波动放大、估值中枢下移，扩张期相反', () => {
    expect(F.cycleEffects('contraction').volMul).toBeGreaterThan(F.cycleEffects('expansion').volMul);
    expect(F.cycleEffects('expansion').valuationBias).toBeGreaterThan(0);
    expect(F.cycleEffects('contraction').valuationBias).toBeLessThan(0);
    expect(F.cycleEffects('expansion').growthBias).toBeGreaterThan(F.cycleEffects('contraction').growthBias);
  });
});

describe('P3 公司基本面与财报预期差', () => {
  test('initFundamentals 确定性有界', () => {
    const f = F.initFundamentals(seqRand([0.5, 0.5, 0.5]));
    expect(f.revenueGrowth).toBeCloseTo(0.02, 10);
    expect(f.netMargin).toBeCloseTo(0.125, 10);
    expect(f.roe).toBeGreaterThan(-0.2);
    expect(f.roe).toBeLessThan(0.45);
  });

  test('一致预期向实际增速收敛（分析师跟踪）', () => {
    const f = F.initFundamentals(seqRand([0.5, 0.5, 0.5]));
    f.revenueGrowth = 0.2;
    f.consensusGrowth = -0.1;
    for (let i = 0; i < 300; i++) {
      F.evolveFundamentals(f, 'expansion', randnZero, seqRand([0.5]));
    }
    expect(Math.abs(f.consensusGrowth - f.revenueGrowth)).toBeLessThan(0.005);
  });

  test('surprise 五档分级阈值', () => {
    expect(F.surpriseClassOf(0.10, 0.04)).toBe(2);
    expect(F.surpriseClassOf(0.10, 0.075)).toBe(1);
    expect(F.surpriseClassOf(0.10, 0.10)).toBe(0);
    expect(F.surpriseClassOf(0.02, 0.09)).toBe(-2);
    expect(F.surpriseClassOf(0.02, 0.05)).toBe(-1);
  });

  test('财报披露：披露噪声与分级', () => {
    const f = { revenueGrowth: 0.12, consensusGrowth: 0.05, netMargin: 0.1, roe: 0.18, revision: 0 };
    const r = F.makeEarningsReport(f, 45, 'Q2', randnZero);
    expect(r.surpriseClass).toBe(2); // 12% vs 5% → 大超预期
    expect(r.surpriseLabel).toBe('大超预期');
    expect(r.roe).toBeCloseTo(18, 5);
  });

  test('披露日跳空分级幅度与 PEAD 同向', () => {
    const r = (cls) => F.earningsShock(cls, () => 0.5);
    expect(r(2)).toBeGreaterThan(r(1));
    expect(r(1)).toBeGreaterThan(Math.abs(r(0)));
    expect(r(-2)).toBeLessThan(r(-1));
    expect(F.peadDaily(2)).toBeGreaterThan(0);
    expect(F.peadDaily(-2)).toBeLessThan(0);
    expect(F.peadDaily(0)).toBe(0);
  });

  test('一致预期修正：大超后上调', () => {
    const f = { consensusGrowth: 0.05, revision: 0 };
    F.reviseConsensus(f, 2);
    expect(f.consensusGrowth).toBeCloseTo(0.08, 10);
    expect(f.revision).toBe(2);
  });
});

describe('P3 宏观数据日历', () => {
  test('事件落地：surprise 分级与实际值', () => {
    const def = { key: 'CPI', name: 'CPI', std: 0.4, base: 0 };
    const ok = F.rollMacroEvent(def, () => 0);
    expect(ok.surprise).toBe(0);
    expect(ok.actual).toBe(0);
    const up = F.rollMacroEvent(def, () => 2);
    expect(up.surprise).toBe(2);
    expect(up.actual).toBeCloseTo(0.8, 10);
    const capped = F.rollMacroEvent(def, () => 99);
    expect(capped.surprise).toBe(3);
  });

  test('事件定义含行业敏感度与市场因子', () => {
    for (const def of F.MACRO_EVENT_DEFS) {
      expect(def.key).toBeTruthy();
      expect(def.cadence).toBeGreaterThan(0);
      expect(def.marketFactor).toBeTruthy();
      expect(Object.keys(def.industries).length).toBeGreaterThan(0);
    }
  });
});

describe('P3 新闻影响衰减曲线', () => {
  test('首日全额、几何衰减、到期归零', () => {
    expect(F.newsDecayFactor(0, 4)).toBe(1);
    const d0 = F.newsDecayFactor(0, 4);
    const d1 = F.newsDecayFactor(1, 4);
    const d2 = F.newsDecayFactor(2, 4);
    expect(d1).toBeCloseTo(0.7, 10);
    expect(d2).toBeCloseTo(0.49, 10);
    expect(d0).toBeGreaterThan(d1);
    expect(F.newsDecayFactor(4, 4)).toBe(0);
    expect(F.newsDecayFactor(-1, 4)).toBe(0);
  });
});

describe('P3 行情引擎集成（null 依赖构造）', () => {
  function makeService() {
    const s = new MarketDataService(null, null, null, 'CN');
    s.stocks.set('T1', {
      symbol: 'T1', name: '测试', industry: '银行', price: 10, intrinsic: 10,
      volatility: 0.02, lastReturn: 0, prevClose: 10, dayOpen: 10, dayHigh: 10, dayLow: 10,
      dayVolume: 0, minuteCounter: 0, baseVolume: 10000, avgVolume: 10000, prevVolume: 10000, lastVolume: 0,
      kline1min: [], kline5min: [], klineDaily: [], current1min: null, current5min: null, currentDaily: null,
      trendCounter: 0, trendDirection: 0, trendAccumulated: 0, isTrending: false,
      fund: F.initFundamentals(seqRand([0.5, 0.5, 0.5])),
      nextReportDay: 0, pead: null,
    });
    s.industryCycles.set('银行', 'expansion');
    s.factors = { '宏观经济': 0, '行业景气': 0, '公司特质': 0, '市场情绪': 0, '国际环境': 0, '政策风险': 0, '消费景气': 0 };
    return s;
  }

  test('generateReports：按披露日历触发，含预期差/PEAD/下一披露日', () => {
    const s = makeService();
    const st = s.stocks.get('T1');
    st.fund = { revenueGrowth: 0.15, consensusGrowth: 0.02, netMargin: 0.12, roe: 0.2, revision: 0 };
    const n = s.generateReports();
    expect(n).toBe(1);
    const report = s.reports.get('T1')[0];
    expect(report.surpriseClass).toBe(2);
    expect(report.consensusGrowth).toBeCloseTo(0.02, 3);
    expect(report.industryPhase).toBe('expansion');
    expect(st.pead.daysLeft).toBe(5);
    expect(st.nextReportDay).toBeGreaterThanOrEqual(45);
  });

  test('新闻因果链：个股新闻即时冲击 + 持久档案，逐日衰减后移除', () => {
    const s = makeService();
    const st = s.stocks.get('T1');
    const before = st.price;
    s.applyNewsImpact({ title: '利好', type: 'bullish', targetedSymbol: 'T1', duration: 3, impact: {} });
    expect(st.price).toBeGreaterThan(before);
    expect(s.newsImpacts.length).toBe(1);
    expect(s.newsImpacts[0]).toMatchObject({ mode: 'symbol', symbol: 'T1', daysLeft: 3 });
    s.applyPersistentNewsImpacts();
    expect(s.newsImpacts[0].daysLeft).toBe(2);
    s.applyPersistentNewsImpacts();
    s.applyPersistentNewsImpacts();
    expect(s.newsImpacts.length).toBe(0);
    expect(Number.isFinite(st.price)).toBe(true);
  });

  test('宏观日历：到期事件落地 → 历史记录 + 因子/行业持久影响档案 + 重新排期', () => {
    const s = makeService();
    s.gameDay = 10;
    s.macroEvents = [{ ...F.MACRO_EVENT_DEFS[0], dueDay: 10 }];
    s.runMacroCalendar();
    expect(s.macroHistory.length).toBe(1);
    expect(s.macroHistory[0].key).toBe('CPI');
    expect(s.macroEvents[0].dueDay).toBe(10 + F.MACRO_EVENT_DEFS[0].cadence);
    expect(s.newsImpacts.length).toBe(2); // 市场因子 + 行业传导
    expect(Number.isFinite(s.stocks.get('T1').price)).toBe(true);
  });

  test('每日管线：行业周期演化 + 基本面演化 + PEAD 递减', () => {
    const s = makeService();
    const st = s.stocks.get('T1');
    st.pead = { mag: 0.0015, daysLeft: 5 };
    const before = { ...st.fund };
    s.evolveIndustryCycles();
    expect(s.industryCycles.get('银行')).toBeTruthy();
    s.evolveFundamentalsDaily();
    expect(Number.isFinite(st.fund.revenueGrowth)).toBe(true);
    expect(st.pead.daysLeft).toBe(4);
    expect(Number.isFinite(before.revenueGrowth)).toBe(true);
  });
});
