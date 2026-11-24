require('reflect-metadata');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { generateKeyPairSync, sign, verify } = require('node:crypto');
const Database = require('better-sqlite3');
const { Module, Controller, Get, Req, UseGuards, ValidationPipe } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { ConfigModule } = require('@nestjs/config');
const { TypeOrmModule } = require('@nestjs/typeorm');
const { DataSource, getMetadataArgsStorage } = require('typeorm');
const { AuthModule } = require('../dist/src/modules/auth/auth.module');
const { AuthService } = require('../dist/src/modules/auth/auth.service');
const { JwtAuthGuard } = require('../dist/src/common/guards/jwt-auth.guard');
const { Account } = require('../dist/src/infrastructure/database/entities/account.entity');
const { User } = require('../dist/src/infrastructure/database/entities/user.entity');
// This authority fixture has its own database/port; it is never a game module.
function siteFixture() {
    const db = new Database(':memory:');
    db.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY, identityId TEXT, active INTEGER); INSERT INTO sessions VALUES('site-session','site-identity',1)");
    const keys = generateKeyPairSync('ed25519');
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    let mode = 'normal';
    const mint = () => {
        const now = Math.floor(Date.now() / 1000);
        const claims = { iss: 'https://bobbycn.cc', aud: 'bobbycn.cc', sub: 'site-identity', sid: 'site-session', iat: now, exp: now + 600,
            ...(mode === 'oauth' ? { client_id: 'third-party' } : {}) };
        const unsigned = encode({ alg: 'EdDSA', kid: 'synthetic' }) + '.' + encode(claims);
        return unsigned + '.' + sign(null, Buffer.from(unsigned), keys.privateKey).toString('base64url');
    };
    const server = http.createServer(async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (mode === 'unavailable') {
            res.writeHead(503);
            return res.end('{}');
        }
        if (mode === 'malformed')
            return res.end('not-json');
        if (mode === 'rate-limit') {
            res.writeHead(429);
            return res.end('{}');
        }
        if (mode === 'redirect') {
            res.writeHead(302, { Location: 'http://127.0.0.1:1/forbidden' });
            return res.end('{}');
        }
        const active = db.prepare('SELECT active FROM sessions').get().active === 1;
        if (req.url === '/api/auth/identity/session-context') {
            if (req.headers.authorization !== 'Bearer synthetic-opaque-sid' || !active) {
                res.writeHead(401);
                return res.end('{}');
            }
            const identityId = mode === 'mismatch' ? 'wrong-subject' : 'site-identity';
            return res.end(JSON.stringify({ id: 'site-session', identityId, expiresAt: new Date(Date.now() + (mode === 'expired' ? -1000 : 3600000)),
                identity: { id: identityId, username: 'http-site-player', status: mode === 'disabled' ? 'disabled' : 'active' },
                access: { token: mint(), tokenType: 'Bearer', expiresIn: 600, kid: 'synthetic' } }));
        }
        if (req.url === '/api/auth/identity/introspect') {
            let body = '';
            for await (const chunk of req)
                body += chunk;
            let claims;
            try {
                const parts = JSON.parse(body).token.split('.');
                if (!verify(null, Buffer.from(parts[0] + '.' + parts[1]), keys.publicKey, Buffer.from(parts[2], 'base64url')))
                    throw Error();
                claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
            }
            catch {
                return res.end('{"active":false}');
            }
            return res.end(JSON.stringify({ active, sub: mode === 'introspection-mismatch' ? 'wrong-subject' : claims.sub, sid: claims.sid, exp: claims.exp }));
        }
        res.writeHead(404);
        res.end('{}');
    });
    return { server, db, setMode: value => { mode = value; }, revoke: () => db.exec('UPDATE sessions SET active=0') };
}
const entitiesDir = path.resolve(__dirname, '../dist/src/infrastructure/database/entities');
for (const filename of fs.readdirSync(entitiesDir).filter(name => name.endsWith('.entity.js')))
    require(path.join(entitiesDir, filename));
class ConsumerController {
    me(req) { return { id: req.user.id, username: req.user.username, role: req.user.role }; }
}
Controller('test-game')(ConsumerController);
Get()(ConsumerController.prototype, 'me', Object.getOwnPropertyDescriptor(ConsumerController.prototype, 'me'));
Req()(ConsumerController.prototype, 'me', 0);
UseGuards(JwtAuthGuard)(ConsumerController.prototype, 'me', Object.getOwnPropertyDescriptor(ConsumerController.prototype, 'me'));
describe('independent site identity and game ledger over HTTP', () => {
    let site, app, base, ds, seed;
    beforeEach(async () => {
        site = siteFixture();
        await new Promise(resolve => site.server.listen(0, '127.0.0.1', resolve));
        class TestRoot {
        }
        Module({ imports: [
                ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true, load: [() => ({
                            JWT_SECRET: 'synthetic-test-secret-with-at-least-32-chars', SITE_IDENTITY_URL: 'http://127.0.0.1:' + site.server.address().port
                        })] }),
                TypeOrmModule.forRoot({ type: 'better-sqlite3', database: ':memory:', synchronize: true, entities: getMetadataArgsStorage().tables.map(table => table.target) }), AuthModule,
            ], controllers: [ConsumerController] })(TestRoot);
        seed = jest.spyOn(AuthService.prototype, 'onModuleInit').mockResolvedValue(undefined);
        app = await NestFactory.create(TestRoot, { logger: false, abortOnError: false });
        app.setGlobalPrefix('api');
        app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
        await app.listen(0, '127.0.0.1');
        base = await app.getUrl();
        ds = app.get(DataSource);
    });
    afterEach(async () => { if (app)
        await app.close(); seed?.mockRestore(); site.server.closeAllConnections(); await new Promise(resolve => site.server.close(resolve)); site.db.close(); });
    const post = (endpoint, body, cookie = true, origin = 'https://game.bobbycn.cc') => fetch(base + endpoint, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: 'sid=synthetic-opaque-sid; unrelated=not-forwarded' } : {}) }, body: JSON.stringify(body) });
    test('site mapping is idempotent; revocation blocks its access chain', async () => {
        const before = await post('/api/auth/site-session', {});
        expect(before.status).toBe(200);
        expect((await before.json()).needsAccountSetup).toBe(true);
        const created = await post('/api/auth/site-session', { create: true });
        expect(created.status).toBe(200);
        const linked = await created.json();
        expect(linked.user.password).toBeUndefined();
        expect(created.headers.get('cache-control')).toBe('no-store');
        expect((await (await post('/api/auth/site-session', { create: true })).json()).user.id).toBe(linked.user.id);
        expect(await ds.getRepository(User).count()).toBe(1);
        expect(await ds.getRepository(Account).count()).toBe(3);
        expect(await ds.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('identities','sessions','app_secrets')")).toEqual([]);
        const authHeaders = { Authorization: 'Bearer ' + linked.token };
        expect((await fetch(base + '/api/test-game', { headers: authHeaders })).status).toBe(200);
        site.setMode('introspection-mismatch');
        expect((await fetch(base + '/api/test-game', { headers: authHeaders })).status).toBe(401);
        site.setMode('normal');
        site.revoke();
        expect((await fetch(base + '/api/test-game', { headers: authHeaders })).status).toBe(401);
        expect((await post('/api/auth/site-session', {})).status).toBe(401);
    });
    test.each(['mismatch', 'expired', 'disabled', 'oauth', 'unavailable', 'malformed', 'redirect', 'rate-limit'])('%s site response cannot create users or starting assets', async (mode) => {
        site.setMode(mode);
        const response = await post('/api/auth/site-session', { create: true });
        expect(response.status).toBe(mode === 'rate-limit' ? 429 : ['unavailable', 'malformed', 'redirect'].includes(mode) ? 503 : 401);
        expect(await ds.getRepository(User).count()).toBe(0);
        expect(await ds.getRepository(Account).count()).toBe(0);
    });
    test.each(['https://evil.example', 'null'])('origin %s cannot create or bind accounts', async (origin) => {
        expect((await post('/api/auth/site-session', { create: true }, true, origin)).status).toBe(400);
        expect((await post('/api/auth/site-link', { username: 'test', password: 'test-password' }, true, origin)).status).toBe(400);
        expect(await ds.getRepository(User).count()).toBe(0);
    });
    test('native game credentials work while site is unavailable', async () => {
        site.setMode('unavailable');
        const registered = await post('/api/auth/register', { username: 'http-game-player', password: 'synthetic-password-123' }, false);
        expect(registered.status).toBe(201);
        const user = await registered.json();
        const profile = await fetch(base + '/api/auth/game-profile', { headers: { Authorization: 'Bearer ' + user.token } });
        expect(profile.status).toBe(200);
        expect((await profile.json()).subject).toBe('game:' + user.user.id);
        expect((await post('/api/auth/login', { username: 'http-game-player', password: 'incorrect' }, false)).status).toBe(401);
        expect((await post('/api/auth/login', { username: 'http-game-player', password: 'synthetic-password-123' }, false)).status).toBe(200);
    });
});
