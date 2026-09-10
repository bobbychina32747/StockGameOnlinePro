// Phase 14 REFACTOR-5 批次 A 下单加固回归：
// R5-② 集合竞价中断的回滚粒度——失败条目绝不回盘口（可能已部分落库），只回滚其后的未结算条目；
//      失败条目保持 PENDING 并写 rejectReason «集合竞价结算中断，需人工核对» 供人工对账；预校验失败分支仍全量回盘。
// R5-③ 盘后固定价格交易的对手单回滚目标——rollbackTo:'close' 回盘后队列（closingBook），默认仍回连续竞价盘口。
// R5-⑥ 下单幂等键 clientOrderId——同键重复提交返回同一订单且不再走引擎；不传键行为与修复前完全一致。
const { TradingEngineService } = require('../dist/src/core/trading-engine/trading-engine.service');
const { OrderService } = require('../dist/src/modules/trading/order.service');
const { Order } = require('../dist/src/infrastructure/database/entities/order.entity');

// 简易内存仓库（与 phase12/phase13 同款口径），failSaveIds 用于模拟指定实体 id 写库异常
function matchesWhere(r, where) {
  if (Array.isArray(where)) return where.some((w) => matchesWhere(r, w));
  return Object.entries(where || {}).every(([k, v]) => {
    if (v && typeof v === 'object' && v._type === 'in') return (v.value || []).map(String).includes(String(r[k]));
    return String(r[k]) === String(v);
  });
}
function countingRepo(seed = [], opts = {}) {
  const rows = [...seed];
  let idc = 1;
  const calls = { find: 0, findOne: 0, save: 0 };
  return {
    rows, calls,
    find: async (q) => { calls.find++; return rows.filter((r) => matchesWhere(r, q?.where)); },
    findOne: async (q) => { calls.findOne++; return rows.find((r) => matchesWhere(r, q?.where)) || null; },
    save: async (e) => {
      calls.save++;
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
function makeEnv({ accounts = [], positions = [], orders = [], failAccountSave = [], failOrderSave = [] } = {}) {
  const orderRepo = countingRepo(orders, { failSaveIds: failOrderSave });
  const accountRepo = countingRepo(accounts, { failSaveIds: failAccountSave });
  const posRepo = countingRepo(positions);
  const txRepo = countingRepo();
  const snapRepo = countingRepo();
  const engine = new TradingEngineService(orderRepo, accountRepo, posRepo, txRepo, snapRepo);
  engine.prices.set('T1', 10);
  return { engine, orderRepo, accountRepo, posRepo, txRepo, snapRepo };
}
function captureLogs(engine) {
  const errors = [];
  const warns = [];
  engine.logger.error = (msg) => { errors.push(String(msg)); };
  engine.logger.warn = (msg) => { warns.push(String(msg)); };
  return { errors, warns };
}
// 记录 placeRestingOrder 调用（"失败条目是否回盘"的判定依据：回盘=进连续竞价盘口）
function spyResting(orderEngine) {
  const resting = [];
  const orig = orderEngine.placeRestingOrder.bind(orderEngine);
  orderEngine.placeRestingOrder = (symbol, orderId, accountId, side, price, qty, opts) => {
    resting.push({ symbol, orderId, accountId, side, price, qty });
    return orig(symbol, orderId, accountId, side, price, qty, opts);
  };
  return resting;
}
const MARKET = '集合竞价结算中断，需人工核对';

describe('Phase 14 R5-② 集合竞价中断的回滚粒度（防二次结算）', () => {
  // 三条成交：oA 正常结算 / oB 账户写库抛异常（失败条目）/ oC 尚未结算（必须回盘）
  const auctionFills = () => [
    { orderId: 'oA', accountId: 'AC1', side: 'buy', price: 10, qty: 100, virtual: false },
    { orderId: 'oB', accountId: 'AC2', side: 'buy', price: 10, qty: 100, virtual: false },
    { orderId: 'oC', accountId: 'AC3', side: 'sell', price: 10, qty: 100, virtual: false },
  ];
  const auctionOrders = () => [
    { id: 'oA', accountId: 'AC1', symbol: 'T1', side: 'buy', quantity: 100, price: 10, filledQty: 0, status: 'pending' },
    { id: 'oB', accountId: 'AC2', symbol: 'T1', side: 'buy', quantity: 100, price: 10, filledQty: 0, status: 'pending' },
    { id: 'oC', accountId: 'AC3', symbol: 'T1', side: 'sell', quantity: 100, price: 10, filledQty: 0, status: 'pending' },
  ];
  const auctionAccounts = () => [
    makeAccount('AC1', { cash: 100000 }), makeAccount('AC2', { cash: 100000 }), makeAccount('AC3', { cash: 1000 }),
  ];

  test('队列内异常：只回滚失败条目之后的条目，失败条目未回盘且保持 PENDING + rejectReason 标记', async () => {
    const { engine, orderRepo, accountRepo, posRepo } = makeEnv({
      accounts: auctionAccounts(),
      positions: [makePosition('AC3', 'T1', 100, { longCost: 1000 })],
      orders: auctionOrders(),
      failAccountSave: ['AC2'], // 第二条（oB）已过预校验，写账户时抛异常 → 可能已部分落库
    });
    const resting = spyResting(engine);
    const logs = captureLogs(engine);
    const r = await engine.settleAuctionFills('T1', auctionFills());

    expect(r.success).toBe(false); // 异常必须上报为失败（P1-7 语义保留）
    expect(r.settled).toBe(1); // 第一条已结算，计数保留供对账
    expect(r.error).toContain('模拟 DB 写入失败');

    // ① 唯一回盘的条目是"失败条目之后"的 oC；失败条目 oB 绝不回盘（放回=允许二次撮合结算）
    expect(resting.map((x) => x.orderId)).toEqual(['oC']);
    expect((engine.realBooks.get('T1').asks || []).some((a) => a.orderId === 'oC')).toBe(true);
    expect((engine.realBooks.get('T1').bids || []).some((b) => b.orderId === 'oB')).toBe(false);

    // ② 失败条目：保持 PENDING（不置 FILLED/CANCELLED）+ rejectReason 打标，仅留给人工对账
    const oB = orderRepo.rows.find((o) => o.id === 'oB');
    expect(oB.status).toBe('pending');
    expect(oB.rejectReason).toBe(MARKET);

    // ③ 已结算条目照常回写 filledQty/FILLED；未结算条目 oC 不被误标
    const oA = orderRepo.rows.find((o) => o.id === 'oA');
    expect(oA.status).toBe('filled');
    expect(Number(oA.filledQty)).toBe(100);
    const oC = orderRepo.rows.find((o) => o.id === 'oC');
    expect(oC.status).toBe('pending');
    expect(oC.rejectReason).toBeUndefined();

    // ④ oC 一条未结算：资金/持仓分文未动（回盘恢复 PENDING 的前提）
    expect(Number(accountRepo.rows.find((a) => a.id === 'AC3').cash)).toBe(1000);
    expect(Number(posRepo.rows.find((p) => p.accountId === 'AC3').longQty)).toBe(100);

    // ⑤ 日志留证：中断 + 该条不回滚/请人工对账
    expect(logs.errors.join('|')).toContain('集合竞价结算中断');
    expect(logs.errors.join('|')).toContain('请人工对账');
  });

  test('回归：预校验失败（一条未结算）仍全量回盘，且不打"需人工核对"标', async () => {
    const { engine, orderRepo } = makeEnv({
      accounts: [makeAccount('AC1', { cash: 500 }), makeAccount('AC2', { cash: 100000 }), makeAccount('AC3', { cash: 1000 })],
      positions: [makePosition('AC3', 'T1', 100, { longCost: 1000 })],
      orders: auctionOrders(),
    });
    const resting = spyResting(engine);
    const r = await engine.settleAuctionFills('T1', auctionFills());

    expect(r.success).toBe(false);
    expect(r.settled).toBe(0); // 预校验失败 = 一条未结算（安全状态）
    const book = engine.realBooks.get('T1');
    expect((book.bids || []).some((b) => b.orderId === 'oA')).toBe(true);
    expect((book.bids || []).some((b) => b.orderId === 'oB')).toBe(true);
    expect((book.asks || []).some((a) => a.orderId === 'oC')).toBe(true);
    expect(resting.map((x) => x.orderId).sort()).toEqual(['oA', 'oB', 'oC']);
    expect(orderRepo.rows.every((o) => o.status === 'pending')).toBe(true);
    // 关键：预校验失败是"未结算"状态，不得误打人工对账标（否则真·异常会被淹没）
    expect(orderRepo.rows.every((o) => o.rejectReason === undefined)).toBe(true);
  });

  test('回归：失败条目之后的虚拟单/无 orderId 条目不回盘（口径与 P1-6 一致）', async () => {
    const { engine } = makeEnv({
      accounts: auctionAccounts(),
      positions: [makePosition('AC3', 'T1', 100, { longCost: 1000 })],
      orders: auctionOrders(),
      failAccountSave: ['AC2'],
    });
    const resting = spyResting(engine);
    const r = await engine.settleAuctionFills('T1', [
      ...auctionFills().slice(0, 2),
      { orderId: null, accountId: null, side: 'buy', price: 10, qty: 100, virtual: true },
      { orderId: 'oC', accountId: 'AC3', side: 'sell', price: 10, qty: 100, virtual: false },
    ]);
    expect(r.success).toBe(false);
    expect(resting.map((x) => x.orderId)).toEqual(['oC']); // 虚拟单不入真实盘口
  });
});

describe('Phase 14 R5-③ 盘后固定价格交易的对手单回滚目标', () => {
  test("submitClosingOrder：对手单结算失败回滚进盘后队列，不写连续竞价盘口", async () => {
    const { engine, accountRepo } = makeEnv({
      accounts: [makeAccount('AC1', { cash: 1000 }), makeAccount('AC2', { cash: 0 })], // 对手买方无钱 → 结算失败
      positions: [makePosition('AC1', 'T1', 100, { longCost: 1000 })],
    });
    const logs = captureLogs(engine);
    const book = engine.getClosingBook('T1');
    book.bids.push({ orderId: 'cBid', accountId: 'AC2', side: 'buy', price: 10, qty: 100, time: Date.now() - 1 });
    const acct = accountRepo.rows.find((a) => a.id === 'AC1');
    const r = await engine.submitClosingOrder(
      { userId: 'U1', accountId: 'AC1', symbol: 'T1', type: 'limit', side: 'sell', quantity: 100, price: 10 },
      acct, 10,
    );

    expect(r.success).toBe(true); // 本方已成交，对手方失败不撤销本方
    const rolled = engine.getClosingBook('T1').bids.find((b) => b.orderId === 'cBid');
    expect(rolled).toBeTruthy();
    // 字段形状与 submitClosingOrder 内既有 push 一致
    expect(Object.keys(rolled).sort()).toEqual(['accountId', 'orderId', 'price', 'qty', 'side', 'time']);
    expect(rolled).toMatchObject({ accountId: 'AC2', side: 'buy', price: 10, qty: 100 });
    expect(typeof rolled.time).toBe('number');
    // 关键：连续竞价盘口绝不能出现盘后申报（否则 15:30 后申报变次日活单）
    expect(((engine.realBooks.get('T1') || {}).bids || []).some((b) => b.orderId === 'cBid')).toBe(false);
    expect(logs.warns.join('|')).toContain('回滚至盘后队列');
  });

  test("显式 rollbackTo:'close'：卖方向对手单回滚进 closingBook.asks（方向映射）", async () => {
    const { engine } = makeEnv({
      accounts: [makeAccount('AC1', { cash: 1000 }), makeAccount('AC2', { cash: 1000 })], // AC2 无持仓 → 卖出结算失败
    });
    const logs = captureLogs(engine);
    const r = await engine.settleCounterFills(
      'T1', 'CN',
      [{ orderId: 'oS', accountId: 'AC2', side: 'sell', price: 10, qty: 100, virtual: false }],
      { rollbackTo: 'close' },
    );
    expect(r.ok).toBe(false);
    expect((engine.closingBook.get('T1').asks || []).some((a) => a.orderId === 'oS')).toBe(true);
    expect(((engine.realBooks.get('T1') || {}).asks || []).some((a) => a.orderId === 'oS')).toBe(false);
    expect(logs.warns.join('|')).toContain('回滚至盘后队列');
  });

  test("默认（不传 opts）：仍回连续竞价盘口，既有调用点行为不变", async () => {
    const { engine } = makeEnv({
      accounts: [makeAccount('AC2', { cash: 0 })],
      orders: [{ id: 'oB', accountId: 'AC2', symbol: 'T1', side: 'buy', quantity: 100, price: 10, filledQty: 0, status: 'pending' }],
    });
    const logs = captureLogs(engine);
    const r = await engine.settleCounterFills('T1', 'CN', [{ orderId: 'oB', accountId: 'AC2', side: 'buy', price: 10, qty: 100, virtual: false }]);
    expect(r.ok).toBe(false);
    expect((engine.realBooks.get('T1').bids || []).some((b) => b.orderId === 'oB')).toBe(true);
    expect(((engine.closingBook.get('T1') || {}).bids || []).some((b) => b.orderId === 'oB')).toBe(false);
    expect(logs.warns.join('|')).toContain('已回滚盘口');
  });
});

describe('Phase 14 R5-⑥ 下单幂等键 clientOrderId', () => {
  // 手写 OrderService 环境：accountRepo/orderRepo 内存实现 + 计数版假引擎（引擎调用次数=重复下单判定）
  function makeOrderService({ orders = [], engineEchoesKey = false } = {}) {
    const accountRepo = countingRepo([makeAccount('AC1', { userId: 'U1' })]);
    const orderRepo = countingRepo(orders);
    const positionRepo = countingRepo();
    const txRepo = countingRepo();
    let calls = 0;
    const engine = {
      prices: new Map([['T1', 10]]),
      submitOrder: async (dto) => {
        calls++;
        // 模拟引擎落库订单实体（挂单路径返回 { success, order }）；engineEchoesKey=引擎直接落键（R5-⑥ 透传）
        const order = {
          id: 'ord-' + calls, accountId: dto.accountId, symbol: dto.symbol, type: dto.type, side: dto.side,
          quantity: dto.quantity, price: dto.price, status: 'pending', filledQty: 0,
          clientOrderId: engineEchoesKey ? dto.clientOrderId : undefined,
        };
        orderRepo.rows.push(order);
        return { success: true, order };
      },
    };
    const service = new OrderService(accountRepo, positionRepo, orderRepo, txRepo, engine, {}, { canBypassHours: () => true });
    return { service, orderRepo, calls: () => calls };
  }

  test('同一 clientOrderId 第二次提交：返回同一订单 + duplicate:true，引擎未被再次调用', async () => {
    const { service, orderRepo, calls } = makeOrderService();
    const first = await service.placeOrder('U1', 'CN', 'T1', 'limit', 'buy', 100, 10, undefined, undefined, 'KEY-1');
    expect(first.success).toBe(true);
    expect(first.duplicate).toBeUndefined(); // 首次提交不含 duplicate 字段（响应结构只允许新增）
    expect(calls()).toBe(1);
    // 服务层兜底：引擎未回带键时按 orderId 回填 clientOrderId 落库
    expect(orderRepo.rows[0].clientOrderId).toBe('KEY-1');

    const second = await service.placeOrder('U1', 'CN', 'T1', 'limit', 'buy', 100, 10, undefined, undefined, 'KEY-1');
    expect(second).toEqual({ success: true, order: first.order, duplicate: true });
    expect(second.order.id).toBe(first.order.id); // 同一订单，不是新单
    expect(calls()).toBe(1); // 关键断言：引擎未被再次调用（无二次撮合/扣款）
    expect(orderRepo.rows.length).toBe(1);
  });

  test('引擎已直落幂等键时不重复写库；不同键/不同账户各自独立', async () => {
    const { service, orderRepo, calls } = makeOrderService({ engineEchoesKey: true });
    await service.placeOrder('U1', 'CN', 'T1', 'limit', 'buy', 100, 10, undefined, undefined, 'KEY-A');
    expect(orderRepo.rows[0].clientOrderId).toBe('KEY-A');
    expect(orderRepo.calls.save).toBe(0); // 引擎直落 → service 兜底无需再写
    await service.placeOrder('U1', 'CN', 'T1', 'limit', 'buy', 100, 11, undefined, undefined, 'KEY-B');
    expect(calls()).toBe(2); // 不同键 = 新单
    const dup = await service.placeOrder('U1', 'CN', 'T1', 'limit', 'buy', 100, 10, undefined, undefined, 'KEY-A');
    expect(dup.duplicate).toBe(true);
    expect(calls()).toBe(2);
  });

  test('不传 clientOrderId：行为与修复前完全一致（零幂等查询、不写键、不出现 duplicate 字段）', async () => {
    const { service, orderRepo, calls } = makeOrderService();
    const res = await service.placeOrder('U1', 'CN', 'T1', 'limit', 'buy', 100, 10, undefined, undefined);
    expect(Object.keys(res).sort()).toEqual(['order', 'success']); // 响应结构未变
    expect('duplicate' in res).toBe(false);
    expect(calls()).toBe(1);
    expect(orderRepo.rows[0].clientOrderId).toBeUndefined();
    expect(orderRepo.calls.findOne).toBe(0); // 未传键不得发起幂等查询
    expect(orderRepo.rows.length).toBe(1);
  });

  test('空串/纯空白 clientOrderId 视为未传（不生成默认键，行为不变）', async () => {
    const { service, orderRepo, calls } = makeOrderService();
    const res = await service.placeOrder('U1', 'CN', 'T1', 'limit', 'buy', 100, 10, undefined, undefined, '   ');
    expect('duplicate' in res).toBe(false);
    expect(calls()).toBe(1);
    expect(orderRepo.rows[0].clientOrderId).toBeUndefined();
    expect(orderRepo.calls.findOne).toBe(0);
  });

  test('引擎落库透传：挂单路径订单实体带上 clientOrderId（FOK/IOC 同一 create 口径）', async () => {
    const { engine, orderRepo } = makeEnv({ accounts: [makeAccount('AC1')] });
    const r = await engine.submitOrder(
      { userId: 'U1', accountId: 'AC1', symbol: 'T1', type: 'limit', side: 'buy', quantity: 100, price: 9, clientOrderId: 'K9' },
      makeAccount('AC1'),
    );
    expect(r.success).toBe(true);
    expect(r.order.clientOrderId).toBe('K9');
    expect(orderRepo.rows.find((o) => o.id === r.order.id).clientOrderId).toBe('K9');
  });
});

describe('Phase 14 R5-⑥ 订单实体元数据（synchronize 首启落库）', () => {
  const { getMetadataArgsStorage } = require('typeorm');
  const storage = getMetadataArgsStorage();
  const idxOf = (target, columns) => storage.indices.find((i) =>
    i.target === target && JSON.stringify(i.columns) === JSON.stringify(columns));

  test('orders 新增 clientOrderId 可空列', () => {
    const col = storage.columns.find((c) => c.target === Order && c.propertyName === 'clientOrderId');
    expect(col).toBeTruthy();
    expect(col.options.type).toBe('varchar');
    expect(col.options.nullable).toBe(true);
  });

  test('orders 有 (accountId, clientOrderId) 幂等索引，且既有两条索引保留（不互相替换）', () => {
    expect(idxOf(Order, ['accountId', 'clientOrderId'])).toBeTruthy();
    expect(idxOf(Order, ['accountId', 'status'])).toBeTruthy();
    expect(idxOf(Order, ['status', 'type'])).toBeTruthy();
  });
});
