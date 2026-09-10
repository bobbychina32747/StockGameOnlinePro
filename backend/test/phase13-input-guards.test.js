// Phase 13 回归：账户模块输入校验加固——角色预设/划转汇率表禁止走原型链，流水 limit 双向钳制
const { AccountService } = require('../dist/src/modules/account/account.service');
const { getFxRates, FX_TRANSFER_FEE_RATE } = require('../dist/src/common/constants');

describe('Phase 13 输入校验加固（account.service）', () => {
  function matchesWhere(r, where) {
    if (Array.isArray(where)) return where.some((w) => matchesWhere(r, w));
    return Object.entries(where || {}).every(([k, v]) => {
      if (v && typeof v === 'object' && v._type === 'in') return (v.value || []).map(String).includes(String(r[k]));
      return String(r[k]) === String(v);
    });
  }
  function fakeRepo(seed = []) {
    const rows = [...seed];
    const calls = { find: 0, findOne: 0, save: 0, lastQuery: null };
    return {
      rows, calls,
      find: async (q) => { calls.find++; calls.lastQuery = q; return rows.filter((r) => matchesWhere(r, q?.where)); },
      findOne: async (q) => { calls.findOne++; return rows.find((r) => matchesWhere(r, q?.where)) || null; },
      save: async (e) => {
        calls.save++;
        if (!e.id) e.id = 'auto-' + (rows.length + 1);
        const i = rows.findIndex((r) => r.id === e.id);
        if (i >= 0) rows[i] = e; else rows.push(e);
        return e;
      },
      create: (o) => o,
    };
  }
  function makeAccount(o = {}) {
    return {
      id: 'AC1', userId: 'U1', marketMode: 'US',
      cash: 100000, leverage: 1, totalEquity: 100000, peakEquity: 100000,
      initialEquity: 100000, dayStartEquity: 100000,
      dailyPnl: 1234, totalPnl: 5678, marginUsed: 100, shortCollateral: 50, borrowed: 200,
      lastResetDay: 0, currentDay: 3, resetCount: 2,
      ...o,
    };
  }
  function buildService(accounts = [], txs = []) {
    const accountRepo = fakeRepo(accounts);
    const positionRepo = fakeRepo();
    const transactionRepo = fakeRepo(txs);
    const fundHoldingRepo = fakeRepo();
    const orderRepo = fakeRepo();
    const resetAuditRepo = fakeRepo();
    const engine = { runExclusive: (fn) => fn() }; // 只需串行队列语义，行为等价 settleFill
    const config = { get: () => 'true' };
    const seasonService = { isBlocked: async () => false };
    const svc = new AccountService(
      accountRepo, positionRepo, transactionRepo, fundHoldingRepo, orderRepo,
      resetAuditRepo, {}, engine, config, fakeRepo(), seasonService,
    );
    return { svc, accountRepo, positionRepo, transactionRepo, fundHoldingRepo, orderRepo, resetAuditRepo };
  }
  const capture = async (p) => { try { await p; return null; } catch (e) { return e; } };

  describe('① 角色预设必须按自有键判定（原型链绕过 P1）', () => {
    test("preset='constructor' 被拒且账户字段未被写成 undefined/清零", async () => {
      const { svc, accountRepo } = buildService([makeAccount()]);
      const err = await capture(svc.resetAccount('U1', 'US', 'constructor'));
      expect(err).toBeTruthy();
      expect(err.getStatus()).toBe(400);
      expect(err.message).toBe('未知的角色预设');
      const acct = accountRepo.rows[0];
      for (const f of ['cash', 'leverage', 'totalEquity', 'peakEquity', 'initialEquity', 'dayStartEquity']) {
        expect(Number.isFinite(acct[f])).toBe(true); // 关键回归点：原实现会写成 undefined
      }
      expect([acct.cash, acct.leverage, acct.totalEquity]).toEqual([100000, 1, 100000]);
      // 盈亏/保证金/负债不被清零，重置计数与冷却不被推进，落库动作零发生
      expect([acct.dailyPnl, acct.totalPnl, acct.marginUsed, acct.shortCollateral, acct.borrowed]).toEqual([1234, 5678, 100, 50, 200]);
      expect([acct.resetCount, acct.lastResetDay]).toEqual([2, 0]);
      expect(accountRepo.calls.save).toBe(0);
    });

    test("'__proto__'/'toString'/'hasOwnProperty' 等原型链键全部被拒（参数化）", async () => {
      for (const bad of ['__proto__', 'toString', 'hasOwnProperty', 'valueOf', '未知角色', '', null, undefined]) {
        const { svc, accountRepo } = buildService([makeAccount()]);
        const err = await capture(svc.resetAccount('U1', 'US', bad));
        expect(err && err.getStatus()).toBe(400);
        expect(accountRepo.calls.save).toBe(0);
        expect(Number.isFinite(accountRepo.rows[0].cash)).toBe(true);
      }
    });

    test("合法路径不变：'散户' 重置为 100000/1 且审计落库 preset 正确", async () => {
      const { svc, accountRepo, resetAuditRepo } = buildService([makeAccount()]);
      const res = await svc.resetAccount('U1', 'US', '散户');
      expect(res.success).toBe(true);
      const acct = accountRepo.rows[0];
      expect([acct.cash, acct.leverage]).toEqual([100000, 1]);
      expect([acct.totalEquity, acct.peakEquity, acct.initialEquity, acct.dayStartEquity]).toEqual([100000, 100000, 100000, 100000]);
      expect([acct.dailyPnl, acct.totalPnl, acct.marginUsed, acct.shortCollateral, acct.borrowed]).toEqual([0, 0, 0, 0, 0]);
      expect([acct.resetCount, acct.lastResetDay]).toEqual([3, 3]);
      expect(resetAuditRepo.rows.length).toBe(1);
      expect(resetAuditRepo.rows[0].preset).toBe('散户');
      expect(resetAuditRepo.rows[0].prevEquity).toBe(100000);
    });

    test("合法路径不变：'机构'/'日内交易者' 数值保持 500000/2 与 200000/3", async () => {
      for (const [preset, cash, lev] of [['机构', 500000, 2], ['日内交易者', 200000, 3]]) {
        const { svc, accountRepo } = buildService([makeAccount()]);
        const res = await svc.resetAccount('U1', 'US', preset);
        expect(res.success).toBe(true);
        expect([accountRepo.rows[0].cash, accountRepo.rows[0].leverage]).toEqual([cash, lev]);
      }
    });
  });

  describe('② 划转汇率表禁止走原型链（市场白名单）', () => {
    test('非法 fromMode/toMode 直接 400（含 __proto__/constructor/小写/未知市场）', async () => {
      const cases = [
        ['__proto__', 'US'], ['constructor', 'US'], ['toString', 'US'],
        ['CN', '__proto__'], ['CN', 'constructor'], ['JP', 'US'], ['CN', 'cny'], ['cn', 'US'], ['US', 'us'],
      ];
      for (const [from, to] of cases) {
        const { svc, accountRepo } = buildService([makeAccount({ marketMode: 'CN', cash: 50000 }), makeAccount({ id: 'AC2' })]);
        const err = await capture(svc.transferCash('U1', from, to, 1000));
        expect(err && err.getStatus()).toBe(400);
        expect(accountRepo.calls.save).toBe(0); // 未触碰任何账户资金
      }
    });

    test('合法划转行为不变：CN→US 按实时汇率折算并收 0.1% 手续费', async () => {
      const cn = makeAccount({ id: 'AC1', marketMode: 'CN', cash: 50000 });
      const us = makeAccount({ id: 'AC2', marketMode: 'US', cash: 100000 });
      const { svc, accountRepo } = buildService([cn, us]);
      const fx = getFxRates();
      const res = await svc.transferCash('U1', 'CN', 'US', 10000);
      const expected = (10000 * fx.CN / fx.US) * (1 - FX_TRANSFER_FEE_RATE);
      expect(res.success).toBe(true);
      expect(res.received).toBeCloseTo(Number(expected.toFixed(2)), 2);
      const from = accountRepo.rows.find((a) => a.marketMode === 'CN');
      const to = accountRepo.rows.find((a) => a.marketMode === 'US');
      expect(from.cash).toBe(40000);
      expect(to.cash).toBeCloseTo(Number((100000 + Number(expected.toFixed(2))).toFixed(2)), 2);
    });

    test('返回结构不变：合法市场但转出账户不存在仍返回 success:false（不抛异常）', async () => {
      const { svc } = buildService([makeAccount({ id: 'AC2', marketMode: 'US' })]);
      const r = await svc.transferCash('U1', 'CN', 'US', 1000);
      expect(r).toEqual({ success: false, error: '转出账户不存在' });
    });

    test('返回结构不变：空市场/同市场仍走原有软失败（不进白名单抛错分支）', async () => {
      const { svc } = buildService([makeAccount()]);
      expect(await svc.transferCash('U1', '', 'US', 1000)).toEqual({ success: false, error: '划转市场必须不同（CN/HK/US）' });
      expect(await svc.transferCash('U1', 'CN', 'CN', 1000)).toEqual({ success: false, error: '划转市场必须不同（CN/HK/US）' });
    });
  });

  describe('③ 流水 limit 双向钳制（原 take=-1 = SQLite 无上限）', () => {
    test('limit=-1/0/9e9/abc/undefined/50 全部落在 [1,300] 且取值符合预期', async () => {
      const cases = [
        [-1, 1], ['-1', 1], [0, 100], ['abc', 100], [undefined, 100], [null, 100],
        [9e9, 300], [301, 300], [50, 50], [1, 1], [300, 300],
      ];
      for (const [limit, want] of cases) {
        const { svc, transactionRepo } = buildService([makeAccount()]);
        await svc.getTransactions('U1', 'US', limit);
        const take = transactionRepo.calls.lastQuery.take;
        expect(take).toBe(want);
        expect(take).toBeGreaterThanOrEqual(1);
        expect(take).toBeLessThanOrEqual(300);
      }
    });

    test('默认 100：不传 limit 时 take=100（上限 300 口径不变）', async () => {
      const { svc, transactionRepo } = buildService([makeAccount()]);
      await svc.getTransactions('U1', 'US');
      expect(transactionRepo.calls.lastQuery.take).toBe(100);
    });

    test('账户不存在时仍返回 []', async () => {
      const { svc } = buildService([]);
      expect(await svc.getTransactions('U1', 'US', -1)).toEqual([]);
    });
  });

  describe('④ 防回退源码锚点（dist 产物）', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'dist', 'src', 'modules', 'account', 'account.service.js'), 'utf8');

    test('预设判定走 hasOwnProperty（不再裸取 presets[preset] 作真值判据）', () => {
      expect(src).toContain('Object.prototype.hasOwnProperty.call(presets, preset)');
    });

    test('汇率取值前有白名单 hasOwnProperty 校验', () => {
      // 编译产物里常量是命名空间导入（constants_1.FX_CNY_PER_UNIT），故锚点带前缀
      expect(src).toContain('Object.prototype.hasOwnProperty.call(constants_1.FX_CNY_PER_UNIT, m)');
    });

    test('limit 先钳下界再钳上界', () => {
      expect(src).toContain('Math.min(Math.max(1, Number(limit) || 100), 300)');
      expect(src).not.toMatch(/take:\s*Math\.min\(Number\(limit\)/);
    });
  });
});
