// 授权系统（OAuth 2.0 授权码 + PKCE）单测公共装置。
// 与 _harness.js 同一风格：真实 TypeORM 内存库 + 手工装配，不引 @nestjs/testing。
// 与 _harness.js 的差别只有一处：多注册四张授权表，并额外装配 OauthService。
require('reflect-metadata');

const { generateKeyPairSync } = require('crypto');
const { mkdtempSync, writeFileSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { DataSource } = require('typeorm');

const { Identity } = require('../../../../dist/src/infrastructure/database/entities/identity.entity');
const { Credential } = require('../../../../dist/src/infrastructure/database/entities/credential.entity');
const { Session } = require('../../../../dist/src/infrastructure/database/entities/session.entity');
const { IdentityToken } = require('../../../../dist/src/infrastructure/database/entities/identity-token.entity');
const { OAuthClient } = require('../../../../dist/src/infrastructure/database/entities/oauth-client.entity');
const { OAuthCode } = require('../../../../dist/src/infrastructure/database/entities/oauth-code.entity');
const { OAuthGrant } = require('../../../../dist/src/infrastructure/database/entities/oauth-grant.entity');
const { OAuthRefreshToken } = require('../../../../dist/src/infrastructure/database/entities/oauth-refresh-token.entity');
const { IdentitySecret } = require('../../../../dist/src/infrastructure/database/entities/identity-secret.entity');
const { GameSave } = require('../../../../dist/src/infrastructure/database/entities/game-save.entity');
const { AppSecret } = require('../../../../dist/src/infrastructure/database/entities/app-secret.entity');

const { IdentityService } = require('../../../../dist/src/modules/identity/identity.service');
const { PasswordService } = require('../../../../dist/src/modules/identity/password.service');
const { TokenService } = require('../../../../dist/src/modules/identity/token.service');
const { RateLimitService } = require('../../../../dist/src/modules/identity/rate-limit.service');
const { KeysService } = require('../../../../dist/src/modules/identity/keys.service');
const { IdentityJwtService } = require('../../../../dist/src/modules/identity/jwt.service');
const { OauthService } = require('../../../../dist/src/modules/identity/oauth.service');
const { GameSavesService } = require('../../../../dist/src/modules/game-saves/game-saves.service');

const TEST_PASSWORD = 'Passw0rd!23';

/** 现场生成一把 Ed25519 私钥到临时目录（仓库/日志里绝不出现私钥，与 jwt-keys.test.js 同款做法） */
function withTempKey() {
  const dir = mkdtempSync(join(tmpdir(), 'oauth-keys-'));
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const file = join(dir, 'identity-ed25519.pem');
  writeFileSync(file, pem, { mode: 0o600 });
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const ENTITIES = [
  Identity, Credential, Session, IdentityToken,
  OAuthClient, OAuthCode, OAuthGrant, OAuthRefreshToken,
  IdentitySecret, GameSave, AppSecret,
];

async function createOauthHarness(options = {}) {
  const ds = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    entities: ENTITIES,
    synchronize: true,
    logging: false,
  });
  await ds.initialize();

  const password = new PasswordService();
  const tokens = new TokenService();
  const rateLimit = new RateLimitService();
  rateLimit.BASE_DELAY_MS = 0;
  rateLimit.MAX_DELAY_MS = 0;

  const sent = [];
  const mailer = { send: async (m) => { sent.push(m); } };
  const config = { get: (key, fallback) => (key === 'APP_BASE_URL' ? 'http://test.local' : fallback) };

  const repos = {
    identity: ds.getRepository(Identity),
    credential: ds.getRepository(Credential),
    session: ds.getRepository(Session),
    token: ds.getRepository(IdentityToken),
    client: ds.getRepository(OAuthClient),
    code: ds.getRepository(OAuthCode),
    grant: ds.getRepository(OAuthGrant),
    refresh: ds.getRepository(OAuthRefreshToken),
    secret: ds.getRepository(IdentitySecret),
    save: ds.getRepository(GameSave),
    appSecret: ds.getRepository(AppSecret),
  };

  const identityService = new IdentityService(
    repos.identity, repos.credential, repos.session, repos.token,
    password, tokens, rateLimit, mailer, config,
  );

  const keys = new KeysService();
  const keyDir = withTempKey();
  const cleanupKey = keyDir.cleanup;
  if (!options.withoutKeys) {
    keys.env = { ...process.env, IDENTITY_JWT_KEY_FILE: keyDir.file };
    keys.reload();
  }
  else {
    // 私钥缺失的降级场景：指向一个不存在的路径
    keys.env = { ...process.env, IDENTITY_JWT_KEY_FILE: join(keyDir.dir, 'missing.pem'), IDENTITY_JWT_PRIVATE_KEY: '' };
    keys.reload();
  }
  const jwt = new IdentityJwtService(keys);

  const oauth = new OauthService(
    repos.client, repos.code, repos.grant, repos.refresh,
    repos.identity, repos.session, identityService, jwt, tokens,
  );
  await oauth.seedBuiltinClients();

  const saves = new GameSavesService(repos.save, repos.secret, repos.appSecret);

  return {
    ds, repos, oauth, saves, keys, jwt, identityService, tokens, password, rateLimit, sent, mailer,
    /** 模拟运行期私钥不可用（部署未就位 / 密钥文件被撤）：只影响签发令牌，不影响其它功能 */
    degradeKeys() {
      keys.env = { ...process.env, IDENTITY_JWT_KEY_FILE: join(keyDir.dir, 'gone.pem'), IDENTITY_JWT_PRIVATE_KEY: '' };
      keys.reload();
    },
    /** 建一个已验证的身份 + 一个有效会话（绕过邮件流程，OAuth 测试只关心授权链路） */
    async activeIdentity(email = 'player@example.com', username = 'player') {
      const identity = repos.identity.create({
        email,
        username,
        emailVerifiedAt: new Date(),
        status: 'active',
        provider: 'email',
        providerUid: null,
        pendingExpiresAt: null,
      });
      const saved = await repos.identity.save(identity);
      await repos.credential.save(repos.credential.create({
        identityId: saved.id,
        passwordHash: await password.hash(TEST_PASSWORD),
        totpSecretEnc: null,
        recoveryCodes: '[]',
      }));
      const sessionToken = tokens.newToken();
      const session = await repos.session.save(repos.session.create({
        identityId: saved.id,
        tokenHash: tokens.sha256(sessionToken),
        expiresAt: tokens.expiryFromNow(30 * 24 * 3600 * 1000),
        revokedAt: null,
        ua: 'jest',
        ip: '127.0.0.1',
      }));
      session.identity = saved;
      return { identity: saved, session, sessionToken };
    },
    async close() {
      cleanupKey();
      await ds.destroy();
    },
  };
}

/** PKCE：生成 verifier 与 challenge（S256） */
function pkcePair() {
  const { createHash, randomBytes } = require('crypto');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'utf8').digest('base64url');
  return { verifier, challenge };
}

module.exports = { createOauthHarness, pkcePair, TEST_PASSWORD };
