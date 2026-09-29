// RateLimitService 纯单测（不依赖 DB / HTTP）：双维度、锁定、递增延迟、键上限与定期清理
const { RateLimitService } = require('../../../../dist/src/modules/identity/rate-limit.service');

describe('RateLimitService · IP + 账号双维度限流', () => {
  let rl;
  beforeEach(() => {
    rl = new RateLimitService();
    rl.BASE_DELAY_MS = 0; // 单测不等真延迟
    rl.LOCK_BASE_MS = 1000;
  });
  afterEach(() => { rl.onModuleDestroy(); });

  test('连续失败达到阈值即锁定；锁定期间 assertAllowed 抛 429 且文案不泄露维度', async () => {
    for (let i = 0; i < rl.MAX_STRIKES - 1; i++) {
      expect(() => rl.assertAllowed('login', '1.2.3.4', 'a@x.com')).not.toThrow();
      rl.recordFailure('login', '1.2.3.4', 'a@x.com');
    }
    rl.assertAllowed('login', '1.2.3.4', 'a@x.com'); // 第 5 次尝试仍放行
    rl.recordFailure('login', '1.2.3.4', 'a@x.com'); // 第 5 次失败 → 锁定

    let caught = null;
    try { rl.assertAllowed('login', '1.2.3.4', 'a@x.com'); }
    catch (e) { caught = e; }
    expect(caught).toBeTruthy();
    expect(caught.getStatus()).toBe(429);
    expect(caught.message).toBe('尝试次数过多，请稍后再试');
    expect(caught.getResponse().retryAfterSec).toBeGreaterThan(0);
  });

  test('维度隔离：换 IP 仍被账号维度拦，换账号仍被 IP 维度拦', () => {
    for (let i = 0; i < rl.MAX_STRIKES; i++)
      rl.recordFailure('login', '1.1.1.1', 'victim@x.com');

    expect(() => rl.assertAllowed('login', '2.2.2.2', 'victim@x.com')).toThrow(); // 账号维度锁
    expect(() => rl.assertAllowed('login', '1.1.1.1', 'other@x.com')).toThrow(); // IP 维度锁
    expect(() => rl.assertAllowed('login', '3.3.3.3', 'fresh@x.com')).not.toThrow(); // 干净的对儿放行
  });

  test('递增延迟：随失败次数指数增长并封顶', () => {
    rl.BASE_DELAY_MS = 100;
    rl.MAX_DELAY_MS = 800;
    const delays = [];
    for (let i = 0; i < 5; i++)
      delays.push(rl.recordFailure('login', '4.4.4.4', 'd@x.com'));
    expect(delays).toEqual([100, 200, 400, 800, 800]);
    expect(Math.max(...delays)).toBeLessThanOrEqual(rl.MAX_DELAY_MS);
  });

  test('成功只清账号维度：IP 维度的失败计数不被洗白', () => {
    rl.BASE_DELAY_MS = 100;
    for (let i = 0; i < 3; i++)
      rl.recordFailure('login', '5.5.5.5', 'e@x.com');
    const ipKey = rl.key('login', 'ip', '5.5.5.5');
    const accountKey = rl.key('login', 'account', 'e@x.com');
    expect(rl.buckets.get(ipKey).strikes).toBe(3);

    rl.recordSuccess('login', 'e@x.com');
    expect(rl.buckets.has(accountKey)).toBe(false); // 账号维度清零
    expect(rl.buckets.get(ipKey).strikes).toBe(3); // IP 维度保留（否则刷一次成功即可绕过）
  });

  test('大小写归一：同账号不同写法共享计数（无法靠改大小写绕过）', () => {
    for (let i = 0; i < rl.MAX_STRIKES; i++)
      rl.recordFailure('login', undefined, 'A@X.com');
    expect(() => rl.assertAllowed('login', undefined, 'a@x.com')).toThrow();
  });

  test('窗口内尝试过多也会被拦（体量限流，防批量枚举）', () => {
    rl.MAX_HITS_IN_WINDOW = 3;
    rl.assertAllowed('register', '6.6.6.6', 'k1@x.com');
    rl.assertAllowed('register', '6.6.6.6', 'k2@x.com');
    rl.assertAllowed('register', '6.6.6.6', 'k3@x.com');
    expect(() => rl.assertAllowed('register', '6.6.6.6', 'k4@x.com')).toThrow();
  });

  test('键数量上限：海量伪造 IP/邮箱不会撑爆内存', () => {
    rl.MAX_KEYS = 10;
    for (let i = 0; i < 200; i++)
      rl.assertAllowed('login', `10.0.0.${i}`, `user${i}@x.com`);
    expect(rl.size).toBeLessThanOrEqual(10);
  });

  test('定期清理：陈旧桶被回收，锁定期内的桶保留', () => {
    rl.assertAllowed('login', '7.7.7.7', 'old@x.com');
    const stale = rl.key('login', 'ip', '7.7.7.7');
    const bucket = rl.buckets.get(stale);
    bucket.updatedAt = Date.now() - (rl.WINDOW_MS + rl.LOCK_MAX_MS + 1000);
    bucket.hits = [];
    rl.assertAllowed('login', '8.8.8.8', 'locked@x.com');
    const lockedKey = rl.key('login', 'ip', '8.8.8.8');
    rl.buckets.get(lockedKey).lockedUntil = Date.now() + 60 * 1000;

    rl.sweep();
    expect(rl.buckets.has(stale)).toBe(false); // 陈旧桶回收
    expect(rl.buckets.has(lockedKey)).toBe(true); // 锁定期内不许被清理（否则锁形同虚设）
  });

  test('锁定到期后惰性解除（无需定时任务参与）', () => {
    for (let i = 0; i < rl.MAX_STRIKES; i++)
      rl.recordFailure('login', undefined, 'f@x.com'); // 只走账号维度，便于单独解锁
    const key = rl.key('login', 'account', 'f@x.com');
    expect(() => rl.assertAllowed('login', '9.9.9.9', 'f@x.com')).toThrow();
    rl.buckets.get(key).lockedUntil = Date.now() - 1; // 模拟锁定期满
    expect(() => rl.assertAllowed('login', '9.9.9.9', 'f@x.com')).not.toThrow();
  });

  test('二次锁定惩罚翻倍并封顶', () => {
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < rl.MAX_STRIKES; i++)
        rl.recordFailure('login', '11.1.1.1', 'g@x.com');
      const bucket = rl.buckets.get(rl.key('login', 'ip', '11.1.1.1'));
      bucket.lockedUntil = Date.now() - 1; // 立刻解锁进入下一轮
    }
    const bucket = rl.buckets.get(rl.key('login', 'ip', '11.1.1.1'));
    expect(bucket.lockCount).toBe(2);
    expect(rl.LOCK_BASE_MS * 2 ** (bucket.lockCount - 1)).toBeLessThanOrEqual(rl.LOCK_MAX_MS);
  });
});
