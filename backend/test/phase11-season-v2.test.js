// Phase E 回归：seasonPoints 拆列 / 大赛 V2（类型轮换+赛程+档案+积分榜）
const fs = require('fs');
const path = require('path');
const { SeasonService } = require('../dist/src/modules/season/season.service');
const { RiskManagerService } = require('../dist/src/core/risk-manager/risk-manager.service');

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

describe('Phase E seasonPoints 拆列', () => {
  test('结算奖励记 seasonPoints，tierScore 不被污染', async () => {
    const { svc, entryRepo, accountRepo } = makeSeason(ACCOUNTS, { gameDay: 10 });
    await svc.enroll('U1');
    entryRepo.rows.push({ id: 'E4', seasonId: svc && (await svc.ensureSeason()).id, userId: 'U2', accountId: 'AC4', marketMode: 'CN', startEquity: 50000, startDay: 10, status: 'active' });
    for (const a of accountRepo.rows) {
      a.totalEquity = a.userId === 'U1' ? Number(a.totalEquity) * 1.1 : Number(a.totalEquity) * 1.2;
    }
    const r = await svc.settleSeason();
    expect(r.success).toBe(true);
    const u2 = accountRepo.rows.find((a) => a.id === 'AC4');
    expect(Number(u2.seasonPoints)).toBe(300);
    expect(Number(u2.tierScore)).toBe(0);
    const u1 = accountRepo.rows.find((a) => a.id === 'AC1');
    expect(Number(u1.seasonPoints)).toBe(200);
    expect(Number(u1.tierScore)).toBe(0);
  });

  test('跨届冠军累加 seasonPoints（300→600）', async () => {
    const { svc, seasonRepo, accountRepo } = makeSeason(ACCOUNTS, { gameDay: 10 });
    await svc.enroll('U1');
    for (const a of accountRepo.rows) a.totalEquity = Number(a.totalEquity) * 1.1;
    await svc.settleSeason(); // U1 冠军 +300
    seasonRepo.rows[0].status = 'settled';
    await svc.ensureSeason(); // 开新赛季
    await svc.enroll('U1');
    for (const a of accountRepo.rows) a.totalEquity = Number(a.totalEquity) * 1.05;
    await svc.settleSeason(); // U1 再冠军 +300
    const u1 = accountRepo.rows.find((a) => a.id === 'AC1');
    expect(Number(u1.seasonPoints)).toBe(600);
  });

  test('实体源码含 seasonPoints 列（防列被误删）', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/infrastructure/database/entities/account.entity.ts'), 'utf8');
    expect(src).toContain('"seasonPoints"');
    expect(src).toContain("'float'");
  });

  test('computeTier 不覆盖 seasonPoints（两列互不隐式互算）', () => {
    const rm = new RiskManagerService(null, null, null, null);
    const account = { initialEquity: 100000, totalEquity: 100000, peakEquity: 100000, totalTrades: 0, tierScore: 23, seasonPoints: 900 };
    rm.computeTier(account, { totalReturn: 0, maxDrawdown: 0, profitFactor: 0, winRate: 0, totalTrades: 0 });
    expect(account.tierScore).toBe(23); // 段位分被覆盖为公式输出
    expect(account.seasonPoints).toBe(900); // 赛季分不受段位结算影响
  });
});

describe('Phase E 大赛 V2：类型轮换与赛程', () => {
  test('轮换顺序 biweekly(10)→monthly(20)→weekly(5)（teams 定稿）', async () => {
    const { svc, seasonRepo } = makeSeason([]);
    const s1 = await svc.ensureSeason();
    expect(s1.seq).toBe(1);
    expect(s1.type).toBe('biweekly');
    expect(Number(s1.durationDays)).toBe(10);
    s1.status = 'settled';
    const s2 = await svc.ensureSeason();
    expect(s2.seq).toBe(2);
    expect(s2.type).toBe('monthly');
    expect(Number(s2.durationDays)).toBe(20);
    s2.status = 'settled';
    const s3 = await svc.ensureSeason();
    expect(s3.seq).toBe(3);
    expect(s3.type).toBe('weekly');
    expect(Number(s3.durationDays)).toBe(5);
  });

  test('schedule：running 赛季 + 合成未来届（startDay 相对偏移）', async () => {
    const { svc } = makeSeason([], {
      gameDay: 87,
      seasons: [{ id: 'S5', seq: 5, name: '第 5 赛季', type: 'monthly', status: 'running', anchorDay: JSON.stringify({ CN: 77, HK: 77, US: 77 }), durationDays: 20 }],
    });
    const r = await svc.schedule(3);
    expect(r.today.CN).toBe(87);
    expect(r.seasons[0]).toMatchObject({ seq: 5, type: 'monthly', status: 'running', startDay: 0, durationDays: 20, daysLeft: 10 });
    expect(r.seasons[1]).toMatchObject({ seq: 6, type: 'weekly', status: 'upcoming', startDay: 10, durationDays: 5 });
    expect(r.seasons[2]).toMatchObject({ seq: 7, type: 'biweekly', status: 'upcoming', startDay: 15, durationDays: 10 });
  });

  test('schedule：enrolling 未开赛 → daysLeft null，后续合成行从期长起算', async () => {
    const { svc } = makeSeason([], {
      seasons: [{ id: 'S1', seq: 1, name: '第 1 赛季', type: 'biweekly', status: 'enrolling', anchorDay: '{}', durationDays: 10 }],
    });
    const r = await svc.schedule(2);
    expect(r.seasons[0]).toMatchObject({ seq: 1, type: 'biweekly', status: 'enrolling', daysLeft: null });
    expect(r.seasons[1]).toMatchObject({ seq: 2, type: 'monthly', status: 'upcoming', startDay: 10 });
  });

  test('schedule：count 钳制 1~100（缺省 6）', async () => {
    const { svc } = makeSeason([]);
    const r = await svc.schedule(1000);
    expect(r.seasons.length).toBe(100);
    const r2 = await svc.schedule(-3);
    expect(r2.seasons.length).toBe(6);
  });
});

describe('Phase E 大赛 V2：档案与积分榜', () => {
  function settledEntries(seasonId) {
    return [
      { id: 'E1', seasonId, userId: 'U1', accountId: 'AC1', marketMode: 'CN', startEquity: 100000, finalEquity: 110000, finalReturn: 0.1, finalRank: 2, status: 'settled' },
      { id: 'E2', seasonId, userId: 'U1', accountId: 'AC2', marketMode: 'HK', startEquity: 100000, finalEquity: 110000, finalReturn: 0.1, finalRank: 2, status: 'settled' },
      { id: 'E3', seasonId, userId: 'U1', accountId: 'AC3', marketMode: 'US', startEquity: 100000, finalEquity: 110000, finalReturn: 0.1, finalRank: 2, status: 'settled' },
      { id: 'E4', seasonId, userId: 'U2', accountId: 'AC4', marketMode: 'CN', startEquity: 50000, finalEquity: 60000, finalReturn: 0.2, finalRank: 1, status: 'settled' },
    ];
  }
  const SETTLED = { id: 'S1', seq: 1, name: '第 1 赛季', type: 'biweekly', status: 'settled', settledAt: new Date('2026-09-01') };

  test('archive：已结算赛季取到我的成绩/奖牌/两点曲线/分市场明细', async () => {
    const { svc } = makeSeason([], { seasons: [SETTLED], entries: settledEntries('S1') });
    const r = await svc.archive('S1', 'U1');
    expect(r.success).toBe(true);
    expect(r.season.type).toBe('biweekly');
    expect(r.season.champion.userId).toBe('U2');
    expect(r.mine.rank).toBe(2);
    expect(r.mine.ret).toBeCloseTo(10, 2);
    expect(r.mine.medal).toBe('silver');
    expect(r.mine.points).toBe(200);
    expect(r.mine.curve).toEqual([{ point: '报名', equity: 300000 }, { point: '结算', equity: 330000 }]);
    expect(r.mine.entries.length).toBe(3);
    expect(r.championCurve.userId).toBe('U2');
  });

  test('archive：未结算/不存在 → success:false', async () => {
    const { svc } = makeSeason([], { seasons: [{ id: 'S1', seq: 1, name: '第 1 赛季', status: 'running' }] });
    const r = await svc.archive('S1', 'U1');
    expect(r.success).toBe(false);
    expect(r.error).toContain('未结算');
    const r2 = await svc.archive('SX', 'U1');
    expect(r2.success).toBe(false);
  });

  test('archive：未报名用户 mine:null 仍可看档案结构', async () => {
    const { svc } = makeSeason([], { seasons: [SETTLED], entries: settledEntries('S1') });
    const r = await svc.archive('S1', 'U9');
    expect(r.success).toBe(true);
    expect(r.mine).toBeNull();
    expect(r.season.champion.userId).toBe('U2');
  });

  test('points：用户级 max 口径（三账户 900 计 1 次非 2700）+ 连续夺冠推导', async () => {
    const entries = [
      ...settledEntries('S3').map((e) => ({ ...e, id: e.id + '-s3', seasonId: 'S3' })),
      ...settledEntries('S2').map((e) => ({ ...e, id: e.id + '-s2', seasonId: 'S2' })),
      ...settledEntries('S1').map((e) => ({ ...e, id: e.id + '-s1', seasonId: 'S1' })),
    ];
    const seasons = [
      { id: 'S3', seq: 3, name: '第 3 赛季', status: 'settled' },
      { id: 'S2', seq: 2, name: '第 2 赛季', status: 'settled' },
      { id: 'S1', seq: 1, name: '第 1 赛季', status: 'settled' },
    ];
    // U1 三市场账户各 900（V1 同额累加语义）；U2 单账户 200
    const accounts = [
      { id: 'AC1', userId: 'U1', seasonPoints: 900 },
      { id: 'AC2', userId: 'U1', seasonPoints: 900 },
      { id: 'AC3', userId: 'U1', seasonPoints: 900 },
      { id: 'AC4', userId: 'U2', seasonPoints: 200 },
    ];
    const { svc } = makeSeason(accounts, { seasons, entries });
    const r = await svc.points(10);
    expect(r[0]).toMatchObject({ rank: 1, userId: 'U1', points: 900, consecutiveWins: 0 }); // max 口径：900 而非 2700；U1 三届皆亚军 → 0 连冠
    expect(r[1]).toMatchObject({ rank: 2, userId: 'U2', points: 200, consecutiveWins: 3 }); // U2 三届连冠
  });

  test('points：积分相同按连续夺冠数排序；limit 钳制', async () => {
    const entries = settledEntries('S1').map((e) => ({ ...e, id: e.id + '-s1' }));
    const accounts = [
      { id: 'AC1', userId: 'U1', seasonPoints: 0 },
      { id: 'AC4', userId: 'U2', seasonPoints: 0 },
    ];
    const { svc } = makeSeason(accounts, { seasons: [SETTLED], entries });
    const r = await svc.points(1000);
    expect(r.length).toBe(2);
    expect(r[0].userId).toBe('U2'); // 同 0 分，连冠 1 者在前
  });
});
