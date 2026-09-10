// Phase 14 回归：R5-④ 登录锁定按「用户名+IP」计数 / R5-⑦ WS 每用户连接上限 / R5-⑩ synchronize 由 DB_SYNCHRONIZE 控制
require('reflect-metadata'); // AppModule 的 @Module 元数据依赖（线上由 main.ts 首行加载，测试里须先于 app.module 导入）
const { AuthService } = require('../dist/src/modules/auth/auth.service');
const { MarketGateway } = require('../dist/src/modules/market/market.gateway');
const { JwtService } = require('@nestjs/jwt');
const { Logger } = require('@nestjs/common');
const bcrypt = require('bcrypt');

// app.module 的 require 懒加载（放在用例/钩子里）：① 它会把整个应用模块图拉起来，
// 万一装配层临时不可 require，也只影响 R5-⑩ 那一组用例，不连坐登录/WS 用例；
// ② config 的 forRoot 在 require 时读 .env 并把缺失键补进 process.env（只补不覆盖），
// 故快照/还原一次，避免污染同 worker 内的其它用例。
function loadAppModule() {
  const envBefore = { ...process.env };
  const mod = require('../dist/src/app.module');
  for (const key of Object.keys(process.env)) {
    if (!(key in envBefore))
      delete process.env[key];
  }
  return mod.AppModule;
}

describe('Phase 14 R5-④ 登录锁定按「用户名+IP」计数（消除账号锁定 DoS）', () => {
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
  // 连错 n 次（断言每次都走「用户名或密码错误」而非锁定文案）
  async function failTimes(svc, n, username, ip) {
    for (let i = 0; i < n; i++)
      await expect(svc.login(username, 'x', ip)).rejects.toThrow('用户名或密码错误');
  }
  const LOCK_MSG = '尝试次数过多，账号已锁定10分钟';

  test('①攻击者 IP 连错 5 次锁死自己，另一 IP 首错仍正常校验并可登录（无法再锁他人账号）', async () => {
    bcryptSpy.mockResolvedValue(false);
    const { svc } = makeAuth();
    await failTimes(svc, 5, 'alice', '10.0.0.9');
    await expect(svc.login('alice', 'right', '10.0.0.9')).rejects.toThrow(LOCK_MSG); // 攻击者 IP 自己被锁
    await expect(svc.login('alice', 'x', '192.168.1.7')).rejects.toThrow('用户名或密码错误'); // 受害者 IP 不受影响
    bcryptSpy.mockResolvedValue(true);
    await expect(svc.login('alice', 'right', '192.168.1.7'))
      .resolves.toEqual(expect.objectContaining({ token: 'tok' }));
  });

  test('②同用户名同 IP 连错 5 次仍锁 10 分钟、锁前置短路不跑 bcrypt、到期惰性解除', async () => {
    bcryptSpy.mockResolvedValue(false);
    const { svc } = makeAuth();
    await failTimes(svc, 5, 'alice', '1.1.1.1');
    const rec = svc.loginFails.get('alice|1.1.1.1');
    const remain = rec.lockedUntil - Date.now();
    expect(remain).toBeGreaterThan(9 * 60 * 1000); // 锁定期 ≈10 分钟（未被缩短）
    expect(remain).toBeLessThanOrEqual(10 * 60 * 1000);
    bcryptSpy.mockResolvedValue(true);
    await expect(svc.login('alice', 'right', '1.1.1.1')).rejects.toThrow(LOCK_MSG);
    expect(bcryptSpy).toHaveBeenCalledTimes(5); // 第 6 次锁前置短路，不查库不跑 bcrypt
    rec.lockedUntil = Date.now() - 1; // 模拟锁定期满（免等 10 分钟）
    await expect(svc.login('alice', 'right', '1.1.1.1'))
      .resolves.toEqual(expect.objectContaining({ token: 'tok' }));
  });

  test('③缺 IP 参数时退化为「用户名|local」（既有调用不回归），且与真实 IP 键互相隔离', async () => {
    bcryptSpy.mockResolvedValue(false);
    const { svc } = makeAuth();
    await failTimes(svc, 5, 'alice'); // 旧签名（phase10 既有单测口径）
    expect(svc.loginFails.has('alice|local')).toBe(true);
    expect(svc.loginFails.has('alice')).toBe(false); // 旧键（裸用户名）不再使用
    await expect(svc.login('alice', 'right')).rejects.toThrow(LOCK_MSG);
    await expect(svc.login('alice', 'x', '2.2.2.2')).rejects.toThrow('用户名或密码错误'); // 带 IP 不吃 local 的锁
    // trim 规范化与既有实现一致：' alice ' 与 'alice' 共享同一个 IP 键
    await failTimes(svc, 1, ' alice ', '2.2.2.2');
    expect(svc.loginFails.get('alice|2.2.2.2').failCount).toBe(2);
  });

  test('④成功登录只清本键：同用户其他 IP 的失败计数保留（互不串扰）', async () => {
    bcryptSpy.mockResolvedValue(false);
    const { svc } = makeAuth();
    await failTimes(svc, 4, 'alice', '3.3.3.3');
    await failTimes(svc, 4, 'alice', '4.4.4.4');
    bcryptSpy.mockResolvedValue(true);
    await expect(svc.login('alice', 'right', '3.3.3.3'))
      .resolves.toEqual(expect.objectContaining({ token: 'tok' }));
    expect(svc.loginFails.has('alice|3.3.3.3')).toBe(false); // 本键清零
    expect(svc.loginFails.get('alice|4.4.4.4').failCount).toBe(4); // 其他 IP 计数原样保留
    bcryptSpy.mockResolvedValue(false);
    await expect(svc.login('alice', 'x', '4.4.4.4')).rejects.toThrow('用户名或密码错误'); // 第 5 次即锁定
    await expect(svc.login('alice', 'x', '4.4.4.4')).rejects.toThrow(LOCK_MSG);
    bcryptSpy.mockResolvedValue(true);
    await expect(svc.login('alice', 'right', '3.3.3.3')) // 另一 IP 仍可登录
      .resolves.toEqual(expect.objectContaining({ token: 'tok' }));
  });

  test('⑤不存在的用户名同样按「用户名|IP」计数锁定，文案一致（防枚举语义保持）', async () => {
    const { svc } = makeAuth({ findOne: async () => null });
    await failTimes(svc, 5, 'ghost', '5.5.5.5');
    await expect(svc.login('ghost', 'x', '5.5.5.5')).rejects.toThrow(LOCK_MSG);
    expect(bcryptSpy).not.toHaveBeenCalled();
    await expect(svc.login('ghost', 'x', '6.6.6.6')).rejects.toThrow('用户名或密码错误'); // 换 IP 仍需重新计数
  });
});

describe('Phase 14 R5-⑦ WS 每用户连接上限', () => {
  const jwtSvc = new JwtService({ secret: 'phase14-test-secret-0123456789' });
  const tokenFor = (sub) => jwtSvc.sign({ sub, username: 'u' + sub, role: 'user' });
  function fakeClient(id, sub = 'u1', token = tokenFor(sub)) {
    return { id, handshake: { auth: { token } }, data: {}, disconnect: jest.fn(), emit: jest.fn() };
  }
  // 按 token 里的 sub 返回对应用户：per-user 上限判定依赖 userId，u1/u2 必须可区分
  const userRepo = () => ({ findOne: async ({ where }) => ({ id: where.id, isActive: true }) });

  test('①单用户前 5 个连接保留，第 6 个被拒并收到提示（clients 与已连集合均不变）', async () => {
    const gw = new MarketGateway(jwtSvc, userRepo());
    const warnSpy = jest.spyOn(gw.logger, 'warn').mockImplementation(() => {});
    expect(gw.MAX_CONNECTIONS_PER_USER).toBe(5); // 具名常量：多标签/多设备够用，防连接放大
    const kept = [];
    for (let i = 0; i < 5; i++) {
      const c = fakeClient('c' + i);
      kept.push(c);
      await gw.handleConnection(c);
    }
    expect(gw.clients).toBe(5);
    expect(gw.userConnections.get('u1').size).toBe(5);
    kept.forEach((c) => expect(c.disconnect).not.toHaveBeenCalled());

    const sixth = fakeClient('c6');
    await gw.handleConnection(sixth);
    expect(sixth.emit).toHaveBeenCalledWith('error', { message: '连接数超限' });
    expect(sixth.disconnect).toHaveBeenCalledWith(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('连接数超限'));
    expect(gw.clients).toBe(5); // 被拒连接不计数
    expect(sixth.data.__counted).toBeUndefined(); // 未打计数标记
    expect(gw.userConnections.get('u1').size).toBe(5);
    gw.handleDisconnect(sixth); // 其断连兜底不得影响在线数/集合
    expect(gw.clients).toBe(5);
    expect(gw.userConnections.get('u1').size).toBe(5);
    warnSpy.mockRestore();
  });

  test('②断开后集合收缩：释放名额后可再连；全部断开后键被回收', async () => {
    const gw = new MarketGateway(jwtSvc, userRepo());
    const cs = [];
    for (let i = 0; i < 5; i++) {
      const c = fakeClient('s' + i);
      cs.push(c);
      await gw.handleConnection(c);
    }
    gw.handleDisconnect(cs[0]);
    expect(gw.userConnections.get('u1').size).toBe(4);
    expect(gw.clients).toBe(4);
    const again = fakeClient('s-new');
    await gw.handleConnection(again); // 第 6 个位置释放后重连成功
    expect(again.disconnect).not.toHaveBeenCalled();
    expect(gw.userConnections.get('u1').size).toBe(5);
    expect(gw.clients).toBe(5);
    for (const c of [...cs.slice(1), again])
      gw.handleDisconnect(c);
    expect(gw.userConnections.has('u1')).toBe(false); // 空集合回收，不留键
    expect(gw.clients).toBe(0);
  });

  test('③上限按用户隔离；重复断连只收缩一次；认证失败连接不进集合', async () => {
    const gw = new MarketGateway(jwtSvc, userRepo());
    for (let i = 0; i < 5; i++)
      await gw.handleConnection(fakeClient('a' + i, 'u1'));
    const other = fakeClient('b0', 'u2');
    await gw.handleConnection(other); // u1 占满不影响 u2
    expect(other.disconnect).not.toHaveBeenCalled();
    expect(gw.clients).toBe(6);
    const bad = fakeClient('bad', 'u1', 'bad-token');
    await gw.handleConnection(bad);
    expect(bad.disconnect).toHaveBeenCalledWith(true);
    expect(gw.userConnections.get('u1').size).toBe(5); // 认证失败连接不入集合
    expect(gw.clients).toBe(6);
    gw.handleDisconnect(other);
    gw.handleDisconnect(other); // 重复断连：集合已回收，第二次为 no-op
    expect(gw.clients).toBe(5);
    expect(gw.userConnections.has('u2')).toBe(false);
    expect(gw.userConnections.get('u1').size).toBe(5);
  });
});

describe('Phase 14 R5-⑩ synchronize 受 DB_SYNCHRONIZE 控制（读取真实装配的 TypeORM options 工厂）', () => {
  // 从 @Module 元数据里挖出 TypeOrmModule.forRootAsync 的 options 工厂：断言的是真实装配，
  // 而不是在测试里重抄一份配置（重抄无法发现生产装配被改回硬编码 true）
  function findTypeOrmOptionsFactory() {
    const seen = new Set();
    const walk = (value) => {
      if (!value || typeof value !== 'object' || seen.has(value))
        return null;
      seen.add(value);
      if (Array.isArray(value)) {
        for (const item of value) {
          const hit = walk(item);
          if (hit)
            return hit;
        }
        return null;
      }
      if (Array.isArray(value.providers)) {
        const provider = value.providers.find((p) => p && typeof p.useFactory === 'function' && /TypeOrmModuleOptions/.test(String(p.provide)));
        if (provider)
          return provider.useFactory;
      }
      return walk(value.imports);
    };
    return walk(Reflect.getMetadata('imports', AppModule));
  }
  // 假 ConfigService：只提供指定键，其余走调用方默认值（等价 ConfigService.get(path, default)）
  const fakeConfig = (env) => ({ get: (key, def) => (key in env ? env[key] : def) });
  let AppModule;
  let factory;
  beforeAll(() => {
    AppModule = loadAppModule();
    factory = findTypeOrmOptionsFactory();
  });

  test('工厂可从装配元数据取出（结构未变）', () => {
    expect(typeof factory).toBe('function');
  });

  test('DB_SYNCHRONIZE=false 时三个分支（postgres/sqlite/sqljs）均为 false；未设置时默认 true（向后兼容）', () => {
    for (const dbType of ['postgres', 'sqlite', 'sqljs']) {
      const base = { DB_TYPE: dbType, DB_PASSWORD: 'pw' };
      expect(factory(fakeConfig({ ...base, DB_SYNCHRONIZE: 'false' })).synchronize).toBe(false);
      expect(factory(fakeConfig({ ...base })).synchronize).toBe(true);
    }
  });

  test('生产环境 + synchronize=true 仅告警不抛错；已关闭或非生产不告警', () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const opts = factory(fakeConfig({ DB_TYPE: 'sqlite', NODE_ENV: 'production' }));
    expect(opts.synchronize).toBe(true); // 只告警，不改变行为（保持向后兼容）
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('DB_SYNCHRONIZE'));
    warnSpy.mockClear();
    factory(fakeConfig({ DB_TYPE: 'sqlite', NODE_ENV: 'production', DB_SYNCHRONIZE: 'false' }));
    factory(fakeConfig({ DB_TYPE: 'sqlite', NODE_ENV: 'development' }));
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
