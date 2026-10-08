// 本机冒烟前置：在本地 dev 库里造一个**已验证**的账号（跳过邮件环节，OAuth 链路才是被测对象）
// 用法：node tools/_seed-local-user.mjs [email] [password]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const DB = 'E:\\Files\\Games\\stockGameOnlinePro\\.local-oauth\\oauth-dev.db';
const email = (process.argv[2] || 'probe@example.com').toLowerCase();
const password = process.argv[3] || 'ProbePass!2026';

const { DataSource } = require('typeorm');
const { Identity } = require('../dist/src/infrastructure/database/entities/identity.entity');
const { Credential } = require('../dist/src/infrastructure/database/entities/credential.entity');
const { Session } = require('../dist/src/infrastructure/database/entities/session.entity');
const { IdentityToken } = require('../dist/src/infrastructure/database/entities/identity-token.entity');
const { OAuthClient } = require('../dist/src/infrastructure/database/entities/oauth-client.entity');
const { OAuthCode } = require('../dist/src/infrastructure/database/entities/oauth-code.entity');
const { OAuthGrant } = require('../dist/src/infrastructure/database/entities/oauth-grant.entity');
const { OAuthRefreshToken } = require('../dist/src/infrastructure/database/entities/oauth-refresh-token.entity');
const { IdentitySecret } = require('../dist/src/infrastructure/database/entities/identity-secret.entity');
const { GameSave } = require('../dist/src/infrastructure/database/entities/game-save.entity');
const { AppSecret } = require('../dist/src/infrastructure/database/entities/app-secret.entity');
const { PasswordService } = require('../dist/src/modules/identity/password.service');

const ds = new DataSource({
  type: 'better-sqlite3',
  database: DB,
  entities: [Identity, Credential, Session, IdentityToken, OAuthClient, OAuthCode, OAuthGrant, OAuthRefreshToken, IdentitySecret, GameSave, AppSecret],
  synchronize: true,
  logging: false,
});
await ds.initialize();

const identities = ds.getRepository(Identity);
const credentials = ds.getRepository(Credential);
const passwordService = new PasswordService();

let identity = await identities.findOne({ where: { email } });
if (!identity) {
  identity = await identities.save(identities.create({
    email,
    username: email.split('@')[0],
    emailVerifiedAt: new Date(),
    status: 'active',
    provider: 'email',
    providerUid: null,
    pendingExpiresAt: null,
  }));
  await credentials.save(credentials.create({
    identityId: identity.id,
    passwordHash: await passwordService.hash(password),
    totpSecretEnc: null,
    recoveryCodes: '[]',
  }));
  console.log(`created verified identity: ${email} / ${password} (id=${identity.id})`);
} else {
  // 已存在就重置口令并确保 active（本机 dev 库，随便改）
  const cred = await credentials.findOne({ where: { identityId: identity.id } });
  if (cred) {
    cred.passwordHash = await passwordService.hash(password);
    await credentials.save(cred);
  }
  identity.status = 'active';
  identity.emailVerifiedAt = identity.emailVerifiedAt || new Date();
  await identities.save(identity);
  console.log(`updated existing identity: ${email} / ${password} (id=${identity.id})`);
}
await ds.destroy();
