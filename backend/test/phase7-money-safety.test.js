// Phase A P0 修复回归：止损限价触发语义 / 强平资金安全 / 市价单兜底 / 分红快照发息 / 账户重置防刷钱
const { MatchingEngine } = require('../dist/src/core/trading-engine/matching-engine');
const { TradingEngineService } = require('../dist/src/core/trading-engine/trading-engine.service');
const { AccountService } = require('../dist/src/modules/account/account.service');

// 简易内存仓库（与 phase2 同款）
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

describe('Phase A 市价单滑点触顶兜底（P0#5）', () => {
  test('滑点触顶后剩余量按触顶价兜底成交，不再静默丢弃', () => {
    const m = new MatchingEngine();
    m.prices.set('T1', 10);
    m.orderBooks.set('T1', {
      bids: [{ price: 9.99, size: 100 }],
      asks: [{ price: 10.01, size: 100 }, { price: 10.02, size: 200 }],
    });
    const fill = m.executeMarketOrder('T1', 'buy', 100000, 'BUYER');
    expect(fill.filledQuantity).toBe(100000); // 全部成交，无剩余丢弃
    expect(fill.avgPrice).toBeGreaterThan(10.02);
  });

  test('封板时不兜底（无报价不可成交）', () => {
    const m = new MatchingEngine();
    m.prices.set('T1', 110);
    m.setDayOpen({ T1: 100 });
    m.refreshOrderBook('T1', 110);
    expect(m.executeMarketOrder('T1', 'buy', 10000, 'BUYER')).toBeNull();
  });
});

describe('Phase A STOP_LIMIT 触发前不入盘口（P0#2）', () => {
  test('提交止损限价单不入盘口，触发价满足后才成交', async () => {
    const orderRepo = fakeRepo();
    const accountRepo = fakeRepo([
      { id: 'AC1', cash: 100000, marketMode: 'CN', totalTrades: 0, shortCollateral: 0 },
      { id: 'AC2', cash: 100000, marketMode: 'CN', totalTrades: 0, shortCollateral: 0 },
    ]);
    const posRepo = fakeRepo([
      { id: 'P1', accountId: 'AC1', symbol: 'T1', longQty: 100, shortQty: 0, longCost: 1000, boughtToday: 0 },
    ]);
    const engine = new TradingEngineService(orderRepo, accountRepo, posRepo, fakeRepo(), null);
    engine.prices.set('T1', 10);

    // 止损限价卖出：触发价 9.5，限价 9.0；现价 10 未触发
    const r = await engine.submitOrder(
      { userId: 'U1', accountId: 'AC1', symbol: 'T1', type: 'stop-limit', side: 'sell', quantity: 100, price: 9.0, triggerPrice: 9.5 },
      { id: 'AC1', cash: 100000, marketMode: 'CN' }
    );
    expect(r.success).toBe(true);
    expect(r.order.status).toBe('pending');
    const book = engine.realBooks.get('T1');
    expect(book ? book.asks.length : 0).toBe(0); // 关键断言：不得提前入盘口

    // 现价跌破触发价且对手方有 9.0 买入挂单 → 转限价成交
    engine.prices.set('T1', 9.4);
    engine.placeRestingOrder('T1', 'oB', 'AC2', 'buy', 9.0, 100);
    const fills = await engine.checkPendingOrders();
    expect(fills.length).toBe(1);
    const saved = orderRepo.rows.find((o) => o.id === r.order.id);
    expect(saved.status).toBe('filled');
    expect(saved.filledQty).toBe(100);
  });
});

describe('Phase A 强平/追保资金安全（P0#4）', () => {
  function makeLiquidationEnv(ownPosQty, restingBidQty) {
    const orderRepo = fakeRepo([{ id: 'oB', accountId: 'AC2', symbol: 'T1', side: 'buy', quantity: restingBidQty, price: 10, filledQty: 0, status: 'pending' }]);
    const accountRepo = fakeRepo([
      { id: 'AC1', cash: 1000, marketMode: 'CN', leverage: 1, totalTrades: 0, shortCollateral: 0 },
      { id: 'AC2', cash: 100000, marketMode: 'CN', leverage: 1, totalTrades: 0, shortCollateral: 0 },
    ]);
    const posRepo = fakeRepo([{ id: 'P1', accountId: 'AC1', symbol: 'T1', longQty: ownPosQty, shortQty: 0, longCost: 10 * ownPosQty, shortCost: 0, boughtToday: 0 }]);
    const engine = new TradingEngineService(orderRepo, accountRepo, posRepo, fakeRepo(), null);
    engine.prices.set('T1', 10);
    engine.placeRestingOrder('T1', 'oB', 'AC2', 'buy', 10, restingBidQty);
    return { engine, orderRepo, accountRepo, posRepo };
  }

  test('跌停无流动性部分强平：按实际成交量扣减，剩余持仓保留（不凭空蒸发）', async () => {
    const { engine, accountRepo, posRepo } = makeLiquidationEnv(1000, 300);
    // 模拟跌停封板：合成盘口清空 + sealedDown（市价卖无兜底）
    engine.orderBooks.set('T1', { bids: [], asks: [], sealedDown: true });
    const account = { id: 'AC1' };
    await engine.forceLiquidate(account);
    const pos = posRepo.rows.find((p) => p.id === 'P1');
    expect(pos.longQty).toBe(700); // 关键断言：剩余持仓保留
    const acct = accountRepo.rows.find((a) => a.id === 'AC1');
    expect(Number(acct.cash)).toBeGreaterThan(1000); // 回收 300 股现金到账
  });

  test('强平不与本人挂单自成交', async () => {
    const { engine } = makeLiquidationEnv(500, 0);
    // 本人 AC1 的买入挂单在盘口（强平卖出不得吃自己的单）
    engine.placeRestingOrder('T1', 'oOwn', 'AC1', 'buy', 10, 500);
    const account = { id: 'AC1' };
    await engine.forceLiquidate(account);
    // 本人挂单仍应在盘口（未被自己的强平卖单吃掉）
    const ownInBook = (engine.realBooks.get('T1')?.bids || []).some((b) => b.orderId === 'oOwn');
    expect(ownInBook).toBe(true);
  });

  test('强平结算对手方挂单：对手账户扣款、订单置为已成交', async () => {
    const { engine, orderRepo, accountRepo } = makeLiquidationEnv(500, 200);
    const account = { id: 'AC1' };
    await engine.forceLiquidate(account);
    const oB = orderRepo.rows.find((o) => o.id === 'oB');
    expect(oB.status).toBe('filled');
    expect(oB.filledQty).toBe(200);
    const acct2 = accountRepo.rows.find((a) => a.id === 'AC2');
    expect(Number(acct2.cash)).toBeLessThan(100000); // 对手买入扣款
  });
});

describe('Phase A 分红快照发息（P0#3）', () => {
  function makeDivEnv(snaps, accounts = [{ id: 'AC1', cash: 1000, marketMode: 'CN', totalTrades: 0 }]) {
    const snapRepo = fakeRepo(snaps);
    const accountRepo = fakeRepo(accounts);
    const txRepo = fakeRepo();
    const engine = new TradingEngineService(fakeRepo(), accountRepo, fakeRepo(), txRepo, snapRepo);
    return { engine, snapRepo, accountRepo, txRepo };
  }

  test('多头按登记日快照发息，快照置 paid（lockDay=0 → 持有0日 → CN 红利税 20%）', async () => {
    const { engine, accountRepo, snapRepo, txRepo } = makeDivEnv([
      { id: 'S1', accountId: 'AC1', symbol: 'T1', exDay: 6, longQty: 100, shortQty: 0, lockDay: 0, paid: false },
    ]);
    await engine.payDividends([{ symbol: 'T1', perShare: 2 }], 6, 'CN');
    const acct = accountRepo.rows.find((a) => a.id === 'AC1');
    expect(Number(acct.cash)).toBeCloseTo(1160, 2); // 税前200 → 20%税 → 到账160
    expect(snapRepo.rows.find((s) => s.id === 'S1').paid).toBe(true);
    expect(txRepo.rows.some((t) => t.side === 'DIVIDEND' && t.turnover === 160 && t.totalFees === 40)).toBe(true);
  });

  test('持有 >7 交易日免红利税（CN 二档制）', async () => {
    const { engine, accountRepo } = makeDivEnv([
      { id: 'S5', accountId: 'AC1', symbol: 'T1', exDay: 40, longQty: 100, shortQty: 0, lockDay: 30, paid: false },
    ]);
    await engine.payDividends([{ symbol: 'T1', perShare: 2 }], 40, 'CN');
    const acct = accountRepo.rows.find((a) => a.id === 'AC1');
    expect(Number(acct.cash)).toBeCloseTo(1200, 2); // 登记日 39 - 建仓日 30 = 9 日 >7 → 免税
  });

  test('HK 统一红利税 20%、US 统一 30%（长持有也收）', async () => {
    const env1 = makeDivEnv([{ id: 'S6', accountId: 'AC1', symbol: 'T1', exDay: 40, longQty: 100, shortQty: 0, lockDay: 30, paid: false }]);
    await env1.engine.payDividends([{ symbol: 'T1', perShare: 2 }], 40, 'HK');
    expect(Number(env1.accountRepo.rows.find((a) => a.id === 'AC1').cash)).toBeCloseTo(1160, 2);
    const env2 = makeDivEnv([{ id: 'S7', accountId: 'AC1', symbol: 'T1', exDay: 40, longQty: 100, shortQty: 0, lockDay: 30, paid: false }]);
    await env2.engine.payDividends([{ symbol: 'T1', perShare: 2 }], 40, 'US');
    expect(Number(env2.accountRepo.rows.find((a) => a.id === 'AC1').cash)).toBeCloseTo(1140, 2);
  });

  test('净空头除权日扣息（负 DIVIDEND 流水）', async () => {
    const { engine, accountRepo, txRepo } = makeDivEnv([
      { id: 'S2', accountId: 'AC1', symbol: 'T1', exDay: 6, longQty: 0, shortQty: 50, paid: false },
    ]);
    await engine.payDividends([{ symbol: 'T1', perShare: 2 }], 6);
    const acct = accountRepo.rows.find((a) => a.id === 'AC1');
    expect(Number(acct.cash)).toBeCloseTo(900, 2);
    expect(txRepo.rows.some((t) => t.side === 'DIVIDEND' && t.turnover === -100)).toBe(true);
  });

  test('发息幂等：paid 快照不重复发', async () => {
    const { engine, accountRepo } = makeDivEnv([
      { id: 'S3', accountId: 'AC1', symbol: 'T1', exDay: 6, longQty: 100, shortQty: 0, paid: true },
    ]);
    await engine.payDividends([{ symbol: 'T1', perShare: 2 }], 6);
    const acct = accountRepo.rows.find((a) => a.id === 'AC1');
    expect(Number(acct.cash)).toBe(1000);
  });

  test('登记日快照只拍本市场账户，重复拍摄幂等更新', async () => {
    const snapRepo = fakeRepo();
    const posRepo = fakeRepo([
      { id: 'P1', accountId: 'AC1', symbol: 'T1', longQty: 100, shortQty: 0, account: { id: 'AC1', marketMode: 'CN' } },
      { id: 'P2', accountId: 'AC2', symbol: 'T1', longQty: 200, shortQty: 0, account: { id: 'AC2', marketMode: 'US' } },
      { id: 'P3', accountId: 'AC3', symbol: 'T1', longQty: 0, shortQty: 0, account: { id: 'AC3', marketMode: 'CN' } },
    ]);
    const engine = new TradingEngineService(fakeRepo(), fakeRepo(), posRepo, fakeRepo(), snapRepo);
    const created = await engine.snapshotDividendHolders([{ symbol: 'T1' }], 7, 'CN');
    expect(created).toBe(1); // 只拍 CN 的 AC1；AC3 无持仓不拍
    expect(snapRepo.rows.length).toBe(1);
    expect(snapRepo.rows[0]).toMatchObject({ accountId: 'AC1', exDay: 7, longQty: 100 });
    const created2 = await engine.snapshotDividendHolders([{ symbol: 'T1' }], 7, 'CN');
    expect(created2).toBe(0); // 已存在 → 更新而非新建
    expect(snapRepo.rows.length).toBe(1);
  });
});

describe('Phase A 账户重置防刷钱（P0#1）', () => {
  function makeAccountService(over = {}) {
    const accountRepo = fakeRepo([{
      id: 'AC1', userId: 'U1', marketMode: 'CN', cash: 100000, leverage: 1, totalEquity: 100000,
      peakEquity: 100000, initialEquity: 100000, dayStartEquity: 100000, dailyPnl: 0, totalPnl: 0,
      marginUsed: 0, shortCollateral: 0, currentDay: 5, lastResetDay: 0, resetCount: 0, totalTrades: 0,
    }]);
    const fundHoldingRepo = fakeRepo(over.fundHoldings || []);
    const orderRepo = fakeRepo(over.orders || []);
    const resetAuditRepo = fakeRepo();
    const engine = { runExclusive: (fn) => fn() };
    const config = { get: (k, d) => (k === 'RESET_ENABLED' ? (over.resetEnabled === undefined ? 'true' : over.resetEnabled) : d) };
    const svc = new AccountService(accountRepo, fakeRepo(), fakeRepo(), fundHoldingRepo, orderRepo, resetAuditRepo, null, engine, config);
    return { svc, accountRepo, resetAuditRepo };
  }

  test('持基金持仓时重置被拒（封堵申购→重置→赎回刷钱）', async () => {
    const { svc, accountRepo } = makeAccountService({ fundHoldings: [{ userId: 'U1', marketMode: 'CN', fundId: 'fund-1', shares: 1000 }] });
    const r = await svc.resetAccount('U1', 'CN', '散户');
    expect(r.success).toBe(false);
    expect(r.error).toContain('基金持仓');
    expect(Number(accountRepo.rows.find((a) => a.id === 'AC1').cash)).toBe(100000); // 账户不变
  });

  test('有未成交挂单时重置被拒', async () => {
    const { svc } = makeAccountService({ orders: [{ id: 'O1', accountId: 'AC1', status: 'pending' }] });
    const r = await svc.resetAccount('U1', 'CN', '散户');
    expect(r.success).toBe(false);
    expect(r.error).toContain('挂单');
  });

  test('同一游戏日内二次重置被拒（冷却）', async () => {
    const { svc, accountRepo } = makeAccountService();
    const r1 = await svc.resetAccount('U1', 'CN', '散户');
    expect(r1.success).toBe(true);
    const r2 = await svc.resetAccount('U1', 'CN', '机构');
    expect(r2.success).toBe(false);
    expect(r2.error).toContain('频繁');
    // 推进到下一游戏日后允许
    accountRepo.rows.find((a) => a.id === 'AC1').currentDay = 6;
    const r3 = await svc.resetAccount('U1', 'CN', '机构');
    expect(r3.success).toBe(true);
  });

  test('RESET_ENABLED=false（大赛中）重置被拒', async () => {
    const { svc } = makeAccountService({ resetEnabled: 'false' });
    const r = await svc.resetAccount('U1', 'CN', '散户');
    expect(r.success).toBe(false);
    expect(r.error).toContain('大赛');
  });

  test('干净账户重置成功：字段复位 + 审计落库 + resetCount 递增', async () => {
    const { svc, accountRepo, resetAuditRepo } = makeAccountService();
    const r = await svc.resetAccount('U1', 'CN', '机构');
    expect(r.success).toBe(true);
    const a = accountRepo.rows.find((x) => x.id === 'AC1');
    expect(Number(a.cash)).toBe(500000);
    expect(Number(a.leverage)).toBe(2);
    expect(Number(a.shortCollateral)).toBe(0);
    expect(Number(a.resetCount)).toBe(1);
    expect(Number(a.lastResetDay)).toBe(5);
    expect(resetAuditRepo.rows.length).toBe(1);
    expect(resetAuditRepo.rows[0]).toMatchObject({ userId: 'U1', preset: '机构', prevCash: 100000 });
  });
});
