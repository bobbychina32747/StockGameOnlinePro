// Phase C 回归：红利税二档 / 指数市值加权与新股阶梯 / 基金费率档位 / 赛季报名结算与防作弊
const { dividendTaxRate } = require('../dist/src/common/constants');
const { cnPriceLimits } = require('../dist/src/common/market-utils');
const { FundService } = require('../dist/src/modules/fund/fund.service');
const { SeasonService } = require('../dist/src/modules/season/season.service');

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
    delete: async (id) => {
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
    },
  };
}

describe('Phase C 红利税二档制（teams 定稿）', () => {
  test('CN：持有 0-7 日 20%、8 日及以上 0%', () => {
    expect(dividendTaxRate('CN', 0)).toBe(0.2);
    expect(dividendTaxRate('CN', 7)).toBe(0.2);
    expect(dividendTaxRate('CN', 8)).toBe(0);
    expect(dividendTaxRate('CN', 100)).toBe(0);
  });
  test('HK 统一 20%、US 统一 30%（与持有期无关）', () => {
    expect(dividendTaxRate('HK', 0)).toBe(0.2);
    expect(dividendTaxRate('HK', 365)).toBe(0.2);
    expect(dividendTaxRate('US', 0)).toBe(0.3);
    expect(dividendTaxRate('US', 365)).toBe(0.3);
  });
});

describe('Phase C 基金费率模型', () => {
  function makeFund(over = {}) {
    const accountRepo = fakeRepo([{ id: 'AC1', userId: 'U1', marketMode: 'CN', cash: 100000 }]);
    const holdingRepo = fakeRepo(over.holding ? [over.holding] : []);
    const engine = { runExclusive: (fn) => fn() };
    const marketData = { gameDay: over.gameDay ?? 0 };
    const seasonService = { isBlocked: async () => false };
    const svc = new FundService(accountRepo, holdingRepo, engine, marketData, seasonService);
    return { svc, accountRepo, holdingRepo };
  }
  test('申购费：ETF 0.15%（份额按扣费后净额计算）', async () => {
    const { svc, holdingRepo } = makeFund();
    const r = await svc.subscribe('U1', 'CN', 'fund-1', 1000);
    expect(r.success).toBe(true);
    expect(r.fee).toBeCloseTo(1.5, 2);
    const h = holdingRepo.rows.find((x) => x.fundId === 'fund-1');
    expect(Number(h.shares)).toBeCloseTo((1000 - 1.5) / 4.5, 4);
    expect(Number(h.firstBuyDay)).toBe(0);
  });
  test('赎回费档位：<7日 1.5%、7-30日 0.5%、≥30日 0', async () => {
    // <7 日
    const a = makeFund({ gameDay: 5, holding: { userId: 'U1', marketMode: 'CN', fundId: 'fund-2', shares: 100, totalInvested: 100, firstBuyDay: 0 } });
    const r1 = await a.svc.redeem('U1', 'CN', 'fund-2', 100);
    expect(r1.feeRate).toBe(0.015);
    expect(Number(r1.amount)).toBeCloseTo(100 * 1.0 * 0.985, 2);
    // 7-30 日
    const b = makeFund({ gameDay: 30, holding: { userId: 'U1', marketMode: 'CN', fundId: 'fund-2', shares: 100, totalInvested: 100, firstBuyDay: 10 } });
    const r2 = await b.svc.redeem('U1', 'CN', 'fund-2', 100);
    expect(r2.feeRate).toBe(0.005);
    // ≥30 日
    const c = makeFund({ gameDay: 100, holding: { userId: 'U1', marketMode: 'CN', fundId: 'fund-2', shares: 100, totalInvested: 100, firstBuyDay: 50 } });
    const r3 = await c.svc.redeem('U1', 'CN', 'fund-2', 100);
    expect(r3.feeRate).toBe(0);
    expect(Number(r3.amount)).toBeCloseTo(100, 2);
  });
  test('赛季中申购/赎回被拒', async () => {
    const { svc } = makeFund();
    svc.seasonService = { isBlocked: async () => true };
    const r1 = await svc.subscribe('U1', 'CN', 'fund-1', 100);
    const r2 = await svc.redeem('U1', 'CN', 'fund-1', 1);
    expect(r1.success).toBe(false);
    expect(r1.error).toContain('赛季');
    expect(r2.success).toBe(false);
    expect(r2.error).toContain('赛季');
  });
});

describe('Phase C 模拟大赛 V1', () => {
  function makeSeason(accounts, over = {}) {
    const seasonRepo = fakeRepo(over.seasons || []);
    const entryRepo = fakeRepo(over.entries || []);
    const accountRepo = fakeRepo(accounts);
    const md = { gameDay: over.gameDay ?? 0 };
    const svc = new SeasonService(seasonRepo, entryRepo, accountRepo, md, { gameDay: over.hkDay ?? 0 }, { gameDay: over.usDay ?? 0 });
    return { svc, seasonRepo, entryRepo, accountRepo };
  }
  const accounts = [
    { id: 'AC1', userId: 'U1', marketMode: 'CN', totalEquity: 100000, currentDay: 10, tierScore: 0 },
    { id: 'AC2', userId: 'U1', marketMode: 'HK', totalEquity: 100000, currentDay: 10, tierScore: 0 },
    { id: 'AC3', userId: 'U1', marketMode: 'US', totalEquity: 100000, currentDay: 10, tierScore: 0 },
    { id: 'AC4', userId: 'U2', marketMode: 'CN', totalEquity: 50000, currentDay: 10, tierScore: 0 },
  ];
  test('首个报名者开赛：三市场账户各建报名（幂等），anchorDay 定格', async () => {
    const { svc, seasonRepo, entryRepo } = makeSeason(accounts, { gameDay: 10 });
    const r1 = await svc.enroll('U1');
    expect(r1.success).toBe(true);
    expect(r1.created).toBe(3);
    expect(seasonRepo.rows[0].status).toBe('running');
    expect(JSON.parse(seasonRepo.rows[0].anchorDay).CN).toBe(10);
    // 开赛后重复报名被拒（幂等口径：报名窗口随开赛关闭）
    const r2 = await svc.enroll('U1');
    expect(r2.success).toBe(false);
    expect(r2.error).toContain('截止');
    expect(entryRepo.rows.length).toBe(3);
    // 开赛后他人不可报名
    const r3 = await svc.enroll('U2');
    expect(r3.success).toBe(false);
    expect(r3.error).toContain('截止');
  });
  test('榜单按快照净值合成收益率排序（本金差异免疫）', async () => {
    const { svc, seasonRepo, entryRepo, accountRepo } = makeSeason(accounts, { gameDay: 10 });
    await svc.enroll('U1');
    // U2 手动补报名（模拟开赛前报名）
    entryRepo.rows.push({ id: 'E4', seasonId: seasonRepo.rows[0].id, userId: 'U2', accountId: 'AC4', marketMode: 'CN', startEquity: 50000, startDay: 10, status: 'active' });
    // U1 赚 10%（每账户 +10%），U2 赚 20%
    for (const a of accountRepo.rows) {
      a.totalEquity = a.userId === 'U1' ? Number(a.totalEquity) * 1.1 : Number(a.totalEquity) * 1.2;
    }
    const board = await svc.leaderboard(seasonRepo.rows[0].id, 'ALL', 10);
    expect(board[0].userId).toBe('U2'); // U2 +20% 排名第一
    expect(Number(board[0].seasonReturn)).toBeCloseTo(20, 1);
    expect(Number(board[1].seasonReturn)).toBeCloseTo(10, 1);
  });
  test('结算：固化收益与排名、前三 seasonPoints 奖励、幂等', async () => {
    const { svc, seasonRepo, entryRepo, accountRepo } = makeSeason(accounts, { gameDay: 10 });
    await svc.enroll('U1');
    entryRepo.rows.push({ id: 'E4', seasonId: seasonRepo.rows[0].id, userId: 'U2', accountId: 'AC4', marketMode: 'CN', startEquity: 50000, startDay: 10, status: 'active' });
    for (const a of accountRepo.rows) {
      a.totalEquity = a.userId === 'U1' ? Number(a.totalEquity) * 1.1 : Number(a.totalEquity) * 1.2;
    }
    const r = await svc.settleSeason();
    expect(r.success).toBe(true);
    expect(r.top3.length).toBe(2);
    expect(r.top3[0].userId).toBe('U2');
    expect(seasonRepo.rows[0].status).toBe('settled');
    expect(entryRepo.rows.every((e) => e.status === 'settled' && e.finalReturn !== undefined)).toBe(true);
    const u2 = accountRepo.rows.find((a) => a.id === 'AC4');
    expect(Number(u2.seasonPoints)).toBe(300); // 冠军奖励（Phase E 拆列后记 seasonPoints）
    expect(Number(u2.tierScore)).toBe(0); // 段位分不被赛季奖励污染
    const u1 = accountRepo.rows.find((a) => a.id === 'AC1');
    expect(Number(u1.seasonPoints)).toBe(200);
    expect(Number(u1.tierScore)).toBe(0);
    // 幂等：无 RUNNING 赛季再结算
    const r2 = await svc.settleSeason();
    expect(r2.success).toBe(false);
  });
  test('赛季中 isBlocked：已报名用户为 true，未报名为 false', async () => {
    const { svc } = makeSeason(accounts, { gameDay: 10 });
    await svc.enroll('U1');
    expect(await svc.isBlocked('U1')).toBe(true);
    expect(await svc.isBlocked('U9')).toBe(false);
  });
  test('按时钟结算：任一市场 gameDay 跑满时长自动结算并开新赛季', async () => {
    const { svc, seasonRepo } = makeSeason(accounts, { gameDay: 10 });
    await svc.enroll('U1');
    svc.marketData.gameDay = 21; // CN 跑满 10 游戏日
    const r = await svc.maybeSettleByClock();
    expect(r).not.toBeNull();
    expect(seasonRepo.rows[0].status).toBe('settled');
    expect(seasonRepo.rows[1].status).toBe('enrolling'); // 自动开新赛季
  });
});

describe('Phase C 涨跌停工具（Phase B 补充回归）', () => {
  test('cnPriceLimits 常规与新股首日', () => {
    expect(cnPriceLimits(100, false)).toEqual({ up: 110, down: 90 });
    const first = cnPriceLimits(10, true);
    expect(first.up).toBeCloseTo(14.4, 6);
    expect(first.down).toBeCloseTo(6.4, 6);
  });
});
