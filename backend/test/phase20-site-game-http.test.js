require('reflect-metadata');
const fs = require('node:fs');
const path = require('node:path');
const { generateKeyPairSync } = require('node:crypto');
const { Module, Controller, Get, Req, UseGuards, ValidationPipe } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { ConfigModule } = require('@nestjs/config');
const { TypeOrmModule } = require('@nestjs/typeorm');
const { DataSource, getMetadataArgsStorage } = require('typeorm');
const { AuthModule } = require('../dist/src/modules/auth/auth.module');
const { AuthService } = require('../dist/src/modules/auth/auth.service');
const { JwtAuthGuard } = require('../dist/src/common/guards/jwt-auth.guard');
const { KeysService } = require('../dist/src/modules/identity/keys.service');
const { TokenService } = require('../dist/src/modules/identity/token.service');
const { Identity } = require('../dist/src/infrastructure/database/entities/identity.entity');
const { Session } = require('../dist/src/infrastructure/database/entities/session.entity');
const { Account } = require('../dist/src/infrastructure/database/entities/account.entity');

const entitiesDir = path.resolve(__dirname, '../dist/src/infrastructure/database/entities');
for (const filename of fs.readdirSync(entitiesDir).filter(name => name.endsWith('.entity.js'))) require(path.join(entitiesDir, filename));

class ConsumerController { me(req) { return { id: req.user.id, username: req.user.username, role: req.user.role }; } }
Controller('test-game')(ConsumerController);
Get()(ConsumerController.prototype, 'me', Object.getOwnPropertyDescriptor(ConsumerController.prototype, 'me'));
Req()(ConsumerController.prototype, 'me', 0);
UseGuards(JwtAuthGuard)(ConsumerController.prototype, 'me', Object.getOwnPropertyDescriptor(ConsumerController.prototype, 'me'));
class ConsumerModule {}
Module({ controllers: [ConsumerController] })(ConsumerModule);
class TestRoot {}
Module({ imports: [
  ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true,
    load: [() => ({ JWT_SECRET: 'synthetic-test-secret-with-at-least-32-chars' })] }),
  TypeOrmModule.forRoot({ type: 'better-sqlite3', database: ':memory:', synchronize: true,
    entities: getMetadataArgsStorage().tables.map(table => table.target) }),
  AuthModule, ConsumerModule,
] })(TestRoot);

it('real site Cookie → Ed25519 token → game HTTP auth → global logout revokes game access', async () => {
  const seed = jest.spyOn(AuthService.prototype, 'onModuleInit').mockResolvedValue(undefined);
  let app;
  try {
    app = await NestFactory.create(TestRoot, { logger: false, abortOnError: false });
    const pair = generateKeyPairSync('ed25519');
    app.get(KeysService).env = { IDENTITY_JWT_PRIVATE_KEY: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() };
    app.setGlobalPrefix('api'); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const ds = app.get(DataSource);
    const identityRepo = ds.getRepository(Identity);
    const identity = await identityRepo.save(identityRepo.create({ username: 'http-site-player', email: 'synthetic@example.test', status: 'active', provider: 'email' }));
    const sessionRepo = ds.getRepository(Session);
    const plain = 'synthetic-site-session-for-http-test';
    await sessionRepo.save(sessionRepo.create({ identityId: identity.id,
      tokenHash: app.get(TokenService).sha256(plain), expiresAt: new Date(Date.now() + 3600000), revokedAt: null }));
    const post = (endpoint, body, cookie = true) => fetch(base + endpoint, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://game.bobbycn.cc', ...(cookie ? { Cookie: 'sid=' + plain } : {}) },
      body: JSON.stringify(body) });
    expect((await post('/api/auth/site-session', {}, false)).status).toBe(401);
    expect(await (await post('/api/auth/site-session', {})).json()).toMatchObject({ needsAccountSetup: true });
    const response = await post('/api/auth/site-session', { create: true }); expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const game = await response.json(); expect(game.user.id).not.toBe(identity.id); expect(game.expiresIn).toBe(600);
    expect(await ds.getRepository(Account).count()).toBe(3);
    const authHeaders = { Authorization: 'Bearer ' + game.token };
    const me = await fetch(base + '/api/test-game', { headers: authHeaders }); expect(me.status).toBe(200);
    expect((await me.json()).id).toBe(game.user.id);
    expect((await post('/api/auth/site-session', { create: 'yes' })).status).toBe(400);
    expect((await fetch(base + '/api/auth/site-return?origin=https%3A%2F%2Fevil.example', { redirect: 'manual' })).status).toBe(400);
    const redirect = await fetch(base + '/api/auth/site-return?origin=https%3A%2F%2Fgame.bobbycn.cc', { redirect: 'manual' });
    expect(redirect.status).toBe(302); expect(redirect.headers.get('location')).toBe('https://game.bobbycn.cc/login');
    const siteRedirect = await fetch(base + '/api/auth/identity/game-return?origin=https%3A%2F%2Fgame.bobbycn.cc', { redirect: 'manual' });
    expect(siteRedirect.status).toBe(302); expect(siteRedirect.headers.get('location')).toBe('https://game.bobbycn.cc/login');
    expect((await post('/api/auth/identity/logout', {})).status).toBe(200);
    expect((await fetch(base + '/api/test-game', { headers: authHeaders })).status).toBe(401);
    expect((await post('/api/auth/site-session', {})).status).toBe(401);
  } finally {
    if (app) await app.close();
    seed.mockRestore();
  }
});
