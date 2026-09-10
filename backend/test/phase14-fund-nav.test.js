// Phase 14 P0 修复回归：基金 NAV 持久化（重启后净值复位 → 持仓市值凭空缩水）。
// 缺陷现场：NAV 只活在内存（硬编码初值 4.5 / 1.0），60s 定时器只涨不跌地演化；进程重启后 NAV 回到初值，
// 而用户份额仍留在 fund_holdings —— 重启前累计的涨幅被一次性抹掉：已涨到 5.2 的基金重启后回落 4.5，
// 100 份持仓市值 520 → 450（不可逆地少 70，只能等后续周期慢慢涨回来）。
const { FundService } = require('../dist/src/modules/fund/fund.service');
const { FundNav } = require('../dist/src/infrastructure/database/entities/fund-nav.entity');

function matchesWhere(r, where) {
  if (Array.isArray(where)) return where.some((w) => matchesWhere(r, w));
  return Object.entries(where || {}).every(([k, v]) => String(r[k]) === String(v));
}
// 参考 phase13-fund-safety 的 countingRepo：账户/持仓 repo 只需存在（本批次断言集中在净值表）
function countingRepo(seed = []) {
  const rows = [...seed];
  let idc = 1;
  const calls = { findOne: 0, save: 0, delete: 0 };
  return {
    rows, calls,
    find: async (q) => rows.filter((r) => matchesWhere(r, q?.where)),
    findOne: async (q) => {
      calls.findOne++;
      return rows.find((r) => matchesWhere(r, q?.where)) || null;
    },
    save: async (e) => {
      calls.save++;
      if (!e.id) e.id = 'auto-' + idc++;
      const i = rows.findIndex((r) => r.id === e.id);
      if (i >= 0) rows[i] = e; else rows.push(e);
      return e;
    },
    create: (obj) => obj,
    delete: async (id) => {
      calls.delete++;
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
    },
  };
}
// fund_navs fake repo：以 fundId 为主键 → save 语义 = upsert（命中主键即更新，不新增行），
// 并可注入 find/save 异常，用来覆盖「读失败不阻塞启动」「落库失败不阻塞行情」两条降级路径
function navRepo(seed = [], opts = {}) {
  const rows = seed.map((r) => ({ ...r }));
  const calls = { find: 0, save: 0 };
  let findError = opts.findError || null;
  let saveError = opts.saveError || null;
  return {
    rows, calls,
    setFindError: (e) => { findError = e; },
    setSaveError: (e) => { saveError = e; },
    find: async () => {
      calls.find++;
      if (findError) throw findError;
      return rows.map((r) => ({ ...r }));
    },
    save: async (e) => {
      calls.save++;
      if (saveError) throw saveError;
      const i = rows.findIndex((r) => r.fundId === e.fundId);
      const next = { ...e, updatedAt: new Date() }; // 模拟 @UpdateDateColumn
      if (i >= 0) rows[i] = { ...rows[i], ...next }; else rows.push(next);
      return next;
    },
  };
}
// 组装被测服务：navSeed = 「库里已有的净值行」；withNavRepo=false 复现既有 5 参构造（未注入 repo）
function makeSvc({ navSeed = [], withNavRepo = true, findError = null, saveError = null, gameDay = 0 } = {}) {
  const accountRepo = countingRepo([{ id: 'AC1', userId: 'U1', marketMode: 'CN', cash: 100000 }]);
  const holdingRepo = countingRepo([]);
  const engine = { runExclusive: (fn) => fn() };
  const marketData = { gameDay };
  const seasonService = { isBlocked: async () => false };
  const nr = navRepo(navSeed, { findError, saveError });
  const svc = withNavRepo
    ? new FundService(accountRepo, holdingRepo, engine, marketData, seasonService, undefined, nr)
    : new FundService(accountRepo, holdingRepo, engine, marketData, seasonService);
  const warns = [];
  const errors = [];
  // 参考 phase13-ai-ledger：直接替换实例上的 logger 方法收集日志（不依赖原型可写性）
  svc.logger.warn = (m) => warns.push(String(m));
  svc.logger.error = (m) => errors.push(String(m));
  return { svc, nr, warns, errors, accountRepo, holdingRepo };
}
const rowOf = (nr, fundId) => nr.rows.find((r) => r.fundId === fundId);
const navOf = (svc, fundId) => svc.getFund(fundId).nav;

describe('Phase 14 基金净值表结构（fund_navs，synchronize 首启建表）', () => {
  const { getMetadataArgsStorage } = require('typeorm');
  const storage = getMetadataArgsStorage();
  const colOf = (propertyName) => storage.columns.find((c) => c.target === FundNav && c.propertyName === propertyName);

  test('表名 fund_navs；fundId 为主键（一只基金一行，save 即幂等 upsert）', () => {
    const table = storage.tables.find((t) => t.target === FundNav);
    expect(table).toBeTruthy();
    expect(table.name).toBe('fund_navs');
    expect(colOf('fundId').options.primary).toBe(true);
    expect(colOf('fundId').mode).toBe('regular'); // 普通列 + primary 标记（类型按属性 String 推断）
  });

  test('nav 为 float 列、updatedAt 为自动更新列（审计用）', () => {
    expect(colOf('nav').options.type).toBe('float');
    expect(colOf('updatedAt').mode).toBe('updateDate');
  });

  test('fund.module 已把 FundNav 注册进 TypeOrmModule.forFeature（autoLoadEntities 才会建表）', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'dist', 'src', 'modules', 'fund', 'fund.module.js'), 'utf8');
    expect(src).toMatch(/forFeature\(\[[\s\S]*?FundNav[\s\S]*?\]\)/);
  });
});

describe('Phase 14 启动回填（onModuleInit：库值 → 内存 NAV）', () => {
  test('① 首启（fund_navs 空表）：用内存初值插入一次基线（fund-1=4.5 / fund-2=1.0），内存值不变', async () => {
    const { svc, nr } = makeSvc();
    await svc.onModuleInit();
    expect(nr.calls.find).toBe(1);
    expect(nr.rows.length).toBe(2);
    expect(rowOf(nr, 'fund-1').nav).toBe(4.5);
    expect(rowOf(nr, 'fund-2').nav).toBe(1.0);
    expect(rowOf(nr, 'fund-1').updatedAt).toBeInstanceOf(Date); // 落了时间戳，便于排查
    expect(navOf(svc, 'fund-1')).toBe(4.5);
    expect(navOf(svc, 'fund-2')).toBe(1.0);
    expect(svc.getFunds().length).toBe(2);
  });

  test('② 库中有净值：覆盖内存 NAV；脏值（负数）忽略并 warn；未知 fundId 不引入新基金', async () => {
    const { svc, nr, warns } = makeSvc({
      navSeed: [
        { fundId: 'fund-1', nav: 5.2 },
        { fundId: 'fund-2', nav: -1 },
        { fundId: 'fund-9', nav: 9.9 }, // 历史遗留/已下线基金
      ],
    });
    await svc.onModuleInit();
    expect(navOf(svc, 'fund-1')).toBe(5.2);       // 库值覆盖初值 4.5
    expect(navOf(svc, 'fund-2')).toBe(1.0);       // 脏值不覆盖
    expect(svc.getFunds().length).toBe(2);        // 未知 fundId 不污染内存口径
    expect(svc.getFund('fund-9')).toBeUndefined();
    expect(warns.some((w) => w.includes('fund-2') && w.includes('非法'))).toBe(true); // 脏数据必须留痕
    expect(nr.calls.save).toBe(0);                // 两只有库行（含脏行）→ 不再补基线
  });

  test('②b 非有限/零/字符串垃圾一律不覆盖内存 NAV（NaN / abc / 0 / Infinity / null / undefined）', async () => {
    for (const bad of [NaN, 'abc', 0, -3, Infinity, -Infinity, null, undefined, '']) {
      const { svc, warns, nr } = makeSvc({ navSeed: [{ fundId: 'fund-1', nav: bad }] });
      await svc.onModuleInit();
      expect(navOf(svc, 'fund-1')).toBe(4.5);     // 脏数据被忽略，内存初值生效
      expect(warns.length).toBeGreaterThan(0);    // 且必须 warn（不静默）
      expect(rowOf(nr, 'fund-1').nav).not.toBe(4.5); // 脏行不被改写，交给下个落库周期修正
    }
  });

  test('读库失败不得影响启动：catch + warn，内存初值生效且不写库', async () => {
    const { svc, warns, nr } = makeSvc({ findError: new Error('SQLITE_BUSY: database is locked') });
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
    expect(navOf(svc, 'fund-1')).toBe(4.5);
    expect(navOf(svc, 'fund-2')).toBe(1.0);
    expect(warns.some((w) => w.includes('读取基金净值失败'))).toBe(true);
    expect(nr.calls.save).toBe(0);
  });
});

describe('Phase 14 定时落库（updateNavs：新 NAV upsert，只涨不跌）', () => {
  test('③ 每只基金的新 NAV 都落库 upsert，且内存 NAV 严格不下降（含 200 轮单调性）', async () => {
    const { svc, nr } = makeSvc();
    await svc.onModuleInit();
    const before = svc.getFunds().map((f) => f.nav);
    nr.calls.save = 0;
    await svc.updateNavs();
    expect(nr.calls.save).toBe(2);
    expect(nr.rows.length).toBe(2); // 主键 upsert：更新既有行而非新增
    // 内存与库中严格同源、且本周期不下降
    svc.getFunds().forEach((f, i) => {
      expect(f.nav).toBeGreaterThanOrEqual(before[i]);
      expect(rowOf(nr, f.id).nav).toBe(f.nav);
    });
    // 连续 200 个周期：NAV 只涨不跌（红线：跌价会重开「重置/赎回」套利窗口）
    let prev = svc.getFunds().map((f) => f.nav);
    for (let i = 0; i < 200; i++) {
      await svc.updateNavs();
      const now = svc.getFunds().map((f) => f.nav);
      now.forEach((v, k) => expect(v).toBeGreaterThanOrEqual(prev[k]));
      prev = now;
    }
    for (const f of svc.getFunds())
      expect(rowOf(nr, f.id).nav).toBe(navOf(svc, f.id)); // 库中始终跟得上内存
    expect(nr.rows.length).toBe(2);
  });

  test('④ 落库失败不影响 NAV 内存更新：updateNavs 不 reject，仅 logger.error', async () => {
    const { svc, nr, errors } = makeSvc({ navSeed: [{ fundId: 'fund-1', nav: 5 }], saveError: new Error('db is locked') });
    await expect(svc.onModuleInit()).resolves.toBeUndefined(); // 初始化补基线同样只降级为日志
    const before = navOf(svc, 'fund-1');
    await expect(svc.updateNavs()).resolves.toBeUndefined();
    expect(navOf(svc, 'fund-1')).toBeGreaterThanOrEqual(before); // 行情照常推进
    expect(errors.some((m) => m.includes('落库失败'))).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
    expect(nr.rows.find((r) => r.fundId === 'fund-1').nav).toBe(5); // 库值未被子虚乌有地改动
  });

  test('落库异常后恢复：下一次周期正常写入（不因单次失败永久停写）', async () => {
    const { svc, nr } = makeSvc();
    await svc.onModuleInit();
    nr.setSaveError(new Error('transient'));
    await svc.updateNavs();
    const afterFail = Object.fromEntries(nr.rows.map((r) => [r.fundId, r.nav]));
    nr.setSaveError(null);
    await svc.updateNavs();
    for (const f of svc.getFunds()) {
      expect(rowOf(nr, f.id).nav).toBe(navOf(svc, f.id));
      expect(rowOf(nr, f.id).nav).toBeGreaterThanOrEqual(afterFail[f.id]);
    }
  });
});

describe('Phase 14 兼容性 + 重启连续性（核心回归）', () => {
  test('⑤ 未注入 repo（既有 5 参构造）：onModuleInit/updateNavs/申购 全不崩，跳过持久化并 warn', async () => {
    const { svc, warns } = makeSvc({ withNavRepo: false });
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
    expect(warns.some((w) => w.includes('未注入'))).toBe(true);
    const before = navOf(svc, 'fund-1');
    await expect(svc.updateNavs()).resolves.toBeUndefined(); // 无 repo：跳过落库而非抛错
    expect(navOf(svc, 'fund-1')).toBeGreaterThanOrEqual(before);
    const r = await svc.subscribe('U1', 'CN', 'fund-2', 10);
    expect(r.success).toBe(true); // 交易路径不受影响
  });

  test('⑥ 核心回归：库中 nav=5.2 → 新实例 onModuleInit 后 getFunds 返回 5.2（不再回落 4.5）', async () => {
    const restarted = makeSvc({ navSeed: [{ fundId: 'fund-1', nav: 5.2 }] });
    // 未初始化 = 缺陷现场：内存里是硬编码初值 4.5，100 份市值凭空少 70
    expect(navOf(restarted.svc, 'fund-1')).toBe(4.5);
    await restarted.svc.onModuleInit();
    expect(restarted.svc.getFund('fund-1').nav).toBe(5.2);
    for (const f of restarted.svc.getFunds())
      expect(f.nav).toBe(f.id === 'fund-1' ? 5.2 : 1.0);
    expect(100 * navOf(restarted.svc, 'fund-1')).toBeCloseTo(520, 6); // 持仓市值跨重启连续
    // 库中缺 fund-2 → 用内存初值补基线，下次重启同样有值可回填
    expect(rowOf(restarted.nr, 'fund-2').nav).toBe(1.0);
    // 申购口径用回填后的 NAV：份额 = CNY×(1-申购费) / 5.2（返回结构不变）
    const r = await restarted.svc.subscribe('U1', 'CN', 'fund-1', 520);
    expect(r.success).toBe(true);
    expect(r.nav).toBe(5.2);
    const expectShares = (520 * (1 - 0.0015)) / 5.2;
    expect(r.shares).toBeCloseTo(expectShares, 3);
    expect(Math.abs(r.shares - expectShares)).toBeLessThanOrEqual(0.00005 + 1e-9); // 份额按 4 位小数落库
  });

  test('⑥b 完整生命周期：演化 50 个周期落库 → 模拟重启 → 净值与市值严格连续', async () => {
    const first = makeSvc();
    await first.svc.onModuleInit();
    for (let i = 0; i < 50; i++) await first.svc.updateNavs();
    const persisted = first.nr.rows.map((r) => ({ ...r }));
    const navBeforeRestart = navOf(first.svc, 'fund-1');
    expect(navBeforeRestart).toBeGreaterThan(4.5); // 净值确实涨过（旧实现在此复位）

    const second = makeSvc({ navSeed: persisted }); // 新进程：内存回到初值，靠库回填
    expect(navOf(second.svc, 'fund-1')).toBe(4.5);
    await second.svc.onModuleInit();
    const shares = 100;
    expect(second.svc.getFunds().map((f) => f.nav))
      .toEqual(first.svc.getFunds().map((f) => f.nav)); // 逐只严格相等，市值零缩水
    expect(shares * navOf(second.svc, 'fund-1'))
      .toBeCloseTo(shares * navBeforeRestart, 6);
  });
});
