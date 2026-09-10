// Phase B 交易规则回归：幻影流动性/跨市场/涨跌停/中性新闻/盘后固定价格/竞价两阶段/真杠杆/回测滑点
const { MatchingEngine } = require('../dist/src/core/trading-engine/matching-engine');
const { TradingEngineService } = require('../dist/src/core/trading-engine/trading-engine.service');
const { MarketDataService } = require('../dist/src/core/market-data/market-data.service');
const { liveFillPrice, slipStepFor } = require('../dist/src/core/trading-engine/slippage');

function matchesWhere(r, where) {
  if (Array.isArray(where)) return where.some((w) => matchesWhere(r, w));
  return Object.entries(where || {}).every(([k, v]) => String(r[k]) === String(v));
}
function fakeRepo(seed = []) {
  const rows = [...seed];
  let idc = 1;
  return {
    rows,
    find: async (q) => rows.filter((r) => matchesWhere(r, q?.where)),
    findOne: async (q) => rows.find((r) => matchesWhere(r, q?.where)) || null,
    save: async (e) => {
      if (!e.id) e.id = 'auto-' + idc++;
      const i = rows.findIndex((r) => r.id === e.id);
      if (i >= 0) rows[i] = e; else rows.push(e);
      return e;
    },
    create: (obj) => obj,
  };
}

describe('Phase B 幻影流动性双计修复（P1#6）', () => {
  function makeEng() {
    const m = new MatchingEngine();
    m.prices.set('T1', 50);
    m.setPrevCloses({ T1: 50 });
    return m;
  }
  test('核心复现：真实 100 股只能被吃一次，剩余走纯合成档', () => {
    const m = makeEng();
    m.placeRestingOrder('T1', 'oA', 'A1', 'sell', 50, 100);
    m.refreshOrderBook('T1', 50); // 合成档：50.05 起 5 档
    const fill = m.executeMarketOrder('T1', 'buy', 150, 'B1');
    const counterQty = fill.counterFills.reduce((s, f) => s + f.qty, 0);
    expect(counterQty).toBe(100); // 真实挂单只成交一次
    expect(fill.filledQuantity).toBe(150); // 剩余 50 来自纯合成档（价格≥50.05）
    expect(fill.avgPrice).toBeGreaterThan(50); // 不再是 50 全单（幻影修复前 avg=50）
    expect(m.realBooks.get('T1').asks.length).toBe(0);
  });
  test('IOC 限价 50 买 150：只成交真实 100，剩余不再被幻影合成档吃掉', () => {
    const m = makeEng();
    m.placeRestingOrder('T1', 'oA', 'A1', 'sell', 50, 100);
    m.refreshOrderBook('T1', 50);
    const fill = m.executeMarketOrderLimited('T1', 'buy', 150, 50, 'B1');
    expect(fill.filledQuantity).toBe(100);
  });
  test('涨停封板 + 真实卖单：市价买只吃真实卖单，无幻影加倍', () => {
    const m = makeEng();
    m.setDayOpen({ T1: 50 });
    m.placeRestingOrder('T1', 'oA', 'A1', 'sell', 55, 100); // 涨停价 55
    m.prices.set('T1', 55);
    m.refreshOrderBook('T1', 55); // sealedUp：合成 asks 清空
    const fill = m.executeMarketOrder('T1', 'buy', 150, 'B1');
    expect(fill.filledQuantity).toBe(100); // 修复前为 150（幻影加倍）
    expect(fill.counterFills.reduce((s, f) => s + f.qty, 0)).toBe(100);
  });
  test('getOrderBook 输出层动态合并真实挂单（展示口径不变）', () => {
    const m = makeEng();
    m.placeRestingOrder('T1', 'oA', 'A1', 'sell', 50, 100);
    m.refreshOrderBook('T1', 50);
    const book = m.getOrderBook('T1');
    expect(book.asks[0].price).toBe(50); // 真实 50 排在合成 50.05 之前
    expect(book.asks[0].size).toBe(100);
    expect(book.asks[1].size).toBeGreaterThan(0); // 纯合成档
  });
});

describe('Phase B 跨市场规则与涨跌停（P1#7/#8）', () => {
  function makeEng(account) {
    const engine = new TradingEngineService(fakeRepo(), fakeRepo(), fakeRepo(), fakeRepo(), null);
    engine.prices.set('T1', 100);
    engine.prices.set('U1', 100);
    engine.setPrevCloses({ T1: 100 });
    return engine;
  }
  test('US 账户买 A 股被拒（禁止跨市场）', async () => {
    const engine = makeEng();
    const r = await engine.validateOrder({ symbol: 'T1', type: 'market', side: 'buy', quantity: 100 }, { id: 'A1', marketMode: 'US', cash: 1e6, leverage: 1 });
    expect(r.valid).toBe(false);
    expect(r.error).toContain('禁止跨市场');
  });
  test('CN 账户买美股被拒', async () => {
    const engine = makeEng();
    const r = await engine.validateOrder({ symbol: 'U1', type: 'market', side: 'buy', quantity: 100 }, { id: 'A1', marketMode: 'CN', cash: 1e6, leverage: 1 });
    expect(r.valid).toBe(false);
  });
  test('A股委托价超涨停价拒单（昨收 100 → 上限 110）', async () => {
    const engine = makeEng();
    const r = await engine.validateOrder({ symbol: 'T1', type: 'limit', side: 'buy', quantity: 100, price: 110.01 }, { id: 'A1', marketMode: 'CN', cash: 1e6, leverage: 1 });
    expect(r.valid).toBe(false);
    expect(r.error).toContain('涨跌停');
  });
  test('涨停价 110 整、跌停价 90 整可挂单', async () => {
    const engine = makeEng();
    const up = await engine.validateOrder({ symbol: 'T1', type: 'limit', side: 'buy', quantity: 100, price: 110 }, { id: 'A1', marketMode: 'CN', cash: 1e6, leverage: 1 });
    const dn = await engine.validateOrder({ symbol: 'T1', type: 'limit', side: 'buy', quantity: 100, price: 90 }, { id: 'A1', marketMode: 'CN', cash: 1e6, leverage: 1 });
    expect(up.valid).toBe(true);
    expect(dn.valid).toBe(true);
  });
  test('新股首日带宽 +44%/-36%（发行价 10 → [6.4, 14.4]）', async () => {
    const engine = makeEng();
    engine.ipoFirstDay.add('T9');
    engine.prices.set('T9', 10);
    engine.setPrevCloses({ T9: 10 });
    const ok = await engine.validateOrder({ symbol: 'T9', type: 'limit', side: 'buy', quantity: 100, price: 14.4 }, { id: 'A1', marketMode: 'CN', cash: 1e6, leverage: 1 });
    const bad = await engine.validateOrder({ symbol: 'T9', type: 'limit', side: 'buy', quantity: 100, price: 14.41 }, { id: 'A1', marketMode: 'CN', cash: 1e6, leverage: 1 });
    expect(ok.valid).toBe(true);
    expect(bad.valid).toBe(false);
  });
  test('港股无涨跌停限制', async () => {
    const engine = makeEng();
    engine.prices.set('H1', 100);
    const r = await engine.validateOrder({ symbol: 'H1', type: 'limit', side: 'buy', quantity: 100, price: 999 }, { id: 'A1', marketMode: 'HK', cash: 1e8, leverage: 1 });
    expect(r.valid).toBe(true);
  });
});

describe('Phase B 中性新闻不再必涨（P1#10）', () => {
  test('neutral 定向个股新闻价格不变；bullish 涨、bearish 跌', () => {
    const svc = new MarketDataService(null, null, null, null, 'CN');
    const st = { symbol: 'T1', price: 100, lastReturn: 0 };
    svc.stocks.set('T1', st);
    const before = st.price;
    svc.applyNewsImpact({ type: 'neutral', targetedSymbol: 'T1', impact: { 市场情绪: 0.01 } });
    expect(st.price).toBe(before); // 中性：无价格冲击
    svc.applyNewsImpact({ type: 'bullish', targetedSymbol: 'T1', impact: {} });
    expect(st.price).toBeGreaterThan(before);
    const afterBull = st.price;
    svc.applyNewsImpact({ type: 'bearish', targetedSymbol: 'T1', impact: {} });
    expect(st.price).toBeLessThan(afterBull);
  });
});

describe('Phase B 盘后固定价格交易（P1）', () => {
  function makeEng() {
    const orderRepo = fakeRepo();
    const accountRepo = fakeRepo([
      { id: 'AC1', cash: 100000, marketMode: 'CN', leverage: 1, totalTrades: 0, shortCollateral: 0, borrowed: 0 },
      { id: 'AC2', cash: 100000, marketMode: 'CN', leverage: 1, totalTrades: 0, shortCollateral: 0, borrowed: 0 },
    ]);
    const posRepo = fakeRepo([
      { id: 'P2', accountId: 'AC2', symbol: 'T1', longQty: 200, shortQty: 0, longCost: 1000, boughtToday: 0 },
    ]);
    const engine = new TradingEngineService(orderRepo, accountRepo, posRepo, fakeRepo(), null);
    engine.prices.set('T1', 10);
    engine.setPrevCloses({ T1: 10 });
    return { engine, orderRepo, accountRepo };
  }
  test('价格≠收盘价拒单', async () => {
    const { engine } = makeEng();
    const r = await engine.submitClosingOrder({ userId: 'U1', accountId: 'AC1', symbol: 'T1', side: 'buy', quantity: 100, price: 9.9 }, { id: 'AC1', marketMode: 'CN', cash: 100000, leverage: 1 }, 10);
    expect(r.success).toBe(false);
    expect(r.error).toContain('收盘价');
  });
  test('同价时间优先撮合，剩余排队（不互吃连续竞价遗留挂单）', async () => {
    const { engine, orderRepo, accountRepo } = makeEng();
    // AC2 挂盘后卖单 100 @10
    const r1 = await engine.submitClosingOrder({ userId: 'U2', accountId: 'AC2', symbol: 'T1', side: 'sell', quantity: 100, price: 10 }, { id: 'AC2', marketMode: 'CN', cash: 100000, leverage: 1 }, 10);
    expect(r1.success).toBe(true);
    // 连续竞价遗留挂单（不应被盘后单吃到）
    engine.placeRestingOrder('T1', 'oX', 'AC2', 'sell', 10, 50);
    // AC1 盘后买 60：吃 AC2 盘后卖单 60（时间优先），不碰 realBooks 的 oX
    const r2 = await engine.submitClosingOrder({ userId: 'U1', accountId: 'AC1', symbol: 'T1', side: 'buy', quantity: 60, price: 10 }, { id: 'AC1', marketMode: 'CN', cash: 100000, leverage: 1 }, 10);
    expect(r2.success).toBe(true);
    expect(r2.fill.filledQuantity).toBe(60);
    expect(r2.fill.counterFills.every((f) => f.orderId !== 'oX')).toBe(true);
    // 卖方 40 剩排队
    expect(engine.closingBook.get('T1').asks.reduce((s, e) => s + e.qty, 0)).toBe(40);
    // 连续竞价遗留挂单原样保留
    expect(engine.realBooks.get('T1').asks.some((e) => e.orderId === 'oX')).toBe(true);
    // 双方结算正确：AC2 现金增加 600 - 费、持仓减 60
    const ac2 = accountRepo.rows.find((a) => a.id === 'AC2');
    expect(Number(ac2.cash)).toBeGreaterThan(100000);
    // 挂单实体：买方全部成交 FILLED
    const buyOrder = orderRepo.rows.find((o) => o.id === r2.order.id);
    expect(buyOrder.status).toBe('filled');
  });
  test('15:30 未成交盘后申报自动撤销（含 rejectReason）', async () => {
    const { engine, orderRepo } = makeEng();
    const r1 = await engine.submitClosingOrder({ userId: 'U2', accountId: 'AC2', symbol: 'T1', side: 'sell', quantity: 100, price: 10 }, { id: 'AC2', marketMode: 'CN', cash: 100000, leverage: 1 }, 10);
    expect(r1.success).toBe(true);
    const n = await engine.cancelAfterHoursOrders();
    expect(n).toBe(1);
    const o = orderRepo.rows.find((x) => x.id === r1.order.id);
    expect(o.status).toBe('cancelled');
    expect(o.rejectReason).toContain('盘后');
    expect((engine.closingBook.get('T1')?.asks || []).length).toBe(0);
  });
});

describe('Phase B 集合竞价两阶段结算（P1#11）', () => {
  test('预校验失败：挂单放回盘口恢复 PENDING，不产生半套结算', async () => {
    const orderRepo = fakeRepo([
      { id: 'oB', accountId: 'AC2', symbol: 'T1', side: 'buy', quantity: 100, price: 10, filledQty: 0, status: 'pending' },
    ]);
    const accountRepo = fakeRepo([
      { id: 'AC1', cash: 100000, marketMode: 'CN', leverage: 1, totalTrades: 0, shortCollateral: 0, borrowed: 0 },
      { id: 'AC2', cash: 100, marketMode: 'CN', leverage: 1, totalTrades: 0, shortCollateral: 0, borrowed: 0 }, // 资金不足
    ]);
    const posRepo = fakeRepo([{ id: 'P1', accountId: 'AC1', symbol: 'T1', longQty: 100, shortQty: 0, boughtToday: 0 }]);
    const engine = new TradingEngineService(orderRepo, accountRepo, posRepo, fakeRepo(), null);
    engine.prices.set('T1', 10);
    engine.placeRestingOrder('T1', 'oB', 'AC2', 'buy', 10, 100);
    // 竞价 fills：卖方 AC1 + 买方 AC2（AC2 资金不足 → 预校验失败 → 全部回滚）
    const fills = [
      { orderId: 'oS', accountId: 'AC1', side: 'sell', price: 10, qty: 100, virtual: false },
      { orderId: 'oB', accountId: 'AC2', side: 'buy', price: 10, qty: 100, virtual: false },
    ];
    const r = await engine.settleAuctionFills('T1', fills);
    expect(r.success).toBe(false);
    // 挂单放回盘口
    expect(engine.realBooks.get('T1').bids.some((e) => e.orderId === 'oB')).toBe(true);
    // 订单保持 PENDING
    expect(orderRepo.rows.find((o) => o.id === 'oB').status).toBe('pending');
  });
  test('全部通过：队列内逐条结算 + 订单 FILLED', async () => {
    const orderRepo = fakeRepo([
      { id: 'oB', accountId: 'AC2', symbol: 'T1', side: 'buy', quantity: 100, price: 10, filledQty: 0, status: 'pending' },
    ]);
    const accountRepo = fakeRepo([
      { id: 'AC1', cash: 100000, marketMode: 'CN', leverage: 1, totalTrades: 0, shortCollateral: 0, borrowed: 0 },
      { id: 'AC2', cash: 100000, marketMode: 'CN', leverage: 1, totalTrades: 0, shortCollateral: 0, borrowed: 0 },
    ]);
    const posRepo = fakeRepo([{ id: 'P1', accountId: 'AC1', symbol: 'T1', longQty: 100, shortQty: 0, boughtToday: 0 }]);
    const engine = new TradingEngineService(orderRepo, accountRepo, posRepo, fakeRepo(), null);
    engine.prices.set('T1', 10);
    engine.placeRestingOrder('T1', 'oB', 'AC2', 'buy', 10, 100);
    const fills = [
      { orderId: 'oS', accountId: 'AC1', side: 'sell', price: 10, qty: 100, virtual: false },
      { orderId: 'oB', accountId: 'AC2', side: 'buy', price: 10, qty: 100, virtual: false },
    ];
    const r = await engine.settleAuctionFills('T1', fills);
    expect(r.success).toBe(true);
    expect(r.settled).toBe(2);
    expect(orderRepo.rows.find((o) => o.id === 'oB').status).toBe('filled');
    expect(Number(accountRepo.rows.find((a) => a.id === 'AC2').cash)).toBeLessThan(100000);
  });
});

describe('Phase B 真杠杆（P1#9）', () => {
  test('购买力 = 现金 × 杠杆：lev=2 可买 2 倍现金的股票', async () => {
    const engine = new TradingEngineService(fakeRepo(), fakeRepo(), fakeRepo(), fakeRepo(), null);
    engine.prices.set('T1', 100);
    engine.setPrevCloses({ T1: 100 });
    const r = await engine.validateOrder({ symbol: 'T1', type: 'market', side: 'buy', quantity: 1500 }, { id: 'A1', marketMode: 'CN', cash: 100000, leverage: 2 });
    expect(r.valid).toBe(true); // 1500×100=15万 ≤ 购买力 20 万
  });
  test('结算记账：自有资金扣一半、负债记一半', async () => {
    const accountRepo = fakeRepo([{ id: 'AC1', cash: 100000, marketMode: 'CN', leverage: 2, totalTrades: 0, shortCollateral: 0, borrowed: 0 }]);
    const posRepo = fakeRepo();
    const engine = new TradingEngineService(fakeRepo(), accountRepo, posRepo, fakeRepo(), null);
    engine.prices.set('T1', 100);
    const fill = { symbol: 'T1', side: 'buy', filledQuantity: 1000, avgPrice: 100, totalCost: 100000 };
    const r = await engine.settleFillInner('AC1', 'T1', 'buy', fill, 'CN');
    expect(r.success).toBe(true);
    const acct = accountRepo.rows.find((a) => a.id === 'AC1');
    expect(Number(acct.borrowed)).toBeCloseTo(50000, 2);
    expect(Number(acct.cash)).toBeCloseTo(100000 - 50000 - r.fees.totalFees, 2);
  });
  test('卖出按比例偿还负债；marginUsed 同步', async () => {
    const accountRepo = fakeRepo([{ id: 'AC1', cash: 50000, marketMode: 'CN', leverage: 2, totalTrades: 0, shortCollateral: 0, borrowed: 50000 }]);
    const posRepo = fakeRepo([{ id: 'P1', accountId: 'AC1', symbol: 'T1', longQty: 1000, shortQty: 0, longCost: 100000, boughtToday: 0 }]);
    const engine = new TradingEngineService(fakeRepo(), accountRepo, posRepo, fakeRepo(), null);
    engine.prices.set('T1', 100);
    const fill = { symbol: 'T1', side: 'sell', filledQuantity: 1000, avgPrice: 100, totalCost: 100000 };
    const r = await engine.settleFillInner('AC1', 'T1', 'sell', fill, 'CN');
    expect(r.success).toBe(true);
    const acct = accountRepo.rows.find((a) => a.id === 'AC1');
    expect(Number(acct.borrowed)).toBeCloseTo(0, 2); // 全卖 → 负债还清
    // P0-1 修复：卖券所得先还债，只有净额进现金（原实现漏扣 repay → 权益凭空 +50000，可反复买卖刷钱）
    const repay = 50000;
    expect(Number(acct.cash)).toBeCloseTo(50000 + 100000 - repay - r.fees.totalFees, 2);
  });
  test('强平检查基于记账负债（不再由持仓市值推导）', async () => {
    const accountRepo = fakeRepo([{ id: 'AC1', cash: 1000, marketMode: 'CN', leverage: 1, totalTrades: 0, shortCollateral: 0, borrowed: 0 }]);
    const posRepo = fakeRepo([{ id: 'P1', accountId: 'AC1', symbol: 'T1', longQty: 1000, shortQty: 0, longCost: 100000, boughtToday: 0 }]);
    const engine = new TradingEngineService(fakeRepo(), accountRepo, posRepo, fakeRepo(), null);
    engine.prices.set('T1', 100);
    const m = await engine.checkMarginLevel(accountRepo.rows[0], { T1: 100 });
    expect(m.action).toBe('ok'); // 无负债（borrowed=0）→ 多头不再被凭空强平
  });
});

describe('Phase B 滑点唯一实现与回测对齐（P1#12）', () => {
  test('slipStepFor 方向与边界', () => {
    const adverse = slipStepFor(0.02, 0.6, 'buy');
    const favorable = slipStepFor(0.02, -0.6, 'buy');
    expect(adverse).toBeGreaterThan(favorable);
    expect(favorable).toBeGreaterThanOrEqual(0.0002);
    expect(adverse).toBeLessThanOrEqual(0.004);
  });
  test('liveFillPrice 触顶兜底（市价单不丢量）', () => {
    const lp = liveFillPrice(100, 100000, 'buy', 0.02, 0, undefined);
    expect(lp.remaining).toBe(0);
    expect(lp.totalQty).toBe(100000);
    expect(lp.totalCost / lp.totalQty).toBeLessThanOrEqual(100 * 1.02 + 1e-6);
  });
  test('限价约束内触顶兜底、超限价不成交', () => {
    const lp = liveFillPrice(100, 100000, 'buy', 0.02, 0, 100.5);
    expect(lp.totalQty).toBeGreaterThan(0);
    expect(lp.remaining).toBeGreaterThan(0); // 触顶价 102 > 限价 100.5 → 剩量不成交
  });
});
