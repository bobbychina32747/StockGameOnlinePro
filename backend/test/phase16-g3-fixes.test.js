// Phase 16（G-3）回归：线上两类"诡异报错"与"AI 赚钱了榜上不显示"的根因修复
//
// ① 虚拟成交回调跨市场错投：三个市场共用同一个撮合引擎，每个 MarketDataService 各注册一次钩子 →
//    后注册者覆盖先注册者，港股 AI9 的成交被记到 A 股 AI9 的账本上（挂单记录/持仓都不存在）→
//    刷屏 `挂单记录缺失` / `无对应持仓`，同时做市商库存被记到错误市场。
//    修复：钩子只注册一次 + 按成交标的所属市场路由（symbolMarket）。
// ② 虚拟挂单清理的跨市场 tick 基准：闭市市场 tickCount 不前进，用别市场的 tick 全量清理会
//    提前删掉"还没到期"的虚拟挂单（虚拟流动性凭空消失）。修复：pruneExpiredVirtualOrders 支持按市场过滤。
// ③ 排行榜/赛季榜"赚钱了显示 0.00%"：totalEquity 只在日终结算写库，盘中不重估。
//    修复：按最新价做市值重估（common/live-equity.ts），缺行情/缺报价时回退存量值。
const { MarketDataService } = require('../dist/src/core/market-data/market-data.service');
const { MatchingEngine } = require('../dist/src/core/trading-engine/matching-engine');
const { RankingService } = require('../dist/src/modules/ranking/ranking.service');
const { SeasonService } = require('../dist/src/modules/season/season.service');
const { computeLiveEquity } = require('../dist/src/common/live-equity');

// ─── 共享引擎的 fake（记录钩子注册次数与清理调用）───
function makeSharedEngine() {
  const calls = { setHook: 0, hook: null, pruned: [] };
  return {
    calls,
    setVirtualFillHook(fn) { calls.setHook++; calls.hook = fn; },
    pruneExpiredVirtualOrders(tick, matchSymbol) { calls.pruned.push({ tick, matchSymbol }); },
  };
}

// 捕获 logger 的 warn/error（断言"不再刷屏"用）
function captureLogs(svc) {
  const warns = [];
  const errors = [];
  svc.logger = {
    warn: (m) => warns.push(String(m)),
    error: (m) => errors.push(String(m)),
    log: () => { },
    debug: () => { },
  };
  return { warns, errors };
}

function makeLedger(over = {}) {
  return Object.assign({
    cash: 100000, initialCash: 100000, positions: new Map(),
    restingValue: 0, restingOrders: [], restingSeq: 0,
    trades: 0, wins: 0, losses: 0, realizedPnl: 0, equityHistory: [],
    params: {}, perfMarks: [], treeHit: [], treeMiss: [], treeWeights: null,
  }, over);
}

// 建一个指定市场的行情实例（同一引擎），名册只有 AI1
function makeInstance(market, engine, ledger) {
  const s = new MarketDataService(null, null, null, null, market);
  s.engine = engine;
  s.aiAgents = [{ id: 'AI1', name: '测试', type: '机构', strategy: 'trend' }];
  s.aiLedger = [ledger];
  return s;
}

describe('Phase 16 G-3①：虚拟成交回调按市场路由（不再错投到别的市场账本）', () => {
  test('同一引擎上钩子只注册一次（三市场实例互相覆盖是原缺陷）', () => {
    const engine = makeSharedEngine();
    const cn = makeInstance('CN', engine, makeLedger());
    const hk = makeInstance('HK', engine, makeLedger());
    const us = makeInstance('US', engine, makeLedger());
    cn.ensureVirtualFillHook();
    hk.ensureVirtualFillHook();
    us.ensureVirtualFillHook();
    expect(engine.calls.setHook).toBe(1); // 原实现是 3 次（后注册覆盖先注册）
    expect(typeof engine.calls.hook).toBe('function');
  });

  test('港股成交记到港股账本：A 股同名 AI 账本完全不动，且不再打"挂单记录缺失/无持仓"告警', () => {
    const engine = makeSharedEngine();
    const cnLedger = makeLedger();
    const hkLedger = makeLedger({
      // 港股 AI1 真实挂过一笔买单（成交前处于活跃冻结）
      restingOrders: [{ orderId: 'ai-AI1-1', symbol: 'H2', side: 'buy', qty: 100, price: 10, expiresAtTick: 9999, filledQty: 0 }],
    });
    const cn = makeInstance('CN', engine, cnLedger);
    const hk = makeInstance('HK', engine, hkLedger);
    const cnLogs = captureLogs(cn);
    const hkLogs = captureLogs(hk);
    cn.ensureVirtualFillHook();
    hk.ensureVirtualFillHook();

    // 撮合引擎抛出港股成交（symbol=H2 → 应路由到 HK 实例）
    engine.calls.hook({ mmId: null, tag: 'AI1', orderId: 'ai-AI1-1', symbol: 'H2', side: 'buy', qty: 100, price: 10 });

    // 港股账本：扣款 + 建仓 + 挂单记录移出（全成）
    expect(hkLedger.cash).toBeCloseTo(100000 - 100 * 10, 6);
    expect(hkLedger.positions.get('H2').qty).toBe(100);
    expect(hkLedger.restingOrders.length).toBe(0);
    // A 股账本：一分钱不动、一股不建（原缺陷：错投到这里，还会打两条告警）
    expect(cnLedger.cash).toBe(100000);
    expect(cnLedger.positions.size).toBe(0);
    expect([...cnLogs.warns, ...cnLogs.errors].join('|')).not.toContain('挂单记录缺失');
    expect([...cnLogs.warns, ...cnLogs.errors].join('|')).not.toContain('无对应持仓');
    expect([...hkLogs.warns, ...hkLogs.errors]).toEqual([]); // 港股侧账实相符，没有任何告警
  });

  test('做市商成交同样按市场路由：港股做市商库存交给港股实例', () => {
    const engine = makeSharedEngine();
    const cn = makeInstance('CN', engine, makeLedger());
    const hk = makeInstance('HK', engine, makeLedger());
    cn.ensureVirtualFillHook();
    hk.ensureVirtualFillHook();
    const cnInvBefore = cn.marketMakers[0].inventory.get('H2');
    engine.calls.hook({ mmId: 'MM1', tag: null, orderId: 'MMA-MM1-H2', symbol: 'H2', side: 'buy', qty: 300, price: 10 });
    // 港股实例的 MM1 库存 +300；A 股实例的 MM1 不受影响
    expect(Number(hk.marketMakers[0].inventory.get('H2'))).toBe(300);
    expect(cn.marketMakers[0].inventory.get('H2')).toBe(cnInvBefore);
  });

  test('未注册市场的成交不做任何兜底错投（宁可漏更新，也不能改写别的市场账本）', () => {
    const engine = makeSharedEngine();
    const cnLedger = makeLedger();
    const cn = makeInstance('CN', engine, makeLedger());
    const hk = makeInstance('HK', engine, makeLedger());
    cn.ensureVirtualFillHook();
    hk.ensureVirtualFillHook();
    const hkCash = hk.aiLedger[0].cash;
    // U9 属于美股，但本用例没有注册美股实例（且注册表里有 2 个实例 → 不触发单实例兜底）
    engine.calls.hook({ mmId: null, tag: 'AI1', orderId: 'ai-AI1-9', symbol: 'U9', side: 'buy', qty: 100, price: 10 });
    expect(cnLedger.cash).toBe(100000);
    expect(hk.aiLedger[0].cash).toBe(hkCash);
  });
});

describe('Phase 16 G-3②：虚拟挂单清理按市场过滤（别市场的 tick 不能删本市场未到期挂单）', () => {
  test('matching-engine：带过滤时只清本市场，不带过滤保持原全量语义', () => {
    const m = new MatchingEngine();
    m.placeVirtualOrder('T1', 'buy', 10, 100, 5, { orderId: 'ai-CN-1', tag: 'AI1' });   // A股，tick 5 到期
    m.placeVirtualOrder('H1', 'buy', 10, 100, 5, { orderId: 'ai-HK-1', tag: 'AI1' });   // 港股，tick 5 到期
    // A 股实例用 tick=99 清理（它自己的 tickCount 已经很大），但只允许清 A 股标的
    // 断言直接读 realBooks（虚拟挂单的真实存放处）：getOrderBook 是"合成深度 + 真实挂单"的合并视图，
    // 不适合用来判断某个挂单是否还在
    m.pruneExpiredVirtualOrders(99, (symbol) => !/^H/.test(symbol) && !/^U/.test(symbol));
    expect(m.realBooks.get('T1').bids.length).toBe(0);   // 本市场到期 → 清掉
    expect(m.realBooks.get('H1').bids.length).toBe(1);   // 别市场：tick 基准不同 → 必须留着
    m.pruneExpiredVirtualOrders(99);                     // 不带过滤 = 原全量语义
    expect(m.realBooks.get('H1').bids.length).toBe(0);
  });

  test('行情实例调用清理时带上本市场过滤（CN 实例只清 CN）', async () => {
    const engine = makeSharedEngine();
    const cn = makeInstance('CN', engine, makeLedger());
    cn.stocks.set('T1', { symbol: 'T1', price: 10, dayOpen: 10, prevClose: 10, industry: '银行', kline1min: [], kline5min: [], klineDaily: [] });
    cn.industryCycles.set('银行', 'expansion');
    cn.factors = {};
    await cn.applyAiTrading();
    expect(engine.calls.pruned.length).toBeGreaterThan(0);
    const match = engine.calls.pruned[0].matchSymbol;
    expect(typeof match).toBe('function');
    expect(match('T1')).toBe(true);
    expect(match('H1')).toBe(false);
    expect(match('U1')).toBe(false);
  });
});

describe('Phase 16 G-3③：排行榜/赛季榜按最新价重估（赚钱了就要显示）', () => {
  const rankingRepo = (accounts) => ({
    find: async () => accounts,
    findOne: async () => null,
  });
  const snapshotRepo = () => ({
    find: async () => [],
  });

  test('computeLiveEquity：cash + 持仓市值 + 空头保证金 − 融资负债；无持仓返回 null', () => {
    const account = { cash: 50000, shortCollateral: 0, borrowed: 0 };
    expect(computeLiveEquity(account, [], { T1: 11 })).toBeNull();
    expect(computeLiveEquity(account, [{ symbol: 'T1', longQty: 1000, shortQty: 0 }], { T1: 11 })).toBeCloseTo(61000, 6);
    // 有持仓却缺报价 → null（不能按 0 估值把浮盈算成亏损）
    expect(computeLiveEquity(account, [{ symbol: 'T1', longQty: 1000, shortQty: 0 }], {})).toBeNull();
    expect(computeLiveEquity(account, [{ symbol: 'T1', longQty: 1000, shortQty: 0 }], { H1: 10 })).toBeNull();
    // 融资负债/空头保证金计入
    expect(computeLiveEquity({ cash: 10000, shortCollateral: 2000, borrowed: 4000 }, [{ symbol: 'U1', longQty: 100, shortQty: 0 }], { U1: 50 }))
      .toBeCloseTo(10000 + 5000 + 2000 - 4000, 6);
  });

  test('排行榜：盘中重估（存量 totalEquity 仍是开户值 → 修复前显示 0.00%）', async () => {
    const accounts = [{
      id: 'A1', userId: 'U1', marketMode: 'CN', tier: '黄金', initialEquity: 100000,
      totalEquity: 100000, dayStartEquity: 100000,   // 日终才写的存量值（陈旧）
      cash: 50000, borrowed: 0, shortCollateral: 0,
      positions: [{ symbol: 'T1', longQty: 5000, shortQty: 0 }],
      user: { username: 'bot_alpha', isBot: true },
    }];
    const riskManager = { getCurrentPrices: () => ({ T1: 11 }) };
    const svc = new RankingService(rankingRepo(accounts), snapshotRepo(), riskManager);
    await svc.calculateRankings();
    const rows = svc.getRankings(50, 'totalReturn', 'ALL');
    expect(rows[0].totalEquity).toBeCloseTo(50000 + 5000 * 11, 6);   // 105000（原实现 100000）
    expect(rows[0].totalReturn).toBeCloseTo(0.05, 6);
    expect(rows[0].dayReturn).toBeCloseTo(0.05, 6);
    expect(rows[0].isBot).toBe(true);
    expect(rows[0].username).toBe('Alpha'); // 机器人展示名不受影响
  });

  test('排行榜：行情未就绪/缺报价 → 回退存量 totalEquity；未注入 RiskManager 时同样回退', async () => {
    const base = {
      id: 'A1', userId: 'U1', marketMode: 'CN', tier: '青铜', initialEquity: 100000,
      totalEquity: 123456, dayStartEquity: 100000,
      cash: 50000, borrowed: 0, shortCollateral: 0,
      positions: [{ symbol: 'T1', longQty: 5000, shortQty: 0 }],
      user: { username: 'human', isBot: false },
    };
    const noPrices = new RankingService(rankingRepo([base]), snapshotRepo(), { getCurrentPrices: () => ({}) });
    await noPrices.calculateRankings();
    expect(noPrices.getRankings(10, 'totalReturn', 'ALL')[0].totalEquity).toBe(123456);

    const legacy = new RankingService(rankingRepo([base]), snapshotRepo()); // 既有 2 参构造
    await legacy.calculateRankings();
    expect(legacy.getRankings(10, 'totalReturn', 'ALL')[0].totalEquity).toBe(123456);
  });

  test('赛季榜：同样按最新价重估（赛季收益率不再恒为 0.00%）', async () => {
    const seasonRepo = {
      findOne: async () => ({ id: 'S1', status: 'running', durationDays: 10, anchorDay: '{}' }),
    };
    const entryRepo = {
      find: async () => [{ seasonId: 'S1', userId: 'U1', accountId: 'A1', marketMode: 'CN', startEquity: 100000 }],
    };
    const accountRepo = {
      find: async () => [{
        id: 'A1', userId: 'U1', marketMode: 'CN', cash: 50000, borrowed: 0, shortCollateral: 0,
        totalEquity: 100000,   // 陈旧存量
        positions: [{ symbol: 'T1', longQty: 5000, shortQty: 0 }],
      }],
      findOne: async () => null,
    };
    const marketData = { getTradableSymbols: () => ['T1'], getLastPrice: (s) => (s === 'T1' ? 11 : undefined) };
    const svc = new SeasonService(seasonRepo, entryRepo, accountRepo, marketData, marketData, marketData);
    const board = await svc.leaderboard('S1', 'ALL', 20);
    expect(board.length).toBe(1);
    expect(board[0].seasonReturn).toBeCloseTo(5, 6);     // (105000-100000)/100000*100
    expect(board[0].seasonPnl).toBeCloseTo(5000, 6);
  });

  test('赛季榜：缺报价时回退存量 totalEquity（不产生假暴跌）', async () => {
    const seasonRepo = { findOne: async () => ({ id: 'S1', status: 'running', durationDays: 10, anchorDay: '{}' }) };
    const entryRepo = { find: async () => [{ seasonId: 'S1', userId: 'U1', accountId: 'A1', marketMode: 'CN', startEquity: 100000 }] };
    const accountRepo = {
      find: async () => [{
        id: 'A1', userId: 'U1', marketMode: 'CN', cash: 50000, borrowed: 0, shortCollateral: 0, totalEquity: 100000,
        positions: [{ symbol: 'T1', longQty: 5000, shortQty: 0 }],
      }],
      findOne: async () => null,
    };
    const marketData = { getTradableSymbols: () => ['T1'], getLastPrice: () => undefined };
    const svc = new SeasonService(seasonRepo, entryRepo, accountRepo, marketData, marketData, marketData);
    const board = await svc.leaderboard('S1', 'ALL', 20);
    expect(board[0].seasonReturn).toBeCloseTo(0, 6);
  });
});
