// Phase D 回归：登录防爆破 / WS isActive 校验 / fill 广播脱敏 / main.ts 安全装配（Swagger dev-only + backtest 限流）
const { AuthService } = require('../dist/src/modules/auth/auth.service');
const { MarketGateway } = require('../dist/src/modules/market/market.gateway');
const { sanitizeFill } = require('../dist/src/common/market-utils');
const { JwtService } = require('@nestjs/jwt');
const bcrypt = require('bcrypt');

describe('Phase D 登录账号级防爆破', () => {
  let bcryptSpy;
  beforeEach(() => { bcryptSpy = jest.spyOn(bcrypt, 'compare'); });
  afterEach(() => { bcryptSpy.mockRestore(); });

  function makeAuth(over = {}) {
    const userRepo = {
      findOne: over.findOne || (async () => ({ id: 'u1', username: 'alice', password: 'hashed', role: 'user', isActive: true })),
    };
    const jwt = { sign: jest.fn(() => 'tok') };
    const svc = new AuthService(userRepo, {}, jwt);
    return { svc, userRepo, jwt };
  }

  test('5 次错密码后第 6 次即使密码正确也锁定，且锁前置短路不跑 bcrypt', async () => {
    bcryptSpy.mockResolvedValue(false);
    const { svc } = makeAuth();
    for (let i = 0; i < 5; i++) {
      await expect(svc.login('alice', 'wrong')).rejects.toThrow('用户名或密码错误');
    }
    bcryptSpy.mockResolvedValue(true);
    await expect(svc.login('alice', 'right')).rejects.toThrow('尝试次数过多，账号已锁定10分钟');
    expect(bcryptSpy).toHaveBeenCalledTimes(5); // 第 6 次被锁前置短路
  });

  test('成功登录清零计数（错4次→成功→再错4次→第9次仍可登录）', async () => {
    const { svc, jwt } = makeAuth();
    bcryptSpy.mockResolvedValue(false);
    for (let i = 0; i < 4; i++) await expect(svc.login('alice', 'x')).rejects.toThrow();
    bcryptSpy.mockResolvedValue(true);
    await expect(svc.login('alice', 'right')).resolves.toEqual(expect.objectContaining({ token: 'tok' }));
    expect(svc.loginFails.has('alice')).toBe(false);
    bcryptSpy.mockResolvedValue(false);
    for (let i = 0; i < 4; i++) await expect(svc.login('alice', 'x')).rejects.toThrow('用户名或密码错误');
    bcryptSpy.mockResolvedValue(true);
    await expect(svc.login('alice', 'right')).resolves.toEqual(expect.objectContaining({ token: 'tok' }));
    expect(jwt.sign).toHaveBeenCalled();
  });

  test('不存在的用户名同样计数锁定，且错误文案与密码错误一致（防枚举）', async () => {
    const { svc } = makeAuth({ findOne: async () => null });
    for (let i = 0; i < 5; i++) {
      await expect(svc.login('ghost', 'x')).rejects.toThrow('用户名或密码错误');
    }
    await expect(svc.login('ghost', 'x')).rejects.toThrow('尝试次数过多，账号已锁定10分钟');
    expect(bcryptSpy).not.toHaveBeenCalled();
  });

  test('username 规范化：trim 后共享计数与查询键', async () => {
    const findOne = jest.fn(async () => null);
    const { svc } = makeAuth({ findOne });
    for (let i = 0; i < 4; i++) await expect(svc.login('alice', 'x')).rejects.toThrow('用户名或密码错误');
    await expect(svc.login(' alice ', 'x')).rejects.toThrow('用户名或密码错误'); // 第 5 次共享计数即锁定（锁定从下次生效）
    await expect(svc.login(' alice ', 'x')).rejects.toThrow('尝试次数过多，账号已锁定10分钟');
    expect(findOne.mock.calls.at(-1)[0].where.username).toBe('alice'); // trim 后查询
  });

  test('锁定期满自动解除（LOGIN_LOCK_MS 覆写为 1ms 实测恢复）', async () => {
    bcryptSpy.mockResolvedValue(false);
    const { svc } = makeAuth();
    svc.LOGIN_LOCK_MS = 1;
    for (let i = 0; i < 5; i++) await expect(svc.login('alice', 'x')).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 15));
    bcryptSpy.mockResolvedValue(true);
    await expect(svc.login('alice', 'right')).resolves.toEqual(expect.objectContaining({ token: 'tok' }));
  });
});

describe('Phase D WS 握手 isActive 校验', () => {
  const jwtSvc = new JwtService({ secret: 'phase10-test-secret-0123456789' });
  const token = jwtSvc.sign({ sub: 'u1', username: 'bob', role: 'user' });
  function fakeClient(t = token) {
    return { id: 'c1', handshake: { auth: { token: t } }, disconnect: jest.fn() };
  }

  test('isActive=false 用户被断开', async () => {
    const userRepo = { findOne: async () => ({ id: 'u1', isActive: false }) };
    const gw = new MarketGateway(jwtSvc, userRepo);
    const client = fakeClient();
    await gw.handleConnection(client);
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  test('用户不存在（findOne null）断开', async () => {
    const gw = new MarketGateway(jwtSvc, { findOne: async () => null });
    const client = fakeClient();
    await gw.handleConnection(client);
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  test('isActive=true 放行并计数', async () => {
    const gw = new MarketGateway(jwtSvc, { findOne: async () => ({ id: 'u1', isActive: true }) });
    const client = fakeClient();
    await gw.handleConnection(client);
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(gw.clients).toBe(1);
  });

  test('缺 token 与坏 token 仍断开（回归既有行为）', async () => {
    const gw = new MarketGateway(jwtSvc, { findOne: async () => ({ id: 'u1', isActive: true }) });
    const c1 = fakeClient(null);
    await gw.handleConnection(c1);
    expect(c1.disconnect).toHaveBeenCalledWith(true);
    const c2 = fakeClient('bad-token');
    await gw.handleConnection(c2);
    expect(c2.disconnect).toHaveBeenCalledWith(true);
    expect(gw.clients).toBe(0);
  });
});

describe('Phase D fill 广播脱敏（sanitizeFill 纯函数）', () => {
  const input = {
    symbol: 'T1', side: 'buy', filledQuantity: 100, avgPrice: 45.3, totalCost: 4530,
    fees: { totalFees: 1.13 },
    counterFills: [
      { orderId: 'o1', accountId: 'a1', side: 'sell', price: 45.3, qty: 60, virtual: false, mmId: 'm1' },
      { orderId: null, accountId: null, side: 'sell', price: 45.31, qty: 40, virtual: true },
    ],
  };

  test('剥离对手方 accountId/orderId/mmId，保留展示字段', () => {
    const out = sanitizeFill(input);
    expect(out.counterFills).toEqual([
      { side: 'sell', price: 45.3, qty: 60, virtual: false },
      { side: 'sell', price: 45.31, qty: 40, virtual: true },
    ]);
    expect(out.filledQuantity).toBe(100);
    expect(out.avgPrice).toBe(45.3);
    expect(out.fees).toEqual({ totalFees: 1.13 });
    expect(JSON.stringify(out)).not.toMatch(/orderId|accountId|mmId/);
  });

  test('不修改输入（纯函数）', () => {
    sanitizeFill(input);
    expect(input.counterFills[0].accountId).toBe('a1');
    expect(input.counterFills[0].orderId).toBe('o1');
  });

  test('边界：counterFills 缺失/null/空数组', () => {
    expect(sanitizeFill(null)).toBe(null);
    expect(sanitizeFill(undefined)).toBe(undefined);
    const noCf = sanitizeFill({ symbol: 'T1' });
    expect(noCf.counterFills).toBeUndefined();
    expect(sanitizeFill({ counterFills: [] }).counterFills).toEqual([]);
  });
});

describe('Phase D main.ts 安全装配（静态抽查编译产物）', () => {
  // 静态断言防"改没了/忘加"；main.ts 属于 Nest 装配层，起完整 app 代价高（DB/定时器/SANDBOX_FAST 校验），
  // 服务层行为已由上方单测覆盖，装配层以字符串断言锁门槛。
  const fs = require('fs');
  const path = require('path');
  const mainJs = fs.readFileSync(path.resolve(__dirname, '../dist/src/main.js'), 'utf8');

  test('backtest 限流已挂载（/api/market/backtest 20次/分）', () => {
    expect(mainJs).toContain("'/api/market/backtest'");
    expect(mainJs).toMatch(/windowMs: 60 \* 1000[\s\S]{0,400}max: 20/);
  });

  test('Swagger 仅在 NODE_ENV=development 门内 setup', () => {
    expect(mainJs).toContain("process.env.NODE_ENV === 'development'");
    const gateIdx = mainJs.indexOf("process.env.NODE_ENV === 'development'");
    const setupIdx = mainJs.indexOf('SwaggerModule.setup');
    expect(setupIdx).toBeGreaterThan(gateIdx);
  });
});
