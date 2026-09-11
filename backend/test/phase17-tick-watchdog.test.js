// Phase 17（G-4）回归：行情 tick 的"永久停更"防护
//
// 现象（用户实测）：后端进程活着、HTTP 正常、排行榜照刷，但**行情彻底不动且没有任何报错**。
// 根因：tick 循环是串行递归（processing 置位 → await … → finally 里重新 setTimeout），
// 只要有一个 await 永不返回，循环就再也不会被重新调度。机器人玩家是 G-2 新引入的 tick 内旁路
// 副作用路径（下单→撮合→结算→落库），必须给它加上界，并给整个循环加看门狗：
//   ① withTimeout：超时 resolve 出 TIMEOUT 哨兵（不 reject、不产生未处理拒绝），异常仍透传
//   ② 看门狗：本次 tick 远超预算时 → 日志指名卡在哪个阶段 → 强制恢复调度（把"永久停更"降级为"少一个 tick"）
const { MarketService } = require('../dist/src/modules/market/market.service');
const { withTimeout, TIMEOUT } = require('../dist/src/common/with-timeout');

describe('Phase 17 G-4：withTimeout（给可能永不返回的旁路动作加上界）', () => {
  test('正常返回：原值透传', async () => {
    await expect(withTimeout(Promise.resolve({ processed: 3 }), 1000)).resolves.toEqual({ processed: 3 });
    await expect(withTimeout(42, 1000)).resolves.toBe(42);
  });

  test('永不返回：超时给出 TIMEOUT 哨兵（不抛错、不产生未处理拒绝）', async () => {
    const never = new Promise(() => { });
    const r = await withTimeout(never, 30);
    expect(r).toBe(TIMEOUT);
  });

  test('原 promise 异常：原样抛出（不吞错，交给调用方 try/catch）', async () => {
    await expect(withTimeout(Promise.reject(new Error('DB 抖动')), 1000)).rejects.toThrow('DB 抖动');
  });
});

// ─── MarketService 的最小构造（只喂看门狗需要的依赖）───
function makeService() {
  const marketData = {
    gameDay: 45, tickCount: 1, stocks: new Map(),
    getState: () => ({ gameDay: 45, tickCount: 1 }),
  };
  const engine = {};
  const gateway = {};
  const news = {};
  const risk = { setMarketPrices: () => { } };
  const debugMode = { isMarketActive: () => true, getGlobalBypass: () => true };
  const config = { get: (k, d) => (k === 'TICK_INTERVAL_MS' ? 60000 : d) };
  const svc = new MarketService(marketData, engine, gateway, news, risk, marketData, marketData, debugMode, config, undefined);
  const logs = { errors: [], warns: [] };
  svc.logger = {
    error: (m) => logs.errors.push(String(m)),
    warn: (m) => logs.warns.push(String(m)),
    log: () => { }, debug: () => { },
  };
  return { svc, logs };
}

describe('Phase 17 G-4：tick 看门狗（指名卡点 + 强制恢复调度）', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('某个阶段卡死超过预算 → 日志指名阶段、processing 复位、自愈计数 +1', () => {
    const { svc, logs } = makeService();
    svc.startTickLoop();
    // 模拟"CN 阶段卡住 10 分钟"（预算 = max(tickIntervalMs*3, 120s) = 180s）
    svc.processing = true;
    svc.tickStage = 'CN';
    svc.tickStartedAt = Date.now() - 10 * 60 * 1000;
    jest.advanceTimersByTime(16000); // 看门狗间隔 15s
    expect(svc.processing).toBe(false);
    expect(svc.getTickHealth().hungRecoveries).toBe(1);
    expect(logs.errors.join('|')).toContain('看门狗');
    expect(logs.errors.join('|')).toContain('「CN」');
  });

  test('未超预算不误杀（processing 保持、无自愈）', () => {
    const { svc, logs } = makeService();
    svc.startTickLoop();
    svc.processing = true;
    svc.tickStage = 'riskManager';
    svc.tickStartedAt = Date.now() - 5000; // 5s，远小于 180s 预算
    jest.advanceTimersByTime(16000);
    expect(svc.processing).toBe(true);
    expect(svc.getTickHealth().hungRecoveries).toBe(0);
    expect(logs.errors.join('|')).not.toContain('看门狗');
  });

  test('空闲时不干预（processing=false 即使时间很旧）', () => {
    const { svc } = makeService();
    svc.startTickLoop();
    svc.processing = false;
    svc.tickStartedAt = Date.now() - 60 * 60 * 1000;
    jest.advanceTimersByTime(16000);
    expect(svc.getTickHealth().hungRecoveries).toBe(0);
  });

  test('健康度可观测：getState 暴露 tickHealth（卡住时前端/运维一眼可判）', () => {
    const { svc } = makeService();
    svc.processing = true;
    svc.tickStage = 'HK';
    svc.tickStartedAt = Date.now() - 1000;
    const st = svc.getState();
    expect(st.tickHealth).toMatchObject({ stage: 'HK', processing: true });
    expect(st.tickHealth.sinceMs).toBeGreaterThanOrEqual(900);
  });
});
