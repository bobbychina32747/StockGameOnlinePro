import { MAX_CLIENT_ORDER_ID_LENGTH, newClientOrderId, shouldKeepClientOrderId } from './orderIdempotency';

// 可见 ASCII（不含空白/控制字符）——幂等键要能原样穿过 JSON 与网关
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;
// 回退路径形态：<时间戳 36 进制>-<随机 36 进制>
const FALLBACK_SHAPE = /^[0-9a-z]+-[0-9a-z]+$/;

describe('newClientOrderId', () => {
  it('非空、长度 ≤64、纯 ASCII', () => {
    for (let i = 0; i < 100; i++) {
      const id = newClientOrderId();
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
      expect(id.length).toBeLessThanOrEqual(MAX_CLIENT_ORDER_ID_LENGTH);
      expect(id).toMatch(VISIBLE_ASCII);
    }
  });

  it('连续调用 100 次不重复', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(newClientOrderId());
    expect(ids.size).toBe(100);
  });

  it('同一毫秒内批量生成 100 个也不碰撞（回退路径的时间戳相同，靠随机段区分）', () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) ids.add(newClientOrderId());
      expect(ids.size).toBe(100);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('crypto.randomUUID 不可用时走回退路径且仍满足约束', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    // 模拟老浏览器/非安全上下文：crypto 存在但没有 randomUUID
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true, writable: true });
    try {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const id = newClientOrderId();
        expect(id).toMatch(FALLBACK_SHAPE);
        expect(id.length).toBeGreaterThan(0);
        expect(id.length).toBeLessThanOrEqual(MAX_CLIENT_ORDER_ID_LENGTH);
        expect(id).toMatch(VISIBLE_ASCII);
        ids.add(id);
      }
      expect(ids.size).toBe(100);
    } finally {
      if (original) Object.defineProperty(globalThis, 'crypto', original);
      else delete (globalThis as { crypto?: unknown }).crypto;
    }
  });

  it('randomUUID 返回空串或含非法字符时仍产出合法 ASCII 幂等键', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: { randomUUID: () => '' }, configurable: true, writable: true });
    try {
      // 空串 → 回退路径
      expect(newClientOrderId()).toMatch(FALLBACK_SHAPE);
    } finally {
      if (original) Object.defineProperty(globalThis, 'crypto', original);
      else delete (globalThis as { crypto?: unknown }).crypto;
    }

    const original2 = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: { randomUUID: () => ' 中文 id\n' }, configurable: true, writable: true });
    try {
      // 非法字符被剥离（剥离后仍有内容则直接用），保证纯 ASCII + 长度上限
      const id = newClientOrderId();
      expect(id).toMatch(VISIBLE_ASCII);
      expect(id.length).toBeLessThanOrEqual(MAX_CLIENT_ORDER_ID_LENGTH);
    } finally {
      if (original2) Object.defineProperty(globalThis, 'crypto', original2);
      else delete (globalThis as { crypto?: unknown }).crypto;
    }
  });
});

describe('shouldKeepClientOrderId', () => {
  it('无 response 的网络错误（ERR_NETWORK）→ true（请求可能已到达服务端）', () => {
    expect(
      shouldKeepClientOrderId({ isAxiosError: true, code: 'ERR_NETWORK', message: 'Network Error', request: {} }),
    ).toBe(true);
  });

  it('客户端超时 ECONNABORTED → true（服务端可能已受理，只是响应没回来）', () => {
    expect(shouldKeepClientOrderId({ isAxiosError: true, code: 'ECONNABORTED', message: 'timeout of 15000ms exceeded' })).toBe(true);
  });

  it('5xx → true（服务端处理中出错，订单可能已落库）', () => {
    expect(shouldKeepClientOrderId({ isAxiosError: true, code: 'ERR_BAD_RESPONSE', response: { status: 500 } })).toBe(true);
    expect(shouldKeepClientOrderId({ response: { status: 502 } })).toBe(true);
    expect(shouldKeepClientOrderId({ response: { status: 503, data: { message: 'unavailable' } } })).toBe(true);
  });

  it('5xx 即使 body 带 success:false 也判 true（状态码更权威，宁可复用不可漏单）', () => {
    expect(shouldKeepClientOrderId({ response: { status: 500, data: { success: false } } })).toBe(true);
  });

  it('4xx 业务/校验拒绝 → false（服务端明确未受理，必须换新 id）', () => {
    expect(shouldKeepClientOrderId({ isAxiosError: true, code: 'ERR_BAD_REQUEST', response: { status: 400 } })).toBe(false);
    expect(shouldKeepClientOrderId({ response: { status: 422, data: { message: '数量不合法' } } })).toBe(false);
    expect(shouldKeepClientOrderId({ response: { status: 401 } })).toBe(false);
    expect(shouldKeepClientOrderId({ response: { status: 403 } })).toBe(false);
  });

  it('success:false 形态的业务拒绝 → false（订单不存在，复用旧 id 会让下次合法提交被误判重复）', () => {
    expect(shouldKeepClientOrderId({ success: false, error: '可用资金不足' })).toBe(false);
    expect(shouldKeepClientOrderId({ response: { status: 200, data: { success: false } } })).toBe(false);
  });

  it('undefined / 普通 Error / 无 axios 痕迹的对象 → false', () => {
    // 口径理由：这些形态说明请求根本没由 axios 发出去（本地代码异常或调用方没传错误），
    // 服务端不可能已受理 → 按业务失败换新 id。换 id 最坏只是去重窗口重置，误保留则会吞掉真实订单。
    expect(shouldKeepClientOrderId(undefined)).toBe(false);
    expect(shouldKeepClientOrderId(null)).toBe(false);
    expect(shouldKeepClientOrderId(new Error('boom'))).toBe(false);
    expect(shouldKeepClientOrderId('some string')).toBe(false);
    expect(shouldKeepClientOrderId({})).toBe(false);
  });

  it('无 response 但有 axios 请求痕迹（isAxiosError / request）→ true（结果未知，保守复用）', () => {
    expect(shouldKeepClientOrderId({ isAxiosError: true })).toBe(true);
    expect(shouldKeepClientOrderId({ request: {} })).toBe(true);
    expect(shouldKeepClientOrderId({ isAxiosError: true, code: 'ERR_CANCELED' })).toBe(true);
  });
});
