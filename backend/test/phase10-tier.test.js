// Phase D 回归：段位数据驱动公式 / 实体索引元数据 / checkPendingOrders 批量预载行为
const { computeTierScore, tierOf, TIER_LEVELS } = require('../dist/src/core/risk-manager/tier');
const { TradingEngineService } = require('../dist/src/core/trading-engine/trading-engine.service');

describe('Phase D 段位公式（纯函数，teams 定稿权重）', () => {
  test('满分边界：收益50%/回撤0/pf2/胜率100%/50笔 → 100 分王者', () => {
    const score = computeTierScore({ totalReturn: 0.5, maxDrawdown: 0, profitFactor: 2, winRate: 1, totalTrades: 50 });
    expect(score).toBe(100);
    expect(tierOf(score).name).toBe('王者');
  });

  test('典型账户：收益25%/回撤10%/pf1.5/胜率55%/30笔 → 69 分铂金', () => {
    const score = computeTierScore({ totalReturn: 0.25, maxDrawdown: 0.1, profitFactor: 1.5, winRate: 0.55, totalTrades: 30 });
    expect(score).toBe(69);
    expect(tierOf(score).name).toBe('铂金');
  });

  test('0 流水账户 → 23 分白银（回撤保底0.7+活跃保底0.3，游戏策划红线 ≥15）', () => {
    const score = computeTierScore({ totalReturn: 0, maxDrawdown: 0, profitFactor: 0, winRate: 0, totalTrades: 0 });
    expect(score).toBe(23);
    expect(tierOf(score).name).toBe('白银');
  });

  test('灾难账户（亏损+大回撤+低pf+0胜率）→ 21 分白银（保底系数副作用：最低分=回撤14+活跃3=17，青铜段仅表保留不可达——teams 定稿取舍）', () => {
    const score = computeTierScore({ totalReturn: -0.2, maxDrawdown: 0.6, profitFactor: 0.2, winRate: 0.1, totalTrades: 0 });
    expect(score).toBe(21);
    expect(tierOf(score).name).toBe('白银');
  });

  test('pf=Infinity 视为满分；metrics=undefined 不抛', () => {
    expect(computeTierScore({ totalReturn: 0.5, maxDrawdown: 0, profitFactor: Infinity, winRate: 0.9, totalTrades: 200 })).toBeGreaterThanOrEqual(97);
    expect(() => computeTierScore(undefined)).not.toThrow();
  });

  test('阈值表保留原七段', () => {
    expect(TIER_LEVELS.map((t) => t.name)).toEqual(['王者', '大师', '钻石', '铂金', '黄金', '白银', '青铜']);
  });
});

describe('Phase D 实体索引（TypeORM 元数据，synchronize 首启落库）', () => {
  const { getMetadataArgsStorage } = require('typeorm');
  // require 即注册装饰器元数据（编译风格 TS，dist 产物）
  const { Order } = require('../dist/src/infrastructure/database/entities/order.entity');
  const { Transaction } = require('../dist/src/infrastructure/database/entities/transaction.entity');
  const { Position } = require('../dist/src/infrastructure/database/entities/position.entity');
  const storage = getMetadataArgsStorage();
  const idxOf = (target, columns) => storage.indices.find((i) =>
    i.target === target && JSON.stringify(i.columns) === JSON.stringify(columns));

  test('orders 有复合索引 (accountId, status)', () => {
    expect(idxOf(Order, ['accountId', 'status'])).toBeTruthy();
  });

  test('transactions 有 accountId 索引', () => {
    expect(idxOf(Transaction, ['accountId'])).toBeTruthy();
  });

  test('positions 不加冗余 accountId 索引（teams 定稿砍除，Unique 左前缀已覆盖）', () => {
    expect(idxOf(Position, ['accountId'])).toBeFalsy();
    expect(storage.uniques.some((u) => u.target === Position && JSON.stringify(u.columns) === JSON.stringify(['accountId', 'symbol']))).toBeTruthy();
  });
});

describe('Phase D checkPendingOrders 批量预载（行为级验收，teams 门槛）', () => {
  function matchesWhere(r, where) {
    if (Array.isArray(where)) return where.some((w) => matchesWhere(r, w));
    return Object.entries(where || {}).every(([k, v]) => {
      if (v && typeof v === 'object' && v._type === 'in') return (v.value || []).map(String).includes(String(r[k]));
      return String(r[k]) === String(v);
    });
  }
  function countingRepo(seed = []) {
    const rows = [...seed];
    let idc = 1;
    const calls = { find: 0, findOne: 0, lastFindWhere: null, findOneById: new Map() };
    return {
      rows, calls,
      find: async (q) => { calls.find++; calls.lastFindWhere = q?.where; return rows.filter((r) => matchesWhere(r, q?.where)); },
      findOne: async (q) => {
        calls.findOne++;
        const id = q?.where?.id;
        if (typeof id === 'string') calls.findOneById.set(id, (calls.findOneById.get(id) || 0) + 1);
        return rows.find((r) => matchesWhere(r, q?.where)) || null;
      },
      save: async (e) => {
        if (!e.id) e.id = 'auto-' + idc++;
        const i = rows.findIndex((r) => r.id === e.id);
        if (i >= 0) rows[i] = e; else rows.push(e);
        return e;
      },
      create: (obj) => obj,
    };
  }
  function makeAccount(id, cash) {
    return { id, userId: 'U' + id, marketMode: 'CN', cash, leverage: 1, totalEquity: cash, initialEquity: cash, peakEquity: cash, dayStartEquity: cash, borrowed: 0, shortCollateral: 0, totalTrades: 0, currentDay: 0 };
  }
  function makeOrder(id, accountId, symbol, qty, price = 9.5) {
    return { id, accountId, userId: 'U' + accountId, symbol, type: 'limit', side: 'buy', quantity: qty, price, triggerPrice: null, filledQty: 0, status: 'pending', postClose: false };
  }

  test('3 笔将成交挂单 2 账户：账户 find 只查 1 次（In 批量），同账户第二单 findOne 刷新 1 次', async () => {
    const orderRepo = countingRepo([makeOrder('O1', 'AC1', 'T1', 100), makeOrder('O2', 'AC1', 'T2', 100), makeOrder('O3', 'AC2', 'T3', 100)]);
    const accountRepo = countingRepo([makeAccount('AC1', 100000), makeAccount('AC2', 100000)]);
    const engine = new TradingEngineService(orderRepo, accountRepo, countingRepo(), countingRepo(), null);
    engine.prices.set('T1', 9); engine.prices.set('T2', 9); engine.prices.set('T3', 9);
    engine.placeRestingOrder('T1', 'r1', 'RX1', 'sell', 9, 100);
    engine.placeRestingOrder('T2', 'r2', 'RX2', 'sell', 9, 100);
    engine.placeRestingOrder('T3', 'r3', 'RX3', 'sell', 9, 100);
    const fills = await engine.checkPendingOrders();
    expect(fills.length).toBe(3);
    expect(orderRepo.rows.find((r) => r.id === 'O1').status).toBe('filled');
    expect(orderRepo.rows.find((r) => r.id === 'O2').status).toBe('filled');
    expect(orderRepo.rows.find((r) => r.id === 'O3').status).toBe('filled');
    // 批量预载：账户 find 恰好 1 次且为 In 查询
    expect(accountRepo.calls.find).toBe(1);
    expect(accountRepo.calls.lastFindWhere.id._type).toBe('in');
    expect(accountRepo.calls.lastFindWhere.id.value.map(String).sort()).toEqual(['AC1', 'AC2']);
    // AC1 三次 findOne = O1 结算内部重读(1) + O2 脏刷新(1) + O2 结算内部重读(1)——证明脏刷新恰好一次
    expect(accountRepo.calls.findOneById.get('AC1')).toBe(3);
    // AC2 一次 findOne = O3 结算内部重读（未触发脏刷新，直接命中批量 Map）
    expect(accountRepo.calls.findOneById.get('AC2')).toBe(1);
  });

  test('同账户第二单读到结算后现金：资金不足校验失败取消（脏刷新数据新鲜度）', async () => {
    const orderRepo = countingRepo([makeOrder('O1', 'AC1', 'T1', 9500), makeOrder('O2', 'AC1', 'T2', 2000)]);
    const accountRepo = countingRepo([makeAccount('AC1', 100000)]);
    const engine = new TradingEngineService(orderRepo, accountRepo, countingRepo(), countingRepo(), null);
    engine.prices.set('T1', 9); engine.prices.set('T2', 9);
    engine.placeRestingOrder('T1', 'r1', 'RX1', 'sell', 9, 9500);
    engine.placeRestingOrder('T2', 'r2', 'RX2', 'sell', 9, 2000);
    const fills = await engine.checkPendingOrders();
    expect(fills.length).toBe(1); // 只有第一单成交
    const o2 = orderRepo.rows.find((r) => r.id === 'O2');
    expect(o2.status).toBe('cancelled');
    expect(o2.rejectReason).toContain('资金不足');
    // 行为锚点：批量 find 1 次；AC1 两次 findOne = O1 结算内部重读(1) + O2 脏刷新(1)
    // （刷新读到结算后现金，validateOrder 才正确取消第二单——数据新鲜度的行为级证明）
    expect(accountRepo.calls.find).toBe(1);
    expect(accountRepo.calls.findOneById.get('AC1')).toBe(2);
  });
});
