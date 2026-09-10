// Phase 13 回归：WS 在线计数只认已认证连接 / 日终重放幂等 / 流水预载失败不刷段位 / 净值除零与 NaN 兜底
const { JwtService } = require('@nestjs/jwt');
const { MarketGateway } = require('../dist/src/modules/market/market.gateway');
const { RiskManagerService } = require('../dist/src/core/risk-manager/risk-manager.service');
const { RISK } = require('../dist/src/common/constants');

describe('Phase 13 WS 在线人数计数（P1：认证失败连接不得影响 clients）', () => {
  const jwtSvc = new JwtService({ secret: 'phase13-test-secret-0123456789' });
  const token = jwtSvc.sign({ sub: 'u1', username: 'bob', role: 'user' });
  function fakeClient(id, t = token) {
    return { id, handshake: { auth: { token: t } }, data: {}, disconnect: jest.fn() };
  }
  const activeUserRepo = () => ({ findOne: async () => ({ id: 'u1', isActive: true }) });

  test('1 合法 + 1 坏 token：被拒连接断连后 clients 仍为 1（原实现被扣回 0）', async () => {
    const gw = new MarketGateway(jwtSvc, activeUserRepo());
    const good = fakeClient('c-good');
    const bad = fakeClient('c-bad', 'bad-token');
    await gw.handleConnection(good);
    expect(gw.clients).toBe(1);
    await gw.handleConnection(bad);
    expect(bad.disconnect).toHaveBeenCalledWith(true);
    expect(gw.clients).toBe(1); // 认证失败不计数
    // 关键回归：被拒连接未计数，其 handleDisconnect 不得自减
    gw.handleDisconnect(bad);
    expect(gw.clients).toBe(1);
    // 合法连接断开才自减一次
    gw.handleDisconnect(good);
    expect(gw.clients).toBe(0);
  });

  test('缺 token / 用户被禁用：既不计数，断连后也不为负（clients 恒 0）', async () => {
    const gw = new MarketGateway(jwtSvc, { findOne: async () => ({ id: 'u1', isActive: false }) });
    const noToken = fakeClient('c-no-token', null);
    const banned = fakeClient('c-banned');
    await gw.handleConnection(noToken);
    await gw.handleConnection(banned);
    expect(gw.clients).toBe(0);
    gw.handleDisconnect(noToken);
    gw.handleDisconnect(banned);
    expect(gw.clients).toBe(0); // Math.max(0, ...) 兜底保留
  });

  test('已计数标记一次性：重复断连事件只扣减一次', async () => {
    const gw = new MarketGateway(jwtSvc, activeUserRepo());
    const good = fakeClient('c-good');
    await gw.handleConnection(good);
    expect(good.data.__counted).toBe(true);
    gw.handleDisconnect(good);
    expect(good.data.__counted).toBe(false);
    gw.handleDisconnect(good); // socket.io 重复触发兜底
    expect(gw.clients).toBe(0);
  });

  test('多连接累加：2 合法 + 1 坏 token，坏连接断连不影响在线数', async () => {
    const gw = new MarketGateway(jwtSvc, activeUserRepo());
    const g1 = fakeClient('c1');
    const g2 = fakeClient('c2');
    const bad = fakeClient('c3', 'bad-token');
    await gw.handleConnection(g1);
    await gw.handleConnection(g2);
    await gw.handleConnection(bad);
    gw.handleDisconnect(bad);
    expect(gw.clients).toBe(2);
    gw.handleDisconnect(g1);
    gw.handleDisconnect(g2);
    expect(gw.clients).toBe(0);
  });
});

describe('Phase 13 日终结算健壮性（重放幂等 / 预载降级 / 除零 / NaN 权益）', () => {
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
    const calls = { find: 0, save: 0, saves: [] };
    return {
      rows, calls,
      find: async (q) => {
        calls.find++;
        // onlyInQuery：只让批量 In 预载失败，逐账户降级查询仍可用（对齐现有降级测试口径）
        const isInQuery = !!(q?.where?.accountId && q.where.accountId._type === 'in');
        if (opts.failFind && (!opts.onlyInQuery || isInQuery)) throw new Error(opts.failFind);
        return rows.filter((r) => matchesWhere(r, q?.where));
      },
      findOne: async (q) => rows.find((r) => matchesWhere(r, q?.where)) || null,
      save: async (e) => {
        calls.save++;
        calls.saves.push(e);
        if (!e.id) e.id = 'auto-' + idc++;
        const i = rows.findIndex((r) => r.id === e.id);
        if (i >= 0) rows[i] = e; else rows.push(e);
        return e;
      },
      create: (obj) => obj,
    };
  }
  const mkAccount = (id, o = {}) => ({ id, userId: 'U' + id, marketMode: 'CN', cash: 100000, leverage: 1, totalEquity: 100000, initialEquity: 100000, peakEquity: 100000, dayStartEquity: 100000, borrowed: 0, shortCollateral: 0, totalTrades: 0, currentDay: 0, tier: '王者', tierScore: 95, ...o });
  function buildRM(accounts, opts = {}) {
    const accountRepo = countingRepo(accounts);
    const snapshotRepo = countingRepo([]);
    const positionRepo = countingRepo([], opts.positionFail ? { failFind: 'simulated positions preload failure', onlyInQuery: true } : {});
    const txRepo = countingRepo([], opts.txFail ? { failFind: opts.txFail } : {});
    const rm = new RiskManagerService(accountRepo, snapshotRepo, positionRepo, txRepo);
    rm.setMarketPrices({});
    return { rm, accountRepo, snapshotRepo, positionRepo, txRepo };
  }

  test('重放更早 day 直接跳过：不重复计息 / 不写快照 / currentDay 不回退 / 净值历史不追加乱序样本', async () => {
    const account = mkAccount('A1', { currentDay: 5, cash: 100000, borrowed: 50000 });
    const { rm, accountRepo, snapshotRepo } = buildRM([account]);
    const out = await rm.dailySettlement(account, 3);
    expect(out).toBe(account);
    expect(account.currentDay).toBe(5); // 不回退
    expect(account.cash).toBe(100000); // 未重复计息（利息基数 borrowed=50000 非 0）
    expect(accountRepo.calls.save).toBe(0);
    expect(snapshotRepo.calls.save).toBe(0);
    expect(rm.getEquityHistory('A1')).toEqual([]);
  });

  test('同日重放同样跳过（原 === 语义保留）', async () => {
    const account = mkAccount('A2', { currentDay: 5, cash: 100000, borrowed: 50000 });
    const { rm, accountRepo, snapshotRepo } = buildRM([account]);
    await rm.dailySettlement(account, 5);
    expect(account.currentDay).toBe(5);
    expect(account.cash).toBe(100000);
    expect(accountRepo.calls.save).toBe(0);
    expect(snapshotRepo.calls.save).toBe(0);
  });

  test('正常路径回归：首日 day=1（currentDay=0）照常结算且只计息一次，更晚的 day 继续推进', async () => {
    const account = mkAccount('A3', { currentDay: 0, cash: 100000, borrowed: 50000 });
    const interest = 50000 * RISK.marginInterestRate; // 0.0002 → 10
    const { rm, accountRepo, snapshotRepo } = buildRM([account]);
    await rm.dailySettlement(account, 1);
    expect(account.currentDay).toBe(1);
    expect(account.cash).toBeCloseTo(100000 - interest, 6); // 恰好计息一次
    expect(accountRepo.calls.save).toBe(1);
    expect(snapshotRepo.calls.save).toBe(1);
    expect(account.peakEquity).toBe(100000);
    expect(account.totalEquity).toBe(Math.round((100000 - interest) * 100) / 100 - 50000);
    expect(Number.isFinite(rm.getEquityHistory('A3')[0].return)).toBe(true);
    await rm.dailySettlement(account, 2); // >= 守卫不得挡住向前推进
    expect(account.currentDay).toBe(2);
    expect(account.cash).toBeCloseTo(100000 - interest * 2, 6);
    expect(accountRepo.calls.save).toBe(2);
    expect(snapshotRepo.calls.save).toBe(2);
    expect(Number.isFinite(account.peakEquity)).toBe(true);
  });

  test('流水预载失败：不重算段位、不因段位再 save（与正常路径 save 次数对照），其余日终结算照常', async () => {
    // 正常路径：结算 save 1 次 + 段位 save 1 次 = 2；0 流水口径 23 分白银（预载成功且确实无流水）
    const ok = buildRM([mkAccount('A5', { currentDay: 0 })]);
    const okMetrics = jest.spyOn(ok.rm, 'buildTierMetrics');
    const settledOk = await ok.rm.settleAllAccounts(1);
    expect(settledOk.length).toBe(1);
    expect(okMetrics).toHaveBeenCalledTimes(1);
    expect(ok.accountRepo.calls.save).toBe(2);
    expect(ok.snapshotRepo.calls.save).toBe(1);
    expect(ok.accountRepo.rows[0].tier).toBe('白银');
    expect(ok.accountRepo.rows[0].tierScore).toBe(23);

    // 预载失败：结算照常（save 1 + 快照 1），段位保持上一次的值（不被保底白银覆盖）
    const bad = buildRM([mkAccount('A6', { currentDay: 0 })], { txFail: 'simulated tx preload failure' });
    const badMetrics = jest.spyOn(bad.rm, 'buildTierMetrics');
    const errSpy = jest.spyOn(bad.rm.logger, 'error').mockImplementation(() => {});
    const settledBad = await bad.rm.settleAllAccounts(1);
    expect(settledBad.length).toBe(1);
    expect(badMetrics).not.toHaveBeenCalled(); // 不调用 computeTier 路径
    expect(bad.accountRepo.calls.save).toBe(1); // 只有结算那次，无段位 save
    expect(bad.snapshotRepo.calls.save).toBe(1);
    expect(bad.accountRepo.rows[0].tier).toBe('王者'); // 原值保持
    expect(bad.accountRepo.rows[0].tierScore).toBe(95);
    expect(bad.accountRepo.rows[0].currentDay).toBe(1); // 其余日终结算照常
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('本日段位保持不变（流水预载失败）'));
    errSpy.mockRestore();
  });

  test('initialEquity=0：日收益除零兜底为 0，内存历史与 daily_snapshots 均无 NaN/Infinity', async () => {
    const account = mkAccount('A7', { initialEquity: 0, cash: 500, totalEquity: 500, peakEquity: 0, dayStartEquity: 0, currentDay: 0 });
    const { rm, snapshotRepo } = buildRM([account]);
    await rm.dailySettlement(account, 1);
    const h = rm.getEquityHistory('A7');
    expect(h.length).toBe(1);
    expect(h[0].return).toBe(0);
    expect(Number.isFinite(h[0].return)).toBe(true);
    expect(snapshotRepo.calls.save).toBe(1);
    expect(snapshotRepo.calls.saves[0].dailyReturn).toBe(0);
    expect(Number.isFinite(snapshotRepo.calls.saves[0].equity)).toBe(true);
  });

  test('历史样本非有限（NaN）时落库前二次兜底为 0', async () => {
    const account = mkAccount('A8', { totalEquity: 1000, currentDay: 1 });
    const { rm, snapshotRepo } = buildRM([account]);
    rm.equityHistory.set('A8', [{ day: 1, equity: NaN, return: 0 }]);
    await rm.recordDailyEquity(account, 2);
    expect(snapshotRepo.calls.saves[0].dailyReturn).toBe(0);
    expect(rm.getEquityHistory('A8')[1].return).toBe(0);
  });

  test('totalEquity 非有限（P2）：dailySettlement 跳过保存与快照，peakEquity 保持原值并记 error', async () => {
    const account = mkAccount('A9', { currentDay: 0, cash: NaN });
    const { rm, accountRepo, snapshotRepo } = buildRM([account]);
    const errSpy = jest.spyOn(rm.logger, 'error').mockImplementation(() => {});
    const out = await rm.dailySettlement(account, 1);
    expect(out).toBe(account);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('totalEquity 非有限值'));
    expect(account.peakEquity).toBe(100000); // 未被 Math.max(peak, NaN) 污染
    expect(account.currentDay).toBe(0); // 不落库、不回退不推进
    expect(accountRepo.calls.save).toBe(0);
    expect(snapshotRepo.calls.save).toBe(0);
    expect(rm.getEquityHistory('A9')).toEqual([]);
    errSpy.mockRestore();
  });

  test('totalEquity 非有限（P2）：settleAllAccounts 中也不因段位回写（段位与权益保持原值）', async () => {
    const account = mkAccount('A10', { currentDay: 0, cash: NaN });
    const { rm, accountRepo, snapshotRepo } = buildRM([account]);
    const metricsSpy = jest.spyOn(rm, 'buildTierMetrics');
    const errSpy = jest.spyOn(rm.logger, 'error').mockImplementation(() => {});
    await rm.settleAllAccounts(1);
    expect(metricsSpy).not.toHaveBeenCalled();
    expect(accountRepo.calls.save).toBe(0);
    expect(snapshotRepo.calls.save).toBe(0);
    expect(accountRepo.rows[0].tier).toBe('王者');
    expect(accountRepo.rows[0].currentDay).toBe(0);
    expect(accountRepo.rows[0].peakEquity).toBe(100000);
    expect('__settleSkipped' in accountRepo.rows[0]).toBe(false); // 临时标记不残留
    errSpy.mockRestore();
  });

  test('结算与持仓预载双失败降级不互相影响：持仓退回逐账户查询、流水失败仅影响段位', async () => {
    const account = mkAccount('A11', { currentDay: 0 });
    const { rm, accountRepo, positionRepo } = buildRM([account], { positionFail: true, txFail: 'tx down' });
    const errSpy = jest.spyOn(rm.logger, 'error').mockImplementation(() => {});
    const warnSpy = jest.spyOn(rm.logger, 'warn').mockImplementation(() => {});
    const settled = await rm.settleAllAccounts(1);
    expect(settled.length).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('日终批量预载持仓失败'));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('本日段位保持不变（流水预载失败）'));
    // 持仓预载失败 → null → getPositionsValue 退回逐账户 find（共 2 次 find：批量抛错 + 逐账户）
    expect(positionRepo.calls.find).toBe(2);
    expect(accountRepo.calls.save).toBe(1);
    expect(account.currentDay).toBe(1);
    expect(account.cash).toBe(100000); // borrowed=0 → 本账户无息，结算数值不受降级影响
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
