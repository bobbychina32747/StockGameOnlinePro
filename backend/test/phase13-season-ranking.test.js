// Phase 13 回归：赛季结算幂等（重放不重复发分）/ ensureSeason 并发唯一约束兜底 / 排行榜 sort=equity
const { SeasonService } = require('../dist/src/modules/season/season.service');
const { RankingService } = require('../dist/src/modules/ranking/ranking.service');

// 与 phase9/phase11 同款手写 fake repo（支持 where 数组 = OR 语义，服务里多用它做 enrolling/running 双查）
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
function makeSeason(accounts, over = {}) {
  const seasonRepo = fakeRepo(over.seasons || []);
  const entryRepo = fakeRepo(over.entries || []);
  const accountRepo = fakeRepo((accounts || []).map((a) => ({ ...a }))); // 克隆：防跨用例共享对象残留
  const md = { gameDay: over.gameDay ?? 0 };
  const svc = new SeasonService(seasonRepo, entryRepo, accountRepo, md, { gameDay: over.hkDay ?? 0 }, { gameDay: over.usDay ?? 0 });
  return { svc, seasonRepo, entryRepo, accountRepo };
}
const ACCOUNTS = [
  { id: 'AC1', userId: 'U1', marketMode: 'CN', totalEquity: 100000, currentDay: 10, tierScore: 0, seasonPoints: 0 },
  { id: 'AC2', userId: 'U1', marketMode: 'HK', totalEquity: 100000, currentDay: 10, tierScore: 0, seasonPoints: 0 },
  { id: 'AC3', userId: 'U1', marketMode: 'US', totalEquity: 100000, currentDay: 10, tierScore: 0, seasonPoints: 0 },
  { id: 'AC4', userId: 'U2', marketMode: 'CN', totalEquity: 50000, currentDay: 10, tierScore: 0, seasonPoints: 0 },
];
const pointsOf = (accountRepo, id) => Number(accountRepo.rows.find((a) => a.id === id).seasonPoints);

// 公共铺场：U1 报三市场（+10%），U2 补一条 CN 报名（+20% → 冠军）
async function setupTwoUsers(seasonOver = {}) {
  const ctx = makeSeason(ACCOUNTS, { gameDay: 10, ...seasonOver });
  await ctx.svc.enroll('U1');
  ctx.entryRepo.rows.push({ id: 'E4', seasonId: ctx.seasonRepo.rows[0].id, userId: 'U2', accountId: 'AC4', marketMode: 'CN', startEquity: 50000, startDay: 10, status: 'active' });
  for (const a of ctx.accountRepo.rows) {
    a.totalEquity = a.userId === 'U1' ? Number(a.totalEquity) * 1.1 : Number(a.totalEquity) * 1.2;
  }
  return ctx;
}

describe('Phase 13 P1 赛季结算幂等（中断重放不重复发分）', () => {
  test('正常结算：前三发奖一次，rewarded 标记随 entry 一起落库', async () => {
    const { svc, entryRepo, accountRepo } = await setupTwoUsers();
    const r = await svc.settleSeason();
    expect(r.success).toBe(true);
    expect(pointsOf(accountRepo, 'AC4')).toBe(300); // 冠军
    expect(pointsOf(accountRepo, 'AC1')).toBe(200); // 亚军（三市场账户同额累加，用户级只计一次）
    expect(entryRepo.rows.filter((e) => e.userId === 'U2').every((e) => e.rewarded === true)).toBe(true);
    expect(entryRepo.rows.filter((e) => e.userId === 'U1').every((e) => e.rewarded === true)).toBe(true);
    expect(entryRepo.rows.every((e) => e.status === 'settled')).toBe(true);
  });

  test('重放同一 entry：season 未落 SETTLED 且 entry 仍 active → 累计只发 1 次奖励（rewarded 生效）', async () => {
    const { svc, seasonRepo, entryRepo, accountRepo } = await setupTwoUsers();
    await svc.settleSeason();
    // 模拟"发分已落库、season.status=SETTLED 那一步被打断"：赛季仍 RUNNING；entry 也回到重放时可被选中的状态
    seasonRepo.rows[0].status = 'running';
    entryRepo.rows.forEach((e) => { e.status = 'active'; });
    const r2 = await svc.settleSeason();
    expect(r2.success).toBe(true);
    expect(pointsOf(accountRepo, 'AC4')).toBe(300); // 300 而非 600
    expect(pointsOf(accountRepo, 'AC1')).toBe(200); // 200 而非 400
    expect(pointsOf(accountRepo, 'AC2')).toBe(200);
  });

  test('半成品重放（部分 entry 已 settled+rewarded，其余仍 active）→ 已发分的用户不重发、未发分的用户不丢发', async () => {
    const { svc, entryRepo, accountRepo } = await setupTwoUsers();
    // 手工构造崩溃现场：U1 的前两条 entry 已落库(status=settled,rewarded=true)且 U1 三账户已各发 200，
    // U2 那条还停在 active（冠军奖励尚未发出）；赛季状态仍是 running
    entryRepo.rows[0].status = 'settled'; entryRepo.rows[0].rewarded = true; entryRepo.rows[0].finalRank = 2;
    entryRepo.rows[1].status = 'settled'; entryRepo.rows[1].rewarded = true; entryRepo.rows[1].finalRank = 2;
    for (const a of accountRepo.rows) {
      if (a.userId === 'U1') a.seasonPoints = 200;
    }
    expect(entryRepo.rows.filter((e) => e.status === 'active').length).toBe(2); // U1 的第三条 + U2 那条
    const r = await svc.settleSeason();
    expect(r.success).toBe(true);
    expect(pointsOf(accountRepo, 'AC1')).toBe(200); // 已发分的用户不重发（旧实现会 +200 → 400）
    expect(pointsOf(accountRepo, 'AC3')).toBe(200);
    expect(pointsOf(accountRepo, 'AC4')).toBe(300); // 未发分的冠军照常补发（不丢发）
    const u1Leftover = entryRepo.rows[2]; // U1 仍 active 的那条（AC3）
    expect(u1Leftover.rewarded).toBe(true); // 同用户剩余 entry 补齐标记但不重复计分
    expect(u1Leftover.status).toBe('settled');
    expect(u1Leftover.finalRank).toBe(2); // 排名照旧固化
  });

  test('实体元数据含 rewarded 列且默认 false（防列被误删/改默认）', () => {
    const { getMetadataArgsStorage } = require('typeorm');
    const { SeasonEntry } = require('../dist/src/infrastructure/database/entities/season-entry.entity');
    const col = getMetadataArgsStorage().columns.find((c) => c.target === SeasonEntry && c.propertyName === 'rewarded');
    expect(col).toBeTruthy();
    expect(col.options.default).toBe(false);
  });
});

// 并发插入兜底用 repo：首次 save 抛唯一约束冲突，并模拟"对手那一届已提交"（行同时出现在表里）
function concurrentInsertRepo(seed, rivalRow) {
  const rows = [...seed];
  let saveCalls = 0;
  return {
    rows,
    get saveCalls() { return saveCalls; },
    find: async (q) => rows.filter((r) => matchesWhere(r, q?.where)),
    findOne: async (q) => rows.find((r) => matchesWhere(r, q?.where)) || null,
    create: (obj) => obj,
    save: async (e) => {
      saveCalls++;
      if (saveCalls === 1) {
        rows.push({ ...rivalRow });
        throw Object.assign(new Error('UNIQUE constraint failed: seasons.seq'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
      }
      if (!e.id) e.id = 'auto-' + saveCalls;
      const i = rows.findIndex((r) => r.id === e.id);
      if (i >= 0) rows[i] = e; else rows.push(e);
      return e;
    },
  };
}

describe('Phase 13 P2 ensureSeason 并发插入同 seq', () => {
  const RIVAL = { id: 'S1', seq: 1, name: '第 1 赛季', status: 'enrolling', anchorDay: '{}', type: 'biweekly', durationDays: 10 };

  test('撞唯一约束 → 重新查询并返回已存在的那一届（幂等同一对象，不抛 500）', async () => {
    const seasonRepo = concurrentInsertRepo([], RIVAL);
    const svc = new SeasonService(seasonRepo, fakeRepo([]), fakeRepo([]), { gameDay: 0 }, { gameDay: 0 }, { gameDay: 0 });
    const s1 = await svc.ensureSeason();
    expect(s1).toBeTruthy();
    expect(s1.id).toBe('S1');
    expect(Number(s1.seq)).toBe(1);
    expect(seasonRepo.saveCalls).toBe(1); // 只在冲突前尝试过 1 次插入
    // 第二次调用直接命中查询（insert 不再发生），并发双方拿到同一届
    const s2 = await svc.ensureSeason();
    expect(s2.id).toBe('S1');
    expect(seasonRepo.saveCalls).toBe(1);
    expect(seasonRepo.rows.filter((r) => Number(r.seq) === 1).length).toBe(1);
  });

  test('冲突后仍查不到那一届 → 保留原始错误（不静默返回空赛季）', async () => {
    const seasonRepo = concurrentInsertRepo([], RIVAL);
    seasonRepo.save = async () => { throw Object.assign(new Error('UNIQUE constraint failed: seasons.seq'), { code: 'SQLITE_CONSTRAINT_UNIQUE' }); };
    const svc = new SeasonService(seasonRepo, fakeRepo([]), fakeRepo([]), { gameDay: 0 }, { gameDay: 0 }, { gameDay: 0 });
    await expect(svc.ensureSeason()).rejects.toThrow('UNIQUE constraint failed');
  });

  test('非唯一约束错误（DB 忙/锁）原样抛出，不被兜底吞掉', async () => {
    const seasonRepo = fakeRepo([]);
    seasonRepo.save = async () => { throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }); };
    const svc = new SeasonService(seasonRepo, fakeRepo([]), fakeRepo([]), { gameDay: 0 }, { gameDay: 0 }, { gameDay: 0 });
    await expect(svc.ensureSeason()).rejects.toThrow('database is locked');
  });
});

describe('Phase 13 P1 排行榜 sort=equity 生效', () => {
  // 总权益与总收益率顺序刻意相反：U1 高权益低收益率、U2 低权益高收益率
  const RANK_ACCOUNTS = [
    { id: 'AC1', userId: 'U1', marketMode: 'CN', tier: '白银', initialEquity: 1000000, totalEquity: 1100000, dayStartEquity: 1000000, user: { username: 'alice' } },
    { id: 'AC2', userId: 'U2', marketMode: 'CN', tier: '青铜', initialEquity: 100000, totalEquity: 200000, dayStartEquity: 100000, user: { username: 'bob' } },
  ];
  async function makeRanking(accounts = RANK_ACCOUNTS) {
    const accountRepo = fakeRepo(accounts);
    const svc = new RankingService(accountRepo, fakeRepo([]));
    await svc.calculateRankings();
    return { svc, accountRepo };
  }

  test('sort=equity 真按 totalEquity 降序（不再是 totalReturn 顺序）', async () => {
    const { svc } = await makeRanking();
    const byEquity = svc.getRankings(20, 'equity', 'ALL');
    expect(byEquity.length).toBe(2);
    expect(byEquity[0].totalEquity).toBe(1100000); // 旧实现取 key 'equity' → 比较恒 0，首位会是被 totalReturn 序顶上去的 U2
    expect(byEquity[0].totalReturn).toBeCloseTo(0.1, 6);
    expect(byEquity[1].totalEquity).toBe(200000);
    expect(byEquity[1].totalReturn).toBeCloseTo(1, 6);
    expect(byEquity.some((e) => e.userId !== undefined)).toBe(false); // 对外输出仍剔除内部标识
  });

  test('默认与 sort=totalReturn 行为不变（按总收益率降序）', async () => {
    const { svc } = await makeRanking();
    const def = svc.getRankings(20);
    expect(def[0].totalReturn).toBeCloseTo(1, 6); // U2 翻倍居首
    expect(def[1].totalReturn).toBeCloseTo(0.1, 6);
    const byReturn = svc.getRankings(20, 'totalReturn', 'ALL');
    expect(byReturn.map((e) => e.totalEquity)).toEqual(def.map((e) => e.totalEquity));
    // dayReturn 分支同样不受影响（U2 今日 +100% > U1 +10%）
    const byDay = svc.getRankings(20, 'dayReturn', 'ALL');
    expect(byDay[0].totalEquity).toBe(200000);
  });
});
