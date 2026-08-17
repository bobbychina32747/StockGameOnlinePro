// P5 账户/风控/多市场：配对级绩效 + 券源池 + 动态折算率 + 新股首日带宽 + 动态汇率
const { pairedMetrics } = require('../dist/src/core/risk-manager/perf');
const { shortMarginRateFor, getFxRates, setFxRates, FX_CNY_PER_UNIT } = require('../dist/src/common/constants');
const { MatchingEngine } = require('../dist/src/core/trading-engine/matching-engine');

describe('P5 配对级绩效（FIFO 流水配对）', () => {
  const day = (offset, side, qty, price, symbol = 'T1') => ({
    symbol, side, quantity: qty, price, turnover: qty * price,
    createdAt: new Date(2026, 0, offset),
  });

  test('一买一卖：盈亏/胜率/月度收益', () => {
    const r = pairedMetrics([day(5, 'buy', 100, 10), day(10, 'sell', 100, 12)]);
    expect(r.pairedTrades).toBe(1);
    expect(r.pairedWinRate).toBe(1);
    expect(r.grossWin).toBeCloseTo(200, 2);
    expect(r.profitFactor).toBe(Infinity);
    expect(r.monthlyPnl).toEqual([{ month: '2026-01', pnl: 200 }]);
  });

  test('部分平仓 FIFO：两笔买入分两次卖出', () => {
    const txs = [day(1, 'buy', 100, 10), day(2, 'buy', 100, 12), day(3, 'sell', 150, 13)];
    const r = pairedMetrics(txs);
    expect(r.pairedTrades).toBe(2);
    expect(r.grossWin).toBeCloseTo(100 * 3 + 50 * 1, 2); // 第一笔 +300，第二笔 +50
    expect(r.pairedWinRate).toBe(1);
  });

  test('做空配对：short → cover 盈亏', () => {
    const r = pairedMetrics([day(1, 'short', 100, 10), day(2, 'cover', 100, 8)]);
    expect(r.pairedTrades).toBe(1);
    expect(r.grossWin).toBeCloseTo(200, 2); // 开空得 1000，平空花 800
  });

  test('亏损配对：胜率与盈亏因子', () => {
    const txs = [day(1, 'buy', 100, 10), day(2, 'sell', 100, 9), day(3, 'buy', 100, 10), day(4, 'sell', 100, 12)];
    const r = pairedMetrics(txs);
    expect(r.pairedWinRate).toBe(0.5);
    expect(r.profitFactor).toBe(2); // 200/100
  });
});

describe('P5 动态折算率与动态汇率', () => {
  test('折算率波动率上浮且钳制 [0.5, 0.65]', () => {
    const calm = shortMarginRateFor('T1', 0.02);
    const stressed = shortMarginRateFor('T1', 0.08);
    expect(stressed).toBeGreaterThanOrEqual(calm);
    expect(stressed).toBeLessThanOrEqual(0.65);
    expect(calm).toBeGreaterThanOrEqual(0.5);
    expect(shortMarginRateFor('T1')).toBe(calm); // 缺省波动率与 0.02 一致
  });

  test('动态汇率：setFxRates 钳制在 ±3% 波动带内', () => {
    setFxRates({ HK: 5, US: 100 }); // 超带 → 钳制
    const fx = getFxRates();
    expect(fx.CN).toBe(1);
    expect(fx.HK).toBeCloseTo(FX_CNY_PER_UNIT.HK * 1.03, 10);
    expect(fx.US).toBeCloseTo(FX_CNY_PER_UNIT.US * 1.03, 10);
    setFxRates({ HK: 0.01, US: 0.1 }); // 低于带 → 钳制
    expect(getFxRates().HK).toBeCloseTo(FX_CNY_PER_UNIT.HK * 0.97, 10);
    setFxRates({ HK: FX_CNY_PER_UNIT.HK, US: FX_CNY_PER_UNIT.US }); // 复位
  });
});

describe('P5 券源池与新股首日带宽（MatchingEngine）', () => {
  test('券源池：消耗/归还/上限', () => {
    const m = new MatchingEngine();
    const p0 = m.getShortPool('T1');
    expect(p0.available).toBeGreaterThan(0);
    expect(p0.feeRate).toBeGreaterThan(0);
    m.consumeShort('T1', 5000);
    expect(m.getShortPool('T1').available).toBe(p0.available - 5000);
    m.returnShort('T1', 3000);
    expect(m.getShortPool('T1').available).toBe(p0.available - 2000);
    m.returnShort('T1', 999999); // 归还上限 = 初始值
    expect(m.getShortPool('T1').available).toBe(p0.initial);
  });

  test('新股首日：合成卖盘上界 +44%，竞价区间 1.44/0.64', () => {
    const m = new MatchingEngine();
    m.setDayOpen({ T1: 10 });
    m.setIpoFirstDays(['T1']);
    m.refreshOrderBook('T1', 10);
    const book = m.orderBooks.get('T1');
    for (const l of book.asks) expect(l.price).toBeLessThanOrEqual(14.4);
    for (const l of book.bids) expect(l.price).toBeGreaterThanOrEqual(6.4);
    // 竞价：买卖极端价交叉 → 开盘价限制在 [6.4, 14.4]
    m.placeRestingOrder('T1', 'b1', 'A1', 'buy', 15, 100);
    m.placeVirtualOrder('T1', 'sell', 5, 100, 999999);
    const res = m.runOpeningAuction('T1', 10);
    expect(res.auctionPrice).toBeGreaterThanOrEqual(6.4);
    expect(res.auctionPrice).toBeLessThanOrEqual(14.4);
  });

  test('次日恢复 ±10% 带宽', () => {
    const m = new MatchingEngine();
    m.setDayOpen({ T1: 10 });
    m.setIpoFirstDays([]); // 次日集合为空
    m.refreshOrderBook('T1', 10);
    for (const l of m.orderBooks.get('T1').asks) expect(l.price).toBeLessThanOrEqual(11.0);
  });
});
