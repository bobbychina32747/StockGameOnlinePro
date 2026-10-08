// 授权系统（OAuth 2.0 授权码 + PKCE）行为单测。
// 关注点不是"能跑通"，而是**每条安全边界都真的拦得住**：
// 回调地址精确匹配、PKCE 校验、授权码一次性、刷新令牌轮换与重放检测、scope 裁剪、撤销生效。
const { createOauthHarness, pkcePair } = require('./_oauth-harness');

const GAMES_CLIENT = 'bobbycn-games';
const REDIRECT = 'https://bobbycn.cc/games/oauth-callback.html';

/** 断言 Nest HttpException 的 OAuth 错误码 */
function expectOauthError(promise, error, status) {
  return promise.then(
    () => { throw new Error(`预期失败（${error}），但调用成功了`); },
    (e) => {
      const body = typeof e.getResponse === 'function' ? e.getResponse() : {};
      expect(body.error).toBe(error);
      if (status)
        expect(e.getStatus()).toBe(status);
    },
  );
}

describe('授权系统 · 客户端注册与参数校验', () => {
  let h;
  beforeEach(async () => { h = await createOauthHarness(); });
  afterEach(async () => { await h.close(); });

  test('第一方游戏客户端已自动注册（加游戏 = 加一行种子）', async () => {
    const list = await h.oauth.listClients();
    const ids = list.map((c) => c.clientId);
    expect(ids).toContain(GAMES_CLIENT);
    expect(ids).toContain('zombie-survival');
    expect(ids).toContain('dreamcore-walk');
    const games = list.find((c) => c.clientId === GAMES_CLIENT);
    expect(games.firstParty).toBe(true);
    expect(games.scopes).toEqual(expect.arrayContaining(['openid', 'profile', 'email', 'saves', 'arcade']));
    // 公开信息里绝不能出现 secret 哈希
    expect(JSON.stringify(games)).not.toMatch(/clientSecret/i);
  });

  test('种子幂等：重复执行不产生重复行', async () => {
    const before = await h.repos.client.count();
    await h.oauth.seedBuiltinClients();
    await h.oauth.seedBuiltinClients();
    expect(await h.repos.client.count()).toBe(before);
  });

  test('回调地址必须精确登记：未登记的一律拒绝', async () => {
    const client = await h.oauth.findClient(GAMES_CLIENT);
    expect(() => h.oauth.resolveRedirectUri(client, 'https://evil.example/cb')).toThrow(/未在客户端登记/);
    // 前缀相似也不行（防开放重定向）
    expect(() => h.oauth.resolveRedirectUri(client, 'https://bobbycn.cc/games/oauth-callback.html.evil.com'))
      .toThrow(/未在客户端登记/);
    expect(h.oauth.resolveRedirectUri(client, REDIRECT)).toBe(REDIRECT);
  });
  test('未注册/已停用的客户端 = invalid_client', async () => {
    expect(await h.oauth.findClient('nope')).toBeNull();
    const client = await h.oauth.findClient(GAMES_CLIENT);
    client.active = false;
    await h.repos.client.save(client);
    expect(await h.oauth.findClient(GAMES_CLIENT)).toBeNull();
  });

  test('scope 越权申请直接报错，不静默缩小', async () => {
    const client = await h.oauth.findClient(GAMES_CLIENT);
    expect(() => h.oauth.resolveScopes(client, 'openid admin')).toThrow(/不支持的 scope/);
    expect(() => h.oauth.resolveScopes(client, 'openid profile')).not.toThrow();
    expect(h.oauth.resolveScopes(client, 'openid profile')).toEqual(['openid', 'profile']);
  });
});

describe('授权系统 · /authorize', () => {
  let h, identity;
  beforeEach(async () => {
    h = await createOauthHarness();
    identity = await h.activeIdentity();
  });
  afterEach(async () => { await h.close(); });

  test('未登录：不报错，引导去站点登录页（next 回跳白名单）', async () => {
    const { challenge } = pkcePair();
    const result = await h.oauth.resolveAuthorize({
      clientId: GAMES_CLIENT, redirectUri: REDIRECT, responseType: 'code', scope: 'openid profile',
      codeChallenge: challenge, codeChallengeMethod: 'S256', state: 'st-1',
    }, null);
    expect(result.kind).toBe('page');
    const loginUrl = h.oauth.loginUrlFor(`/api/auth/identity/oauth/authorize?client_id=${GAMES_CLIENT}`);
    expect(loginUrl).toBe(`/login/?next=${encodeURIComponent(`/api/auth/identity/oauth/authorize?client_id=${GAMES_CLIENT}`)}`);
    // 站外地址不许回跳（开放重定向防护）
    expect(h.oauth.loginUrlFor('https://evil.example/')).toBe('/login/');
    expect(h.oauth.loginUrlFor('//evil.example/')).toBe('/login/');
  });

  test('首次授权：返回同意页（不自动放行）', async () => {
    const { challenge } = pkcePair();
    const result = await h.oauth.resolveAuthorize({
      clientId: GAMES_CLIENT, redirectUri: REDIRECT, responseType: 'code', scope: 'openid profile saves',
      codeChallenge: challenge, codeChallengeMethod: 'S256', state: 'st-2',
    }, identity.session);
    expect(result.kind).toBe('page');
    expect(result.scopes).toEqual(['openid', 'profile', 'saves']);
    expect(result.client.clientId).toBe(GAMES_CLIENT);
  });

  test('同意后：发码并带上 state；授权关系被记住', async () => {
    const { challenge } = pkcePair();
    const approved = await h.oauth.approve({
      clientId: GAMES_CLIENT, redirectUri: REDIRECT, scope: 'openid profile', state: 'st-3',
      codeChallenge: challenge, codeChallengeMethod: 'S256',
    }, identity.session);
    const url = new URL(approved.location);
    expect(url.origin + url.pathname).toBe(REDIRECT);
    expect(url.searchParams.get('state')).toBe('st-3');
    expect(url.searchParams.get('code')).toBeTruthy();

    const grants = await h.oauth.listGrants(identity.identity.id);
    expect(grants).toHaveLength(1);
    expect(grants[0].scopes).toEqual(['openid', 'profile']);
    // 库里只存授权码哈希，明文绝不落库
    const rows = await h.repos.code.find();
    expect(rows).toHaveLength(1);
    expect(rows[0].codeHash).toBe(h.tokens.sha256(url.searchParams.get('code')));
    expect(rows[0].codeHash).not.toBe(url.searchParams.get('code'));
  });

  test('已同意过同一组 scope：第二次直接发码（不再打扰用户）', async () => {
    const first = pkcePair();
    await h.oauth.approve({
      clientId: GAMES_CLIENT, redirectUri: REDIRECT, scope: 'openid profile', state: 'a',
      codeChallenge: first.challenge, codeChallengeMethod: 'S256',
    }, identity.session);
    const second = pkcePair();
    const result = await h.oauth.resolveAuthorize({
      clientId: GAMES_CLIENT, redirectUri: REDIRECT, responseType: 'code', scope: 'openid profile',
      codeChallenge: second.challenge, codeChallengeMethod: 'S256', state: 'b',
    }, identity.session);
    expect(result.kind).toBe('redirect');
    expect(new URL(result.location).searchParams.get('code')).toBeTruthy();
  });

  test('申请了额外 scope：必须重新确认（不能拿旧授权放行）', async () => {
    const first = pkcePair();
    await h.oauth.approve({
      clientId: GAMES_CLIENT, redirectUri: REDIRECT, scope: 'openid profile', state: 'a',
      codeChallenge: first.challenge, codeChallengeMethod: 'S256',
    }, identity.session);
    const second = pkcePair();
    const result = await h.oauth.resolveAuthorize({
      clientId: GAMES_CLIENT, redirectUri: REDIRECT, responseType: 'code', scope: 'openid profile saves',
      codeChallenge: second.challenge, codeChallengeMethod: 'S256',
    }, identity.session);
    expect(result.kind).toBe('page');
  });

  test('客户端可信但参数不可信：用 302 带 error 回客户端（RFC 6749 §4.1.2.1）', async () => {
    const bad = await h.oauth.resolveAuthorize({
      clientId: GAMES_CLIENT, redirectUri: REDIRECT, responseType: 'token', scope: 'openid', state: 's',
    }, identity.session);
    expect(bad.kind).toBe('redirect');
    expect(new URL(bad.location).searchParams.get('error')).toBe('unsupported_response_type');
    expect(new URL(bad.location).searchParams.get('state')).toBe('s');

    const noPkce = await h.oauth.resolveAuthorize({
      clientId: GAMES_CLIENT, redirectUri: REDIRECT, responseType: 'code', scope: 'openid',
    }, identity.session);
    expect(new URL(noPkce.location).searchParams.get('error')).toBe('invalid_request');
  });

  test('客户端/回调地址不可信：不跳转，直接 400（否则站点成了跳板）', async () => {
    const badClient = await h.oauth.resolveAuthorize({
      clientId: 'unknown-app', redirectUri: REDIRECT, responseType: 'code', scope: 'openid',
    }, identity.session);
    expect(badClient.kind).toBe('error');
    expect(badClient.status).toBe(400);

    const badRedirect = await h.oauth.resolveAuthorize({
      clientId: GAMES_CLIENT, redirectUri: 'https://evil.example/cb', responseType: 'code', scope: 'openid',
    }, identity.session);
    expect(badRedirect.kind).toBe('error');
  });

  test('拒绝授权：error=access_denied 回客户端，且不写授权关系', async () => {
    const denied = await h.oauth.deny({ clientId: GAMES_CLIENT, redirectUri: REDIRECT, state: 'd' });
    const url = new URL(denied.location);
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('state')).toBe('d');
    expect(await h.repos.grant.count()).toBe(0);
  });
});

describe('授权系统 · /token 授权码兑换', () => {
  let h, identity;
  beforeEach(async () => {
    h = await createOauthHarness();
    identity = await h.activeIdentity();
  });
  afterEach(async () => { await h.close(); });

  async function fullFlow(scope = 'openid profile email') {
    const { verifier, challenge } = pkcePair();
    const approved = await h.oauth.approve({
      clientId: GAMES_CLIENT, redirectUri: REDIRECT, scope, state: 'x',
      codeChallenge: challenge, codeChallengeMethod: 'S256',
    }, identity.session);
    const code = new URL(approved.location).searchParams.get('code');
    return { verifier, challenge, code };
  }

  test('兑换成功：返回 access/refresh/id_token，claims 带 client_id 与 scope', async () => {
    const { verifier, code } = await fullFlow();
    const out = await h.oauth.exchangeCode({
      clientId: GAMES_CLIENT, code, redirectUri: REDIRECT, codeVerifier: verifier,
    });
    expect(out.token_type).toBe('Bearer');
    expect(out.expires_in).toBe(600);
    expect(out.scope).toBe('openid profile email');
    expect(out.refresh_token).toBeTruthy();

    const claims = h.jwt.verify(out.access_token);
    expect(claims.sub).toBe(identity.identity.id);
    expect(claims.sid).toBe(identity.session.id);
    expect(claims.client_id).toBe(GAMES_CLIENT);
    expect(claims.scope).toBe('openid profile email');
    expect(claims.iss).toBe('https://bobbycn.cc');
    expect(claims.aud).toBe('bobbycn.cc');

    // 刷新令牌只存哈希
    const rows = await h.repos.refresh.find();
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(h.tokens.sha256(out.refresh_token));
    expect(rows[0].tokenHash).not.toBe(out.refresh_token);
  });

  test('授权码一次性：第二次兑换 invalid_grant', async () => {
    const { verifier, code } = await fullFlow();
    await h.oauth.exchangeCode({ clientId: GAMES_CLIENT, code, redirectUri: REDIRECT, codeVerifier: verifier });
    await expectOauthError(
      h.oauth.exchangeCode({ clientId: GAMES_CLIENT, code, redirectUri: REDIRECT, codeVerifier: verifier }),
      'invalid_grant',
    );
  });

  test('PKCE 校验：verifier 不对 / 缺失 → invalid_grant（校验失败不消耗授权码）', async () => {
    const { verifier, code } = await fullFlow();
    await expectOauthError(
      h.oauth.exchangeCode({ clientId: GAMES_CLIENT, code, redirectUri: REDIRECT, codeVerifier: 'x'.repeat(50) }),
      'invalid_grant',
    );
    await expectOauthError(
      h.oauth.exchangeCode({ clientId: GAMES_CLIENT, code, redirectUri: REDIRECT }),
      'invalid_grant',
    );
    // 两次失败都发生在"烧码"之前，所以正确的 verifier 仍然能成功兑换
    const ok = await h.oauth.exchangeCode({ clientId: GAMES_CLIENT, code, redirectUri: REDIRECT, codeVerifier: verifier });
    expect(ok.access_token).toBeTruthy();
  });

  test('redirect_uri 必须与授权时逐字一致', async () => {
    const { verifier, code } = await fullFlow();
    await expectOauthError(
      h.oauth.exchangeCode({ clientId: GAMES_CLIENT, code, redirectUri: 'https://bobbycn.cc/games/', codeVerifier: verifier }),
      'invalid_grant',
    );
  });

  test('授权码不能给别的客户端用', async () => {
    const { verifier, code } = await fullFlow();
    await expectOauthError(
      h.oauth.exchangeCode({ clientId: 'zombie-survival', code, redirectUri: REDIRECT, codeVerifier: verifier }),
      'invalid_grant',
    );
  });

  test('授权码过期即失效', async () => {
    const { verifier, code } = await fullFlow();
    await h.repos.code.update({ codeHash: h.tokens.sha256(code) }, { expiresAt: new Date(Date.now() - 1000) });
    await expectOauthError(
      h.oauth.exchangeCode({ clientId: GAMES_CLIENT, code, redirectUri: REDIRECT, codeVerifier: verifier }),
      'invalid_grant',
    );
  });

  test('会话在此期间被撤销：发不出令牌', async () => {
    const { verifier, code } = await fullFlow();
    await h.repos.session.update({ id: identity.session.id }, { revokedAt: new Date() });
    await expectOauthError(
      h.oauth.exchangeCode({ clientId: GAMES_CLIENT, code, redirectUri: REDIRECT, codeVerifier: verifier }),
      'invalid_grant',
    );
  });

  test('PKCE 只接受 S256（plain 一律拒绝）', async () => {
    const { challenge } = pkcePair();
    const result = await h.oauth.resolveAuthorize({
      clientId: GAMES_CLIENT, redirectUri: REDIRECT, responseType: 'code', scope: 'openid',
      codeChallenge: challenge, codeChallengeMethod: 'plain',
    }, identity.session);
    expect(result.kind).toBe('redirect');
    expect(new URL(result.location).searchParams.get('error')).toBe('invalid_request');
  });
});

describe('授权系统 · /token 刷新与撤销', () => {
  let h, identity;
  beforeEach(async () => {
    h = await createOauthHarness();
    identity = await h.activeIdentity();
  });
  afterEach(async () => { await h.close(); });

  async function tokensFor(scope = 'openid profile') {
    const { verifier, challenge } = pkcePair();
    const approved = await h.oauth.approve({
      clientId: GAMES_CLIENT, redirectUri: REDIRECT, scope, state: 'x',
      codeChallenge: challenge, codeChallengeMethod: 'S256',
    }, identity.session);
    return h.oauth.exchangeCode({
      clientId: GAMES_CLIENT,
      code: new URL(approved.location).searchParams.get('code'),
      redirectUri: REDIRECT,
      codeVerifier: verifier,
    });
  }

  test('刷新：换新 access + 新 refresh（一次性轮换，旧刷新令牌立刻作废）', async () => {
    const first = await tokensFor();
    const second = await h.oauth.refreshTokens({ clientId: GAMES_CLIENT, refreshToken: first.refresh_token });
    expect(second.access_token).toBeTruthy();
    expect(h.jwt.verify(second.access_token).client_id).toBe(GAMES_CLIENT);
    // 轮换：新刷新令牌入库、旧的被标记 usedAt
    const oldRow = await h.repos.refresh.findOne({ where: { tokenHash: h.tokens.sha256(first.refresh_token) } });
    const newRow = await h.repos.refresh.findOne({ where: { tokenHash: h.tokens.sha256(second.refresh_token) } });
    expect(oldRow.usedAt).toBeTruthy();
    expect(newRow.usedAt).toBeNull();
    expect(newRow.grantId).toBe(oldRow.grantId);
  });

  test('刷新令牌重放：同一授权下全部刷新令牌作废（宁可让用户重授权）', async () => {
    const first = await tokensFor();
    const second = await h.oauth.refreshTokens({ clientId: GAMES_CLIENT, refreshToken: first.refresh_token });
    // 攻击者拿着用过的旧刷新令牌再来一次
    await expectOauthError(h.oauth.refreshTokens({ clientId: GAMES_CLIENT, refreshToken: first.refresh_token }), 'invalid_grant');
    // 正当用户手里的新令牌也被一并作废（无法区分谁是攻击者）
    await expectOauthError(h.oauth.refreshTokens({ clientId: GAMES_CLIENT, refreshToken: second.refresh_token }), 'invalid_grant');
  });

  test('刷新令牌不能跨客户端使用', async () => {
    const first = await tokensFor();
    await expectOauthError(h.oauth.refreshTokens({ clientId: 'zombie-survival', refreshToken: first.refresh_token }), 'invalid_grant');
  });

  test('登出（站点会话全部撤销）后刷新失败', async () => {
    const first = await tokensFor();
    await h.repos.session.update({ id: identity.session.id }, { revokedAt: new Date() });
    await expectOauthError(h.oauth.refreshTokens({ clientId: GAMES_CLIENT, refreshToken: first.refresh_token }), 'invalid_grant');
  });

  test('用户解除授权：刷新令牌作废 + 已发出的令牌被 userinfo 拒绝', async () => {
    const first = await tokensFor();
    expect(await h.oauth.userInfo(first.access_token)).toMatchObject({ sub: identity.identity.id });
    const revoked = await h.oauth.revokeGrantFor(identity.identity.id, GAMES_CLIENT);
    expect(revoked.revoked).toBe(true);
    await expectOauthError(h.oauth.refreshTokens({ clientId: GAMES_CLIENT, refreshToken: first.refresh_token }), 'invalid_grant');
    // access token 是短时 JWT，撤销后立刻被"授权已撤销"拦下（userinfo 走 verifyAccessToken）
    await expect(h.oauth.userInfo(first.access_token)).rejects.toBeTruthy();
  });

  test('RFC 7009 撤销刷新令牌：成功一次；重复调用不再返回成功；撤销后刷新必然失败', async () => {
    const first = await tokensFor();
    expect(await h.oauth.revoke({ clientId: GAMES_CLIENT, token: first.refresh_token })).toEqual({ revoked: true });
    // 授权已解除 → 第二次调用返回 false（对外不区分"撤销过"与"不存在"，但刷新一定失败）
    expect(await h.oauth.revoke({ clientId: GAMES_CLIENT, token: first.refresh_token })).toEqual({ revoked: false });
    expect(await h.oauth.revoke({ clientId: GAMES_CLIENT, token: 'not-a-token' })).toEqual({ revoked: false });
    expect(await h.oauth.revoke({ clientId: 'zombie-survival', token: first.refresh_token })).toEqual({ revoked: false });
    await expectOauthError(h.oauth.refreshTokens({ clientId: GAMES_CLIENT, refreshToken: first.refresh_token }), 'invalid_grant');
  });
});

describe('授权系统 · /userinfo 与 scope 裁剪', () => {
  let h, identity;
  beforeEach(async () => {
    h = await createOauthHarness();
    identity = await h.activeIdentity('scoped@example.com', 'scoped');
  });
  afterEach(async () => { await h.close(); });

  async function tokenWithScope(scope) {
    const { verifier, challenge } = pkcePair();
    const approved = await h.oauth.approve({
      clientId: GAMES_CLIENT, redirectUri: REDIRECT, scope, state: 'x',
      codeChallenge: challenge, codeChallengeMethod: 'S256',
    }, identity.session);
    const out = await h.oauth.exchangeCode({
      clientId: GAMES_CLIENT,
      code: new URL(approved.location).searchParams.get('code'),
      redirectUri: REDIRECT,
      codeVerifier: verifier,
    });
    return out.access_token;
  }

  test('scope 决定字段：没申请 email 就绝不返回邮箱', async () => {
    const withEmail = await h.oauth.userInfo(await tokenWithScope('openid profile email'));
    expect(withEmail).toMatchObject({ sub: identity.identity.id, username: 'scoped', email: 'scoped@example.com', email_verified: true });

    const withoutEmail = await h.oauth.userInfo(await tokenWithScope('openid profile'));
    expect(withoutEmail.email).toBeUndefined();
    expect(withoutEmail.username).toBe('scoped');
  });

  test('伪造/篡改的令牌一律 401', async () => {
    const token = await tokenWithScope('openid profile');
    await expect(h.oauth.userInfo(`${token}x`)).rejects.toBeTruthy();
    await expect(h.oauth.userInfo('a.b.c')).rejects.toBeTruthy();
    await expect(h.oauth.userInfo('')).rejects.toBeTruthy();
  });

  test('requireScope：资源服务按 scope 放行', async () => {
    const token = await tokenWithScope('openid profile saves');
    const claims = await h.oauth.requireScope(token, 'saves');
    expect(claims.sub).toBe(identity.identity.id);
    await expect(h.oauth.requireScope(token, 'arcade')).rejects.toBeTruthy();
  });

  test('身份被停用：令牌立即失效', async () => {
    const token = await tokenWithScope('openid profile');
    await h.repos.identity.update({ id: identity.identity.id }, { status: 'disabled' });
    await expect(h.oauth.userInfo(token)).rejects.toBeTruthy();
  });

  test('不存在身份的令牌（会话查不到）被拒绝', async () => {
    const token = await tokenWithScope('openid profile');
    await h.repos.session.delete({ id: identity.session.id });
    await expect(h.oauth.userInfo(token)).rejects.toBeTruthy();
  });
});

describe('授权系统 · 降级与私钥缺失', () => {
  test('私钥缺失：/token 回 temporarily_unavailable（503）而不是 500', async () => {
    const h = await createOauthHarness();
    const identity = await h.activeIdentity();
    const client = await h.oauth.findClient(GAMES_CLIENT);
    // 运行期私钥不可用（部署未就位）：授权关系照旧写得进，失败点必须发生在「签发令牌」这一步
    h.degradeKeys();

    const { verifier, challenge } = pkcePair();
    const code = await h.oauth.issueCode(client, identity.session, REDIRECT, ['openid', 'profile'], challenge, 'S256');
    await expectOauthError(
      h.oauth.exchangeCode({ clientId: GAMES_CLIENT, code, redirectUri: REDIRECT, codeVerifier: verifier }),
      'temporarily_unavailable',
      503,
    );
    const again = await h.oauth.issueCode(client, identity.session, REDIRECT, ['openid'], null, null);
    await expectOauthError(
      h.oauth.exchangeCode({ clientId: GAMES_CLIENT, code: again, redirectUri: REDIRECT }),
      'temporarily_unavailable',
      503,
    );
    // 降级只影响签发：JWKS 回空 set、其它端点照常
    expect(h.keys.jwks().keys).toEqual([]);
    expect(h.keys.isReady()).toBe(false);
    await h.close();
  });
});

describe('授权系统 · 机密客户端（有服务端密钥的接入方）', () => {
  let h, identity;
  beforeEach(async () => {
    h = await createOauthHarness();
    identity = await h.activeIdentity();
    const { createHash } = require('crypto');
    await h.repos.client.save(h.repos.client.create({
      clientId: 'third-party-app',
      name: '第三方应用',
      type: 'confidential',
      clientSecretHash: createHash('sha256').update('s3cret-value', 'utf8').digest('hex'),
      redirectUris: ['https://partner.example/callback'],
      scopes: ['openid', 'profile', 'email'],
      requirePkce: false,
      active: true,
      firstParty: false,
    }));
  });
  afterEach(async () => { await h.close(); });

  test('client_secret 不对 → invalid_client(401)', async () => {
    await expectOauthError(
      h.oauth.exchangeCode({ clientId: 'third-party-app', clientSecret: 'wrong', code: 'x', redirectUri: 'https://partner.example/callback' }),
      'invalid_client',
      401,
    );
  });

  test('public 客户端不需要 secret；但拿机密客户端身份伪造也不行', async () => {
    // 公开客户端（站内游戏）不带 secret 也能换令牌，见上一组用例；这里验证机密客户端的另一面：
    const client = await h.oauth.findClient('third-party-app');
    expect(client.type).toBe('confidential');
    expect(client.clientSecretHash).toBeTruthy();
    // 库里只有哈希，明文绝不出现
    expect(JSON.stringify(await h.repos.client.find())).not.toContain('s3cret-value');
  });

  test('无 PKCE 的机密客户端可以正常换令牌', async () => {
    const approved = await h.oauth.approve({
      clientId: 'third-party-app', redirectUri: 'https://partner.example/callback', scope: 'openid profile', state: 's',
    }, identity.session);
    const out = await h.oauth.exchangeCode({
      clientId: 'third-party-app',
      clientSecret: 's3cret-value',
      code: new URL(approved.location).searchParams.get('code'),
      redirectUri: 'https://partner.example/callback',
    });
    expect(out.access_token).toBeTruthy();
    expect(out.scope).toBe('openid profile');
  });

  test('机密客户端申请未登记的 scope 一样被拒', async () => {
    const client = await h.oauth.findClient('third-party-app');
    expect(() => h.oauth.resolveScopes(client, 'openid saves')).toThrow(/不支持的 scope/);
    expect(h.oauth.resolveScopes(client, 'openid email')).toEqual(['openid', 'email']);
  });
});
