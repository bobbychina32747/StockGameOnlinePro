// Phase 13 P0/P1 资金安全回归：
// P0-1 卖出偿还融资必须扣现金（settleFillInner / forceLiquidateInner / forceLiquidateToTargetInner 三处）
// P0-2 settleCounterFills 结算失败必须回滚盘口 + 返回结构化结果
// P1-6 回滚不得把 AI 虚拟挂单固化成无主真实挂单
// P2   IOC 部分成交落 PARTIAL
// P1-7 集合竞价两阶段结算的队列内预校验与失败语义
// P1-8 强平/追保必须写交易流水
// P0-4 分红金额 NaN 不得污染现金
const { TradingEngineService } = require('../dist/src/core/trading-engine/trading-engine.service');

// 简易内存仓库（与 phase7/phase10/phase12 同款口径）
function matchesWhere(r, where) {
  if (Array.isArray(where)) return where.some((w) => matchesWhere(r, w));
  return Object.entries(where || {}).every(([k, v]) => {
    if (v && typeof v === 'object' && v._type === 'in') return (v.value || []).map(String).includes(String(r[k]));
    return String(r[k]) === String(v);
  });
}
// countingRepo：带调用计数的内存仓库（save 计数用于断言“未写库”）
function countingRepo(seed = [], opts = {}) {
  const rows = [...seed];
  let idc = 1;
  const calls = { find: 0, findOne: 0, save: 0, saves: [] };
  return {
    rows, calls,
    find: async (q) => { calls.find++; return rows.filter((r) => matchesWhere(r, q?.where)); },
    findOne: async (q) => { calls.findOne++; return rows.find((r) => matchesWhere(r, q?.where)) || null; },
    save: async (e) => {
      calls.save++;
      calls.saves.push(e);
      if (opts.failSaveIds && opts.failSaveIds.includes(e.id)) throw new Error('模拟 DB 写入失败');
      if (!e.id) e.id = 'auto-' + idc++;
      const i = rows.findIndex((r) => r.id === e.id);
      if (i >= 0) rows[i] = e; else rows.push(e);
      return e;
    },
    create: (obj) => obj,
  };
}
function makeAccount(id, over = {}) {
  return {
    id, userId: 'U' + id, marketMode: 'CN', cash: 100000, leverage: 1, borrowed: 0,
    shortCollateral: 0, marginUsed: 0, totalTrades: 0, currentDay: 0, ...over,
  };
}
function makePosition(accountId, symbol, longQty, over = {}) {
  return {
    id: 'P' + accountId + symbol, accountId, symbol,
    longQty, longCost: longQty * 10, shortQty: 0, shortCost: 0, boughtToday: 0, lockDay: 0, ...over,
  };
}
function makeEnv({ accounts = [], positions = [], orders = [], opts = {} } = {}) {
  const orderRepo = countingRepo(orders, opts);
  const accountRepo = countingRepo(accounts);
  const posRepo = countingRepo(positions);
  const txRepo = countingRepo();
  const snapRepo = countingRepo();
  const engine = new TradingEngineService(orderRepo, accountRepo, posRepo, txRepo, snapRepo);
  engine.prices.set('T1', 10);
  return { engine, orderRepo, accountRepo, posRepo, txRepo, snapRepo };
}
// 捕获 logger.error/warn（避免依赖 jest.spyOn 对 Nest Logger 原型方法的可写性）
function captureLogs(engine) {
  const errors = [];
  const warns = [];
  engine.logger.error = (msg) => { errors.push(String(msg)); };
  engine.logger.warn = (msg) => { warns.push(String(msg)); };
  return { errors, warns };
}
// 记录 placeRestingOrder 调用（虚拟单固化的判定依据）
function spyResting(orderEngine) {
  const resting = [];
  const orig = orderEngine.placeRestingOrder.bind(orderEngine);
  orderEngine.placeRestingOrder = (symbol, orderId, accountId, side, price, qty, opts) => {
    resting.push({ symbol, orderId, accountId, side, price, qty });
    return orig(symbol, orderId, accountId, side, price, qty, opts);
  };
  return resting;
}
// CN 卖出 1000 元成交的费用锚点：佣金 max(1000×0.00025, 5)=5 + 印花税 1000×0.001=1 + 过户费 1000×0.00002=0.02
const CN_SELL_FEES_1000 = 6.02;

describe('Phase 13 P0-1 卖出偿还融资必须扣现金（权益守恒）', () => {
  test('P0-1a 杠杆 2 买入→卖出：卖券所得先还 500 融资，权益只损失手续费（不再凭空 +500）', async () => {
    const { engine, accountRepo, posRepo } = makeEnv({
      accounts: [makeAccount('AC1', { cash: 600, leverage: 2 })],
      positions: [makePosition('AC1', 'T1', 0, { longCost: 0 })],
    });
    const buy = await engine.settleFill('AC1', 'T1', 'buy', { symbol: 'T1', filledQuantity: 100, avgPrice: 10, totalCost: 1000 }, 'CN');
    expect(buy.success).toBe(true);
    const afterBuy = accountRepo.rows[0];
    // ownCash = 1000/2 = 500 进现金扣减，差额 500 记入融资负债
    expect(Number(afterBuy.borrowed)).toBeCloseTo(500, 6);
    expect(Number(afterBuy.cash)).toBeCloseTo(600 - 500 - buy.fees.totalFees, 2);
    // 权益 = cash + 持仓市值 − borrowed：买入只损失手续费
    expect(Number(afterBuy.cash) + 100 * 10 - Number(afterBuy.borrowed)).toBeCloseTo(600 - buy.fees.totalFees, 2);

    posRepo.rows[0].boughtToday = 0; // 模拟次日 T+1 解锁后卖出
    const sell = await engine.settleFill('AC1', 'T1', 'sell', { symbol: 'T1', filledQuantity: 100, avgPrice: 10, totalCost: 1000 }, 'CN');
    expect(sell.success).toBe(true);
    const afterSell = accountRepo.rows[0];
    expect(Number(afterSell.borrowed)).toBeCloseTo(0, 6);
    // 数值自检（任务书口径的钱）：修复前 cash = 600−500−买费+1000−卖费 = 1100−费用（凭空 +500）
    // 修复后 cash = 600 − 买费 − 卖费（卖券所得先扣 500 偿还额，只有净额进现金）
    const expected = 600 - buy.fees.totalFees - sell.fees.totalFees;
    expect(Number(afterSell.cash)).toBeCloseTo(expected, 2);
    expect(Number(afterSell.cash) + 0 - Number(afterSell.borrowed)).toBeCloseTo(expected, 2);
    expect(Number(afterSell.cash)).toBeLessThan(600); // 关键回归：绝不能回到 1000 以上
    expect(afterSell.cash).toBeCloseTo(588.96, 2); // 600 − 5.02(买) − 6.02(卖)
  });

  test('P0-1a 杠杆 1（repay 恒为 0）：买卖一轮现金口径与修复前完全一致（不回归）', async () => {
    const { engine, accountRepo, posRepo } = makeEnv({
      accounts: [makeAccount('AC1', { cash: 10000, leverage: 1 })],
      positions: [makePosition('AC1', 'T1', 0, { longCost: 0 })],
    });
    const buy = await engine.settleFill('AC1', 'T1', 'buy', { symbol: 'T1', filledQuantity: 100, avgPrice: 10, totalCost: 1000 }, 'CN');
    expect(Number(accountRepo.rows[0].borrowed)).toBeCloseTo(0, 6); // 无杠杆无融资
    posRepo.rows[0].boughtToday = 0;
    const sell = await engine.settleFill('AC1', 'T1', 'sell', { symbol: 'T1', filledQuantity: 100, avgPrice: 10, totalCost: 1000 }, 'CN');
    expect(Number(accountRepo.rows[0].cash)).toBeCloseTo(10000 - buy.fees.totalFees - sell.fees.totalFees, 2);
    expect(Number(accountRepo.rows[0].cash)).toBeCloseTo(10000 - 5.02 - 6.02, 2);
  });

  test('P0-1b forceLiquidateInner 平多：回收额先扣偿还额（recovered=500 而非 1000），权益守恒 + 落流水', async () => {
    const { engine, accountRepo, txRepo } = makeEnv({
      accounts: [makeAccount('AC1', { cash: 1000, leverage: 2, borrowed: 500 }), makeAccount('AC2')],
      positions: [makePosition('AC1', 'T1', 100, { longCost: 1000 }), makePosition('AC2', 'T1', 0, { longCost: 0 })],
      orders: [{ id: 'oB', accountId: 'AC2', symbol: 'T1', side: 'buy', quantity: 100, price: 10, filledQty: 0, status: 'pending' }],
    });
    engine.placeRestingOrder('T1', 'oB', 'AC2', 'buy', 10, 100);
    const recovered = await engine.forceLiquidate({ id: 'AC1' });
    const acct = accountRepo.rows.find((a) => a.id === 'AC1');
    expect(recovered).toBeCloseTo(500, 6); // 1000 成交额 − 500 偿还额（修复前为 1000）
    expect(Number(acct.borrowed)).toBeCloseTo(0, 6);
    // 权益前 = 1000 + 100×10 − 500 = 1500；权益后 = cash，只差卖出费用
    expect(Number(acct.cash)).toBeCloseTo(1500 - CN_SELL_FEES_1000, 2);
    expect(Number(acct.cash)).toBeCloseTo(1493.98, 2);
    expect(Number(acct.cash) + 0 - Number(acct.borrowed)).toBeLessThan(1500);
    // P1-8：强平成交必须有流水（口径与 settleFillInner 一致）
    const tx = txRepo.rows.find((t) => t.side === 'sell' && t.symbol === 'T1');
    expect(tx).toMatchObject({ accountId: 'AC1', quantity: 100, price: 10, turnover: 1000 });
    expect(tx.stampDuty).toBeCloseTo(1, 6);
    expect(tx.totalFees).toBeCloseTo(CN_SELL_FEES_1000, 6);
  });

  test('P0-1c forceLiquidateToTargetInner 追保卖出一半：netCash 扣偿还额，权益只损失手续费 + 落流水', async () => {
    const { engine, accountRepo, posRepo, txRepo } = makeEnv({
      accounts: [makeAccount('AC1', { cash: 100, leverage: 2, borrowed: 20000 }), makeAccount('AC2', { cash: 1000000 })],
      positions: [makePosition('AC1', 'T1', 2000, { longCost: 20000 }), makePosition('AC2', 'T1', 0, { longCost: 0 })],
      orders: [{ id: 'oB2', accountId: 'AC2', symbol: 'T1', side: 'buy', quantity: 1000, price: 10, filledQty: 0, status: 'pending' }],
    });
    engine.placeRestingOrder('T1', 'oB2', 'AC2', 'buy', 10, 1000);
    // 初始保证金率 = (100 + 2000×10 − 20000) / 20000 ≈ 1.005 < 5 → 触发部分平仓
    const netCash = await engine.forceLiquidateToTarget({ id: 'AC1' }, 5);
    const acct = accountRepo.rows.find((a) => a.id === 'AC1');
    const pos = posRepo.rows.find((p) => p.accountId === 'AC1');
    expect(pos.longQty).toBe(1000); // 只平一半
    // 卖出 1000×10 = 10000，偿还 5000，费用 15.2（佣金 5 + 印花税 10 + 过户费 0.2）
    expect(netCash).toBeCloseTo(10000 - 15.2 - 5000, 2);
    expect(Number(acct.borrowed)).toBeCloseTo(15000, 6);
    expect(Number(acct.cash)).toBeCloseTo(100 + 4984.8, 2);
    // 权益前 = 100 + 2000×10 − 20000 = 100；权益后 = cash + 1000×10 − 15000 = 84.8（只损失 15.2 费用）
    expect(Number(acct.cash) + 1000 * 10 - Number(acct.borrowed)).toBeCloseTo(84.8, 2);
    expect(Number(acct.cash)).toBeLessThan(6000); // 修复前 cash = 10084.8（凭空 +5000）
    const tx = txRepo.rows.find((t) => t.side === 'sell');
    expect(tx).toMatchObject({ accountId: 'AC1', quantity: 1000, price: 10, turnover: 10000 });
    expect(tx.totalFees).toBeCloseTo(15.2, 6);
  });

  test('P1-8 强平平空（COVER）同样落流水，费用按该笔 calcFees', async () => {
    const { engine, accountRepo, txRepo } = makeEnv({
      accounts: [makeAccount('AC1', { cash: 1000, shortCollateral: 500 }), makeAccount('AC2')],
      positions: [makePosition('AC1', 'T1', 0, { longCost: 0, shortQty: 100, shortCost: 1000 }), makePosition('AC2', 'T1', 100, { longCost: 1000 })],
      orders: [{ id: 'oAsk', accountId: 'AC2', symbol: 'T1', side: 'sell', quantity: 100, price: 10, filledQty: 0, status: 'pending' }],
    });
    engine.placeRestingOrder('T1', 'oAsk', 'AC2', 'sell', 10, 100);
    await engine.forceLiquidate({ id: 'AC1' });
    const tx = txRepo.rows.find((t) => t.side === 'cover');
    expect(tx).toMatchObject({ accountId: 'AC1', symbol: 'T1', quantity: 100, price: 10, turnover: 1000 });
    expect(tx.totalFees).toBeCloseTo(CN_SELL_FEES_1000, 6);
    const acct = accountRepo.rows.find((a) => a.id === 'AC1');
    // 权益前 = 1000 + 500 − 100×10 = 500；买回花 1000、释放保证金 500、费用 6.02 → 权益后 493.98
    expect(Number(acct.cash)).toBeCloseTo(493.98, 2);
    expect(Number(acct.shortCollateral)).toBeCloseTo(0, 6);
  });
});

describe('Phase 13 P0-2 对手方结算失败必须回滚（不再静默记账）', () => {
  test('P0-2 settleCounterFills 失败：返回 ok:false/settled:0/failed，订单回盘口且不累加 filledQty、不置 FILLED', async () => {
    const { engine, orderRepo, accountRepo } = makeEnv({
      accounts: [makeAccount('AC2', { cash: 0 })], // 对手买方无钱 → 结算必然失败
      orders: [{ id: 'oB', accountId: 'AC2', symbol: 'T1', side: 'buy', quantity: 100, price: 10, filledQty: 0, status: 'pending' }],
    });
    const r = await engine.settleCounterFills('T1', 'CN', [{ orderId: 'oB', accountId: 'AC2', side: 'buy', price: 10, qty: 100, virtual: false }]);
    expect(r.ok).toBe(false);
    expect(r.settled).toBe(0);
    expect(r.failed).toEqual([{ orderId: 'oB', error: expect.stringContaining('资金不足') }]);
    const oB = orderRepo.rows.find((o) => o.id === 'oB');
    expect(oB.status).toBe('pending'); // 关键断言：不得置 FILLED
    expect(Number(oB.filledQty)).toBe(0); // 关键断言：不得累加 filledQty
    expect((engine.realBooks.get('T1').bids || []).some((b) => b.orderId === 'oB')).toBe(true); // 回盘口
    expect(Number(accountRepo.rows.find((a) => a.id === 'AC2').cash)).toBe(0); // 未扣款
  });

  test('P0-2 settleCounterFills 成功：ok:true / settled:1，订单置 FILLED（原语义保留）', async () => {
    const { engine, orderRepo } = makeEnv({
      accounts: [makeAccount('AC2', { cash: 100000 })],
      orders: [{ id: 'oB', accountId: 'AC2', symbol: 'T1', side: 'buy', quantity: 100, price: 10, filledQty: 0, status: 'pending' }],
    });
    const r = await engine.settleCounterFills('T1', 'CN', [{ orderId: 'oB', accountId: 'AC2', side: 'buy', price: 10, qty: 100, virtual: false }]);
    expect(r).toEqual({ ok: true, settled: 1, failed: [] });
    expect(orderRepo.rows[0].status).toBe('filled');
    expect(Number(orderRepo.rows[0].filledQty)).toBe(100);
  });

  test('P0-2 submitOrder 市价路径：对手单结算失败时本方成交照常、对手挂单回到盘口并保持 PENDING', async () => {
    const { engine, orderRepo, accountRepo } = makeEnv({
      accounts: [makeAccount('AC1', { cash: 1000 }), makeAccount('AC2', { cash: 0 })],
      positions: [makePosition('AC1', 'T1', 100, { longCost: 1000 })],
      orders: [{ id: 'oB', accountId: 'AC2', symbol: 'T1', side: 'buy', quantity: 100, price: 10, filledQty: 0, status: 'pending' }],
    });
    engine.placeRestingOrder('T1', 'oB', 'AC2', 'buy', 10, 100);
    const r = await engine.submitOrder(
      { userId: 'U1', accountId: 'AC1', symbol: 'T1', type: 'market', side: 'sell', quantity: 100 },
      makeAccount('AC1', { cash: 1000 })
    );
    expect(r.success).toBe(true); // 调用方语义不变（await 语义与返回值均向后兼容）
    const oB = orderRepo.rows.find((o) => o.id === 'oB');
    expect(oB.status).toBe('pending');
    expect(Number(oB.filledQty)).toBe(0);
    expect((engine.realBooks.get('T1').bids || []).some((b) => b.orderId === 'oB')).toBe(true);
    expect(Number(accountRepo.rows.find((a) => a.id === 'AC2').cash)).toBe(0);
  });
});

describe('Phase 13 P1-6 回滚不得固化 AI 虚拟挂单', () => {
  function virtualEnv(orderType, limitPrice) {
    const env = makeEnv({
      accounts: [makeAccount('AC1', { cash: 0 })], // 结算必然失败，触发回滚分支
      positions: [makePosition('AC1', 'T1', 0, { longCost: 0 })],
    });
    env.engine.placeVirtualOrder('T1', 'sell', 10, 100, 999); // AI/做市商虚拟卖单：orderId=null、accountId=null
    const resting = spyResting(env.engine);
    const orderData = { userId: 'U1', accountId: 'AC1', symbol: 'T1', type: orderType, side: 'buy', quantity: 100 };
    if (limitPrice) orderData.price = limitPrice;
    // validateOrder 用入参账户快照（有钱）→ 通过；settleFillInner 重读仓库（没钱）→ 失败 → 走回滚
    const stale = makeAccount('AC1', { cash: 100000 });
    return { env, resting, orderData, stale };
  }

  test('P1-6 市价单回滚：虚拟单不进真实盘口（placeRestingOrder 未被调用、盘口无无主残留）', async () => {
    const { env, resting, orderData, stale } = virtualEnv('market');
    const r = await env.engine.submitOrder(orderData, stale);
    expect(r.success).toBe(false);
    expect(resting).toEqual([]); // 关键断言：不得把虚拟单固化成无主真实挂单
    const asks = env.engine.realBooks.get('T1')?.asks || [];
    expect(asks.filter((a) => !a.orderId).length).toBe(0);
    expect(asks.length).toBe(0); // 虚拟单已被吃掉，不得被写回
  });

  test('P1-6 IOC 回滚：同上（虚拟单不入盘口）', async () => {
    const { env, resting, orderData, stale } = virtualEnv('ioc', 10);
    const r = await env.engine.submitOrder(orderData, stale);
    expect(r.success).toBe(false);
    expect(resting).toEqual([]);
    expect((env.engine.realBooks.get('T1')?.asks || []).length).toBe(0);
  });
});

describe('Phase 13 P2 IOC 部分成交状态', () => {
  test('P2 IOC 部分成交落 PARTIAL（原实现谎报 FILLED）', async () => {
    const { engine, orderRepo } = makeEnv({
      accounts: [makeAccount('AC1', { cash: 100000 }), makeAccount('AC2', { cash: 100000 })],
      positions: [makePosition('AC2', 'T1', 100, { longCost: 1000 })],
    });
    engine.placeRestingOrder('T1', 'oAsk', 'AC2', 'sell', 9, 40); // 盘口仅 40 股可成交
    const r = await engine.submitOrder(
      { userId: 'U1', accountId: 'AC1', symbol: 'T1', type: 'ioc', side: 'buy', quantity: 100, price: 9 },
      makeAccount('AC1', { cash: 100000 })
    );
    expect(r.success).toBe(true);
    expect(r.fill.filledQuantity).toBe(40);
    // submitOrder 的返回体不含订单实体（保持既有 API 形状），落库状态从 repo 断言
    const iocOrder = orderRepo.rows.find((o) => o.type === 'ioc');
    expect(iocOrder.status).toBe('partial'); // 关键断言：不得为 filled
    expect(Number(iocOrder.filledQty)).toBe(40);
  });

  test('P2 IOC 全部成交仍为 FILLED；FOK 部分成交仍撤销（语义未变）', async () => {
    const full = makeEnv({
      accounts: [makeAccount('AC1', { cash: 100000 }), makeAccount('AC2', { cash: 100000 })],
      positions: [makePosition('AC2', 'T1', 200, { longCost: 2000 })],
    });
    full.engine.placeRestingOrder('T1', 'oAsk', 'AC2', 'sell', 9, 100);
    const r1 = await full.engine.submitOrder(
      { userId: 'U1', accountId: 'AC1', symbol: 'T1', type: 'ioc', side: 'buy', quantity: 100, price: 9 },
      makeAccount('AC1', { cash: 100000 })
    );
    expect(r1.success).toBe(true);
    expect(r1.fill.filledQuantity).toBe(100);
    expect(full.orderRepo.rows.find((o) => o.type === 'ioc').status).toBe('filled');

    const fok = makeEnv({
      accounts: [makeAccount('AC1', { cash: 100000 }), makeAccount('AC2', { cash: 100000 })],
      positions: [makePosition('AC2', 'T1', 100, { longCost: 1000 })],
    });
    fok.engine.placeRestingOrder('T1', 'oAsk', 'AC2', 'sell', 9, 40);
    const r2 = await fok.engine.submitOrder(
      { userId: 'U1', accountId: 'AC1', symbol: 'T1', type: 'fok', side: 'buy', quantity: 100, price: 9 },
      makeAccount('AC1', { cash: 100000 })
    );
    expect(r2.success).toBe(false);
    expect(r2.error).toContain('FOK');
    // 撤单回滚：对手挂单回盘口
    expect((fok.engine.realBooks.get('T1').asks || []).some((a) => a.orderId === 'oAsk')).toBe(true);
  });
});

describe('Phase 13 P1-7 集合竞价两阶段结算的失败语义', () => {
  const auctionFills = [
    { orderId: 'oBid', accountId: 'AC2', side: 'buy', price: 10, qty: 100, virtual: false },
    { orderId: 'oAsk', accountId: 'AC1', side: 'sell', price: 10, qty: 100, virtual: false },
  ];

  test('P1-7 预校验失败：返回 success:false 且双方挂单全部回滚盘口、资金未动', async () => {
    const { engine, accountRepo, posRepo } = makeEnv({
      accounts: [makeAccount('AC1', { cash: 1000 }), makeAccount('AC2', { cash: 0 })], // 买方无钱
      positions: [makePosition('AC1', 'T1', 100, { longCost: 1000 })],
    });
    const r = await engine.settleAuctionFills('T1', auctionFills);
    expect(r.success).toBe(false);
    expect(r.settled).toBe(0);
    expect(typeof r.error).toBe('string');
    const book = engine.realBooks.get('T1');
    expect((book.bids || []).some((b) => b.orderId === 'oBid')).toBe(true);
    expect((book.asks || []).some((a) => a.orderId === 'oAsk')).toBe(true);
    expect(Number(accountRepo.rows.find((a) => a.id === 'AC1').cash)).toBe(1000);
    expect(Number(posRepo.rows.find((p) => p.accountId === 'AC1').longQty)).toBe(100);
  });

  test('P1-7 队列内结算中途异常：返回 success:false 且保留已结算计数 settled=1 + logger.error', async () => {
    const { engine, accountRepo, orderRepo } = makeEnv({
      accounts: [makeAccount('AC1', { cash: 1000 }), makeAccount('AC2', { cash: 100000 })],
      positions: [makePosition('AC1', 'T1', 100, { longCost: 1000 })],
      orders: [
        { id: 'oBid', accountId: 'AC2', symbol: 'T1', side: 'buy', quantity: 100, price: 10, filledQty: 0, status: 'pending' },
        { id: 'oAsk', accountId: 'AC1', symbol: 'T1', side: 'sell', quantity: 100, price: 10, filledQty: 0, status: 'pending' },
      ],
      opts: { failSaveIds: ['oAsk'] }, // 第二条订单实体回写时模拟 DB 异常
    });
    const logs = captureLogs(engine);
    const r = await engine.settleAuctionFills('T1', auctionFills);
    expect(r.success).toBe(false); // 关键断言：异常不再被吞成 success:true
    expect(r.settled).toBe(1); // 第一条已结算，计数保留供对账
    expect(r.error).toContain('模拟 DB 写入失败');
    expect(logs.errors.join('|')).toContain('集合竞价结算中断');
    // 第一条（买方 AC2）资金确实已变：这是 settled=1 的对账依据
    expect(Number(accountRepo.rows.find((a) => a.id === 'AC2').cash)).toBeLessThan(100000);
    // R5-② 语义更新（原断言为"中断条目回到盘口"）：失败条目不再回盘口——settleFillInner 是"校验→逐条 save"顺序写，
    // 失败可能发生在已写账户之后，放回盘口等于允许它被再次撮合结算（重复扣款/重复持仓变动）。
    // 现改为：只回滚失败条目之后的未结算条目；失败条目保持 PENDING + rejectReason 标记供人工核对。
    // 本用例的失败点正是订单实体写入（failSaveIds 含 oAsk），故打标保存同样失败——此处只校验"未回盘"与"留下人工对账凭据"；
    // 打标成功路径（PENDING + rejectReason）由 phase14-order-hardening.test.js 覆盖。
    // 注：失败条目不再回盘且其后无未结算条目 → 该标的盘口可能根本没被创建，故用可选链判空（判空即"未回盘"成立）
    expect((engine.realBooks.get('T1')?.asks || []).some((a) => a.orderId === 'oAsk')).toBe(false);
    expect(logs.errors.join('|')).toContain('请人工对账');
    expect(orderRepo.calls.save).toBeGreaterThanOrEqual(1);
  });

  test('P1-7 空成交列表：success:true / settled:0（不回归）', async () => {
    const { engine } = makeEnv({});
    expect(await engine.settleAuctionFills('T1', [])).toEqual({ success: true, settled: 0 });
  });
});

describe('Phase 13 P0-4 分红金额 NaN 不得污染现金', () => {
  test('P0-4 perShare=NaN：整条事件跳过（不扣现金、不记账、账户不写库）', async () => {
    const { engine, accountRepo, txRepo, snapRepo } = makeEnv({
      accounts: [makeAccount('AC1', { cash: 1000 })],
    });
    snapRepo.rows.push({ id: 'S1', accountId: 'AC1', symbol: 'T1', exDay: 6, longQty: 100, shortQty: 0, lockDay: 0, paid: false });
    const logs = captureLogs(engine);
    const paid = await engine.payDividends([{ symbol: 'T1', perShare: NaN }], 6, 'CN');
    expect(paid).toBe(0);
    expect(Number(accountRepo.rows[0].cash)).toBe(1000); // 现金未被写坏
    expect(Number.isFinite(Number(accountRepo.rows[0].cash))).toBe(true);
    expect(accountRepo.calls.save).toBe(0); // 未写库
    expect(txRepo.rows.length).toBe(0); // 未记账
    expect(snapRepo.rows[0].paid).toBe(false); // 保持未发，数据修复后可重跑补发
    expect(logs.errors.join('|')).toContain('分红事件金额非法');
  });

  test('P0-4 净空头扣息金额非有限：整条事件跳过（现金不动、无负数流水）', async () => {
    const { engine, accountRepo, txRepo, snapRepo } = makeEnv({
      accounts: [makeAccount('AC1', { cash: 1000 })],
    });
    snapRepo.rows.push({ id: 'S2', accountId: 'AC1', symbol: 'T1', exDay: 6, longQty: 0, shortQty: 50, lockDay: 0, paid: false });
    const logs = captureLogs(engine);
    const paid = await engine.payDividends([{ symbol: 'T1', perShare: 'abc' }], 6, 'CN');
    expect(paid).toBe(0);
    expect(Number(accountRepo.rows[0].cash)).toBe(1000);
    expect(txRepo.rows.length).toBe(0);
    expect(accountRepo.calls.save).toBe(0);
    expect(logs.errors.join('|')).toContain('分红事件金额非法');
  });

  test('P0-4 一条脏数据不影响其它分红事件：坏 symbol 跳过、好 symbol 照常到账', async () => {
    const { engine, accountRepo, snapRepo, txRepo } = makeEnv({
      accounts: [makeAccount('AC1', { cash: 1000 }), makeAccount('AC2', { cash: 1000 })],
    });
    snapRepo.rows.push(
      { id: 'S1', accountId: 'AC1', symbol: 'T1', exDay: 6, longQty: 100, shortQty: 0, lockDay: 0, paid: false },
      { id: 'S3', accountId: 'AC2', symbol: 'T2', exDay: 6, longQty: 100, shortQty: 0, lockDay: 0, paid: false },
    );
    const logs = captureLogs(engine);
    const paid = await engine.payDividends([{ symbol: 'T1', perShare: NaN }, { symbol: 'T2', perShare: 2 }], 6, 'CN');
    expect(paid).toBeCloseTo(160, 2); // 200 税前 × (1−20% 红利税)
    expect(Number(accountRepo.rows.find((a) => a.id === 'AC1').cash)).toBe(1000); // 坏事件跳过
    expect(Number(accountRepo.rows.find((a) => a.id === 'AC2').cash)).toBeCloseTo(1160, 2); // 好事件照常
    expect(snapRepo.rows.find((s) => s.id === 'S1').paid).toBe(false);
    expect(snapRepo.rows.find((s) => s.id === 'S3').paid).toBe(true);
    expect(txRepo.rows.filter((t) => t.accountId === 'AC2').length).toBe(1);
    expect(logs.errors.length).toBeGreaterThan(0);
  });

  test('P0-4 写库防线：账户现金已是非有限数时跳过保存（保持原值，不写脏数据、返回失败）', async () => {
    const { engine, accountRepo, snapRepo } = makeEnv({
      accounts: [makeAccount('AC1', { cash: NaN })],
    });
    snapRepo.rows.push({ id: 'S4', accountId: 'AC1', symbol: 'T1', exDay: 6, longQty: 100, shortQty: 0, lockDay: 0, paid: false });
    const logs = captureLogs(engine);
    const paid = await engine.payDividends([{ symbol: 'T1', perShare: 2 }], 6, 'CN');
    expect(paid).toBe(0); // 返回失败而不是写脏数据
    expect(accountRepo.calls.save).toBe(0); // 关键断言：该账户未被保存
    expect(Number.isFinite(Number(accountRepo.rows[0].cash))).toBe(false); // 原值未被改成“看起来正常”的数
    expect(logs.errors.join('|')).toContain('分红到账后现金非有限数');
  });
});
