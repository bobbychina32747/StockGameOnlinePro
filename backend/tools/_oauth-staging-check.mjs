// 授权系统部署后验收（HTTP 层）
// 默认打 staging；`CHECK_BASE=https://bobbycn.cc CHECK_AUTH= CHECK_REDIRECT=...` 可直接验线上：
//   $env:CHECK_BASE='https://bobbycn.cc'; $env:CHECK_AUTH=''; node tools/_oauth-staging-check.mjs
// 与 _oauth-smoke.mjs 的差别：不注册新账号（生产/staging 都没有面向脚本的邮件通道），
// 因此这里验的是"部署后端点真的活着、守卫真的拦得住、线上没被拖坏"。
const BASE = process.env.CHECK_BASE || 'https://staging.bobbycn.cc';
const AUTH_RAW = process.env.CHECK_AUTH === undefined
  ? 'Basic ' + Buffer.from('staging:J5qJ22F69KcEU9hxar').toString('base64')
  : process.env.CHECK_AUTH;
const REDIRECT = process.env.CHECK_REDIRECT || (BASE.includes('bobbycn.cc') && !BASE.includes('staging')
  ? 'https://bobbycn.cc/games/oauth-callback.html'
  : 'https://bobbycn.cc/games/oauth-callback.html');
const CLIENT = process.env.CHECK_CLIENT || 'bobbycn-games';
const LABEL = process.env.CHECK_LABEL || (BASE.includes('staging') ? 'staging' : '线上');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function req(url, init) {
  const opts = Object.assign({}, init || {});
  opts.headers = Object.assign({}, AUTH_RAW ? { Authorization: AUTH_RAW } : {}, opts.headers || {});
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout)
    opts.signal = AbortSignal.timeout(20000);
  return fetch(url, opts);
}

async function main() {
  // ① 客户端目录：证明 oauth_clients 建表 + 种子写入 + 端点挂在 nginx 能到的地方
  const clients = await req(`${BASE}/api/auth/identity/oauth/clients`);
  const body = await clients.json().catch(() => null);
  const ids = (body && body.clients ? body.clients : []).map((c) => c.clientId);
  check(`${LABEL}：客户端目录可读（表已建 + 种子已写）`,
    clients.status === 200 && ids.includes(CLIENT),
    `HTTP ${clients.status} → ${ids.join(',')}`);

  // ② 未登录访问 authorize：必须 302 到站点登录页（说明会话守卫生效、不是裸奔）
  const url = `${BASE}/api/auth/identity/oauth/authorize?` + new URLSearchParams({
    client_id: CLIENT, redirect_uri: REDIRECT, response_type: 'code',
    scope: 'openid profile', state: 'stg', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256',
  });
  const anon = await req(url, { redirect: 'manual' });
  const loc = anon.headers.get('location') || '';
  check(`${LABEL}：未登录 → 302 到站点登录页（带 next 回跳）`,
    anon.status === 302 && loc.includes('/login/?next='), `HTTP ${anon.status} → ${loc.slice(0, 80)}`);

  // ③ 恶意回调地址：必须 400 且**不跳转**（开放重定向防线）
  const evil = await req(`${BASE}/api/auth/identity/oauth/authorize?` + new URLSearchParams({
    client_id: CLIENT, redirect_uri: 'https://evil.example/cb', response_type: 'code', scope: 'openid',
  }), { redirect: 'manual' });
  check(`${LABEL}：未登记的 redirect_uri → 400 且无 Location`,
    evil.status === 400 && !evil.headers.get('location'), `HTTP ${evil.status}`);

  // ④ 未注册客户端：400
  const badClient = await req(`${BASE}/api/auth/identity/oauth/authorize?` + new URLSearchParams({
    client_id: 'no-such-app', redirect_uri: REDIRECT, response_type: 'code', scope: 'openid',
  }), { redirect: 'manual' });
  check(`${LABEL}：未注册客户端 → 400`, badClient.status === 400, `HTTP ${badClient.status}`);

  // ⑤ 令牌端点：假授权码必须 invalid_grant（表单体被正确解析；解析失败会变成 unsupported_grant_type）
  const form = new URLSearchParams({
    grant_type: 'authorization_code', client_id: CLIENT, code: 'definitely-not-a-code',
    redirect_uri: REDIRECT, code_verifier: 'y'.repeat(43),
  });
  const token = await req(`${BASE}/api/auth/identity/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString(),
  });
  const tokenBody = await token.json().catch(() => null);
  check(`${LABEL}：表单体被正确解析（假码 → invalid_grant 而不是 unsupported_grant_type）`,
    token.status === 400 && tokenBody && tokenBody.error === 'invalid_grant',
    `HTTP ${token.status} → ${JSON.stringify(tokenBody)}`);

  // ⑥ 云存档端点：无令牌必须 401（不能裸开放）
  const saves = await req(`${BASE}/api/auth/identity/saves/key`);
  check(`${LABEL}：云存档端点无令牌 → 401`, saves.status === 401, `HTTP ${saves.status}`);

  // ⑦ JWKS：公钥集可读（授权与"下游本地验签"共用这条信任链）
  const jwks = await req(`${BASE}/api/auth/identity/.well-known/jwks.json`);
  const jwksBody = await jwks.json().catch(() => null);
  check(`${LABEL}：JWKS 可读且非空`, jwks.status === 200 && jwksBody && jwksBody.keys && jwksBody.keys.length > 0,
    `kid=${jwksBody && jwksBody.keys && jwksBody.keys[0] && jwksBody.keys[0].kid}`);

  // ⑧ 授权记录端点：未登录必须 401（它是站点会话维度的）
  const grants = await req(`${BASE}/api/auth/identity/oauth/grants`);
  check(`${LABEL}：授权记录未登录 → 401`, grants.status === 401, `HTTP ${grants.status}`);

  if (LABEL === '线上') {
    // 线上额外：静态站与游戏/身份旧接口没被拖坏
    const health = await fetch('https://bobbycn.cc/api/health', { signal: AbortSignal.timeout(20000) }).catch(() => null);
    const hb = health && health.ok ? await health.json().catch(() => null) : null;
    check('线上稳定：/api/health 正常（Worker 侧账号/存档链路未受影响）', !!(hb && hb.ok === true), hb ? JSON.stringify(hb).slice(0, 80) : 'unreachable');
    const me = await fetch('https://bobbycn.cc/api/auth/identity/me', { signal: AbortSignal.timeout(20000) }).catch(() => null);
    check('线上稳定：未登录访问 /me 仍返回 401（身份守卫生效）', !!me && me.status === 401, me ? `HTTP ${me.status}` : 'unreachable');
    const portal = await fetch('https://bobbycn.cc/games/', { signal: AbortSignal.timeout(20000) }).catch(() => null);
    check('线上稳定：游戏厅页面可访问', !!portal && portal.status === 200, portal ? `HTTP ${portal.status}` : 'unreachable');
  } else {
    const live = await fetch('https://bobbycn.cc/api/health', { signal: AbortSignal.timeout(20000) }).catch(() => null);
    const liveBody = live && live.ok ? await live.json().catch(() => null) : null;
    check('线上未受影响：bobbycn.cc /api/health 正常', !!(liveBody && liveBody.ok === true),
      liveBody ? JSON.stringify(liveBody).slice(0, 80) : 'unreachable');
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
  for (const f of failed) console.log(`FAILED: ${f.name} — ${f.detail}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('验收脚本异常：', e); process.exit(2); });
