// 统一身份 · Cloudflare Turnstile 人机验证（注册 / 忘记口令）
// 全程用假 fetch 注入：不打真网络、不依赖 CF 可达性，也不触碰任何真实密钥。
const { plainToInstance } = require('class-transformer');
const { validate } = require('class-validator');

const { createHarness, expectStatus, TEST_PASSWORD } = require('./_harness');
const { TurnstileService, TURNSTILE_VERIFY_URL } = require('../../../../dist/src/modules/identity/turnstile.service');
const { IdentityController } = require('../../../../dist/src/modules/identity/identity.controller');
const { RegisterDto, LoginDto, ResetRequestDto } = require('../../../../dist/src/modules/identity/dto/identity.dto');

const SECRET = 'test-secret-not-a-real-key';
const OK = { status: 200, json: { success: true, 'error-codes': [] } };
const BAD = { status: 200, json: { success: false, 'error-codes': ['invalid-input-response'] } };
/** 完整成功响应：带 CF 回报的 action/hostname（生产实测形状） */
const OK_FULL = { status: 200, json: { success: true, 'error-codes': [], action: 'register', hostname: 'bobbycn.cc' } };

/** 造一个带调用记录的假 fetch；未预期会发请求时直接抛错（防止用例悄悄打真网络） */
function makeService(env, responder) {
  const calls = [];
  const svc = new TurnstileService();
  svc.env = env;
  svc.fetchImpl = async (url, init) => {
    calls.push({ url, init, form: new URLSearchParams(String(init && init.body)) });
    if (!responder)
      throw new Error('本用例不应发起 Turnstile 校验请求');
    const out = responder(calls.length);
    if (out && out.networkError)
      throw new Error('ECONNREFUSED');
    return { status: (out && out.status) || 200, json: async () => (out && out.json) || {} };
  };
  return { svc, calls };
}

const SECRET_ENV = (mode) => ({ TURNSTILE_SECRET: SECRET, TURNSTILE_MODE: mode });

describe('统一身份 · Turnstile 人机验证', () => {
  let h;
  afterEach(async () => { if (h) await h.close(); h = null; });

  // ───────────────────── 模式矩阵 ─────────────────────

  test('默认模式是 optional；off / required / 非法值 的解析口径固定', () => {
    expect(makeService({}, null).svc.mode()).toBe('optional');
    expect(makeService({ TURNSTILE_MODE: 'OFF' }, null).svc.mode()).toBe('off');
    expect(makeService({ TURNSTILE_MODE: 'required' }, null).svc.mode()).toBe('required');
    expect(makeService({ TURNSTILE_MODE: 'nonsense' }, null).svc.mode()).toBe('optional'); // 非法值不静默变成 off
  });

  test('optional + 未配密钥：放行且完全不发校验请求', async () => {
    const { svc, calls } = makeService({ TURNSTILE_MODE: 'optional' }, null);
    await expect(svc.assertHuman('前端传来的token', '1.2.3.4')).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  test('optional + 配了密钥但前端没带 token：过渡期放行（不打网络）', async () => {
    const { svc, calls } = makeService(SECRET_ENV('optional'), null);
    await expect(svc.assertHuman(undefined, '1.2.3.4')).resolves.toBeUndefined();
    await expect(svc.assertHuman('', '1.2.3.4')).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  test('off：即使配了密钥、带了 token 也完全跳过', async () => {
    const { svc, calls } = makeService(SECRET_ENV('off'), null);
    await expect(svc.assertHuman('whatever', '1.2.3.4')).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  // ───────────────────── 校验请求的形状与结果 ─────────────────────

  test('verify：POST 到 CF siteverify，表单含 secret/response/remoteip，结果映射为 {ok,errorCodes,action,hostname}', async () => {
    const { svc, calls } = makeService(SECRET_ENV('optional'), () => OK);
    await expect(svc.verify('cf-token-abc', '1.2.3.4')).resolves.toEqual({ ok: true, errorCodes: [], action: '', hostname: '' });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(TURNSTILE_VERIFY_URL);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(calls[0].form.get('secret')).toBe(SECRET);
    expect(calls[0].form.get('response')).toBe('cf-token-abc');
    expect(calls[0].form.get('remoteip')).toBe('1.2.3.4');

    const bad = makeService(SECRET_ENV('optional'), () => BAD);
    await expect(bad.svc.verify('cf-token-abc')).resolves.toEqual({ ok: false, errorCodes: ['invalid-input-response'], action: '', hostname: '' });
    expect(bad.calls[0].form.get('remoteip')).toBeNull(); // 无 IP 时不带该字段

    // action/hostname 原样透传（assertHuman 靠它做本站面纵深校验）
    const full = makeService(SECRET_ENV('optional'), () => OK_FULL);
    await expect(full.svc.verify('cf-token-abc')).resolves.toMatchObject({ ok: true, action: 'register', hostname: 'bobbycn.cc' });
  });

  // ───────────────────── 纵深校验：action / hostname ─────────────────────

  test('站面纵深校验：别的站点或别的页面签出的 token 不能搬来复用', async () => {
    const env = { ...SECRET_ENV('required'), TURNSTILE_HOSTNAMES: 'bobbycn.cc,game.bobbycn.cc' };

    // 本站 + 正确 action → 放行
    const good = makeService(env, () => OK_FULL);
    await expect(good.svc.assertHuman('tok', '1.2.3.4', 'register')).resolves.toBeUndefined();

    // 同一张 token 拿去顶"忘记口令"入口 → 拒（期望 bobbycn.cc 会报 action=register）
    const swapped = makeService(env, () => OK_FULL);
    await expectStatus(() => swapped.svc.assertHuman('tok', '1.2.3.4', 'password-reset'), 400);

    // 别的域名签出的 token → 拒
    const foreign = makeService(env, () => ({ status: 200, json: { success: true, 'error-codes': [], action: 'register', hostname: 'evil.example.com' } }));
    await expectStatus(() => foreign.svc.assertHuman('tok', '1.2.3.4', 'register'), 400);

    // 子域按清单放行
    const sub = makeService(env, () => ({ status: 200, json: { success: true, 'error-codes': [], action: 'register', hostname: 'game.bobbycn.cc' } }));
    await expect(sub.svc.assertHuman('tok', '1.2.3.4', 'register')).resolves.toBeUndefined();

    // 字段缺失（CF 某些模式不回报）→ 不拦，避免把注册口打死
    const bare = makeService(env, () => OK);
    await expect(bare.svc.assertHuman('tok', '1.2.3.4', 'register')).resolves.toBeUndefined();

    // 默认清单不含 localhost：本机签出的 token 不该被当成生产流量
    expect(makeService({}, null).svc.allowedHostnames()).toEqual(['bobbycn.cc', 'game.bobbycn.cc']);
  });

  test('optional + 带 token 但校验失败：400（带了 token 就必须过，否则校验形同虚设）', async () => {
    const { svc, calls } = makeService(SECRET_ENV('optional'), () => BAD);
    await expectStatus(() => svc.assertHuman('bad-token', '1.2.3.4'), 400);
    expect(calls).toHaveLength(1);

    // 超长 token 直接拒，不浪费一次网络往返
    const long = makeService(SECRET_ENV('optional'), () => OK);
    await expectStatus(() => long.svc.assertHuman('x'.repeat(4097), '1.2.3.4'), 400);
    expect(long.calls).toHaveLength(0);
  });

  test('required + 未带 token：400 且不发校验请求', async () => {
    const { svc, calls } = makeService(SECRET_ENV('required'), null);
    await expectStatus(() => svc.assertHuman(undefined, '1.2.3.4'), 400);
    await expectStatus(() => svc.assertHuman('', '1.2.3.4'), 400);
    expect(calls).toHaveLength(0);
  });

  test('required + 校验失败：400；校验通过：放行', async () => {
    const failed = makeService(SECRET_ENV('required'), () => BAD);
    await expectStatus(() => failed.svc.assertHuman('bad-token', '1.2.3.4'), 400);

    const passed = makeService(SECRET_ENV('required'), () => OK);
    await expect(passed.svc.assertHuman('good-token', '1.2.3.4')).resolves.toBeUndefined();
    expect(passed.calls).toHaveLength(1);
  });

  test('required 但未配密钥：fail-closed 400（配置事故不能静默把注册口敞开）', async () => {
    const { svc, calls } = makeService({ TURNSTILE_MODE: 'required' }, null);
    await expectStatus(() => svc.assertHuman('any', '1.2.3.4'), 400);
    expect(calls).toHaveLength(0);
  });

  test('CF 不可达：optional 放行（不封注册口）、required 拦截', async () => {
    const optional = makeService(SECRET_ENV('optional'), () => ({ networkError: true }));
    await expect(optional.svc.assertHuman('tok', '1.2.3.4')).resolves.toBeUndefined();
    const required = makeService(SECRET_ENV('required'), () => ({ networkError: true }));
    await expectStatus(() => required.svc.assertHuman('tok', '1.2.3.4'), 400);
    // 响应体不是预期形状（CF 返回 5xx/HTML）同样按失败处理
    const garbage = makeService(SECRET_ENV('optional'), () => ({ status: 502, json: { oops: true } }));
    await expectStatus(() => garbage.svc.assertHuman('tok', '1.2.3.4'), 400);
  });

  // ───────────────────── DTO 契约（whitelist 陷阱） ─────────────────────

  test('DTO 收得下 cfToken：三个入口都不会被 whitelist+forbidNonWhitelisted 400 掉', async () => {
    const cases = [
      [RegisterDto, { email: 'a@b.com', password: TEST_PASSWORD }],
      [LoginDto, { email: 'a@b.com', password: 'x' }],
      [ResetRequestDto, { email: 'a@b.com' }],
    ];
    for (const [Dto, base] of cases) {
      const dto = plainToInstance(Dto, { ...base, cfToken: 'turnstile-token' });
      expect(dto.cfToken).toBe('turnstile-token');
      const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
      expect(errors).toHaveLength(0);
      // 不传 cfToken 也合法（optional 模式的前端还没挂 widget）
      const plain = plainToInstance(Dto, { ...base });
      expect(await validate(plain, { whitelist: true, forbidNonWhitelisted: true })).toHaveLength(0);
    }
  });

  // ───────────────────── 端点接入 ─────────────────────

  test('注册端点：required 模式下无 token/校验失败都不落库不发信；通过后照常建 pending 身份并发验证邮件', async () => {
    h = await createHarness();
    const good = makeService(SECRET_ENV('required'), () => OK);
    const controller = new IdentityController(h.service, {}, {}, good.svc);
    const req = { ip: '10.0.0.9' };

    await expectStatus(() => controller.register({ email: 'ts1@example.com', password: TEST_PASSWORD }, req), 400);
    expect(await h.repos.identity.count()).toBe(0);   // 被拦住的请求不产生任何副作用
    expect(h.sent).toHaveLength(0);                   // 也不消耗邮件配额

    const bad = makeService(SECRET_ENV('required'), () => BAD);
    const controller2 = new IdentityController(h.service, {}, {}, bad.svc);
    await expectStatus(() => controller2.register({ email: 'ts1@example.com', password: TEST_PASSWORD, cfToken: 'bad' }, req), 400);
    expect(await h.repos.identity.count()).toBe(0);

    await expect(controller.register({ email: 'ts1@example.com', password: TEST_PASSWORD, cfToken: 'good' }, req))
      .resolves.toMatchObject({ success: true });
    expect((await h.repos.identity.findOne({ where: { email: 'ts1@example.com' } })).status).toBe('pending');
    expect(h.sent).toHaveLength(1);
  });

  test('忘记口令端点：同样受闸；optional 未配密钥时既有行为不受影响', async () => {
    h = await createHarness();
    await h.registerAndVerify('ts2@example.com');

    const required = makeService(SECRET_ENV('required'), () => OK);
    const controller = new IdentityController(h.service, {}, {}, required.svc);
    await expectStatus(() => controller.resetRequest({ email: 'ts2@example.com' }, { ip: '10.0.0.9' }), 400);
    expect(h.sent).toHaveLength(1); // 只有注册那封验证邮件，重置邮件没发出去

    // 回归：没配密钥（过渡期）时，注册与忘记口令与阶段一之前完全一致
    const legacy = makeService({}, null);
    const legacyController = new IdentityController(h.service, {}, {}, legacy.svc);
    await expect(legacyController.resetRequest({ email: 'ts2@example.com' }, { ip: '10.0.0.9' })).resolves.toMatchObject({ success: true });
    expect(h.sent).toHaveLength(2);
    expect(legacy.calls).toHaveLength(0);
  });

  test('登录端点不强制校验（已注册用户不被挡），带 cfToken 也不报错', async () => {
    h = await createHarness();
    await h.registerAndVerify('ts3@example.com');
    const required = makeService(SECRET_ENV('required'), () => OK);
    const controller = new IdentityController(h.service, {}, {}, required.svc);

    // 无 token 也能登录成功（登录当前刻意不设闸）
    const out = await controller.login({ email: 'ts3@example.com', password: TEST_PASSWORD }, { ip: '10.0.0.9', headers: {} }, {});
    expect(out.token).toBeTruthy();
    expect(required.calls).toHaveLength(0); // 登录链路根本没碰人机验证
  });
});
