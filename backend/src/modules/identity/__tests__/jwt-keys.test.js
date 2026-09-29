// 统一身份 · 阶段一（跨服务统一身份）：Ed25519 密钥服务 / EdDSA JWT / JWKS / exchange / introspect
// 装置沿用 _harness.js 风格：真实 TypeORM 内存库 + 手工装配服务（不引 @nestjs/testing）。
// 密钥全部现场生成到临时目录，仓库里不存在任何私钥。
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createHarness, expectStatus, TEST_PASSWORD } = require('./_harness');
const { KeysService } = require('../../../../dist/src/modules/identity/keys.service');
const { IdentityJwtService, JWT_TTL_SEC, JWT_ISSUER, JWT_AUDIENCE } = require('../../../../dist/src/modules/identity/jwt.service');
const { TokenExchangeService } = require('../../../../dist/src/modules/identity/token-exchange.service');
const { TurnstileService } = require('../../../../dist/src/modules/identity/turnstile.service');
const { IdentityController } = require('../../../../dist/src/modules/identity/identity.controller');

/** 现场生成一对 Ed25519 密钥，并按规格独立算出 kid（不调用被测代码，避免自证） */
function makeKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return {
    privateKey,
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
    kid: crypto.createHash('sha256').update(der).digest('hex').slice(0, 16),
  };
}

/** 手工造一张 EdDSA 令牌（用于"过期/超长 TTL/换密钥/未知 kid"等被篡改场景） */
function craftToken(privateKey, kid, payload, { alg = 'EdDSA', signature } = {}) {
  const seg = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  const input = `${seg({ alg, typ: 'JWT', kid })}.${seg(payload)}`;
  const sig = signature !== undefined ? signature : crypto.sign(null, Buffer.from(input, 'utf8'), privateKey).toString('base64url');
  return `${input}.${sig}`;
}

function fakeRes() {
  return {
    headers: {}, statusCode: null, body: null, ended: false,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; },
    end() { this.ended = true; return this; },
  };
}

/**
 * 在既有身份装置上挂载阶段一的服务（密钥/JWT/交换/控制器）。
 * env 决定密钥来源；不写 privateKeyFile 时故意指向不存在的路径（模拟"私钥缺失"部署）。
 */
async function bootStage1({ env = {}, privateKeyFile = true, keypair = null } = {}) {
  const h = await createHarness();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-jwt-'));
  const pair = keypair || makeKeyPair();
  const pemPath = path.join(dir, 'identity-ed25519.pem');
  if (privateKeyFile)
    fs.writeFileSync(pemPath, pair.privatePem, { mode: 0o600 });

  const keys = new KeysService();
  keys.env = { IDENTITY_JWT_KEY_FILE: pemPath, ...env };
  keys.reload();

  const jwt = new IdentityJwtService(keys);
  const exchange = new TokenExchangeService(jwt, h.repos.session, h.repos.identity);
  // 本文件只测密钥/JWT/交换三件事：人机验证关掉（它自身在 turnstile.test.js 里单独覆盖）
  const turnstile = new TurnstileService();
  turnstile.env = { TURNSTILE_MODE: 'off' };
  const controller = new IdentityController(h.service, exchange, keys, turnstile);

  return {
    ...h, dir, pemPath, pair, keys, jwt, exchange, controller,
    dispose: async () => { await h.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

describe('统一身份 · 阶段一 密钥与 JWT', () => {
  let h;
  afterEach(async () => { if (h) await h.dispose(); h = null; });

  // ───────────────────── ① JWKS 结构与 kid 稳定性 ─────────────────────

  test('JWKS：OKP/Ed25519/use=sig/alg=EdDSA，kid = 公钥 DER sha256 前 16 位且可复现', async () => {
    h = await bootStage1();
    expect(h.keys.isReady()).toBe(true);
    expect(h.keys.currentKid()).toBe(h.pair.kid);

    const { keys, body, etag } = h.keys.jwks();
    expect(keys).toHaveLength(1);
    const jwk = keys[0];
    expect(jwk).toMatchObject({ kty: 'OKP', crv: 'Ed25519', use: 'sig', alg: 'EdDSA', kid: h.pair.kid });
    // x 是裸公钥（32 字节）的 base64url，不是 PEM/DER
    expect(Buffer.from(jwk.x, 'base64url')).toHaveLength(32);
    expect(body).not.toContain('PRIVATE');           // 私钥绝不进响应体
    expect(body).not.toContain('BEGIN');

    // kid 稳定性：同一把公钥无论重新加载几次、换不换进程，都得到同一个 kid 与同一份 body
    const again = new KeysService();
    again.env = { ...h.keys.env };
    again.reload();
    expect(again.currentKid()).toBe(h.pair.kid);
    expect(again.jwks().body).toBe(body);
    expect(again.jwks().etag).toBe(etag);
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
  });

  test('GET /.well-known/jwks.json：200 + Cache-Control + 内容哈希 ETag；命中 If-None-Match 时 304', async () => {
    h = await bootStage1();
    const res = fakeRes();
    h.controller.jwks({ headers: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.headers['etag']).toBe(h.keys.jwks().etag);
    expect(JSON.parse(res.body).keys[0].kid).toBe(h.pair.kid);
    expect(res.headers['set-cookie']).toBeUndefined(); // 公开端点不种/不读主域 Cookie

    const cached = fakeRes();
    h.controller.jwks({ headers: { 'if-none-match': res.headers['etag'] } }, cached);
    expect(cached.statusCode).toBe(304);
    expect(cached.body).toBeNull();
  });

  // ───────────────────── ② 签发 / 验签 / 篡改 ─────────────────────

  test('签发令牌可被 verify 通过；篡改 payload、改签名、alg:none、未知 kid 一律失败', async () => {
    h = await bootStage1();
    const { identity } = await h.registerAndVerify('jwt1@example.com');
    const session = (await h.repos.session.find())[0];
    const { token, tokenType, expiresIn, kid } = h.exchange.exchange(identity.id, session.id);

    expect(tokenType).toBe('Bearer');
    expect(kid).toBe(h.pair.kid);
    expect(token.split('.')).toHaveLength(3);

    const claims = h.jwt.verify(token);
    expect(claims).toMatchObject({ iss: JWT_ISSUER, aud: JWT_AUDIENCE, sub: identity.id, sid: session.id, kid: h.pair.kid });
    const { header } = h.jwt.peek(token);
    expect(header).toEqual({ alg: 'EdDSA', typ: 'JWT', kid: h.pair.kid });

    // 篡改 payload（换 sub）而签名不动 —— 必须失败
    const [head, payloadPart, sigPart] = token.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ ...h.jwt.peek(token).payload, sub: 'other-identity' }), 'utf8').toString('base64url');
    expectStatus(() => h.jwt.verify(`${head}.${tamperedPayload}.${sigPart}`), 401);
    // 篡改签名
    expectStatus(() => h.jwt.verify(`${head}.${payloadPart}.${sigPart.slice(0, -2)}xy`), 401);
    // alg 降级（alg:none，签名段留空）
    const noneToken = craftToken(null, h.pair.kid, h.jwt.peek(token).payload, { alg: 'none', signature: '' });
    expectStatus(() => h.jwt.verify(noneToken), 401);
    // 拿别的私钥签、kid 换成自己的（服务端没有这把公钥）
    const stranger = makeKeyPair();
    const strangerToken = craftToken(stranger.privateKey, stranger.kid, h.jwt.peek(token).payload);
    expectStatus(() => h.jwt.verify(strangerToken), 401);
    // 结构不完整
    expectStatus(() => h.jwt.verify('not-a-jwt'), 401);
    expectStatus(() => h.jwt.verify(''), 401);
  });

  // ───────────────────── ③ TTL 硬上限 600s ─────────────────────

  test('TTL 硬上限：exp - iat === 600、expiresIn === 600，超长 TTL 即便签名有效也被拒', async () => {
    h = await bootStage1();
    expect(JWT_TTL_SEC).toBe(600); // 「10 分钟硬上限」这条常量本身不许被调大

    const { identity } = await h.registerAndVerify('jwt2@example.com');
    const session = (await h.repos.session.find())[0];
    const { token, expiresIn } = h.exchange.exchange(identity.id, session.id);
    const claims = h.jwt.verify(token);

    expect(expiresIn).toBe(600);
    expect(claims.exp - claims.iat).toBe(600);
    expect(claims.iat).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));

    // 用真私钥签一张 1 小时 TTL 的令牌：签名有效，但超过硬上限 → 拒绝
    const nowSec = Math.floor(Date.now() / 1000);
    const longLived = craftToken(h.pair.privateKey, h.pair.kid, {
      iss: JWT_ISSUER, aud: JWT_AUDIENCE, sub: identity.id, sid: session.id, iat: nowSec, exp: nowSec + 3600,
    });
    expectStatus(() => h.jwt.verify(longLived), 401);
    // 已过期同理
    const expired = craftToken(h.pair.privateKey, h.pair.kid, {
      iss: JWT_ISSUER, aud: JWT_AUDIENCE, sub: identity.id, sid: session.id, iat: nowSec - 700, exp: nowSec - 100,
    });
    expectStatus(() => h.jwt.verify(expired), 401);
    // 受众/签发者不符也拒（防止令牌被搬到别站复用）
    expectStatus(() => h.jwt.verify(craftToken(h.pair.privateKey, h.pair.kid, {
      iss: 'https://evil.example', aud: JWT_AUDIENCE, sub: identity.id, sid: session.id, iat: nowSec, exp: nowSec + 600,
    })), 401);
  });

  // ───────────────────── ④ introspect 与撤销 ─────────────────────

  test('introspect：换出的令牌 active:true；登出/会话过期/令牌过期/拼装令牌一律 active:false', async () => {
    h = await bootStage1();
    const { identity } = await h.registerAndVerify('jwt3@example.com');
    const session = (await h.repos.session.find())[0];
    const { token } = h.exchange.exchange(identity.id, session.id);

    const alive = await h.controller.introspect(token);
    expect(alive).toMatchObject({ active: true, sub: identity.id, sid: session.id });
    expect(alive.exp).toBe(h.jwt.verify(token).exp);

    // 登出 → 同库强一致：立刻 active:false
    await h.service.logout(await h.repos.session.findOne({ where: { id: session.id } }));
    expect(await h.controller.introspect(token)).toEqual({ active: false, sub: null, sid: null, exp: null });

    // 无效令牌 / 空令牌：不抛错、不泄露原因
    const other = await h.registerAndVerify('jwt4@example.com');
    const otherSession = await h.repos.session.findOne({ where: { identityId: other.identity.id } });
    expect(await h.controller.introspect('garbage')).toMatchObject({ active: false });
    expect(await h.controller.introspect('')).toMatchObject({ active: false });
    expect(await h.controller.introspect(undefined)).toMatchObject({ active: false });

    // 拼装令牌：合法会话 sid + 别人的 sub → 绑定关系不自洽，必须拒绝
    const nowSec = Math.floor(Date.now() / 1000);
    const mismatched = craftToken(h.pair.privateKey, h.pair.kid, {
      iss: JWT_ISSUER, aud: JWT_AUDIENCE, sub: identity.id, sid: otherSession.id, iat: nowSec, exp: nowSec + 600,
    });
    expect(await h.controller.introspect(mismatched)).toMatchObject({ active: false });

    // 令牌过期（JWT 自身 exp 已过）
    const stale = craftToken(h.pair.privateKey, h.pair.kid, {
      iss: JWT_ISSUER, aud: JWT_AUDIENCE, sub: other.identity.id, sid: otherSession.id, iat: nowSec - 700, exp: nowSec - 100,
    });
    expect(await h.controller.introspect(stale)).toMatchObject({ active: false });

    // 会话在库里过期（令牌还在有效期内）
    otherSession.expiresAt = new Date(Date.now() - 1000);
    await h.repos.session.save(otherSession);
    const fresh = h.exchange.exchange(other.identity.id, otherSession.id).token;
    expect(await h.controller.introspect(fresh)).toMatchObject({ active: false });

    // 账号被停用：已发出的令牌立即失效（与 SessionAuthGuard 同口径）
    await h.repos.identity.update({ id: other.identity.id }, { status: 'disabled' });
    const stillToken = h.exchange.exchange(other.identity.id, otherSession.id).token;
    expect(await h.controller.introspect(stillToken)).toMatchObject({ active: false });
  });

  // ───────────────────── ⑤ 私钥缺失的降级（硬要求） ─────────────────────

  test('私钥缺失：启动不崩、JWKS 空 set、exchange 503、验签一律失败', async () => {
    h = await bootStage1({ privateKeyFile: false });
    expect(h.keys.isReady()).toBe(false);
    expect(h.keys.currentKid()).toBeNull();
    expect(h.keys.jwks().keys).toEqual([]);                 // 空 set，不是 500
    expect(JSON.parse(h.keys.jwks().body)).toEqual({ keys: [] });

    const res = fakeRes();
    h.controller.jwks({ headers: {} }, res);                // 端点本身照常可用
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');

    const { identity } = await h.registerAndVerify('jwt5@example.com'); // 既有身份功能不受影响
    const session = (await h.repos.session.find())[0];
    await expectStatus(() => h.exchange.exchange(identity.id, session.id), 503);
    await expectStatus(() => h.controller.token(identity.id, session.id), 503);
    expect(await h.controller.introspect('anything')).toMatchObject({ active: false });
    // 既有会话鉴权链路（Cookie/Bearer）完全不受密钥缺失影响
    const second = await h.registerAndVerify('jwt6@example.com');
    await expect(h.service.resolveSession(second.sessionToken)).resolves.toBeTruthy();
  });

  test('私钥内容非法（PEM 解析失败）同样只降级，不让应用起不来', async () => {
    const keys = new KeysService();
    keys.env = { IDENTITY_JWT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\n不是密钥\n-----END PRIVATE KEY-----' };
    expect(() => keys.onModuleInit()).not.toThrow();  // onModuleInit 必须吞掉异常
    expect(keys.isReady()).toBe(false);
    expect(keys.jwks().keys).toEqual([]);

    // 单行内联 PEM（把 \n 写成转义）也要能加载：部署脚本最常见的写法
    const pair = makeKeyPair();
    const inline = new KeysService();
    inline.env = { IDENTITY_JWT_PRIVATE_KEY: pair.privatePem.replace(/\n/g, '\\n') };
    inline.reload();
    expect(inline.isReady()).toBe(true);
    expect(inline.currentKid()).toBe(pair.kid);
  });

  // ───────────────────── ⑥ 双 kid 热轮换 ─────────────────────

  test('双密钥：JWKS 同时含新旧 kid，签发只用当前私钥，旧私钥签的旧令牌仍可验', async () => {
    const prev = makeKeyPair();
    const next = makeKeyPair();
    h = await bootStage1({ keypair: next, env: { IDENTITY_JWT_PREV_KEYS: JSON.stringify([{ kid: prev.kid, publicPem: prev.publicPem }]) } });

    const kids = h.keys.jwks().keys.map((k) => k.kid);
    expect(kids).toHaveLength(2);
    expect(kids).toContain(next.kid);   // 当前键
    expect(kids).toContain(prev.kid);   // 轮换期旧键（旧令牌还能验）
    expect(h.keys.currentKid()).toBe(next.kid);

    const { identity } = await h.registerAndVerify('jwt7@example.com');
    const session = (await h.repos.session.find())[0];
    const { token, kid } = h.exchange.exchange(identity.id, session.id);
    expect(kid).toBe(next.kid);                          // 签发只用当前私钥
    expect(h.jwt.peek(token).header.kid).toBe(next.kid);

    // 轮换前用旧私钥签发的令牌：kid 在 JWKS 里 → 继续通过
    const nowSec = Math.floor(Date.now() / 1000);
    const legacy = craftToken(prev.privateKey, prev.kid, {
      iss: JWT_ISSUER, aud: JWT_AUDIENCE, sub: identity.id, sid: session.id, iat: nowSec, exp: nowSec + 600,
    });
    expect(h.jwt.verify(legacy).kid).toBe(prev.kid);
    expect(await h.controller.introspect(legacy)).toMatchObject({ active: true });

    // 目录扫描：*.pub.pem 无需重启即可补进 JWKS（reload 热加载）
    const older = makeKeyPair();
    const etagBefore = h.keys.jwks().etag;
    fs.writeFileSync(path.join(h.dir, 'identity-ed25519.old.pub.pem'), older.publicPem);
    h.keys.reload();
    const after = h.keys.jwks();
    expect(after.keys.map((k) => k.kid)).toEqual(expect.arrayContaining([next.kid, prev.kid, older.kid]));
    expect(after.etag).not.toBe(etagBefore);             // 密钥集变了 → ETag 必须变（下游缓存才会失效）
    expect(h.keys.currentKid()).toBe(next.kid);          // 私钥没换，签发身份不变
  });
});
