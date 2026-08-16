// P4 AI 对手盘：本地策略 + 本地随机森林（零外部 API）+ 羊群 + 绩效记账
const A = require('../dist/src/core/market-data/ai-opponents');
const { MarketDataService } = require('../dist/src/core/market-data/market-data.service');

describe('P4 本地随机森林（RF）', () => {
  test('特征打分：利好特征组合 → 正分，利空组合 → 负分', () => {
    const bull = A.rfScore({ ret: 0.03, vol: 0.02, ofi: 0.5, cycle: 0, senti: 0.1 });
    const bear = A.rfScore({ ret: -0.03, vol: 0.06, ofi: -0.5, cycle: 2, senti: -0.1 });
    expect(bull).toBeGreaterThan(0.2);
    expect(bear).toBeLessThan(-0.2);
  });

  test('打分有界 [-1,1] 且缺失特征不崩溃', () => {
    expect(A.rfScore({})).toBeGreaterThanOrEqual(-1);
    expect(A.rfScore({})).toBeLessThanOrEqual(1);
    expect(A.rfScore({ ret: 0, vol: 0, ofi: 0, cycle: 0, senti: 0 })).toBeGreaterThanOrEqual(-1);
  });
});

describe('P4 本地策略信号', () => {
  const up = { ret: 0.02, vol: 0.02, ofi: 0.3, cycle: 0, senti: 0.05 };
  const down = { ret: -0.02, vol: 0.02, ofi: -0.3, cycle: 2, senti: -0.05 };

  test('趋势跟随：上涨看多、下跌看空', () => {
    expect(A.strategySignal('trend', up)).toBeGreaterThan(0.3);
    expect(A.strategySignal('trend', down)).toBeLessThan(-0.3);
  });

  test('均值回归/反转：与趋势相反', () => {
    expect(A.strategySignal('meanrev', up)).toBeLessThan(0);
    expect(A.strategySignal('reversal', up)).toBeLessThan(0);
    expect(A.strategySignal('meanrev', down)).toBeGreaterThan(0);
  });

  test('羊群：热点板块信号显著增强', () => {
    expect(A.strategySignal('herd', up, true)).toBeGreaterThan(A.strategySignal('herd', up, false));
  });

  test('动量：强趋势信号更强', () => {
    expect(A.strategySignal('momentum', { ...up, ret: 0.05 })).toBeGreaterThan(A.strategySignal('momentum', up));
  });

  test('decideDirection：确定性 RNG 与阈值', () => {
    expect(A.decideDirection('trend', up, false, () => 0.5)).toBe(1);
    expect(A.decideDirection('trend', down, false, () => 0.5)).toBe(-1);
    expect(A.decideDirection('trend', { ret: 0, vol: 0.02, ofi: 0, cycle: 0, senti: 0 }, false, () => 0.5)).toBe(0);
  });
});

describe('P4 AI 对手盘定义与绩效记账', () => {
  test('10 个具名对手盘，策略在合法集合内', () => {
    expect(A.AI_OPPONENT_DEFS.length).toBe(10);
    for (const d of A.AI_OPPONENT_DEFS) {
      expect(d.name).toBeTruthy();
      expect(['trend', 'meanrev', 'momentum', 'herd', 'reversal', 'noise']).toContain(d.strategy);
      expect(['机构', '游资', '散户']).toContain(d.type);
    }
  });

  test('绩效记账：盈亏/胜率/交易数', () => {
    const ledger = { trades: 0, wins: 0, losses: 0, realizedPnl: 0 };
    A.recordAiTrade(ledger, 5000);
    A.recordAiTrade(ledger, -2000);
    expect(ledger.trades).toBe(2);
    expect(ledger.wins).toBe(1);
    expect(ledger.losses).toBe(1);
    expect(ledger.realizedPnl).toBe(3000);
    expect(A.winRateOf(ledger)).toBeCloseTo(0.5, 10);
  });

  test('段位：高收益高胜率高活跃 → 王者；平庸 → 青铜/白银', () => {
    expect(A.tierFor(1.0, 1.0, 200).tier).toBe('王者');
    expect(['青铜', '白银']).toContain(A.tierFor(0, 0.3, 1).tier);
  });
});

describe('P4 行情引擎集成（AI 对手盘绩效与订单流信号）', () => {
  function makeService() {
    const s = new MarketDataService(null, null, null, 'CN');
    s.stocks.set('T1', {
      symbol: 'T1', name: '测试', industry: '银行', market: 'CN', price: 10, intrinsic: 10,
      volatility: 0.02, lastReturn: 0, prevClose: 10, dayOpen: 10, dayHigh: 10, dayLow: 10,
      dayVolume: 0, minuteCounter: 0, baseVolume: 10000, avgVolume: 10000, prevVolume: 10000, lastVolume: 0,
      kline1min: [], kline5min: [], klineDaily: [], current1min: null, current5min: null, currentDaily: null,
      trendCounter: 0, trendDirection: 0, trendAccumulated: 0, isTrending: false,
      fund: null, nextReportDay: 999, pead: null,
    });
    s.industryCycles.set('银行', 'expansion');
    s.factors = { '宏观经济': 0, '行业景气': 0, '公司特质': 0, '市场情绪': 0, '国际环境': 0, '政策风险': 0, '消费景气': 0 };
    return s;
  }

  test('getAiOpponents：10 个对手盘含净值/收益率/胜率/段位/嘲讽', () => {
    const s = makeService();
    const list = s.getAiOpponents();
    expect(list.length).toBe(10);
    for (const o of list) {
      expect(o.name).toBeTruthy();
      expect(o.strategyName).toBeTruthy();
      expect(o.taunt).toBeTruthy();
      expect(typeof o.equity).toBe('number');
      expect(typeof o.pnlPct).toBe('number');
      expect(typeof o.winRate).toBe('number');
      expect(o.tier).toBeTruthy();
    }
    // 排序：pnlPct 降序
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1].pnlPct).toBeGreaterThanOrEqual(list[i].pnlPct);
    }
  });

  test('markAiEquityDaily：净值快照记录', () => {
    const s = makeService();
    s.markAiEquityDaily();
    expect(s.aiLedger[0].equityHistory.length).toBe(1);
    expect(s.aiLedger[0].equityHistory[0].equity).toBeGreaterThan(0);
  });

  test('getFlowSignals：OFI 与主力净流入结构', () => {
    const s = makeService();
    s.bigOrderFlow.set('T1', 25000);
    const sig = s.getFlowSignals('T1');
    expect(sig).toMatchObject({ symbol: 'T1', bigNetFlow: 25000, bigNetFlowWan: 2.5 });
    expect(typeof sig.ofi).toBe('number');
    expect(['买压', '卖压', '均衡']).toContain(sig.label);
  });

  test('P5 行情后处理拆分：postTickProcessing 独立可执行（不依赖 generateTick）', async () => {
    const s = makeService();
    s.hotTopics = [{ industry: '银行', day: 0, duration: 2, strength: 0.1 }];
    await s.postTickProcessing(); // null 引擎下不崩溃（AI 挂单/做市商均守卫）
    expect(Number.isFinite(s.stocks.get('T1').price)).toBe(true);
  });
});
