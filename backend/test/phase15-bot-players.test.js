// Phase 15：机器人玩家（算法盘假人）回归
// ① 名册幂等开通（重复调用不新增、缺账户自愈、字段口径）② 禁用开关口径 ③ 委托只经 OrderService.placeOrder
// （同真人路径；fake 只提供 placeOrder 一个方法即证明无旁路）④ 双层节流（每 N tick / 每游戏日 + 跨日重置）
// ⑤ 决策确定性（同 (gameDay,tick,botId) 重放同一序列）⑥ 异常隔离（拒单/抛错不中断 tick、不计成功单数）
// ⑦ 赛季报名：默认**关闭**（首个报名者会替全体真人开赛并关闭报名窗口，见服务内注释）+ 打开后每游戏日至多一次
const { BadRequestException } = require('@nestjs/common');
const { BotPlayerService } = require('../dist/src/modules/bots/bot-player.service');
const { buildRosterDefs } = require('../dist/src/modules/bots/bot-strategies');

const ENV_KEYS = ['BOT_PLAYERS_ENABLED', 'BOT_PLAYERS_COUNT', 'BOT_PLAYERS_TRADE_EVERY_TICKS', 'BOT_PLAYERS_MAX_ORDERS_PER_DAY', 'BOT_PLAYERS_SEASON_ENROLL'];
const savedEnv = {};
beforeAll(() => { for (const k of ENV_KEYS) savedEnv[k] = process.env[k]; });
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});
// 每个用例从"环境变量未设置"的干净状态开始（默认值 6 / 10 / 12）
beforeEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });

// ─── 手写 fake 仓储（纯内存，只支持本服务实际使用的 where 等值查询）───
function matches(row, where) {
  return Object.keys(where || {}).every((k) => row[k] === where[k]);
}

function makeUserRepo() {
  const rows = [];
  const calls = { create: 0, save: 0 };
  let seq = 0;
  return {
    rows, calls,
    async findOne({ where }) { return rows.find((r) => matches(r, where)) || null; },
    create(obj) { calls.create++; return Object.assign({}, obj); },
    async save(obj) {
      calls.save++;
      if (!obj.id) obj.id = 'u' + (++seq);
      if (!rows.includes(obj)) rows.push(obj);
      return obj;
    },
  };
}

function makeAccountRepo() {
  const rows = [];
  const calls = { create: 0, save: 0 };
  let seq = 0;
  return {
    rows, calls,
    async findOne({ where }) { return rows.find((r) => matches(r, where)) || null; },
    create(obj) { calls.create++; return Object.assign({ positions: [] }, obj); },
    async save(obj) {
      calls.save++;
      if (!obj.id) obj.id = 'a' + (++seq);
      if (!rows.includes(obj)) rows.push(obj);
      return obj;
    },
  };
}

// 只提供 placeOrder 的 fake：机器人若存在任何旁路（直接写 Account/Order、直连撮合）都会在此暴露为
// "TypeError: xxx is not a function"，因此这个最小接口本身就是"资金路径唯一"的证明。
function makeOrderService(impl) {
  const calls = [];
  return {
    calls,
    async placeOrder(...args) {
      calls.push(args);
      return impl ? impl(args, calls.length) : { success: true, order: { id: 'o' + calls.length } };
    },
  };
}

function makeSeasonService(impl) {
  const calls = [];
  return {
    calls,
    async enroll(userId) {
      calls.push(userId);
      return impl ? impl(userId) : { success: true };
    },
  };
}

// ─── 场景装配：两个标的（一涨一跌，保证买/卖两条路径都会走到）───
const SYMBOLS = ['600000', '000001'];
const PRICES = { '600000': 10.5, '000001': 9 };
const DAY_OPEN = 10; // 相对 10：600000 = +5%（看多）、000001 = -10%（看空）

function makeHarness(opts = {}) {
  const userRepo = opts.userRepo || makeUserRepo();
  const accountRepo = opts.accountRepo || makeAccountRepo();
  const orderService = opts.orderService || makeOrderService();
  const seasonService = opts.seasonService || makeSeasonService();
  const svc = new BotPlayerService(userRepo, accountRepo, orderService, seasonService);
  const priceCalls = [];
  svc.configure({
    getSymbols: opts.getSymbols || (() => SYMBOLS),
    getPrice: opts.getPrice || ((s) => {
      priceCalls.push(s);
      return PRICES[s];
    }),
    getDayOpen: opts.getDayOpen || (() => DAY_OPEN),
  });
  const harness = { svc, userRepo, accountRepo, orderService, seasonService, priceCalls };
  // 返回最后一个 tick 的 { processed, submitted }：用于断言"整轮都跑完/全部被拒但已尝试"
  harness.runTicks = async (count, startTick = 0, gameDay = 0, market = 'CN') => {
    let last = { processed: 0, submitted: 0 };
    for (let t = startTick; t < startTick + count; t++)
      last = await svc.runTick({ gameDay, tick: t, market });
    return last;
  };
  return harness;
}

// 开通名册（N 由参数注入）+ 给每个机器人的 CN 账户铺初始资金与持仓
async function openRoster(harness, count) {
  const res = await harness.svc.ensureRoster(count);
  seedTradingAccounts(harness, count);
  return res;
}

function seedTradingAccounts(harness, count) {
  for (const acc of harness.accountRepo.rows) {
    if (acc.marketMode !== 'CN')
      continue;
    acc.cash = 100000;
    acc.positions = [
      { symbol: '600000', longQty: 0, boughtToday: 0, longCost: 0 },
      { symbol: '000001', longQty: 1000, boughtToday: 0, longCost: 9 },
    ];
  }
}

// 按 userId（placeOrder 第 0 个参数）统计委托笔数
function callsByBot(calls) {
  const out = {};
  for (const c of calls) {
    const id = c[0];
    out[id] = (out[id] || 0) + 1;
  }
  return out;
}

describe('Phase 15 机器人玩家：名册幂等开通', () => {
  test('首次开通建 N 个 bot + 每人 3 个市场账户，字段口径与 register() 一致', async () => {
    const h = makeHarness();
    const res = await openRoster(h, 3);

    expect(res.total).toBe(3);
    expect(res.created).toBe(3);
    expect(h.userRepo.rows).toHaveLength(3);
    expect(h.accountRepo.rows).toHaveLength(9); // 3 bot × CN/HK/US
    for (const u of h.userRepo.rows) {
      expect(u.username).toMatch(/^bot_[a-z0-9_]+$/); // 纯 ASCII，避免编码问题
      expect(u.isBot).toBe(true);
      expect(u.isActive).toBe(true);
      expect(u.role).toBe('user');
      // 密码：只断言"是非空长串"，不断言具体值（随机口令永不进断言/日志）
      expect(typeof u.password).toBe('string');
      expect(u.password.length).toBeGreaterThan(20);
      expect(u.password).not.toBe(u.username);
      const accounts = h.accountRepo.rows.filter((a) => a.userId === u.id);
      expect(accounts.map((a) => a.marketMode).sort()).toEqual(['CN', 'HK', 'US']);
      for (const acc of accounts) {
        expect(acc.cash).toBe(100000); // RISK.initialCash，与 AuthService.register() 同口径
        expect(acc.totalEquity).toBe(100000);
        expect(acc.peakEquity).toBe(100000);
        expect(acc.initialEquity).toBe(100000);
        expect(acc.dayStartEquity).toBe(100000);
      }
    }
    expect(h.svc.getState().rosterSize).toBe(3);
  });

  test('重复调用不新增；缺一个账户能补齐；只有用户的半拉子残留能自愈', async () => {
    const h = makeHarness();
    await openRoster(h, 3);
    const usersBefore = h.userRepo.rows.length;
    const accountsBefore = h.accountRepo.rows.length;

    const again = await h.svc.ensureRoster(3);
    expect(again.created).toBe(0);
    expect(again.accounts).toBe(0);
    expect(h.userRepo.rows).toHaveLength(usersBefore);
    expect(h.accountRepo.rows).toHaveLength(accountsBefore);

    // 场景 B：某个机器人被删掉了一个市场账户 → 只补缺的那个
    const uid = h.userRepo.rows[0].id;
    const idx = h.accountRepo.rows.findIndex((a) => a.userId === uid && a.marketMode === 'HK');
    h.accountRepo.rows.splice(idx, 1);
    const repair = await h.svc.ensureRoster(3);
    expect(repair.created).toBe(0);
    expect(repair.accounts).toBe(1);
    expect(h.accountRepo.rows.filter((a) => a.userId === uid)).toHaveLength(3);

    // 场景 C：上次中途失败留下的"有用户没账户"残留（用户已建、账户一个都没建）→ 补齐 3 个账户，不再建用户
    const uid3 = h.userRepo.rows[2].id;
    const name3 = h.userRepo.rows[2].username;
    const rest = h.accountRepo.rows.filter((a) => a.userId !== uid3);
    h.accountRepo.rows.length = 0;
    h.accountRepo.rows.push(...rest);
    const heal = await h.svc.ensureRoster(3);
    expect(heal.created).toBe(0);
    expect(heal.accounts).toBe(3);
    expect(h.accountRepo.rows.filter((a) => a.userId === uid3)).toHaveLength(3);
    expect(h.userRepo.rows.filter((u) => u.username === name3)).toHaveLength(1);
    // 残留自愈后仍然是完整的三市场账户
    expect(h.accountRepo.rows.filter((a) => a.userId === uid3).map((a) => a.marketMode).sort()).toEqual(['CN', 'HK', 'US']);
  });

  test('名册定义确定且唯一：上限 20，用户名不重复、纯 ASCII', () => {
    const defs = buildRosterDefs(20);
    expect(defs).toHaveLength(20);
    expect(new Set(defs.map((d) => d.username)).size).toBe(20);
    expect(new Set(defs.map((d) => d.id)).size).toBe(20);
    for (const d of defs) {
      expect(d.username).toMatch(/^bot_[a-z0-9_]+$/);
      expect(d.market).toBe('CN');
      expect(d.activity).toBeGreaterThan(0);
      expect(d.activity).toBeLessThanOrEqual(0.6);
      expect(d.cashFraction).toBeLessThanOrEqual(0.5); // 单笔买入绝不超过可用现金 50%
    }
    expect(buildRosterDefs(999)).toHaveLength(20); // 越界钳到 20
    expect(buildRosterDefs(0)).toHaveLength(0);
    expect(buildRosterDefs(-5)).toHaveLength(0);
    // 同名册重建得到同一批人设（重启不改变任何机器人性格）
    expect(buildRosterDefs(6)).toEqual(buildRosterDefs(6));
  });
});

describe('Phase 15 机器人玩家：禁用开关口径', () => {
  test("BOT_PLAYERS_ENABLED='false' 时不开通任何用户", async () => {
    process.env.BOT_PLAYERS_ENABLED = 'false';
    const h = makeHarness();
    const res = await h.svc.ensureRoster(3);
    expect(res.total).toBe(0);
    expect(h.userRepo.rows).toHaveLength(0);
    expect(h.accountRepo.rows).toHaveLength(0);
    expect(h.svc.getState().enabled).toBe(false);
    // 关闭态下 runTick 必须是彻底的 no-op：不读行情、不下单
    await h.runTicks(20);
    expect(h.orderService.calls).toHaveLength(0);
    expect(h.priceCalls).toHaveLength(0);
  });

  test("'0' / 'no' / 'off' / 未设置 均视为开启（与项目 DB_SYNCHRONIZE 口径一致）", async () => {
    for (const v of ['0', 'no', 'off', '']) {
      process.env.BOT_PLAYERS_ENABLED = v;
      const h = makeHarness();
      const res = await h.svc.ensureRoster(2);
      expect(res.total).toBe(2);
      expect(h.userRepo.rows).toHaveLength(2);
      expect(h.svc.getState().enabled).toBe(true);
    }
  });
});

describe('Phase 15 机器人玩家：委托只经 OrderService（同真人路径）', () => {
  test('runTick 的每一次委托都只经过 placeOrder，参数形状合法且无任何旁路写入', async () => {
    process.env.BOT_PLAYERS_TRADE_EVERY_TICKS = '1';
    process.env.BOT_PLAYERS_MAX_ORDERS_PER_DAY = '200';
    const h = makeHarness();
    await openRoster(h, 2);

    // fake 只有一个方法：机器人若直接写 Account/Order 或直连撮合，会立刻以 TypeError 暴露
    expect(Object.keys(h.orderService)).toEqual(['calls', 'placeOrder']);

    const savesAfterRoster = h.accountRepo.calls.save;
    const createsAfterRoster = h.accountRepo.calls.create;
    await h.runTicks(60);

    expect(h.orderService.calls.length).toBeGreaterThan(0);
    for (const [userId, mode, symbol, type, side, quantity, price, triggerPrice, displayQty] of h.orderService.calls) {
      expect(typeof userId).toBe('string');
      expect(['CN', 'HK', 'US']).toContain(mode);
      expect(mode).toBe('CN'); // 机器人主战场 = A 股账户
      expect(SYMBOLS).toContain(symbol);
      expect(['limit', 'market']).toContain(type);
      expect(['buy', 'sell']).toContain(side);
      expect(Number.isInteger(quantity)).toBe(true);
      expect(quantity).toBeGreaterThan(0);
      expect(Number.isFinite(price)).toBe(true);
      expect(price).toBeGreaterThan(0);
      expect(triggerPrice).toBe(0);
      expect(displayQty).toBe(0);
    }
    // 买卖两条路径都被覆盖（策略确实按日内涨跌双向出单）
    expect(h.orderService.calls.some((c) => c[4] === 'buy')).toBe(true);
    expect(h.orderService.calls.some((c) => c[4] === 'sell')).toBe(true);
    // 交易期间不得有任何账户写入（账户只能由名册开通路径创建/补齐）
    expect(h.accountRepo.calls.save).toBe(savesAfterRoster);
    expect(h.accountRepo.calls.create).toBe(createsAfterRoster);
    // 买单金额受"可用现金 × 50%"硬约束（100000 现金 / 10.5 元 → 约 4761 股，误差 ≤ 1 手向下取整）
    for (const c of h.orderService.calls.filter((x) => x[4] === 'buy'))
      expect(c[5] * c[6]).toBeLessThanOrEqual(100000 * 0.5 + c[6]);
    // 卖单不超过可卖持仓（账户里只有 000001 的 1000 股）
    for (const c of h.orderService.calls.filter((x) => x[4] === 'sell')) {
      expect(c[2]).toBe('000001');
      expect(c[5]).toBeLessThanOrEqual(1000);
    }
  });

  test('行情缺失（无标的/无有效报价）时不下任何单，也不抛错', async () => {
    process.env.BOT_PLAYERS_TRADE_EVERY_TICKS = '1';
    const h = makeHarness({ getSymbols: () => [], getPrice: () => undefined });
    await openRoster(h, 2);
    const out = await h.runTicks(10);
    expect(out.processed).toBe(0);   // 无标的直接跳过整轮
    expect(h.orderService.calls).toHaveLength(0);
    expect(h.svc.getState().lastDecision).toBeNull();

    const h2 = makeHarness({ getSymbols: () => ['600000'], getPrice: () => NaN });
    await openRoster(h2, 2);
    const out2 = await h2.runTicks(10);
    expect(out2.processed).toBe(0);  // 有标的但报价全无效 → 整轮跳过
    expect(h2.orderService.calls).toHaveLength(0);
  });
});

describe('Phase 15 机器人玩家：双层节流', () => {
  test('每 N tick 至多一次决策尝试（every=10 → 200 tick 内每 bot ≤ 20 笔）', async () => {
    process.env.BOT_PLAYERS_TRADE_EVERY_TICKS = '10';
    process.env.BOT_PLAYERS_MAX_ORDERS_PER_DAY = '200';
    const h = makeHarness();
    await openRoster(h, 3);
    await h.runTicks(200);

    const perBot = callsByBot(h.orderService.calls);
    // 节流上限：每 bot ≤ 200/10 = 20 笔，总计 ≤ 3×20（不要求每个 bot 都恰好出单——
    // 出单还取决于响应率闸门与有无可卖持仓，这里只钉死"上限"）
    for (const id of Object.keys(perBot))
      expect(perBot[id]).toBeLessThanOrEqual(20);
    expect(h.orderService.calls.length).toBeLessThanOrEqual(3 * 20);
    expect(h.orderService.calls.length).toBeGreaterThan(0);
    expect(h.svc.getState().tradeEveryTicks).toBe(10);
    expect(Object.keys(perBot).length).toBeLessThanOrEqual(3);
    for (const b of h.svc.getState().bots)
      expect(b.submitted).toBeLessThanOrEqual(20);
  });

  test('每游戏日提交上限是硬上限（含被拒的单），跨游戏日自动重置', async () => {
    process.env.BOT_PLAYERS_TRADE_EVERY_TICKS = '1';
    process.env.BOT_PLAYERS_MAX_ORDERS_PER_DAY = '5';
    const h = makeHarness();
    await openRoster(h, 3);

    await h.runTicks(200, 0, 0); // 第 0 游戏日：额度只有 5，跑再多 tick 也只能下 5 笔
    const perBot0 = callsByBot(h.orderService.calls);
    expect(Object.keys(perBot0)).toHaveLength(3);
    for (const id of Object.keys(perBot0))
      expect(perBot0[id]).toBeLessThanOrEqual(5);
    expect(h.svc.getState().maxOrdersPerDay).toBe(5);
    for (const b of h.svc.getState().bots) {
      expect(b.day).toBe(0);
      expect(b.submitted).toBe(5);
    }

    // 跨日：计数清零后同一天又能下满额度（不是"一次性总额度"）
    const beforeDay1 = h.orderService.calls.length;
    await h.runTicks(50, 0, 1);
    const day1Added = h.orderService.calls.length - beforeDay1;
    expect(day1Added).toBeGreaterThan(0);
    expect(day1Added).toBeLessThanOrEqual(3 * 5);
    for (const b of h.svc.getState().bots) {
      expect(b.day).toBe(1);
      expect(b.submitted).toBeGreaterThan(0);
      expect(b.submitted).toBeLessThanOrEqual(5);
    }
  });

  test('BOT_PLAYERS_MAX_ORDERS_PER_DAY=0 时完全不下单（但名册照常开通）', async () => {
    process.env.BOT_PLAYERS_TRADE_EVERY_TICKS = '1';
    process.env.BOT_PLAYERS_MAX_ORDERS_PER_DAY = '0';
    const h = makeHarness();
    await openRoster(h, 2);
    await h.runTicks(50);
    expect(h.userRepo.rows).toHaveLength(2);
    expect(h.orderService.calls).toHaveLength(0);
    expect(h.svc.getState().maxOrdersPerDay).toBe(0);
  });
});

describe('Phase 15 机器人玩家：决策确定性（可重放）', () => {
  test('同一 (gameDay,tick,botId) 序列重放产生完全相同的委托序列', async () => {
    process.env.BOT_PLAYERS_TRADE_EVERY_TICKS = '3';
    process.env.BOT_PLAYERS_MAX_ORDERS_PER_DAY = '200';
    const a = makeHarness();
    const b = makeHarness();
    await openRoster(a, 3);
    await openRoster(b, 3);
    await a.runTicks(45, 0, 7); // 任意游戏日 7：种子含 gameDay，日号不影响可复现性
    await b.runTicks(45, 0, 7);

    expect(a.orderService.calls.length).toBeGreaterThan(0);
    expect(a.orderService.calls).toEqual(b.orderService.calls); // uid 由 fake 顺序生成，因此可逐字对比
    expect(a.svc.getState().bots).toEqual(b.svc.getState().bots);
    expect(a.svc.getState().lastDecision).toEqual(b.svc.getState().lastDecision);
  });
});

describe('Phase 15 机器人玩家：异常隔离（绝不中断行情 tick）', () => {
  test('placeOrder 抛 BadRequestException / 返回 success:false 时不抛、不计成功单数、后续 bot 继续处理', async () => {
    process.env.BOT_PLAYERS_TRADE_EVERY_TICKS = '1';
    process.env.BOT_PLAYERS_MAX_ORDERS_PER_DAY = '50';
    let n = 0;
    const orderService = makeOrderService(() => {
      n++;
      if (n % 2 === 1)
        throw new BadRequestException('休市中，当前市场不在交易时段，无法下单');
      return { success: false, error: '持仓不足，当前可平 0 股' };
    });
    const h = makeHarness({ orderService });
    await openRoster(h, 2);

    const out = await h.runTicks(40); // 不得抛出（抛出即用例失败）

    expect(h.orderService.calls.length).toBeGreaterThan(0);
    expect(out.processed).toBe(2); // 两个 bot 都被处理到（前一个抛错不影响后一个）
    const state = h.svc.getState();
    for (const b of state.bots) {
      expect(b.accepted).toBe(0);             // 全部被拒 → 成功单数为 0
      expect(b.submitted).toBeGreaterThan(0); // 但确实尝试过（不计成功、也不重试）
      expect(['rejected', 'error', 'skip']).toContain(b.lastResult);
    }
    expect(state.lastDecision.outcome).toBe('rejected'); // 最近一次决策是"被拒"，而不是"成功"
  });

  test('账户不存在时静默跳过，不抛错也不下单', async () => {
    process.env.BOT_PLAYERS_TRADE_EVERY_TICKS = '1';
    const h = makeHarness();
    await openRoster(h, 2);
    h.accountRepo.rows.length = 0; // 模拟账户被清理/未开通
    const out = await h.runTicks(20);
    expect(out.processed).toBe(2);
    expect(h.orderService.calls).toHaveLength(0);
    for (const b of h.svc.getState().bots)
      expect(['skip', 'idle']).toContain(b.lastResult);
  });

  test('行情回调抛错时整轮不抛，机器人静默跳过', async () => {
    process.env.BOT_PLAYERS_TRADE_EVERY_TICKS = '1';
    const h = makeHarness({ getPrice: () => { throw new Error('行情未就绪'); } });
    await openRoster(h, 2);
    const out = await h.runTicks(10);
    expect(out.processed).toBe(0); // 无有效报价 → 本 tick 不处理
    expect(h.orderService.calls).toHaveLength(0);
  });
});

describe('Phase 15 机器人玩家：赛季报名（默认关闭，打开后每游戏日至多一次）', () => {
  test('默认不报名（首个报名者会替全体真人开赛并关闭报名窗口——冒烟实测副作用）', async () => {
    process.env.BOT_PLAYERS_TRADE_EVERY_TICKS = '1';
    const h = makeHarness();
    await openRoster(h, 2);
    await h.runTicks(50);
    expect(h.seasonService.calls).toHaveLength(0);
    expect(h.orderService.calls.length).toBeGreaterThan(0); // 不报名不影响交易
  });

  test('打开开关后：每个游戏日每个机器人至多报名一次，跨日重新尝试', async () => {
    process.env.BOT_PLAYERS_TRADE_EVERY_TICKS = '5';
    process.env.BOT_PLAYERS_SEASON_ENROLL = 'true';
    const h = makeHarness();
    await openRoster(h, 3);
    await h.runTicks(200, 0, 0);
    const perUser = {};
    for (const id of h.seasonService.calls)
      perUser[id] = (perUser[id] || 0) + 1;
    expect(Object.keys(perUser)).toHaveLength(3);
    for (const id of Object.keys(perUser))
      expect(perUser[id]).toBe(1); // 200 个 tick 只报名一次

    await h.runTicks(30, 0, 1);
    const perUserDay1 = {};
    for (const id of h.seasonService.calls)
      perUserDay1[id] = (perUserDay1[id] || 0) + 1;
    for (const id of Object.keys(perUserDay1))
      expect(perUserDay1[id]).toBe(2); // 新游戏日再试一次
  });

  test('SeasonService 抛错或返回失败时不影响交易', async () => {
    process.env.BOT_PLAYERS_TRADE_EVERY_TICKS = '1';
    process.env.BOT_PLAYERS_MAX_ORDERS_PER_DAY = '50';
    process.env.BOT_PLAYERS_SEASON_ENROLL = 'true';
    const seasonService = makeSeasonService(() => { throw new Error('赛季未开放'); });
    const h = makeHarness({ seasonService });
    await openRoster(h, 2);

    await h.runTicks(40); // 不得抛出
    expect(h.seasonService.calls.length).toBeGreaterThan(0);
    expect(h.orderService.calls.length).toBeGreaterThan(0); // 交易照常
    expect(h.svc.getState().bots.some((b) => b.accepted > 0)).toBe(true);
  });

  test('未注入 SeasonService 时跳过报名（不抛错，交易不受影响）', async () => {
    process.env.BOT_PLAYERS_TRADE_EVERY_TICKS = '1';
    process.env.BOT_PLAYERS_SEASON_ENROLL = 'true';
    const h = makeHarness();
    const svc = new BotPlayerService(h.userRepo, h.accountRepo, h.orderService, undefined);
    svc.configure({ getSymbols: () => SYMBOLS, getPrice: (s) => PRICES[s], getDayOpen: () => DAY_OPEN });
    await svc.ensureRoster(2);
    seedTradingAccounts(h, 2);
    for (let t = 0; t < 20; t++)
      await svc.runTick({ gameDay: 0, tick: t, market: 'CN' });
    expect(h.orderService.calls.length).toBeGreaterThan(0);
  });
});
