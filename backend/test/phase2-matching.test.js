// P2 撮合与订单系统：MatchingEngine 抽取后行为不变 + 冰山单 + OFI 动态滑点 + 做市商 + 止损簿记
const { MatchingEngine } = require('../dist/src/core/trading-engine/matching-engine');
const { TradingEngineService } = require('../dist/src/core/trading-engine/trading-engine.service');
const { mmQuote, MM_PARAMS } = require('../dist/src/core/market-data/market-maker');

// 简易内存仓库（checkPendingOrders/submitOrder 流程测试用）
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

describe('P2 MatchingEngine 抽取后行为保持', () => {
  let m;
  beforeEach(() => {
    m = new MatchingEngine();
    m.prices.set('T1', 10);
    m.orderBooks.set('T1', { bids: [{ price: 9.99, size: 100 }], asks: [{ price: 10.01, size: 100 }, { price: 10.02, size: 200 }] });
  });

  test('价格-时间优先撮合不变', () => {
    m.placeRestingOrder('T1', 'o2', 'A2', 'sell', 10.05, 60);
    m.placeRestingOrder('T1', 'o3', 'A3', 'sell', 10.05, 40);
    const res = m.matchAgainstBook('T1', 'buy', 150, undefined, 'BUYER');
    expect(res.fills.map((f) => [f.orderId, f.qty])).toEqual([['o2', 60], ['o3', 40]]);
    expect(res.remaining).toBe(50);
  });

  test('限价封顶与部分成交保持不变', () => {
    m.placeRestingOrder('T1', 'o1', 'A1', 'sell', 10.0, 60);
    const fill = m.executeMarketOrderLimited('T1', 'buy', 200, 10.0, 'BUYER');
    expect(fill.filledQuantity).toBe(60);
  });

  test('市价滑点仍然存在（动态模型下平均价高于最深档）', () => {
    const fill = m.executeMarketOrder('T1', 'buy', 10000, 'BUYER');
    expect(fill.filledQuantity).toBe(10000);
    expect(fill.avgPrice).toBeGreaterThan(10.02);
  });

  test('封板时市价单不成交（滑点模型不适用）', () => {
    m.prices.set('T1', 110);
    m.setDayOpen({ T1: 100 });
    m.refreshOrderBook('T1', 110);
    expect(m.executeMarketOrder('T1', 'buy', 10000, 'BUYER')).toBeNull();
  });
});

describe('P2 冰山单', () => {
  let m;
  beforeEach(() => {
    m = new MatchingEngine();
  });

  test('显示量吃尽后从隐藏量逐档补量，补量排到同价队尾', () => {
    m.placeRestingOrder('T1', 'ice1', 'A1', 'sell', 10.0, 300, { displayQty: 100, hiddenQty: 200 });
    m.placeRestingOrder('T1', 'o2', 'A2', 'sell', 10.0, 500);
    // taker 吃 150：先吃 ice1 显示 100（补量 100 排到 o2 之后），再吃 o2 50
    const res = m.matchAgainstBook('T1', 'buy', 150, undefined, 'B1');
    expect(res.fills.map((f) => [f.orderId, f.qty])).toEqual([['ice1', 100], ['o2', 50]]);
    const asks = m.realBooks.get('T1').asks;
    // o2 剩 450 在前，ice1 补量 100 在后，隐藏剩 100
    expect(asks[0]).toMatchObject({ orderId: 'o2', qty: 450 });
    expect(asks[1]).toMatchObject({ orderId: 'ice1', qty: 100, hiddenQty: 100 });
  });

  test('隐藏量耗尽后不再补量，撤单清除所有切片', () => {
    m.placeRestingOrder('T1', 'ice1', 'A1', 'sell', 10.0, 200, { displayQty: 80, hiddenQty: 120 });
    // 吃 240：显示 80 + 补 80 + 补 40 = 200 全部吃尽
    const res = m.matchAgainstBook('T1', 'buy', 240, undefined, 'B1');
    expect(res.fills.filter((f) => f.orderId === 'ice1').reduce((s, f) => s + f.qty, 0)).toBe(200);
    expect(m.realBooks.get('T1').asks.length).toBe(0);
    // 多切片撤单：一个 orderId 出现在多个切片时全部移除
    m.placeRestingOrder('T1', 'ice2', 'A2', 'sell', 10.1, 100, { displayQty: 40, hiddenQty: 60 });
    m.matchAgainstBook('T1', 'buy', 40, undefined, 'B2'); // 触发一次补量 → 两个切片
    m.removeRestingOrder('T1', 'ice2');
    expect(m.realBooks.get('T1').asks.length).toBe(0);
  });

  test('冰山单不参与首轮交叉撮合的隐藏部分（服务层 submitOrder）', async () => {
    const orderRepo = fakeRepo();
    const accountRepo = fakeRepo([{ id: 'AC1', cash: 1000000, marketMode: 'CN', totalTrades: 0, shortCollateral: 0 }]);
    const posRepo = fakeRepo();
    const txRepo = fakeRepo();
    const engine = new TradingEngineService(orderRepo, accountRepo, posRepo, txRepo);
    engine.prices.set('T1', 10);
    const r = await engine.submitOrder({ userId: 'U1', accountId: 'AC1', symbol: 'T1', type: 'iceberg', side: 'buy', quantity: 300, price: 10.0, displayQty: 100 }, { id: 'AC1', cash: 1000000, marketMode: 'CN' });
    expect(r.success).toBe(true);
    expect(r.order.displayQty).toBe(100);
    expect(r.order.hiddenQty).toBe(200);
    const entry = engine.realBooks.get('T1').bids[0];
    expect(entry).toMatchObject({ qty: 100, hiddenQty: 200 });
  });
});

describe('P2 OFI 动态滑点', () => {
  let m;
  beforeEach(() => {
    m = new MatchingEngine();
    m.prices.set('T1', 10);
    m.dayOpenPrices.set('T1', 10);
    m.volatilities.set('T1', 0.02);
    m.orderBooks.set('T1', {
      bids: [{ price: 9.99, size: 800 }],
      asks: [{ price: 10.01, size: 200 }, { price: 10.02, size: 200 }],
      sealedUp: false, sealedDown: false,
    });
  });

  test('OFI 计算：买压大 → 正 OFI', () => {
    expect(m.calcBookOFI(m.orderBooks.get('T1'))).toBeCloseTo((800 - 200) / 1000, 10);
  });

  test('买方逆风（正 OFI）滑点步长大于顺风（负 OFI）', () => {
    const adverse = m.slipStepFor('T1', 'buy').step;   // 买盘厚 → 买方逆风
    m.orderBooks.set('T1', { bids: [{ price: 9.99, size: 200 }], asks: [{ price: 10.01, size: 800 }, { price: 10.02, size: 200 }], sealedUp: false, sealedDown: false });
    const favorable = m.slipStepFor('T1', 'buy').step; // 卖盘厚 → 买方顺风
    expect(adverse).toBeGreaterThan(favorable);
    expect(favorable).toBeGreaterThanOrEqual(0.0002);
    expect(adverse).toBeLessThanOrEqual(0.004);
  });

  test('波动率放大冲击成本', () => {
    const calm = m.slipStepFor('T1', 'buy').step;
    m.volatilities.set('T1', 0.08);
    const stressed = m.slipStepFor('T1', 'buy').step;
    expect(stressed).toBeGreaterThan(calm);
  });

  test('总滑点上限 2%（大单部分成交，均价不超过 anchor×1.02）', () => {
    const fill = m.executeMarketOrder('T1', 'buy', 50000, 'BUYER');
    // 合成 400 全吃；滑点步长 0.0008×(1+2.2×0.6)=0.001856 → 11 档×500=5500，随后 slip 触顶 2% 停止
    expect(fill.filledQuantity).toBe(5900);
    expect(fill.avgPrice).toBeGreaterThan(10.02);
    expect(fill.avgPrice).toBeLessThanOrEqual(10.02 * 1.02 + 1e-6);
  });

  test('限价单滑点受限价约束（不成交超限价档）', () => {
    const fill = m.executeMarketOrderLimited('T1', 'buy', 50000, 10.02, 'BUYER');
    // 合成 10.01×200 + 10.02×200 全吃；滑点第 1 档按锚点价 10.02 成交 500（≤限价），
    // 第 2 档 10.02×(1+step) > 10.02 停止
    expect(fill.filledQuantity).toBe(900);
    expect(fill.avgPrice).toBeLessThanOrEqual(10.02 + 1e-9);
  });
});

describe('P2 做市商模型', () => {
  test('mmQuote：价差随波动率扩大，报价围绕中间价', () => {
    const calm = mmQuote(100, 0.02, 0);
    const wild = mmQuote(100, 0.08, 0);
    expect(wild.ask - wild.bid).toBeGreaterThan(calm.ask - calm.bid);
    expect(calm.bid).toBeLessThan(100);
    expect(calm.ask).toBeGreaterThan(100);
  });

  test('mmQuote：多头库存 → 报价中心下移（主动卖）；空头库存 → 上移', () => {
    const long = mmQuote(100, 0.02, 2000);
    const short = mmQuote(100, 0.02, -2000);
    const mid = mmQuote(100, 0.02, 0);
    const center = (q) => (q.bid + q.ask) / 2;
    expect(center(long)).toBeLessThan(center(mid));
    expect(center(short)).toBeGreaterThan(center(mid));
  });

  test('mmQuote：库存越重报量越小（有下限）', () => {
    const light = mmQuote(100, 0.02, 0);
    const heavy = mmQuote(100, 0.02, MM_PARAMS.inventoryLimit * 0.9);
    expect(heavy.size).toBeLessThan(light.size);
    expect(heavy.size).toBeGreaterThanOrEqual(100);
  });

  test('做市商虚拟报价带 orderId/mmId，成交回调触发库存更新', () => {
    const m = new MatchingEngine();
    const fills = [];
    m.setVirtualFillHook((f) => fills.push(f));
    m.placeVirtualOrder('T1', 'sell', 10.0, 200, 999999, { orderId: 'MMA-MM1-T1', mmId: 'MM1' });
    const res = m.executeVirtualMarketOrder('T1', 'buy', 120);
    expect(res.filledQuantity).toBe(120);
    expect(fills).toEqual([{ mmId: 'MM1', symbol: 'T1', side: 'sell', qty: 120, price: 10.0 }]);
    // 按 orderId 撤单
    m.removeRestingOrder('T1', 'MMA-MM1-T1');
    expect(m.realBooks.get('T1').asks.length).toBe(0);
  });

  test('TTL 到期做市商报价被清理', () => {
    const m = new MatchingEngine();
    m.placeVirtualOrder('T1', 'sell', 10.0, 100, 10, { orderId: 'MMA-MM1-T1', mmId: 'MM1' });
    m.pruneExpiredVirtualOrders(10);
    expect(m.realBooks.get('T1').asks.length).toBe(0);
  });
});

describe('P2 止损单簿记（触发审计/无流动性重试/超限取消）', () => {
  function makeEngine(orders, account = { id: 'AC1', cash: 1000000, marketMode: 'CN', totalTrades: 0, shortCollateral: 0 }) {
    const orderRepo = fakeRepo(orders);
    const accountRepo = fakeRepo([account]);
    const posRepo = fakeRepo();
    const txRepo = fakeRepo();
    const engine = new TradingEngineService(orderRepo, accountRepo, posRepo, txRepo);
    engine.prices.set('T1', 10);
    return { engine, orderRepo };
  }

  test('触发转市价成交：审计记录 triggered → filled', async () => {
    const stop = { id: 'S1', accountId: 'AC1', userId: 'U1', symbol: 'T1', type: 'stop', side: 'buy', quantity: 100, price: null, triggerPrice: 10.0, filledQty: 0, status: 'pending' };
    const { engine, orderRepo } = makeEngine([stop]);
    engine.placeRestingOrder('T1', 'o1', 'A9', 'sell', 10.4, 100);
    const fills = await engine.checkPendingOrders();
    expect(fills.length).toBe(1);
    const saved = orderRepo.rows.find((r) => r.id === 'S1');
    expect(saved.status).toBe('filled');
    expect(saved.filledQty).toBe(100);
    const log = JSON.parse(saved.triggerLog);
    expect(log[0].action).toBe('triggered');
    expect(log[0].convertTo).toBe('market');
    expect(log[log.length - 1].action).toBe('filled');
  });

  test('触发后封板无流动性：保留订单并计数重试，10 次后取消', async () => {
    const stop = { id: 'S2', accountId: 'AC1', userId: 'U1', symbol: 'T1', type: 'stop', side: 'buy', quantity: 100, price: null, triggerPrice: 10.0, filledQty: 0, status: 'pending' };
    const { engine, orderRepo } = makeEngine([stop]);
    engine.prices.set('T1', 11);
    engine.setDayOpen({ T1: 10 });
    engine.refreshOrderBook('T1', 11); // 涨停封板 → 市价单无法成交
    for (let i = 0; i < 9; i++) {
      await engine.checkPendingOrders();
    }
    let saved = orderRepo.rows.find((r) => r.id === 'S2');
    expect(saved.status).toBe('pending');
    expect(saved.triggerRetries).toBe(9);
    await engine.checkPendingOrders(); // 第 10 次 → 取消
    saved = orderRepo.rows.find((r) => r.id === 'S2');
    expect(saved.status).toBe('cancelled');
    expect(saved.triggerRetries).toBe(10);
    expect(saved.rejectReason).toContain('10 次');
    const log = JSON.parse(saved.triggerLog);
    expect(log[0].action).toBe('triggered');
    expect(log[log.length - 1].action).toBe('cancelled');
  });

  test('止损限价触发后按限价撮合（审计 convertTo=limit）', async () => {
    const stopLimit = { id: 'S3', accountId: 'AC1', userId: 'U1', symbol: 'T1', type: 'stop-limit', side: 'buy', quantity: 100, price: 10.5, triggerPrice: 10.0, filledQty: 0, status: 'pending' };
    const { engine, orderRepo } = makeEngine([stopLimit]);
    engine.placeRestingOrder('T1', 'o1', 'A9', 'sell', 10.4, 100);
    const fills = await engine.checkPendingOrders();
    expect(fills.length).toBe(1);
    const saved = orderRepo.rows.find((r) => r.id === 'S3');
    const log = JSON.parse(saved.triggerLog);
    expect(log[0].convertTo).toBe('limit');
    expect(saved.status).toBe('filled');
  });

  test('冰山单不进入 checkPendingOrders 的直拍路径（由盘口撮合驱动）', async () => {
    const ice = { id: 'I1', accountId: 'AC1', userId: 'U1', symbol: 'T1', type: 'iceberg', side: 'buy', quantity: 300, price: 10.0, displayQty: 100, hiddenQty: 200, filledQty: 0, status: 'pending' };
    const { engine } = makeEngine([ice]);
    engine.prices.set('T1', 9.9); // 现价低于挂单价（LIMIT 直拍路径会 shouldFill）
    const fills = await engine.checkPendingOrders();
    expect(fills.length).toBe(0);
    expect(engine.realBooks.get('T1')?.bids ?? []).toHaveLength(0);
  });
});
