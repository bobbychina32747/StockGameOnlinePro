// 身份模块单测公共装置：真实 DataSource（better-sqlite3 内存库）+ 手工装配服务
// （不引 @nestjs/testing：仓库既有单测同样是手工 new + 真实仓储，style 保持一致）
require('reflect-metadata');

const { DataSource } = require('typeorm');

const { Identity } = require('../../../../dist/src/infrastructure/database/entities/identity.entity');
const { Credential } = require('../../../../dist/src/infrastructure/database/entities/credential.entity');
const { Session } = require('../../../../dist/src/infrastructure/database/entities/session.entity');
const { IdentityToken } = require('../../../../dist/src/infrastructure/database/entities/identity-token.entity');
const { IdentityService } = require('../../../../dist/src/modules/identity/identity.service');
const { PasswordService } = require('../../../../dist/src/modules/identity/password.service');
const { TokenService } = require('../../../../dist/src/modules/identity/token.service');
const { RateLimitService } = require('../../../../dist/src/modules/identity/rate-limit.service');

const TEST_PASSWORD = 'Passw0rd!23';

async function createHarness() {
  const ds = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    entities: [Identity, Credential, Session, IdentityToken],
    synchronize: true, // 内存库现建表，永不触碰 data/*.db
    logging: false,
  });
  await ds.initialize();

  const password = new PasswordService();
  const tokens = new TokenService();
  const rateLimit = new RateLimitService();
  // 单测不等真延迟（递增延迟本身在 rate-limit.test.js 里单独验证）
  rateLimit.BASE_DELAY_MS = 0;
  rateLimit.MAX_DELAY_MS = 0;

  const sent = [];
  const mailer = { send: async (message) => { sent.push(message); } };
  const config = { get: (key, fallback) => (key === 'APP_BASE_URL' ? 'http://test.local' : fallback) };

  const repos = {
    identity: ds.getRepository(Identity),
    credential: ds.getRepository(Credential),
    session: ds.getRepository(Session),
    token: ds.getRepository(IdentityToken),
  };

  const service = new IdentityService(
    repos.identity, repos.credential, repos.session, repos.token,
    password, tokens, rateLimit, mailer, config,
  );

  return {
    ds, repos, service, password, tokens, rateLimit, mailer, sent,
    /** 注册 + 验证（返回常用断言数据），后续用例直接从这里开始 */
    async registerAndVerify(email, pwd = TEST_PASSWORD, ip = '10.0.0.1') {
      await service.register(email, pwd, ip);
      const token = tokenFromMail(sent[sent.length - 1]);
      const verified = await service.verify(token, ip, 'jest-agent');
      return { email, password: pwd, token, identity: verified.identity, sessionToken: verified.token };
    },
    close: () => ds.destroy(),
  };
}

/** 从验证/重置邮件正文里取出一次性令牌（顺便验证邮件里确实带了可用链接） */
function tokenFromMail(message) {
  const matched = /[?&]token=([A-Za-z0-9_%.-]+)/.exec(message.html || '');
  if (!matched)
    throw new Error('邮件正文里没有 token');
  return decodeURIComponent(matched[1]);
}

/** 断言调用以指定 HTTP 状态码失败（Nest HttpException 的 status） */
async function expectStatus(target, status) {
  try {
    await (typeof target === 'function' ? target() : target);
  }
  catch (e) {
    if (typeof e.getStatus !== 'function')
      throw e;
    expect(e.getStatus()).toBe(status);
    return e;
  }
  throw new Error(`预期失败（HTTP ${status}），但调用成功返回了`);
}

module.exports = { createHarness, tokenFromMail, expectStatus, TEST_PASSWORD };
