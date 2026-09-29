// 身份模块：注册 → 验证 → 登录 全链路，以及未验证/过期/重复注册/改密/重置的边界行为
const { createHarness, tokenFromMail, expectStatus, TEST_PASSWORD } = require('./_harness');

describe('身份模块 · 注册→验证→登录全链路', () => {
  let h;
  beforeEach(async () => { h = await createHarness(); });
  afterEach(async () => { await h.close(); });

  test('注册（不发会话）→ 验证（签发会话）→ 登录 → me → 登出', async () => {
    const reg = await h.service.register(' Alice@Example.com ', TEST_PASSWORD, '10.0.0.1');
    expect(reg.success).toBe(true);
    expect(reg.token).toBeUndefined(); // 注册阶段绝不签发会话
    expect(await h.repos.session.count()).toBe(0);
    expect(h.sent).toHaveLength(1);

    const verified = await h.service.verify(tokenFromMail(h.sent[0]), '10.0.0.1', 'jest-agent');
    expect(verified.token).toBeTruthy();
    expect(verified.identity.email).toBe('alice@example.com'); // 邮箱归一化
    expect(verified.identity.emailVerified).toBe(true);
    expect(verified.identity.username).toBe('alice'); // 由邮箱 local part 派生

    const session = await h.service.resolveSession(verified.token);
    expect(session.identity.id).toBe(verified.identity.id);
    expect(h.service.toSafeIdentity(session.identity)).not.toHaveProperty('passwordHash');

    // 邮箱登录与用户名登录都能通
    const byEmail = await h.service.login({ email: 'ALICE@example.com', password: TEST_PASSWORD }, '10.0.0.1');
    const byName = await h.service.login({ username: verified.identity.username, password: TEST_PASSWORD }, '10.0.0.1');
    expect(byEmail.identity.id).toBe(verified.identity.id);
    expect(byName.identity.id).toBe(verified.identity.id);

    // 登出后该会话立即失效（幂等：重复登出不报错）
    await h.service.logout(await h.service.resolveSession(byName.token));
    await expectStatus(h.service.resolveSession(byName.token), 401);
    await h.service.logout(await h.service.resolveSession(byEmail.token));
    await expectStatus(h.service.resolveSession(byEmail.token), 401);
  });

  test('未验证邮箱不发会话；口令错误与未验证的失败语义互不干扰', async () => {
    await h.service.register('bob@example.com', TEST_PASSWORD, '10.0.0.2');
    // 口令正确但未验证 → 403（明确提示验证邮箱）
    await expectStatus(h.service.login({ email: 'bob@example.com', password: TEST_PASSWORD }, '10.0.0.2'), 403);
    expect(await h.repos.session.count()).toBe(0);
    // 口令错误 → 401 通用文案（不因账号未验证而改变）
    const e = await expectStatus(h.service.login({ email: 'bob@example.com', password: 'wrong-pass' }, '10.0.0.3'), 401);
    expect(e.message).toBe('邮箱或密码错误');
  });

  test('pending 过期后释放账号名与邮箱（不删行，留 disabled 审计痕迹）', async () => {
    await h.service.register('dup@x.com', TEST_PASSWORD, '10.0.0.4');
    const firstToken = tokenFromMail(h.sent[0]);
    const first = await h.repos.identity.findOne({ where: { email: 'dup@x.com' } });
    expect(first.username).toBe('dup');

    // 把 pending 存活期拨到过去（不等 24h）
    first.pendingExpiresAt = new Date(Date.now() - 1000);
    await h.repos.identity.save(first);

    // 另一个邮箱派生同名用户名：账号名已被释放，可以正常注册
    await h.service.register('dup@y.com', TEST_PASSWORD, '10.0.0.5');
    const second = await h.repos.identity.findOne({ where: { email: 'dup@y.com' } });
    expect(second).toBeTruthy();
    expect(second.username).toBe('dup');

    const old = await h.repos.identity.findOne({ where: { id: first.id } });
    expect(old.status).toBe('disabled');
    expect(old.username).toBeNull();
    expect(old.email).toBeNull(); // 邮箱也释放，否则同一邮箱永远无法重新注册
    // 回收后老验证链接一并作废
    await expectStatus(h.service.verify(firstToken, '10.0.0.4'), 400);
  });

  test('同一邮箱重复注册：pending 期幂等重发并作废旧链接；激活后静默受理不新建', async () => {
    await h.service.register('carol@example.com', TEST_PASSWORD, '10.0.0.6');
    const firstToken = tokenFromMail(h.sent[0]);
    const again = await h.service.register('carol@example.com', 'Other!23456', '10.0.0.6');
    expect(again.success).toBe(true);
    expect(await h.repos.identity.count()).toBe(1); // 幂等：不产生第二条身份
    expect(h.sent).toHaveLength(2);
    const secondToken = tokenFromMail(h.sent[1]);
    expect(secondToken).not.toBe(firstToken);
    await expectStatus(h.service.verify(firstToken, '10.0.0.6'), 400); // 旧链接已作废
    await h.service.verify(secondToken, '10.0.0.6');

    // 已激活后再注册：静默受理（不发信、不新建、不改口令）
    const mailsBefore = h.sent.length;
    const silent = await h.service.register('carol@example.com', 'Another!2345', '10.0.0.6');
    expect(silent.success).toBe(true);
    expect(h.sent).toHaveLength(mailsBefore);
    expect(await h.repos.identity.count()).toBe(1);
    const identity = await h.repos.identity.findOne({ where: { email: 'carol@example.com' } });
    const credential = await h.repos.credential.findOne({ where: { identityId: identity.id } });
    expect(await h.password.verify(credential.passwordHash, TEST_PASSWORD)).toBe(true); // 原口令未被覆盖
    expect(await h.password.verify(credential.passwordHash, 'Another!2345')).toBe(false);
  });

  test('改密撤销其它会话、保留当前会话', async () => {
    // registerAndVerify 里的 verify 本身会签发一个会话，故会话共 3 个：验证会话 + s1 + s2
    const { email, password, sessionToken } = await h.registerAndVerify('dave@example.com');
    const s1 = await h.service.login({ email, password }, '10.0.0.7');
    const s2 = await h.service.login({ email, password }, '10.0.0.7');
    const current = await h.service.resolveSession(s1.token);
    expect(await h.repos.session.count()).toBe(3);

    const res = await h.service.changePassword(current.identityId, current.id, password, 'NewPass!23456');
    expect(res.revokedSessions).toBe(2);
    await expect(h.service.resolveSession(s1.token)).resolves.toBeTruthy(); // 当前会话保留
    await expectStatus(h.service.resolveSession(s2.token), 401); // 其它会话被踢
    await expectStatus(h.service.resolveSession(sessionToken), 401); // 验证时签发的会话也被踢
    await expectStatus(h.service.login({ email, password }, '10.0.0.7'), 401); // 旧口令失效
    await expect(h.service.login({ email, password: 'NewPass!23456' }, '10.0.0.7')).resolves.toBeTruthy();
  });

  test('改密要求原口令正确', async () => {
    const { identity, sessionToken } = await h.registerAndVerify('dave2@example.com');
    const session = await h.service.resolveSession(sessionToken);
    await expectStatus(h.service.changePassword(identity.id, session.id, 'wrong-old', 'NewPass!23456'), 401);
  });

  test('重置口令：不存在的邮箱同样 200 且不发信；重置后撤销全部会话、令牌一次性', async () => {
    const { email, password, sessionToken } = await h.registerAndVerify('erin@example.com');
    const s1 = await h.service.login({ email, password }, '10.0.0.8');
    const s2 = await h.service.login({ email, password }, '10.0.0.8');

    const mailsBefore = h.sent.length;
    const miss = await h.service.requestPasswordReset('nobody@example.com', '10.0.0.9');
    expect(miss.success).toBe(true);
    expect(h.sent).toHaveLength(mailsBefore); // 邮箱不存在 → 不发信

    const hit = await h.service.requestPasswordReset('ERIN@example.com', '10.0.0.9');
    expect(hit).toEqual(miss); // 响应体逐字一致（不泄露邮箱是否注册）

    const resetToken = tokenFromMail(h.sent[h.sent.length - 1]);
    const done = await h.service.resetPassword(resetToken, 'Reset!234567', '10.0.0.9');
    expect(done.revokedSessions).toBe(3); // 该账号全部会话（含验证时签发的那一个）被撤销
    await expectStatus(h.service.resolveSession(s1.token), 401);
    await expectStatus(h.service.resolveSession(s2.token), 401);
    await expectStatus(h.service.resolveSession(sessionToken), 401);
    await expect(h.service.login({ email, password: 'Reset!234567' }, '10.0.0.9')).resolves.toBeTruthy();
    await expectStatus(h.service.login({ email, password }, '10.0.0.9'), 401);
    // 同一重置令牌不可重复使用
    await expectStatus(h.service.resetPassword(resetToken, 'Again!234567', '10.0.0.9'), 400);
  });

  test('登录连续失败触发锁定：IP 与账号双维度都拦得住', async () => {
    const { email, password } = await h.registerAndVerify('frank@example.com');
    for (let i = 0; i < 5; i++)
      await expectStatus(h.service.login({ email, password: 'bad-pass' }, '9.9.9.9'), 401);
    // 账号维度锁定后，即便口令正确也拦（换 IP 也不行）
    const locked = await expectStatus(h.service.login({ email, password }, '9.9.9.9'), 429);
    expect(locked.message).toBe('尝试次数过多，请稍后再试');
    await expectStatus(h.service.login({ email, password }, '8.8.8.8'), 429);
    // 同一 IP 换别的账号同样被 IP 维度拦
    await expectStatus(h.service.login({ email: 'someone-else@example.com', password }, '9.9.9.9'), 429);
  });

  test('GitHub OAuth 端点为占位实现（501，实体约束已就绪）', async () => {
    await expectStatus(() => h.service.githubStart('1.2.3.4'), 501);
    await expectStatus(() => h.service.githubCallback('dummy-code', '1.2.3.4'), 501);
  });
});
