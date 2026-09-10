// Phase F 回归：流水「最近 N 笔」口径统一（sliceRecentAsc）/ 挂单扫描复合索引 / 强平无负债裁剪与降级安全
const { sliceRecentAsc, RECENT_TX_LIMIT, pairedMetrics } = require('../dist/src/core/risk-manager/perf');
const { TradingEngineService } = require('../dist/src/core/trading-engine/trading-engine.service');

describe('Phase F sliceRecentAsc（口径单一来源）', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: 'T' + (i + 1), createdAt: i }));

  test('600 笔升序 → 取最近 500 笔且仍为升序（首=101，末=600）', () => {
    const out = sliceRecentAsc(mk(600));
    expect(out.length).toBe(500);
    expect(out[0].id).toBe('T101');
    expect(out[499].id).toBe('T600');
  });

  test('不足 limit 原样（同一引用，零拷贝）', () => {
    const arr = mk(10);
    expect(sliceRecentAsc(arr)).toBe(arr);
    expect(RECENT_TX_LIMIT).toBe(500);
  });

  test('边界：undefined/null/非数组 → []；limit 非法回落默认值', () => {
    expect(sliceRecentAsc(undefined)).toEqual([]);
    expect(sliceRecentAsc(null)).toEqual([]);
    expect(sliceRecentAsc('nope')).toEqual([]);
    expect(sliceRecentAsc(mk(3), 0).length).toBe(3); // limit<=0 回落 500
    expect(sliceRecentAsc(mk(3), 2).length).toBe(2);
  });

  test('截尾口径与 FIFO 配对一致：配对只用窗口内流水（最旧 lot 不参与）', () => {
    // 6 笔远古买入（成本 1000/笔）+ 最近买 100@100 + 卖 100@120
    const txs = [
      ...Array.from({ length: 6 }, (_, i) => ({ id: 'old' + i, symbol: 'A', side: 'buy', quantity: 100, price: 10, turnover: 1000, createdAt: i })),
      { id: 'b', symbol: 'A', side: 'buy', quantity: 100, price: 100, turnover: 10000, createdAt: 100 },
      { id: 's', symbol: 'A', side: 'sell', quantity: 100, price: 120, turnover: 12000, createdAt: 101 },
    ];
    const all = pairedMetrics(txs); // FIFO 吃最旧 lot（成本 1000）→ 盈亏 11000（虚高，含早已不相关的建仓）
    const recent = pairedMetrics(sliceRecentAsc(txs, 2)); // 只剩最近买/卖 → 盈亏 2000（真实近期绩效）
    expect(all.grossWin).toBe(11000);
    expect(recent.grossWin).toBe(2000);
    expect(recent.pairedTrades).toBe(1);
  });

  test('account.service 已切到 sliceRecentAsc（防回退到 take:500 取最旧）', () => {
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'dist', 'src', 'modules', 'account', 'account.service.js'), 'utf8');
    expect(src).toContain('sliceRecentAsc');
    expect(src).not.toMatch(/take:\s*500/);
  });
});

describe('Phase F orders 挂单扫描索引（TypeORM 元数据，synchronize 首启落库）', () => {
  const { getMetadataArgsStorage } = require('typeorm');
  const { Order } = require('../dist/src/infrastructure/database/entities/order.entity');
  const storage = getMetadataArgsStorage();
  const idxOf = (target, columns) => storage.indices.find((i) =>
    i.target === target && JSON.stringify(i.columns) === JSON.stringify(columns));

  test('orders 有 (status, type) 复合索引（checkPendingOrders 等值+枚举过滤）', () => {
    expect(idxOf(Order, ['status', 'type'])).toBeTruthy();
  });

  test('Phase D 的 (accountId, status) 索引保留（不互相替换）', () => {
    expect(idxOf(Order, ['accountId', 'status'])).toBeTruthy();
  });
});

describe('Phase F forceLiquidateMarginalAccounts 无负债裁剪（风控绝不漏检）', () => {
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
    const calls = { find: 0, findWheres: [], save: 0 };
    return {
      rows, calls,
      find: async (q) => {
        calls.find++;
        calls.findWheres.push(q?.where);
        // 模拟批量 In 预载失败（降级路径测试）
        if (opts.failInQuery && q?.where?.accountId && q.where.accountId._type === 'in')
          throw new Error('simulated batch failure');
        return rows.filter((r) => matchesWhere(r, q?.where));
      },
      findOne: async (q) => rows.find((r) => matchesWhere(r, q?.where)) || null,
      save: async (e) => {
        calls.save++;
        if (!e.id) e.id = 'auto-' + idc++;
        const i = rows.findIndex((r) => r.id === e.id);
        if (i >= 0) rows[i] = e; else rows.push(e);
        return e;
      },
      create: (obj) => obj,
    };
  }
  const acct = (id, o = {}) => ({ id, userId: 'U' + id, marketMode: 'CN', cash: 100000, leverage: 1, totalEquity: 100000, initialEquity: 100000, peakEquity: 100000, dayStartEquity: 100000, borrowed: 0, shortCollateral: 0, marginUsed: 0, totalTrades: 0, currentDay: 0, ...o });
  const pos = (accountId, symbol, longQty, longCost = 10) => ({ id: 'P' + accountId + symbol, accountId, symbol, longQty, longCost, shortQty: 0, shortCost: 0 });
  const buildEngine = (accounts, positions, opts = {}) => {
    const orderRepo = countingRepo([]);
    const accountRepo = countingRepo(accounts);
    const positionRepo = countingRepo(positions, opts);
    const engine = new TradingEngineService(orderRepo, accountRepo, positionRepo, countingRepo(), null);
    engine.prices.set('T1', 10);
    engine.volatilities.set('T1', 0.02);
    return { engine, orderRepo, accountRepo, positionRepo };
  };

  test('无负债账户不评估也不查持仓：批量 In 只含负债候选（AC2/AC3），AC1 有持仓也被跳过', async () => {
    const { engine, positionRepo, accountRepo } = buildEngine(
      [acct('AC1'), acct('AC2', { borrowed: 50000 }), acct('AC3', { cash: 1000, borrowed: 100000 })],
      [pos('AC1', 'T1', 500), pos('AC3', 'T1', 100)],
    );
    const liquidated = await engine.forceLiquidateMarginalAccounts();
    // 首个持仓查询即批量 In 预载，且不含无负债的 AC1
    expect(positionRepo.calls.findWheres[0].accountId._type).toBe('in');
    expect(positionRepo.calls.findWheres[0].accountId.value.map(String).sort()).toEqual(['AC2', 'AC3']);
    // AC2 保证金率 2.0 安全；AC3 0.01 爆仓
    expect(liquidated.map((l) => l.accountId)).toEqual(['AC3']);
    // AC1 现金/持仓未被触碰
    expect(accountRepo.rows.find((a) => a.id === 'AC1').cash).toBe(100000);
    expect(accountRepo.calls.save).toBe(1); // 只有 AC3 的强平回写
  });

  test('marginUsed 遗留口径纳入守卫：borrowed 为 0 但 marginUsed>0 的老账户仍进入评估', async () => {
    const { engine, positionRepo } = buildEngine(
      [acct('AC9', { cash: 1000, marginUsed: 100000, shortCollateral: 100000 })],
      [],
    );
    await engine.forceLiquidateMarginalAccounts();
    expect(positionRepo.calls.findWheres[0].accountId.value.map(String)).toEqual(['AC9']);
  });

  test('预载失败降级：批量 In 抛错仍退回逐账户查询，爆仓账户照常强平（不漏检）', async () => {
    const { engine, positionRepo } = buildEngine(
      [acct('AC3', { cash: 1000, borrowed: 100000 })],
      [pos('AC3', 'T1', 100)],
      { failInQuery: true },
    );
    const liquidated = await engine.forceLiquidateMarginalAccounts();
    expect(liquidated.map((l) => l.accountId)).toEqual(['AC3']);
    // 第 1 次 In 批量失败 → 后续逐账户 find（accountId 为字符串）成功
    expect(positionRepo.calls.findWheres[0].accountId._type).toBe('in');
    expect(typeof positionRepo.calls.findWheres[1].accountId).toBe('string');
  });

  test('checkMarginLevel 向后兼容：不传预载持仓仍走原查询（存量调用零改动）', async () => {
    const { engine, positionRepo } = buildEngine([], [pos('ACX', 'T1', 100)]);
    const r = await engine.checkMarginLevel(acct('ACX', { borrowed: 100000, cash: 1000 }), { T1: 10 });
    expect(r.action).toBe('liquidate');
    expect(positionRepo.calls.find).toBe(1);
  });

  test('优化前后判定输入等价（R6 风控门槛）：预载路径与逐账户查询路径的保证金判定逐点相同', async () => {
    const prices = { T1: 10 };
    const cases = [
      ['A', acct('A', { cash: 100000 }), []],
      ['B', acct('B', { cash: 130000, borrowed: 100000 }), []], // 1.30 → margin_call 边界
      ['C', acct('C', { cash: 1000, borrowed: 100000 }), [pos('C', 'T1', 100)]], // 爆仓
      ['D', acct('D', { cash: 200000, shortCollateral: 50000 }), [pos('D', 'T1', 0)]],
      ['E', acct('E', { cash: 50000, borrowed: 20000 }), [pos('E', 'T1', 1000)]], // 持仓估值参与权益
    ];
    const positionsMap = new Map(cases.map(([id, , posList]) => [id, posList]));
    for (const [, account, posList] of cases) {
      // 逐账户查询路径：持仓预置于 repo，checkMarginLevel 自行 find 出来
      const { engine: oldEngine } = buildEngine([account], posList);
      const oldWay = await oldEngine.checkMarginLevel(account, prices);
      // 批量预载路径：直接把同一份持仓作为第 3 参传入（forceLiquidateMarginalAccounts 的新路径）
      const { engine: newEngine } = buildEngine([account], posList);
      const newWay = await newEngine.checkMarginLevel(account, prices, positionsMap.get(account.id) || posList);
      expect(newWay.action).toBe(oldWay.action);
      expect(newWay.marginLevel).toBeCloseTo(oldWay.marginLevel, 10);
      expect(newWay.safe).toBe(oldWay.safe);
    }
  });
});
