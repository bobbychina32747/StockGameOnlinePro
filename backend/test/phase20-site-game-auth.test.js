const { DataSource, EntitySchema } = require('typeorm');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const { User } = require('../dist/src/infrastructure/database/entities/user.entity');
const { Account } = require('../dist/src/infrastructure/database/entities/account.entity');
const { SiteGameAuthService, isSiteToken } = require('../dist/src/modules/auth/site-game-auth.service');
const { AuthService } = require('../dist/src/modules/auth/auth.service');
const { JwtStrategy } = require('../dist/src/modules/auth/strategies/jwt.strategy');
const { JwtAuthGuard } = require('../dist/src/common/guards/jwt-auth.guard');
const { AuthController } = require('../dist/src/modules/auth/auth.controller');
const { MarketGateway } = require('../dist/src/modules/market/market.gateway');
const { migrateSiteGameAccount } = require('../scripts/migrate-site-game-account.cjs');

const userSchema = new EntitySchema({ name: 'User', target: User, tableName: 'users', columns: {
  id: { type: String, primary: true, generated: 'uuid' }, username: { type: String, unique: true },
  password: { type: String }, identityId: { type: String, nullable: true, unique: true },
  role: { type: String, default: 'user' }, isActive: { type: Boolean, default: true }, isBot: { type: Boolean, default: false },
}});
const accountSchema = new EntitySchema({ name: 'Account', target: Account, tableName: 'accounts', columns: {
  id: { type: String, primary: true, generated: 'uuid' }, userId: { type: String }, marketMode: { type: String },
  ...Object.fromEntries(['cash', 'totalEquity', 'peakEquity', 'initialEquity', 'dayStartEquity'].map(key => [key, { type: Number, default: 0 }])),
}, uniques: [{ columns: ['userId', 'marketMode'] }] });
const session = (identityId = 'site-1', username = 'alice') => ({ id: 'session-1', identityId, revokedAt: null,
  expiresAt: new Date(Date.now() + 3600000), identity: { id: identityId, username, status: 'active' } });

describe('site identity to game account', () => {
  let ds, users, accounts, service, exchange, jwt, legacy;
  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', synchronize: true, entities: [userSchema, accountSchema] });
    await ds.initialize(); users = ds.getRepository(User); accounts = ds.getRepository(Account);
    exchange = { exchange: jest.fn(() => ({ token: 'site-token', expiresIn: 600 })), introspect: jest.fn(async () => ({ active: true })) };
    jwt = { verify: jest.fn(() => ({ sub: 'site-1', sid: 'session-1' })) };
    legacy = new AuthService(users, accounts, { sign: () => 'old-token' });
    service = new SiteGameAuthService(ds, users, jwt, exchange, legacy);
  });
  afterEach(async () => { await ds.destroy(); });
  const oldUser = async (users, overrides = {}) => users.save(users.create({ username: 'alice', password: await bcrypt.hash('old-password', 4), ...overrides }));

  it('asks before creating and does not map an existing same-name user', async () => {
    const old = await oldUser(users);
    expect(await service.session(session())).toMatchObject({ needsAccountSetup: true });
    expect((await users.findOneBy({ id: old.id })).identityId).toBeNull();
    expect(await accounts.count()).toBe(0);
  });
  it('creates a normal user and all three market accounts atomically', async () => {
    const result = await service.session(session(), true);
    expect(result.token).toBe('site-token'); expect(result.user.role).toBe('user');
    expect((await accounts.find()).map(a => a.marketMode).sort()).toEqual(['CN', 'HK', 'US']);
    expect((await users.find())[0].identityId).toBe('site-1');
    expect(result.user.password).toBeUndefined();
  });
  it('never takes over a same-name administrator', async () => {
    const old = await oldUser(users, { role: 'admin' });
    const result = await service.session(session(), true);
    expect(result.user.id).not.toBe(old.id); expect(result.user.role).toBe('user');
    expect(result.user.username).not.toBe('alice');
  });
  it('reuses the existing mapping and never duplicates starting cash', async () => {
    const first = await service.session(session(), true);
    const second = await service.session(session(), true);
    expect(first.user.id).toBe(second.user.id); expect(await users.count()).toBe(1); expect(await accounts.count()).toBe(3);
  });
  it('concurrent creation still produces exactly one user and three accounts', async () => {
    const hash = jest.spyOn(bcrypt, 'hash').mockResolvedValue('synthetic-hash');
    try {
      const results = await Promise.all(Array.from({ length: 5 }, () => service.session(session(), true)));
      expect(new Set(results.map(result => result.user.id)).size).toBe(1);
      expect(await users.count()).toBe(1); expect(await accounts.count()).toBe(3);
    } finally { hash.mockRestore(); }
  });
  it('rolls back user creation if an account cannot be saved', async () => {
    await ds.query("CREATE TRIGGER reject_hk BEFORE INSERT ON accounts WHEN NEW.marketMode = 'HK' BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    await expect(service.session(session(), true)).rejects.toThrow();
    expect(await users.count()).toBe(0); expect(await accounts.count()).toBe(0);
  });
  it('binds only after password proof and preserves the old account and assets', async () => {
    const old = await oldUser(users, { role: 'admin' });
    const account = await accounts.save(accounts.create({ userId: old.id, marketMode: 'CN', cash: 45678, totalEquity: 56789 }));
    const result = await service.link(session(), 'alice', 'old-password', '127.0.0.1');
    expect(result.user.id).toBe(old.id); expect(result.user.role).toBe('admin');
    expect((await accounts.findOneBy({ id: account.id })).cash).toBe(45678); expect(await accounts.count()).toBe(1);
    expect((await users.findOneBy({ id: old.id })).identityId).toBe('site-1');
  });
  it('a bad old password cannot modify the mapping', async () => {
    const old = await oldUser(users);
    await expect(service.link(session(), 'alice', 'wrong', 'ip')).rejects.toThrow();
    expect((await users.findOneBy({ id: old.id })).identityId).toBeNull();
  });
  it('cannot steal an account already linked to another identity', async () => {
    await oldUser(users, { identityId: 'site-other' });
    await expect(service.link(session(), 'alice', 'old-password')).rejects.toThrow('账号已绑定');
  });
  it('cannot overwrite an identity that already owns another game account', async () => {
    await oldUser(users); await service.session(session(), true);
    await expect(service.link(session(), 'alice', 'old-password')).rejects.toThrow('账号已绑定');
    expect(await users.count()).toBe(2); expect(await accounts.count()).toBe(3);
  });
  it('allows safe idempotent rebinding to the same account', async () => {
    const old = await oldUser(users);
    await service.link(session(), 'alice', 'old-password');
    expect((await service.link(session(), 'alice', 'old-password')).user.id).toBe(old.id);
  });
  it('legacy passwords no longer grant independent login after binding', async () => {
    await oldUser(users, { identityId: 'site-1' });
    await expect(legacy.login('alice', 'old-password')).rejects.toThrow('站点账号');
  });
  it.each([{ revokedAt: new Date() }, { expiresAt: new Date(0) }, { identity: { id: 'site-1', status: 'disabled' } }])
    ('rejects an unusable site session before creating accounts (%j)', async overrides => {
      await expect(service.session({ ...session(), ...overrides }, true)).rejects.toThrow(); expect(await users.count()).toBe(0);
    });
  it('maps verified site sub to a distinct local game id', async () => {
    const old = await oldUser(users, { identityId: 'site-1' });
    expect((await service.authenticate('signed-site-token')).id).toBe(old.id);
    exchange.introspect.mockResolvedValue({ active: false });
    await expect(service.authenticate('signed-site-token')).rejects.toThrow('站点会话');
  });
  it('rejects third-party OAuth grants even when their site JWT is valid', async () => {
    await oldUser(users, { identityId: 'site-1' }); jwt.verify.mockReturnValue({ sub: 'site-1', client_id: 'third-party' });
    await expect(service.authenticate('oauth-token')).rejects.toThrow('站点登录');
  });
  it('rejects a disabled local user and rejects unbound identities', async () => {
    await expect(service.authenticate('site-token')).rejects.toThrow();
    await oldUser(users, { identityId: 'site-1', isActive: false });
    await expect(service.authenticate('site-token')).rejects.toThrow();
  });
  it('legacy JWTs stop authorizing a linked user', async () => {
    const old = await oldUser(users, { identityId: 'site-1' });
    const strategy = new JwtStrategy({ get: () => 'test-secret-with-enough-length' }, users);
    await expect(strategy.validate({ sub: old.id })).rejects.toThrow();
  });
  it('HTTP guard attaches the game user rather than the site identity id', async () => {
    const old = await oldUser(users, { identityId: 'site-1' });
    const token = Buffer.from(JSON.stringify({ alg: 'EdDSA' })).toString('base64url') + '.payload.signature';
    const req = { headers: { authorization: 'Bearer ' + token } };
    expect(await new JwtAuthGuard(service).canActivate({ switchToHttp: () => ({ getRequest: () => req }) })).toBe(true);
    expect(req.user.id).toBe(old.id);
  });
  it('WebSocket handshake uses the site identity mapping', async () => {
    const old = await oldUser(users, { identityId: 'site-1' });
    const token = Buffer.from(JSON.stringify({ alg: 'EdDSA' })).toString('base64url') + '.payload.signature';
    const socket = { id: 'socket-test', handshake: { auth: { token } }, data: {}, disconnect: jest.fn() };
    const gateway = new MarketGateway({ verify: jest.fn() }, users, service);
    await gateway.handleConnection(socket); expect(socket.disconnect).not.toHaveBeenCalled(); expect(socket.data.__userId).toBe(old.id);
    gateway.handleDisconnect(socket); expect(gateway.clients).toBe(0);
  });
  it('return route rejects open redirects and CRLF injection', () => {
    const controller = new AuthController(legacy, service); const res = { setHeader: jest.fn(), redirect: jest.fn() };
    for (const origin of ['https://evil.example', 'https://game.bobbycn.cc.evil.example', '//game.bobbycn.cc', 'https://game.bobbycn.cc\r\nX:1']) {
      expect(() => controller.siteReturn(origin, res)).toThrow();
    }
    controller.siteReturn('https://game.bobbycn.cc', res); expect(res.redirect).toHaveBeenCalledWith(302, 'https://game.bobbycn.cc/login');
  });
  it('rejects cross-site account creation and binding', async () => {
    const controller = new AuthController(legacy, service);
    await expect(controller.siteSession(session(), { create: true }, { headers: { origin: 'https://evil.example' } }, {})).rejects.toThrow();
    expect(await users.count()).toBe(0);
  });
});

describe('additive identity mapping migration', () => {
  it('preserves legacy users, allows multiple nulls and enforces one game account per identity', () => {
    const db = new Database(':memory:');
    try {
      db.exec("CREATE TABLE users(id TEXT PRIMARY KEY, username TEXT, password TEXT); INSERT INTO users VALUES ('u1','old','hash1'),('u2','other','hash2')");
      expect(migrateSiteGameAccount(db)).toEqual({ added: true }); expect(migrateSiteGameAccount(db)).toEqual({ added: false });
      expect(db.prepare('SELECT password FROM users WHERE id=?').get('u1').password).toBe('hash1');
      db.exec("UPDATE users SET identityId='site-1' WHERE id='u1'");
      expect(() => db.exec("UPDATE users SET identityId='site-1' WHERE id='u2'")).toThrow();
      expect(db.prepare('SELECT identityId FROM users WHERE id=?').get('u2').identityId).toBeNull();
    } finally { db.close(); }
  });
  it('fails safely when users is absent', () => {
    const db = new Database(':memory:');
    try { expect(() => migrateSiteGameAccount(db)).toThrow('Missing table'); } finally { db.close(); }
  });
  it('malformed JWT headers are never trusted', () => {
    expect(isSiteToken('not-a-jwt')).toBe(false); expect(isSiteToken(null)).toBe(false);
  });
});
