// Phase 13 P0-3 / P1-9 / P1-13 回归：AI 对手盘账本与大单成交口径
// ① AI 限价卖单成交 → 减仓 + 现金增加 + recordAiTrade（原先无任何账本回调）
// ② 卖单数量受「持仓 − 活跃挂单剩余量」约束（不能超卖/跨日重复供货）
// ③ 买单现金占用受 restBudget 精确约束（不再靠 restingValue×0.97 衰减近似）
// ④ 对手方结算失败 → AI 账本与价格冲击都不发生（原实现 catch 吞错）
// ⑤ AI 报价区间与撮合引擎同基准（cnPriceLimits：昨收 + 新股首日 ±44%/-36%）
const A = require('../dist/src/core/market-data/ai-opponents');
const { MarketDataService } = require('../dist/src/core/market-data/market-data.service');
const { MatchingEngine } = require('../dist/src/core/trading-engine/matching-engine');

// ─── 确定性随机：把 agentRng 的每个 salt 钉死，使下单路径（限价/市价）可复现 ───
const REAL_AGENT_RNG = A.agentRng;
function patchRng(values) {
  A.agentRng = (day, tick, agentId, salt) => () => (values[salt] !== undefined ? values[salt] : 0.5);
}
const RNG_LIMIT = { act: 0, pick: 0.1, dir: 0.5, qty: 0.1, route: 0.1, offset: 0.1, ttl: 0.5 };
const RNG_MARKET = { ...RNG_LIMIT, route: 0.9 };

afterEach(() => { A.agentRng = REAL_AGENT_RNG; });

// ─── 真实撮合引擎外包一层 TradingEngineService 门面（hook/挂单/撮合全走真实现） ───
function realEngine() {
  const matching = new MatchingEngine();
  const calls = { placed: [], market: [], settled: [], hookRegs: 0, virtual: [] };
  const engine = {
    matching, calls, hook: null,
    setVirtualFillHook(fn) {
      calls.hookRegs++;
      engine.hook = fn;
      matching.setVirtualFillHook((f) => { calls.virtual.push(f); fn(f); });
    },
    placeVirtualOrder(symbol, side, price, qty, ttl, opts) {
      calls.placed.push({ symbol, side, price, qty, ttl, opts });
      matching.placeVirtualOrder(symbol, side, price, qty, ttl, opts);
    },
    pruneExpiredVirtualOrders(tick) { matching.pruneExpiredVirtualOrders(tick); },
    removeRestingOrder(symbol, orderId) { matching.removeRestingOrder(symbol, orderId); },
    getOrderBook(symbol) { return matching.getOrderBook(symbol); },
    executeVirtualMarketOrder(symbol, side, qty) {
      calls.market.push({ symbol, side, qty });
      return matching.executeVirtualMarketOrder(symbol, side, qty);
    },
    async settleCounterFills(symbol, mode, fills) {
      calls.settled.push({ symbol, mode, fills });
      return { ok: true, settled: fills.length, failed: 0 };
    },
  };
  return { engine, matching, calls };
}

// ─── 手工 fake 引擎：用于「结算失败」等需要注入返回值/成交载荷的场景 ───
function fakeEngine(opts = {}) {
  const calls = { fills: [], settled: [], placed: [], hookRegs: 0 };
  const engine = {
    calls, hook: null,
    setVirtualFillHook(fn) { calls.hookRegs++; engine.hook = fn; },
    pruneExpiredVirtualOrders() { },
    removeRestingOrder() { },
    getOrderBook() { return { bids: [], asks: [] }; },
    placeVirtualOrder(symbol, side, price, qty, ttl, o) { calls.placed.push({ symbol, side, price, qty, ttl, opts: o }); },
    executeVirtualMarketOrder(symbol, side, qty) {
      calls.fills.push({ symbol, side, qty });
      return opts.fill === undefined ? null : opts.fill;
    },
    async settleCounterFills(symbol, mode, fills) {
      calls.settled.push({ symbol, mode, fills });
      return opts.settle;
    },
  };
  return { engine, calls };
}

function makeStock(over = {}) {
  return Object.assign({
    symbol: 'T1', name: '测试', industry: '银行', market: 'CN', price: 10, intrinsic: 10,
    volatility: 0.02, lastReturn: 0, prevClose: 10, dayOpen: 10, dayHigh: 10, dayLow: 10,
    dayVolume: 0, minuteCounter: 0, baseVolume: 10000, avgVolume: 10000, prevVolume: 10000, lastVolume: 0,
    kline1min: [], kline5min: [], klineDaily: [], current1min: null, current5min: null, currentDaily: null,
    trendCounter: 0, trendDirection: 0, trendAccumulated: 0, isTrending: false,
    fund: null, nextReportDay: 999, pead: null,
  }, over);
}

function makeLedger(over = {}) {
  return Object.assign({
    cash: 100000, initialCash: 100000,
    positions: new Map(),
    restingValue: 0, restingOrders: [], restingSeq: 0,
    trades: 0, wins: 0, losses: 0, realizedPnl: 0, equityHistory: [],
    params: A.defaultAiParams(), perfMarks: [],
    treeHit: new Array(A.RF_TREES.length).fill(0), treeMiss: new Array(A.RF_TREES.length).fill(0), treeWeights: null,
  }, over);
}

function makeService(opts = {}) {
  const s = new MarketDataService(null, null, null, null, 'CN');
  const stock = makeStock(opts.stock);
  s.stocks.set(stock.symbol, stock);
  s.industryCycles.set('银行', 'expansion');
  s.factors = { '宏观经济': 0, '行业景气': 0, '公司特质': 0, '市场情绪': 0, '国际环境': 0, '政策风险': 0, '消费景气': 0 };
  const agent = Object.assign({
    id: 'AI1', name: '测试对手', type: '机构', strategy: 'trend',
    activity: 0.5, scale: 400, cash: 100000,
  }, opts.agent);
  const ledger = makeLedger(opts.ledger);
  s.aiAgents = [agent];
  s.aiLedger = [ledger];
  s.aiAdaptiveEnabled = false; // 用默认参数 + 全 1 系数：规模/预算可精确预测
  s.engine = opts.engine || null;
  return { s, stock, agent, ledger };
}

describe('Phase 13 P0-3：AI 限价单成交回调 + 挂单冻结', () => {
  test('① 限价卖单成交：账本减仓 + 现金增加 + 平仓绩效入账 + 挂单移出活跃集合', async () => {
    const { engine, calls } = realEngine();
    const { s, stock, ledger } = makeService({ engine });
    patchRng(RNG_LIMIT);
    stock.dayOpen = 10; stock.prevClose = 10;
    stock.price = 9; // 跌破今开 → trend 策略看空 → 挂卖单
    ledger.positions.set('T1', { qty: 100, cost: 8 });

    await s.applyAiTrading();
    expect(calls.placed.length).toBe(1);
    const placed = calls.placed[0];
    expect(placed.side).toBe('sell');
    expect(placed.qty).toBe(100);
    expect(placed.opts).toMatchObject({ orderId: 'ai-AI1-1', tag: 'AI1' });
    expect(placed.price).toBeGreaterThanOrEqual(9); // P1-13: 报价被夹在 cnPriceLimits(10) = [9, 11]
    expect(placed.price).toBeLessThanOrEqual(11);
    expect(ledger.restingOrders.length).toBe(1);
    expect(ledger.restingOrders[0]).toMatchObject({ orderId: 'ai-AI1-1', symbol: 'T1', side: 'sell', qty: 100, filledQty: 0 });

    // 对手方吃掉这笔挂单（同 tick 另一 AI 的市价买单）
    const fill = engine.matching.executeVirtualMarketOrder('T1', 'buy', 100);
    expect(fill.filledQuantity).toBe(100);
    expect(fill.avgPrice).toBe(placed.price);
    // 回调载荷扩展（做市商消费方只看 mmId，保持兼容）
    expect(calls.virtual[0]).toEqual({
      mmId: null, tag: 'AI1', orderId: 'ai-AI1-1', symbol: 'T1', side: 'sell', qty: 100, price: placed.price,
    });
    // 账本：现金增加、持仓清空、平仓盈亏 (9 - 8) × 100
    expect(ledger.cash).toBeCloseTo(100000 + 100 * placed.price, 6);
    expect(ledger.positions.has('T1')).toBe(false);
    expect(ledger.trades).toBe(1);
    expect(ledger.wins).toBe(1);
    expect(ledger.realizedPnl).toBeCloseTo((placed.price - 8) * 100, 6);
    // 全成 → 挂单移出活跃集合（冻结释放）
    expect(ledger.restingOrders.length).toBe(0);
    expect(ledger.restingValue).toBe(0);
  });

  test('① 部分成交：filledQty 累加、挂单保留、冻结量随之减少', async () => {
    const { engine, calls } = realEngine();
    const { s, stock, ledger } = makeService({ engine });
    patchRng(RNG_LIMIT);
    stock.price = 9;
    ledger.positions.set('T1', { qty: 100, cost: 8 });
    await s.applyAiTrading();
    const price = calls.placed[0].price;

    engine.matching.executeVirtualMarketOrder('T1', 'buy', 40);
    expect(ledger.positions.get('T1').qty).toBe(60);
    expect(ledger.cash).toBeCloseTo(100000 + 40 * price, 6);
    expect(ledger.trades).toBe(1);
    expect(ledger.restingOrders.length).toBe(1);
    expect(ledger.restingOrders[0].filledQty).toBe(40);
  });

  test('② 卖单不超过「持仓 − 活跃卖单剩余量」：第二笔直接跳过（不得超卖）', async () => {
    const { engine, calls } = realEngine();
    const { s, stock, ledger } = makeService({ engine });
    patchRng(RNG_LIMIT);
    stock.price = 9;
    ledger.positions.set('T1', { qty: 100, cost: 8 });

    await s.applyAiTrading(); // 卖 100（持仓全部冻结）
    s.tickCount = 1;
    await s.applyAiTrading(); // 可卖量 = 100 − 100 = 0 → 跳过
    s.tickCount = 2;
    await s.applyAiTrading();
    expect(calls.placed.length).toBe(1);
    const activeSell = ledger.restingOrders.filter((o) => o.side === 'sell')
      .reduce((acc, o) => acc + (o.qty - o.filledQty), 0);
    expect(activeSell).toBeLessThanOrEqual(100); // 冻结量恒 ≤ 持仓
  });

  test('② 市价分支同样受冻结约束：持仓被挂单锁定时市价卖单不再成交', async () => {
    const { engine, calls } = realEngine();
    const { s, stock, ledger } = makeService({ engine });
    patchRng(RNG_LIMIT);
    stock.price = 9;
    ledger.positions.set('T1', { qty: 100, cost: 8 });
    await s.applyAiTrading(); // 限价卖出 100（全冻结）

    patchRng(RNG_MARKET); // 改走市价分支
    s.tickCount = 1;
    await s.applyAiTrading();
    expect(calls.market.length).toBe(0); // qty=0 → 不进撮合
    expect(ledger.cash).toBeCloseTo(100000, 6); // 账本未被凭空改写
  });

  test('③ 买单现金占用受 restBudget 约束（精确占用，不再靠 0.97 衰减）', async () => {
    const { engine, calls } = realEngine();
    const { s, stock, ledger } = makeService({ engine, agent: { scale: 605 }, ledger: { cash: 10000, initialCash: 10000 } });
    patchRng(RNG_LIMIT);
    stock.price = 11; // 上涨 → trend 看多 → 挂买单

    await s.applyAiTrading();
    expect(calls.placed.length).toBe(1);
    const firstCost = calls.placed[0].qty * calls.placed[0].price;
    expect(firstCost).toBeLessThanOrEqual(10000 * 0.6);
    expect(ledger.restingValue).toBeCloseTo(firstCost, 6); // 兼容字段=活跃买单精确占用

    s.tickCount = 1;
    await s.applyAiTrading(); // 首单仍活跃：占用 + 新单 > cash×0.6 → 跳过（旧衰减近似会放行）
    expect(calls.placed.length).toBe(1);
  });

  test('③ 长跑不变量：活跃买单占用恒 ≤ cash × restBudget', async () => {
    const { engine, calls } = realEngine();
    const { s, stock, ledger } = makeService({ engine, agent: { scale: 605 }, ledger: { cash: 10000, initialCash: 10000 } });
    patchRng(RNG_LIMIT);
    stock.price = 11; // 上涨 → 恒为买单方向
    for (let tick = 0; tick < 40; tick++) {
      s.tickCount = tick;
      await s.applyAiTrading();
      const occupation = ledger.restingOrders
        .reduce((acc, o) => acc + (o.qty - o.filledQty) * o.price, 0);
      expect(occupation).toBeLessThanOrEqual(10000 * 0.6 + 1e-6);
    }
    expect(calls.placed.length).toBeGreaterThan(0); // 确保不是空跑
  });

  test('④ 挂钩只注册一次 + tag 找不到 AI 时忽略 + mmId 仍走做市商库存', async () => {
    const { engine, calls } = realEngine();
    const { s, ledger } = makeService({ engine });
    patchRng(RNG_LIMIT);
    await s.applyAiTrading();
    s.tickCount = 1;
    await s.applyAiTrading();
    expect(calls.hookRegs).toBe(1);

    s.onVirtualFill({ mmId: 'MM1', symbol: 'T1', side: 'sell', qty: 100, price: 10 });
    expect(s.marketMakers[0].inventory.get('T1')).toBe(-100);
    expect(() => s.onVirtualFill({ tag: 'NOT_EXIST', symbol: 'T1', side: 'buy', qty: 1, price: 1 })).not.toThrow();
    expect(ledger.cash).toBeCloseTo(100000, 6);
  });

  test('④ 异常载荷（NaN/0）挡在账本外，不写 NaN', () => {
    const { s, ledger } = makeService();
    ledger.positions.set('T1', { qty: 100, cost: 8 });
    const warns = [];
    s.logger.warn = (m) => warns.push(String(m));
    s.onAiVirtualFill({ tag: 'AI1', orderId: 'ai-AI1-1', symbol: 'T1', side: 'sell', qty: NaN, price: 9 });
    s.onAiVirtualFill({ tag: 'AI1', orderId: 'ai-AI1-1', symbol: 'T1', side: 'buy', qty: 10, price: 0 });
    expect(ledger.cash).toBe(100000);
    expect(ledger.positions.get('T1').qty).toBe(100);
    expect(ledger.trades).toBe(0);
    expect(warns.length).toBe(2);
    expect(Number.isFinite(ledger.cash)).toBe(true);
  });
});

describe('Phase 13 P1-9：AI 市价单对手方结算失败不得静默入账', () => {
  const FILL = {
    filledQuantity: 50, avgPrice: 10, totalCost: 500,
    counterFills: [{ orderId: 'U1', accountId: 'A1', side: 'sell', price: 10, qty: 50, virtual: false }],
  };

  test('结算失败（{ok:false}）：不改账本、不打价格冲击、记 error', async () => {
    const { engine } = fakeEngine({ fill: FILL, settle: { ok: false, error: '对手方余额不足' } });
    const { s, stock, ledger } = makeService({ engine, ledger: { cash: 100000 } });
    patchRng(RNG_MARKET);
    stock.price = 11; // 上涨 → 看多 → 市价买
    const errors = [];
    s.logger.error = (m) => errors.push(String(m));
    const priceBefore = stock.price;

    await s.applyAiTrading();
    expect(engine.calls.settled.length).toBe(1);
    expect(ledger.cash).toBe(100000);           // 不再扣现金
    expect(ledger.positions.size).toBe(0);      // 不再建仓
    expect(stock.price).toBe(priceBefore);      // 不再产生价格冲击
    expect(stock.dayVolume).toBe(0);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('结算失败');
  });

  test('结算成功（{ok:true}）：账本与价格冲击照常', async () => {
    const { engine } = fakeEngine({ fill: FILL, settle: { ok: true, settled: 1, failed: 0 } });
    const { s, stock, ledger } = makeService({ engine, ledger: { cash: 100000 } });
    patchRng(RNG_MARKET);
    stock.price = 11;
    stock.prevClose = 11.5; // 带宽 [10.35, 12.65]：冲击价 11.11 不被夹紧，便于断言冲击生效

    await s.applyAiTrading();
    expect(ledger.cash).toBeCloseTo(100000 - 500, 6);
    expect(ledger.positions.get('T1').qty).toBe(50);
    expect(ledger.positions.get('T1').cost).toBeCloseTo(10, 6);
    expect(stock.price).toBeGreaterThan(11); // 买方向价格冲击生效
    expect(stock.dayHigh).toBeGreaterThanOrEqual(stock.price);
  });

  test('容错：结算返回 undefined（旧签名未改）时按原逻辑继续', async () => {
    const { engine } = fakeEngine({ fill: FILL, settle: undefined });
    const { s, stock, ledger } = makeService({ engine, ledger: { cash: 100000 } });
    patchRng(RNG_MARKET);
    stock.price = 11;

    await s.applyAiTrading();
    expect(ledger.cash).toBeCloseTo(99500, 6);
    expect(ledger.positions.get('T1').qty).toBe(50);
  });

  test('虚拟对手单（无账户）不进结算队列，不误判为失败', async () => {
    const virtualOnly = {
      filledQuantity: 30, avgPrice: 10, totalCost: 300,
      counterFills: [{ orderId: 'ai-AI2-1', accountId: null, side: 'sell', price: 10, qty: 30, virtual: true }],
    };
    const { engine } = fakeEngine({ fill: virtualOnly, settle: { ok: false, error: '不应被调用' } });
    const { s, stock, ledger } = makeService({ engine, ledger: { cash: 100000 } });
    patchRng(RNG_MARKET);
    stock.price = 11;

    await s.applyAiTrading();
    expect(engine.calls.settled.length).toBe(0);
    expect(ledger.cash).toBeCloseTo(99700, 6); // 照常入账
    expect(ledger.positions.get('T1').qty).toBe(30);
  });
});

describe('Phase 13 P1-13 / markAiEquityDaily 口径', () => {
  test('P1-13：报价夹紧用 cnPriceLimits（昨收基准 ±10%），不再用 dayOpen±10% 硬编码', async () => {
    const { engine, calls } = realEngine();
    const { s, stock } = makeService({ engine });
    patchRng(RNG_LIMIT);
    // 昨收 10（带宽 [9, 11]）、今开 10、现价 12：原始报价 ≈12.007 应被夹到 11（旧实现同样 11）
    stock.prevClose = 10; stock.dayOpen = 10; stock.price = 12;
    await s.applyAiTrading();
    expect(calls.placed[0].price).toBe(11);
  });

  test('P1-13：新股首日带宽放宽（昨收基准 +44%/-36%），报价可高于 ±10%', async () => {
    const { engine, calls } = realEngine();
    const { s, stock } = makeService({ engine });
    patchRng(RNG_LIMIT);
    stock.prevClose = 10; stock.dayOpen = 10; stock.price = 12; stock.listedDay = s.gameDay; // 首日
    await s.applyAiTrading();
    const price = calls.placed[0].price;
    expect(price).toBeGreaterThan(11);      // 旧 dayOpen±10% 实现会压到 11
    expect(price).toBeLessThanOrEqual(Number((10 * 1.44).toFixed(4)));
  });

  test('非 CN（HK/US）不夹紧：报价维持既有口径', async () => {
    const { engine, calls } = realEngine();
    const { s, stock } = makeService({ engine, stock: { symbol: 'H0001', market: 'HK', prevClose: 10, dayOpen: 10, price: 11 } });
    patchRng(RNG_LIMIT);
    await s.applyAiTrading();
    expect(calls.placed.length).toBe(1);
    expect(calls.placed[0].price).toBeGreaterThan(11); // 无 ±10% 夹紧（HK 无涨跌停）
  });

  test('markAiEquityDaily / getAiOpponents 口径不变：持仓市值按现价计入净值', () => {
    const { s, stock, ledger } = makeService();
    ledger.positions.set('T1', { qty: 100, cost: 8 });
    stock.price = 12;
    s.markAiEquityDaily();
    expect(ledger.equityHistory[0].equity).toBe(100000 + 1200);
    const opp = s.getAiOpponents()[0];
    expect(opp.equity).toBe(101200);
    expect(opp.pnlPct).toBeCloseTo(1.2, 4);
  });
});
