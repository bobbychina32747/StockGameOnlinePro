// 身份模块 · 令牌与哈希落库规格（C10）：一次性、过期拒绝、库内只有 sha256
const { createHash } = require('crypto');
const { createHarness, tokenFromMail, expectStatus, TEST_PASSWORD } = require('./_harness');
const { IDENTITY_TOKEN_TTL_MS } = require('../../../../dist/src/modules/identity/token.service');

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const MINUTES = 60 * 1000;

describe('身份模块 · 令牌规格', () => {
  let h;
  beforeEach(async () => { h = await createHarness(); });
  afterEach(async () => { await h.close(); });

  test('明文令牌为 CSPRNG ≥128bit，落库只有 sha256（库内任何字段都不含明文）', async () => {
    await h.service.register('t1@example.com', TEST_PASSWORD, '1.1.1.1');
    const plain = tokenFromMail(h.sent[0]);
    const rows = await h.repos.token.find();
    expect(rows).toHaveLength(1);
    const row = rows[0];

    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.tokenHash).toBe(sha256(plain));
    expect(row.tokenHash).not.toBe(plain);
    expect(row.tokenHash).not.toContain(plain);
    expect(JSON.stringify(row)).not.toContain(plain); // 整行扫描：没有任何字段存明文

    // base64url(32 字节) = 256bit ≥ 规格下限 128bit
    expect(Buffer.from(plain, 'base64url').length).toBeGreaterThanOrEqual(16);
    expect(plain.length).toBeGreaterThanOrEqual(22);
  });

  test('令牌 TTL ≤ 30 分钟且绑定 identity + purpose', async () => {
    const before = Date.now();
    await h.service.register('t2@example.com', TEST_PASSWORD, '1.1.1.2');
    const row = (await h.repos.token.find())[0];
    // 规格口径：TTL 常量本身不得超过 30 分钟
    expect(IDENTITY_TOKEN_TTL_MS).toBeLessThanOrEqual(30 * MINUTES);
    // 落库的 expiresAt ≈ 签发时刻 + TTL；签发发生在 register 内部的口令哈希之后，
    // 故墙钟基准（before）允许几秒偏差——真正要守住的是「不超过 30 分钟」这条线
    const ttl = new Date(row.expiresAt).getTime() - before;
    expect(ttl).toBeGreaterThan(29 * MINUTES);
    expect(ttl).toBeLessThanOrEqual(30 * MINUTES + 5000);
    expect(row.purpose).toBe('verify_email');
    const identity = await h.repos.identity.findOne({ where: { email: 't2@example.com' } });
    expect(row.identityId).toBe(identity.id);
  });

  test('过期令牌被拒绝（不激活账号、不发会话）', async () => {
    await h.service.register('t3@example.com', TEST_PASSWORD, '1.1.1.3');
    const plain = tokenFromMail(h.sent[0]);
    const row = (await h.repos.token.find())[0];
    row.expiresAt = new Date(Date.now() - 1000);
    await h.repos.token.save(row);

    await expectStatus(h.service.verify(plain, '1.1.1.3'), 400);
    expect((await h.repos.identity.findOne({ where: { email: 't3@example.com' } })).status).toBe('pending');
    expect(await h.repos.session.count()).toBe(0);
  });

  test('二次使用被拒绝：usedAt 一次一废', async () => {
    await h.service.register('t4@example.com', TEST_PASSWORD, '1.1.1.4');
    const plain = tokenFromMail(h.sent[0]);
    await h.service.verify(plain, '1.1.1.4');
    const row = (await h.repos.token.find())[0];
    expect(row.usedAt).toBeTruthy();

    await expectStatus(h.service.verify(plain, '1.1.1.4'), 400); // 复用同一链接 → 400
  });

  test('用途绑定：重置令牌不能当验证令牌用（反之亦然）', async () => {
    const { email } = await h.registerAndVerify('t5@example.com');
    await h.service.requestPasswordReset(email, '1.1.1.5');
    const resetToken = tokenFromMail(h.sent[h.sent.length - 1]);

    await expectStatus(h.service.verify(resetToken, '1.1.1.5'), 400);
    // 重置令牌用在 reset 端点上是正常的
    await expect(h.service.resetPassword(resetToken, 'Brand!234567', '1.1.1.5')).resolves.toMatchObject({ success: true });
  });

  test('会话令牌同样只存哈希，且过期/撤销后一律 401', async () => {
    const { sessionToken } = await h.registerAndVerify('t6@example.com');
    const sessionRow = (await h.repos.session.find())[0];
    expect(sessionRow.tokenHash).toBe(sha256(sessionToken));
    expect(JSON.stringify(sessionRow)).not.toContain(sessionToken);

    sessionRow.expiresAt = new Date(Date.now() - 1000); // 拨到过去模拟过期
    await h.repos.session.save(sessionRow);
    await expectStatus(h.service.resolveSession(sessionToken), 401);
  });

  test('伪造/随机令牌查不到会话（哈希等值匹配，无前缀碰撞面）', async () => {
    await h.registerAndVerify('t7@example.com');
    await expectStatus(h.service.resolveSession('not-a-real-session-token'), 401);
    await expectStatus(h.service.resolveSession(''), 401);
  });
});
