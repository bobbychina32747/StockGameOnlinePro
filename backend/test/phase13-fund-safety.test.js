// Phase 13 资金安全回归：申购舍入套利（0.014 只扣 0.01 却拿 0.014 份）/ 赎回份额与到账金额同源 /
// 「账户现金 + 基金持仓」写库同事务（旧实现两次独立写库，崩溃可凭空造钱）
const { FundService } = require('../dist/src/modules/fund/fund.service');

function matchesWhere(r, where) {
  if (Array.isArray(where)) return where.some((w) => matchesWhere(r, w));
  return Object.entries(where || {}).every(([k, v]) => String(r[k]) === String(v));
}
// 参考 phase12-risk-perf 的 countingRepo：统计 save 次数，并记录「事务外写库」次数（事务证据）
function countingRepo(seed = [], state = { inTxn: 0, savesOutsideTxn: 0 }) {
  const rows = [...seed];
  let idc = 1;
  const calls = { findOne: 0, save: 0, delete: 0 };
  return {
    rows, calls, state,
    find: async (q) => rows.filter((r) => matchesWhere(r, q?.where)),
    findOne: async (q) => {
      calls.findOne++;
      return rows.find((r) => matchesWhere(r, q?.where)) || null;
    },
    save: async (e) => {
      calls.save++;
      if (!state.inTxn) state.savesOutsideTxn++; // 事务外写库 = 缺陷复现信号
      if (!e.id) e.id = 'auto-' + idc++;
      const i = rows.findIndex((r) => r.id === e.id);
      if (i >= 0) rows[i] = e; else rows.push(e);
      return e;
    },
    create: (obj) => obj,
    delete: async (id) => {
      calls.delete++;
      if (!state.inTxn) state.savesOutsideTxn++;
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
    },
  };
}
// fake DataSource：transaction 把同一个 mgr 交给回调，mgr 委托给 fake repo（数据仍可断言），
// 同时记录「两次 save 是否落在同一事务对象上」
function fakeDataSource(state) {
  const calls = { transaction: 0, mgrSaves: [], mgrDeletes: [] };
  const mgr = { calls };
  return {
    calls,
    manager: mgr,
    transaction: async (fn) => {
      calls.transaction++;
      state.inTxn++;
      try {
        return await fn(mgr);
      }
      finally {
        state.inTxn--;
      }
    },
  };
}

describe('Phase 13 P0 申购舍入套利（扣款与份额必须同源）', () => {
  function makeFund({ mode = 'CN', cash = 100, holding = null, withTxn = true, gameDay = 0 } = {}) {
    const state = { inTxn: 0, savesOutsideTxn: 0 };
    const accountRepo = countingRepo([{ id: 'AC1', userId: 'U1', marketMode: mode, cash }], state);
    const holdingRepo = countingRepo(holding ? [holding] : [], state);
    const engine = { runExclusive: (fn) => fn() };
    const marketData = { gameDay };
    const seasonService = { isBlocked: async () => false };
    const ds = withTxn ? fakeDataSource(state) : undefined;
    const svc = new FundService(accountRepo, holdingRepo, engine, marketData, seasonService, ds);
    // mgr 委托真实 fake repo，保证事务路径下数据可见
    if (ds) {
      ds.manager.save = async (e) => {
        ds.calls.mgrSaves.push(e);
        return (e && e.fundId ? holdingRepo : accountRepo).save(e);
      };
      ds.manager.delete = async (_target, id) => {
        ds.calls.mgrDeletes.push(id);
        return holdingRepo.delete(id);
      };
    }
    return { svc, accountRepo, holdingRepo, ds, state };
  }

  test('amt=0.014（净值 1.0 免申购费）→ 只扣 0.01 且只记 0.01 份（旧实现记 0.014 份）', async () => {
    const { svc, accountRepo, holdingRepo } = makeFund();
    const r = await svc.subscribe('U1', 'CN', 'fund-2', 0.014);
    expect(r.success).toBe(true);
    const h = holdingRepo.rows[0];
    const cash = Number(accountRepo.rows[0].cash);
    // 旧缺陷：cash 扣 0.01、shares 记 0.014（白送 40%）
    expect(cash).toBeCloseTo(99.99, 10);
    expect(Number(h.shares)).toBeCloseTo(0.01, 10);
    expect(Number(h.shares)).not.toBeCloseTo(0.014, 6);
    // 扣款 == 份额 × nav（免申购费时严格相等）
    expect(Number(h.shares) * r.nav).toBeCloseTo(100 - cash, 10);
    expect(r.shares).toBeCloseTo(0.01, 4);
  });

  test('循环申购 0.014 不再抽干现金：累计扣款与累计份额严格等值（净值 1.0）', async () => {
    const { svc, accountRepo, holdingRepo } = makeFund();
    for (let i = 0; i < 20; i++)
      expect((await svc.subscribe('U1', 'CN', 'fund-2', 0.014)).success).toBe(true);
    const cash = Number(accountRepo.rows[0].cash);
    const shares = Number(holdingRepo.rows[0].shares);
    expect(cash).toBeCloseTo(99.8, 8); // 20 × 0.01
    expect(100 - cash).toBeCloseTo(shares * 1.0, 8);
  });

  test('计费基金：份额×nav 不超过扣款，差额恰为申购费（≤1 分）', async () => {
    const { svc, accountRepo, holdingRepo } = makeFund({ cash: 1000 });
    const r = await svc.subscribe('U1', 'CN', 'fund-1', 0.014); // 净值 4.5、申购费 0.15%
    expect(r.success).toBe(true);
    const cash = Number(accountRepo.rows[0].cash);
    const paid = 1000 - cash;
    const h = holdingRepo.rows[0];
    expect(paid).toBeCloseTo(0.01, 10);
    // 独立口径的申购费（r.fee 已按分取整，小额会显示 0.00，不能用作断言基准）
    const expectFee = 0.01 * 0.0015;
    expect(Number(h.shares) * r.nav).toBeLessThanOrEqual(paid + 1e-9); // 绝不占平台便宜
    expect(paid - Number(h.shares) * r.nav).toBeCloseTo(expectFee, 10); // 差额就是申购费
    expect(paid - Number(h.shares) * r.nav).toBeLessThanOrEqual(0.01);
  });

  test('非 CN 账户：扣款为本币 amount、份额按 CNY 折算、totalInvested 记 CNY 口径', async () => {
    const { svc, accountRepo, holdingRepo } = makeFund({ mode: 'US', cash: 100000 });
    const r = await svc.subscribe('U1', 'US', 'fund-2', 100);
    expect(r.success).toBe(true);
    const cny = svc.toCny(100, 'US');
    const h = holdingRepo.rows[0];
    expect(Number(accountRepo.rows[0].cash)).toBeCloseTo(99900, 6); // 扣本币
    expect(Number(h.shares)).toBeCloseTo(cny, 6); // 免申购费：份额 = CNY / nav(1.0)
    expect(Number(h.totalInvested)).toBeCloseTo(cny, 6); // P3：重构前记本币 100，现统一 CNY
  });

  test('非法/非有限/负数/不足 1 分的金额一律被拒，账户与持仓零改动', async () => {
    const { svc, accountRepo, holdingRepo } = makeFund();
    const bads = [NaN, 'abc', -1, 0, -0.001, Infinity, -Infinity, null, undefined, 0.004, 0.001];
    for (const bad of bads) {
      const r = await svc.subscribe('U1', 'CN', 'fund-2', bad);
      expect(r.success).toBe(false);
      expect(r.error).toContain('申购金额');
    }
    expect(Number(accountRepo.rows[0].cash)).toBe(100);
    expect(accountRepo.calls.save).toBe(0);
    expect(holdingRepo.rows.length).toBe(0);
  });

  test('未注入 DataSource（既有 5 参构造）仍可用：退化为顺序写库', async () => {
    const { svc, accountRepo, holdingRepo, state } = makeFund({ withTxn: false });
    const r = await svc.subscribe('U1', 'CN', 'fund-2', 10);
    expect(r.success).toBe(true);
    expect(Number(accountRepo.rows[0].cash)).toBeCloseTo(90, 10);
    expect(Number(holdingRepo.rows[0].shares)).toBeCloseTo(10, 10);
    expect(state.savesOutsideTxn).toBe(2); // 无事务降级路径：两笔顺序写
  });
});

describe('Phase 13 P0 赎回份额与到账金额同源', () => {
  const holding = (over = {}) => ({ id: 'H1', userId: 'U1', marketMode: 'CN', fundId: 'fund-2', shares: 100, totalInvested: 100, firstBuyDay: 0, ...over });

  function makeRedeem({ holdingRow = holding(), cash = 0, gameDay = 5, mode = 'CN', withTxn = true } = {}) {
    const state = { inTxn: 0, savesOutsideTxn: 0 };
    const accountRepo = countingRepo([{ id: 'AC1', userId: 'U1', marketMode: mode, cash }], state);
    const holdingRepo = countingRepo([holdingRow], state);
    const engine = { runExclusive: (fn) => fn() };
    const marketData = { gameDay };
    const seasonService = { isBlocked: async () => false };
    const ds = withTxn ? fakeDataSource(state) : undefined;
    const svc = new FundService(accountRepo, holdingRepo, engine, marketData, seasonService, ds);
    if (ds) {
      ds.manager.save = async (e) => {
        ds.calls.mgrSaves.push(e);
        return (e && e.fundId ? holdingRepo : accountRepo).save(e);
      };
      ds.manager.delete = async (_target, id) => {
        ds.calls.mgrDeletes.push(id);
        return holdingRepo.delete(id);
      };
    }
    return { svc, accountRepo, holdingRepo, ds };
  }

  test('全额赎回：到账 = 份额 × nav × (1 - 赎回费)，持仓清仓', async () => {
    const { svc, accountRepo, holdingRepo } = makeRedeem(); // gameDay 5 → 1.5% 档
    const r = await svc.redeem('U1', 'CN', 'fund-2', 100);
    expect(r.success).toBe(true);
    expect(r.feeRate).toBe(0.015);
    expect(r.amount).toBeCloseTo(98.5, 2);
    expect(Number(accountRepo.rows[0].cash)).toBeCloseTo(98.5, 2);
    expect(holdingRepo.rows.length).toBe(0); // 清仓删行
  });

  test('部分赎回：扣减份额与到账金额严格同源、差额 < 1 分且不占平台便宜', async () => {
    const { svc, accountRepo, holdingRepo } = makeRedeem();
    const r = await svc.redeem('U1', 'CN', 'fund-2', 33.333);
    expect(r.success).toBe(true);
    const exact = 33.333 * 1.0 * (1 - r.feeRate);
    expect(r.amount).toBeLessThanOrEqual(exact + 1e-9); // 只向「对平台不亏」一侧取整
    expect(exact - r.amount).toBeLessThan(0.01);
    expect(r.amount).toBe(32.83);
    expect(Number(holdingRepo.rows[0].shares)).toBeCloseTo(100 - 33.333, 6); // 扣减用的是同一 sh
    expect(Number(accountRepo.rows[0].cash)).toBeCloseTo(r.amount, 10);
  });

  test('细分份额赎回不再白送：0.005 份（应值 0.005）被拒，份额不被扣', async () => {
    // 旧实现 Math.round(0.005*100)/100 = 0.01：0.005 份换 1 分，可循环印钱
    const { svc, accountRepo, holdingRepo } = makeRedeem({ holdingRow: holding({ shares: 1, firstBuyDay: 0 }), gameDay: 100 }); // ≥30 日免赎回费
    const r = await svc.redeem('U1', 'CN', 'fund-2', 0.005);
    expect(r.success).toBe(false);
    expect(r.error).toContain('赎回金额');
    expect(Number(holdingRepo.rows[0].shares)).toBe(1);
    expect(Number(accountRepo.rows[0].cash)).toBe(0);
    // 恰好 1 分（0.01 份 × nav 1.0）仍可正常赎回，用户不吃暗亏
    const ok = await svc.redeem('U1', 'CN', 'fund-2', 0.01);
    expect(ok.success).toBe(true);
    expect(ok.amount).toBeCloseTo(0.01, 10);
    expect(Number(holdingRepo.rows[0].shares)).toBeCloseTo(0.99, 10);
  });

  test('份额规范化到 4 位：超精度请求按同一数值计价与扣减', async () => {
    const { svc, holdingRepo } = makeRedeem({ gameDay: 100 }); // 免赎回费 → 金额 == 份额
    const r = await svc.redeem('U1', 'CN', 'fund-2', 10.000049); // → 10.0000 份
    expect(r.success).toBe(true);
    expect(r.amount).toBeCloseTo(10, 10);
    expect(Number(holdingRepo.rows[0].shares)).toBeCloseTo(90, 10);
  });

  test('非法/非有限/负数份额被拒，持仓与现金零改动', async () => {
    const { svc, accountRepo, holdingRepo } = makeRedeem();
    for (const bad of [NaN, 'abc', -1, 0, Infinity, null, undefined, 0.00004]) {
      const r = await svc.redeem('U1', 'CN', 'fund-2', bad);
      expect(r.success).toBe(false);
      expect(r.error).toContain('赎回份额');
    }
    expect(Number(holdingRepo.rows[0].shares)).toBe(100);
    expect(Number(accountRepo.rows[0].cash)).toBe(0);
  });

  test('份额不足仍被拒（互斥队列内重读持仓）', async () => {
    const { svc } = makeRedeem();
    const r = await svc.redeem('U1', 'CN', 'fund-2', 100.0001);
    expect(r.success).toBe(false);
    expect(r.error).toContain('持仓份额不足');
  });
});

describe('Phase 13 P0 现金 + 持仓写库同事务', () => {
  function build({ seedCash = 1000, holdingRow = null, fundId = 'fund-2' } = {}) {
    const state = { inTxn: 0, savesOutsideTxn: 0 };
    const accountRepo = countingRepo([{ id: 'AC1', userId: 'U1', marketMode: 'CN', cash: seedCash }], state);
    const holdingRepo = countingRepo(holdingRow ? [holdingRow] : [], state);
    const ds = fakeDataSource(state);
    ds.manager.save = async (e) => {
      ds.calls.mgrSaves.push(e);
      return (e && e.fundId ? holdingRepo : accountRepo).save(e);
    };
    ds.manager.delete = async (_target, id) => {
      ds.calls.mgrDeletes.push(id);
      return holdingRepo.delete(id);
    };
    const svc = new FundService(accountRepo, holdingRepo, { runExclusive: (fn) => fn() }, { gameDay: 5 }, { isBlocked: async () => false }, ds);
    return { svc, accountRepo, holdingRepo, ds, state, fundId };
  }

  test('申购：transaction 被调用一次，现金与份额两次 save 落在同一事务对象上', async () => {
    const { svc, accountRepo, holdingRepo, ds, state } = build();
    const r = await svc.subscribe('U1', 'CN', 'fund-2', 100);
    expect(r.success).toBe(true);
    expect(ds.calls.transaction).toBe(1);
    expect(ds.calls.mgrSaves.length).toBe(2);
    expect(ds.calls.mgrSaves.filter((e) => e.fundId).length).toBe(1); // 持仓
    expect(ds.calls.mgrSaves.filter((e) => !e.fundId).length).toBe(1); // 账户
    expect(state.savesOutsideTxn).toBe(0); // 不存在事务外写库（旧实现正是这里分两次写）
    expect(Number(accountRepo.rows[0].cash)).toBeCloseTo(900, 10);
    expect(Number(holdingRepo.rows[0].shares)).toBeCloseTo(100, 10);
  });

  test('赎回：现金增加与份额扣减同事务；清仓走事务内 delete', async () => {
    const seeded = build({ seedCash: 0, holdingRow: { id: 'H1', userId: 'U1', marketMode: 'CN', fundId: 'fund-2', shares: 50, totalInvested: 50, firstBuyDay: 0 } });
    const r = await seeded.svc.redeem('U1', 'CN', 'fund-2', 50); // gameDay 5 → 1.5% 档
    expect(r.success).toBe(true);
    expect(seeded.ds.calls.transaction).toBe(1);
    expect(seeded.ds.calls.mgrDeletes).toEqual(['H1']); // 清仓在事务内删行
    expect(seeded.ds.calls.mgrSaves.length).toBe(1); // 只写账户现金
    expect(seeded.state.savesOutsideTxn).toBe(0);
    expect(Number(seeded.accountRepo.rows[0].cash)).toBeCloseTo(50 * 0.985, 2);
    expect(seeded.holdingRepo.rows.length).toBe(0);
    // 部分赎回：事务内 update 持仓而非删行
    const partial = build({ seedCash: 0, holdingRow: { id: 'H2', userId: 'U1', marketMode: 'CN', fundId: 'fund-2', shares: 50, totalInvested: 50, firstBuyDay: 0 } });
    const r2 = await partial.svc.redeem('U1', 'CN', 'fund-2', 20);
    expect(r2.success).toBe(true);
    expect(partial.ds.calls.transaction).toBe(1);
    expect(partial.ds.calls.mgrDeletes.length).toBe(0);
    expect(partial.ds.calls.mgrSaves.filter((e) => e.fundId).length).toBe(1);
    expect(Number(partial.holdingRepo.rows[0].shares)).toBeCloseTo(30, 10);
  });

  test('校验失败/余额不足时事务根本不开启（不产生空事务写库）', async () => {
    const { svc, ds } = build({ seedCash: 1 });
    expect((await svc.subscribe('U1', 'CN', 'fund-2', 100)).error).toContain('余额不足');
    expect((await svc.subscribe('U1', 'CN', 'nope', 1)).error).toContain('基金不存在');
    expect((await svc.subscribe('U1', 'CN', 'fund-2', -1)).error).toContain('申购金额');
    expect(ds.calls.transaction).toBe(0);
  });

  test('生产语义：事务回调异常向调用方抛出而非静默吞掉（崩溃时整体回滚）', async () => {
    const { svc, accountRepo, holdingRepo, ds, state } = build();
    ds.manager.save = async (e) => {
      ds.calls.mgrSaves.push(e);
      if (e && e.fundId) throw new Error('simulated crash before holding write');
      return accountRepo.save(e);
    };
    await expect(svc.subscribe('U1', 'CN', 'fund-2', 100)).rejects.toThrow('simulated crash');
    expect(ds.calls.transaction).toBe(1);
    expect(state.inTxn).toBe(0); // 事务已闭合（fake 只是不具备回滚能力）
    expect(holdingRepo.rows.length).toBe(0);
  });
});
