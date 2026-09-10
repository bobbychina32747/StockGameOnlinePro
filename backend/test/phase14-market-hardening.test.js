// Phase 14 REFACTOR-5 批次 B 回归：行情/做市商/竞价加固
// ① R5-⑧ 做市商库存上下限：顶上限只报卖边、触下限只报买边、区间内双边；onMmFill 越界 clamp
// ② R5-⑪ AI 市价买单数量先扣「活跃挂单现金占用」，占用吃满闸门时直接跳过（不得叠加突破 0.8×cash）
// ②b R5-⑪ 只读占用口径：刷新占用不得重建 ledger.restingOrders 数组（重建会让调用点捕获的别名变孤儿，
//    随后挂出的买单不进账本 → 占用恒 0、成交回调报"挂单记录缺失"）
// ③ R5-⑫ 除权按同一比例缩放 dayHigh/dayLow/dayOpen，并保证 dayHigh ≥ price ≥ dayLow
// ④ R5-⑬ 集合竞价的虚拟成交触发 virtualFillHook（mmId 与 tag 两类各 1 例，真实挂单不触发）
const A = require('../dist/src/core/market-data/ai-opponents');
const MM = require('../dist/src/core/market-data/market-maker');
const { MarketDataService } = require('../dist/src/core/market-data/market-data.service');
const { MatchingEngine } = require('../dist/src/core/trading-engine/matching-engine');

// 与 market-data.service.ts 的 MM_INVENTORY_LIMIT 保持一致（±60,000 股）
const MM_INVENTORY_LIMIT = 60000;

// ─── 确定性随机：钉死 agentRng 的每个 salt，使 AI 下单路径（限价/市价）可复现 ───
const REAL_AGENT_RNG = A.agentRng;
function patchRng(values) {
  A.agentRng = (day, tick, agentId, salt) => () => (values[salt] !== undefined ? values[salt] : 0.5);
}
const RNG_MARKET = { act: 0, pick: 0.1, dir: 0.5, qty: 0.1, route: 0.9 }; // route≥0.67 → 市价分支
const RNG_LIMIT = { act: 0, pick: 0.1, dir: 0.5, qty: 0.1, route: 0.1, offset: 0.1, ttl: 0.5 }; // route<0.67 → 限价分支
afterEach(() => { A.agentRng = REAL_AGENT_RNG; });

// ─── 手工 fake 引擎：只记录报价/撤单，用于库存限额（不需要真撮合） ───
function fakeEngine() {
  const calls = { placed: [], removed: [], hookRegs: 0 };
  const engine = {
    calls, hook: null,
    setVirtualFillHook(fn) { calls.hookRegs++; engine.hook = fn; },
    pruneExpiredVirtualOrders() { },
    removeRestingOrder(symbol, orderId) { calls.removed.push({ symbol, orderId }); },
    getOrderBook() { return { bids: [], asks: [] }; },
    placeVirtualOrder(symbol, side, price, qty, ttl, opts) { calls.placed.push({ symbol, side, price, qty, ttl, opts }); },
  };
  return { engine, calls };
}

// ─── 真实撮合引擎外包一层门面（市价单真吃盘口、真走账本） ───
function realEngine() {
  const matching = new MatchingEngine();
  const calls = { placed: [], market: [], settled: [], hookRegs: 0 };
  const engine = {
    matching, calls, hook: null,
    setVirtualFillHook(fn) { calls.hookRegs++; engine.hook = fn; matching.setVirtualFillHook((f) => fn(f)); },
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
  s.aiAdaptiveEnabled = false; // 默认参数 + 全 1 系数 → 下单量可精确预测
  s.engine = opts.engine || null;
  return { s, stock, agent, ledger };
}

describe('Phase 14 R5-⑧：做市商库存上下限（库存风控，非价格干预）', () => {
  test('顶上限只报卖边、触下限只报买边、区间内双边', () => {
    const { engine, calls } = fakeEngine();
    const { s } = makeService({ engine });

    // MM1 库存顶在上限 → 只报卖边（买边会继续吸货）
    s.marketMakers[0].inventory.set('T1', MM_INVENTORY_LIMIT);
    s.refreshMarketMakers();
    const mm1 = calls.placed.filter((o) => o.opts.mmId === 'MM1');
    expect(mm1.length).toBe(1);
    expect(mm1[0].side).toBe('sell');
    expect(mm1[0].opts.orderId).toBe('MMA-MM1-T1'); // 卖边报价 id 不变
    // MM2 库存 0 → 区间内保持双边；撤旧报价照旧
    const mm2 = calls.placed.filter((o) => o.opts.mmId === 'MM2');
    expect(mm2.map((o) => o.side)).toEqual(['buy', 'sell']);
    expect(calls.placed.length).toBe(3);
    expect(calls.removed.length).toBe(4); // 每个 MM 每标的撤 buy/sell 两条旧报价

    // MM1 库存触下限 → 只报买边
    calls.placed.length = 0;
    s.marketMakers[0].inventory.set('T1', -MM_INVENTORY_LIMIT);
    s.refreshMarketMakers();
    const low = calls.placed.filter((o) => o.opts.mmId === 'MM1');
    expect(low.length).toBe(1);
    expect(low[0].side).toBe('buy');
    expect(low[0].opts.orderId).toBe('MMB-MM1-T1');
  });

  test('判定口径 = 当前库存 ± 本次报量：未越界（= 限额）仍双边，越界 1 股即收边', () => {
    const { engine, calls } = fakeEngine();
    const { s, stock } = makeService({ engine });
    // 贴限额时 mmQuote 的报量已收缩到下限档（|inv| ≫ inventoryLimit=4000 → 系数取 0.2）；
    // 用该档库存值代入计算，保证"库存 + 报量 = 限额"这一边界是精确的
    const size = MM.mmQuote(stock.price, stock.volatility, MM_INVENTORY_LIMIT, MM.MM_PARAMS).size;

    s.marketMakers[1].inventory.set('T1', MM_INVENTORY_LIMIT); // 先让 MM2 闭嘴（只报卖边）
    s.marketMakers[0].inventory.set('T1', MM_INVENTORY_LIMIT - size);
    s.refreshMarketMakers();
    expect(calls.placed.filter((o) => o.opts.mmId === 'MM1').map((o) => o.side)).toEqual(['buy', 'sell']);

    calls.placed.length = 0;
    s.marketMakers[0].inventory.set('T1', MM_INVENTORY_LIMIT - size + 1);
    s.refreshMarketMakers();
    expect(calls.placed.filter((o) => o.opts.mmId === 'MM1').map((o) => o.side)).toEqual(['sell']);
  });

  test('onMmFill 更新库存同样 clamp 到上下限（跳空/巨量成交不越界）', () => {
    const { s } = makeService();
    s.onMmFill({ mmId: 'MM1', symbol: 'T1', side: 'buy', qty: 100000, price: 10 });
    expect(s.marketMakers[0].inventory.get('T1')).toBe(MM_INVENTORY_LIMIT);
    s.onMmFill({ mmId: 'MM1', symbol: 'T1', side: 'sell', qty: 500000, price: 10 });
    expect(s.marketMakers[0].inventory.get('T1')).toBe(-MM_INVENTORY_LIMIT);
    // 区间内的正常成交不被改写（存量口径不变）
    s.onMmFill({ mmId: 'MM2', symbol: 'T1', side: 'sell', qty: 100, price: 10 });
    expect(s.marketMakers[1].inventory.get('T1')).toBe(-100);
    // 异常载荷（NaN）不得污染库存（否则后续限额判定全部失效）
    s.onMmFill({ mmId: 'MM1', symbol: 'T1', side: 'buy', qty: NaN, price: 10 });
    expect(Number.isFinite(s.marketMakers[0].inventory.get('T1'))).toBe(true);
    expect(s.marketMakers[0].inventory.get('T1')).toBe(-MM_INVENTORY_LIMIT);
  });
});

describe('Phase 14 R5-⑪：AI 市价买单不得叠加突破现金闸门', () => {
  // 盘口一条 10 元 / 5000 股卖单；AI 走市价分支买 10 元档
  function marketBuySetup(opts = {}) {
    const { engine, matching, calls } = realEngine();
    const cash = opts.cash === undefined ? 10000 : opts.cash;
    const { s, stock, ledger } = makeService({
      engine,
      agent: { scale: opts.scale === undefined ? 4000 : opts.scale },
      ledger: { cash, initialCash: cash },
    });
    patchRng(RNG_MARKET);
    stock.price = 11; // 上涨 → trend 策略看多 → 买
    matching.placeVirtualOrder('T1', 'sell', 10, 5000, 999999, { orderId: 'MMA-MM1-T1', mmId: 'MM1' });
    if (opts.resting)
      ledger.restingOrders = opts.resting;
    return { s, stock, ledger, calls };
  }

  test('无占用：上限 = floor(cash×0.8 / price)，口径不变', async () => {
    const { s, ledger, calls } = marketBuySetup();
    await s.applyAiTrading();
    expect(calls.market.length).toBe(1);
    expect(calls.market[0].side).toBe('buy');
    expect(calls.market[0].qty).toBe(Math.floor((10000 * 0.8) / 11)); // 727
    expect(10000 - ledger.cash).toBeLessThanOrEqual(10000 * 0.8 + 1e-9);
  });

  test('有活跃挂单占用：数量压缩为 floor((0.8×cash − 占用) / price)，总敞口不破 0.8×cash', async () => {
    const resting = [{ orderId: 'ai-AI1-9', symbol: 'T1', side: 'buy', qty: 700, price: 10, expiresAtTick: 999, filledQty: 0 }];
    const { s, ledger, calls } = marketBuySetup({ resting });
    await s.applyAiTrading();
    // 占用 700×10 = 7000 → 上限 floor((8000−7000)/11) = 90（原实现会按 8000/11 = 727 下单 → 破闸门）
    expect(calls.market.length).toBe(1);
    expect(calls.market[0].qty).toBe(Math.floor((10000 * 0.8 - 7000) / 11));
    expect(calls.market[0].qty).toBeLessThan(Math.floor((10000 * 0.8) / 11));
    const spend = 10000 - ledger.cash;
    expect(spend).toBeCloseTo(90 * 10, 6); // 成交价 = 盘口价 10
    expect(7000 + spend).toBeLessThanOrEqual(10000 * 0.8 + 1e-9); // 占用 + 支出 ≤ 0.8×cash
  });

  test('占用吃满闸门（≥0.8×cash）：该笔直接跳过，账本与盘口都不动', async () => {
    const resting = [{ orderId: 'ai-AI1-8', symbol: 'T1', side: 'buy', qty: 800, price: 10, expiresAtTick: 999, filledQty: 0 }];
    const { s, ledger, calls } = marketBuySetup({ resting });
    await s.applyAiTrading();
    expect(calls.market.length).toBe(0); // qty ≤ 0 → 不进撮合
    expect(ledger.cash).toBe(10000);
    expect(ledger.positions.size).toBe(0);
  });

  test('卖单分支不受影响（仍只受「持仓 − 活跃卖单」约束）', async () => {
    const { engine, matching, calls } = realEngine();
    const { s, stock, ledger } = makeService({ engine, agent: { scale: 4000 } });
    patchRng(RNG_MARKET);
    stock.price = 9; // 下跌 → trend 看空 → 卖
    ledger.positions.set('T1', { qty: 120, cost: 8 });
    matching.placeVirtualOrder('T1', 'buy', 10, 5000, 999999, { orderId: 'MMB-MM1-T1', mmId: 'MM1' });

    await s.applyAiTrading();
    expect(calls.market.length).toBe(1);
    expect(calls.market[0].side).toBe('sell');
    expect(calls.market[0].qty).toBe(120); // 持仓上限，而非现金闸门
  });

  test('服务自己挂出的限价买单必须留在账本（占用刷新不得重建数组）', async () => {
    const { engine, calls } = realEngine();
    const { s, stock, ledger } = makeService({ engine, agent: { scale: 605 }, ledger: { cash: 10000, initialCash: 10000 } });
    patchRng(RNG_LIMIT);
    stock.price = 11; // 上涨 → 买单，走限价分支

    await s.applyAiTrading();
    expect(calls.placed.length).toBe(1);
    const cost = calls.placed[0].qty * calls.placed[0].price;
    // 修复前：买单分支先调 refreshAiRestingValue（重建 restingOrders），resting.push 落进孤儿数组 →
    // 账本 0 条挂单、占用恒 0（下方第二个 tick 会误放行第二笔挂单）
    expect(ledger.restingOrders.length).toBe(1);
    expect(ledger.restingOrders[0].orderId).toBe('ai-AI1-1');
    expect(ledger.restingValue).toBeCloseTo(cost, 6);
    expect(s.aiRestingCash(ledger)).toBeCloseTo(cost, 6);

    s.tickCount = 1;
    await s.applyAiTrading(); // 占用 + 新单 > cash×restBudget → 跳过
    expect(calls.placed.length).toBe(1);

    // 成交回调能定位到该挂单（修复前会走"挂单记录缺失"告警分支）
    engine.matching.executeVirtualMarketOrder('T1', 'sell', calls.placed[0].qty);
    expect(ledger.restingOrders.length).toBe(0);
    expect(ledger.restingValue).toBe(0);
  });

  test('市价买单自动识别服务挂出的占用（无需手工注入 restingOrders）', async () => {
    const { engine, matching, calls } = realEngine();
    const { s, stock, ledger } = makeService({ engine, agent: { scale: 605 }, ledger: { cash: 10000, initialCash: 10000 } });
    patchRng(RNG_LIMIT);
    stock.price = 11;
    await s.applyAiTrading(); // tick 0：限价买 363 股 @11 → 占用 3993
    const cost = calls.placed[0].qty * calls.placed[0].price;
    expect(cost).toBeCloseTo(3993, 6);

    patchRng(RNG_MARKET); // tick 1：改走市价分支，盘口 10 元 5000 股
    matching.placeVirtualOrder('T1', 'sell', 10, 5000, 999999, { orderId: 'MMA-MM1-T1', mmId: 'MM1' });
    s.tickCount = 1;
    await s.applyAiTrading();
    expect(calls.market.length).toBe(1);
    // scale=605 → 363 股；现金上限 floor((8000−3993)/11) = 364 > 363，故仍为 363，
    // 但必须显著小于"无占用口径"的 floor(8000/11) = 727——这证明占用来自账本自持记录
    expect(calls.market[0].qty).toBe(363);
    expect(calls.market[0].qty).toBeLessThan(Math.floor((10000 * 0.8) / 11));
    expect(cost + (10000 - ledger.cash)).toBeLessThanOrEqual(10000 * 0.8 + 1e-9);
  });
});

describe('Phase 14 R5-⑫：除权日 dayHigh/dayLow/dayOpen 同比例缩放', () => {
  test('按 newPrice/oldPrice 缩放，且 dayHigh ≥ price ≥ dayLow；复权因子口径不变', async () => {
    const { s, stock } = makeService({ stock: { price: 10, prevClose: 10, dayOpen: 9.8, dayHigh: 10.6, dayLow: 9.5 } });
    s.recordDividend('T1', 2, 5); // announceDay=5 → exDay=6；10 → 8，ratio = 0.8
    expect(await s.applyExRights(6)).toBe(1);

    expect(stock.price).toBe(8);
    expect(stock.dayHigh).toBeCloseTo(10.6 * 0.8, 6);
    expect(stock.dayLow).toBeCloseTo(9.5 * 0.8, 6);
    expect(stock.dayOpen).toBeCloseTo(9.8 * 0.8, 6);
    expect(stock.dayHigh).toBeGreaterThanOrEqual(stock.price);
    expect(stock.dayLow).toBeLessThanOrEqual(stock.price);
    // P1-15 prevClose 口径不变 + 复权因子不变
    expect(stock.prevClose).toBe(8);
    expect(s.adjFactors.get('T1').factor).toBeCloseTo(0.8, 6);
  });

  test('历史脏值（dayHigh < price / dayLow > price）缩放后以 price 兜底', async () => {
    const { s, stock } = makeService({ stock: { price: 10, prevClose: 10, dayOpen: 10, dayHigh: 7, dayLow: 12 } });
    s.recordDividend('T1', 2, 5);
    await s.applyExRights(6);
    expect(stock.price).toBe(8);
    expect(stock.dayHigh).toBe(stock.price); // max(8, 7×0.8) = 8
    expect(stock.dayLow).toBe(stock.price);  // min(8, 12×0.8) = 8
    expect(stock.dayHigh).toBeGreaterThanOrEqual(stock.price);
    expect(stock.dayLow).toBeLessThanOrEqual(stock.price);
  });

  test('高低缺失（undefined）时不写 NaN、不抛错', async () => {
    const { s, stock } = makeService({ stock: { price: 10, prevClose: 10, dayOpen: undefined, dayHigh: undefined, dayLow: undefined } });
    s.recordDividend('T1', 2, 5);
    expect(await s.applyExRights(6)).toBe(1);
    expect(stock.price).toBe(8);
    expect(stock.dayHigh).toBeUndefined(); // 仍是"缺值"而非 NaN 脏值
    expect(stock.dayLow).toBeUndefined();
  });

  test('未除权（exDay 不匹配）时高低不被改写', async () => {
    const { s, stock } = makeService({ stock: { price: 10, prevClose: 10, dayOpen: 10, dayHigh: 10.6, dayLow: 9.5 } });
    s.recordDividend('T1', 2, 5);
    expect(await s.applyExRights(5)).toBe(0);
    expect(stock.dayHigh).toBe(10.6);
    expect(stock.dayLow).toBe(9.5);
    expect(stock.dayOpen).toBe(10);
  });
});

describe('Phase 14 R5-⑬：集合竞价虚拟成交触发 virtualFillHook', () => {
  test('mmId 与 tag 两类虚拟成交各触发一次，价格用竞价成交价', () => {
    const m = new MatchingEngine();
    const seen = [];
    m.setVirtualFillHook((f) => seen.push(f));
    m.placeVirtualOrder('T1', 'buy', 10.2, 100, 999999, { orderId: 'ai-AI1-1', tag: 'AI1' });
    m.placeVirtualOrder('T1', 'sell', 10.0, 100, 999999, { orderId: 'MMA-MM1-T1', mmId: 'MM1' });

    const res = m.runOpeningAuction('T1', 10.0);
    expect(res.auctionPrice).toBe(10.0);
    expect(res.fills.length).toBe(2); // fills 内容保持原样（不含 mmId/tag）
    expect(res.fills.map((f) => f.price)).toEqual([10.0, 10.0]);
    expect(seen).toEqual([
      { mmId: null, tag: 'AI1', orderId: 'ai-AI1-1', symbol: 'T1', side: 'buy', qty: 100, price: 10.0 },
      { mmId: 'MM1', tag: null, orderId: 'MMA-MM1-T1', symbol: 'T1', side: 'sell', qty: 100, price: 10.0 },
    ]);
  });

  test('非虚拟成交（用户真实挂单）不触发钩子；混合时只触发虚拟一侧', () => {
    const m = new MatchingEngine();
    const seen = [];
    m.setVirtualFillHook((f) => seen.push(f));
    m.placeRestingOrder('T1', 'b1', 'A1', 'buy', 10.2, 100);
    m.placeRestingOrder('T1', 'a1', 'A2', 'sell', 10.0, 100);
    const allReal = m.runOpeningAuction('T1', 10.0);
    expect(allReal.fills.length).toBe(2);
    expect(allReal.fills.every((f) => f.virtual === false)).toBe(true);
    expect(seen.length).toBe(0);

    // 混合：真实买挂单 × 虚拟卖挂单（tag）→ 只触发虚拟的卖边
    const m2 = new MatchingEngine();
    const seen2 = [];
    m2.setVirtualFillHook((f) => seen2.push(f));
    m2.placeRestingOrder('T1', 'b1', 'A1', 'buy', 10.2, 100);
    m2.placeVirtualOrder('T1', 'sell', 10.0, 100, 999999, { orderId: 'ai-AI1-1', tag: 'AI1' });
    const mixed = m2.runOpeningAuction('T1', 10.0);
    expect(mixed.fills.length).toBe(2);
    expect(seen2.length).toBe(1);
    expect(seen2[0]).toMatchObject({ tag: 'AI1', mmId: null, side: 'sell', orderId: 'ai-AI1-1', qty: 100, price: 10.0 });
  });

  test('未注册钩子时竞价照常返回（无副作用），无交叉挂单不触发', () => {
    const m = new MatchingEngine();
    m.placeVirtualOrder('T1', 'buy', 10.2, 100, 999999, { orderId: 'ai-AI1-1', tag: 'AI1' });
    m.placeVirtualOrder('T1', 'sell', 10.0, 100, 999999, { orderId: 'MMA-MM1-T1', mmId: 'MM1' });
    expect(() => m.runOpeningAuction('T1', 10.0)).not.toThrow();
    expect(m.runOpeningAuction('T1', 10.0).fills.length).toBe(0); // 已撮合完，无剩余交叉

    const m2 = new MatchingEngine();
    const seen = [];
    m2.setVirtualFillHook((f) => seen.push(f));
    m2.placeVirtualOrder('T1', 'buy', 9.5, 100, 999999, { orderId: 'ai-AI1-1', tag: 'AI1' });
    m2.placeVirtualOrder('T1', 'sell', 10.5, 100, 999999, { orderId: 'MMA-MM1-T1', mmId: 'MM1' });
    const res = m2.runOpeningAuction('T1', 10.0);
    expect(res.fills.length).toBe(0);
    expect(seen.length).toBe(0);
  });

  test('集成：竞价成交经 onVirtualFill 分发——做市商库存更新 + AI 账本入账 + 冻结立即释放', () => {
    const m = new MatchingEngine();
    const { s, ledger } = makeService();
    ledger.positions.set('T1', { qty: 100, cost: 8 });
    // AI 卖单在竞价成交前处于活跃冻结状态（TTL 未到）
    ledger.restingOrders = [{ orderId: 'ai-AI1-1', symbol: 'T1', side: 'sell', qty: 100, price: 10, expiresAtTick: 999, filledQty: 0 }];
    s.engine = { setVirtualFillHook: (fn) => m.setVirtualFillHook(fn) };
    s.ensureVirtualFillHook();

    m.placeVirtualOrder('T1', 'buy', 10.2, 100, 999999, { orderId: 'MMB-MM1-T1', mmId: 'MM1' });
    m.placeVirtualOrder('T1', 'sell', 10.0, 100, 999999, { orderId: 'ai-AI1-1', tag: 'AI1' });
    const res = m.runOpeningAuction('T1', 10.0);
    expect(res.fills.length).toBe(2);

    expect(s.marketMakers[0].inventory.get('T1')).toBe(100); // 做市商买边成交 → 库存 +100
    expect(ledger.cash).toBeCloseTo(100000 + 100 * 10, 6);  // AI 卖边成交 → 现金入账
    expect(ledger.positions.has('T1')).toBe(false);          // 持仓已减
    expect(ledger.trades).toBe(1);
    expect(ledger.restingOrders.length).toBe(0);             // 冻结立即释放（不必等 TTL 过期）
  });
});
