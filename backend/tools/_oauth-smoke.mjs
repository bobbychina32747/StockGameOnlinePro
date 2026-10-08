// 本机真机冒烟：授权码 + PKCE 全链路（不依赖浏览器）
// 用法：node tools/_oauth-smoke.mjs
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:8099';
const REDIRECT = 'http://localhost:5180/games/oauth-callback.html';
const CLIENT = 'bobbycn-games';

import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const results = [];
/** 每个请求都带超时：某个端点挂住时脚本要报错退出，而不是把整轮冒烟卡死 */
const REQ_TIMEOUT_MS = 15000;
function req(url, init) {
  const opts = Object.assign({}, init || {});
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout)
    opts.signal = AbortSignal.timeout(REQ_TIMEOUT_MS);
  return fetch(url, opts);
}
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function json(res) {
  const text = await res.text();
  try { return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null }; }
  catch { return { status: res.status, headers: res.headers, body: { raw: text } }; }
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

async function main() {
  // ① 客户端目录
  const clients = await json(await req(`${BASE}/api/auth/identity/oauth/clients`));
  const ids = (clients.body?.clients || []).map((c) => c.clientId);
  check('客户端目录公开可读且含站内游戏', clients.status === 200 && ids.includes(CLIENT), ids.join(','));

  // ② 注册一个身份（邮件只写日志）→ 从库里取验证令牌 → 验证 → 拿会话 Cookie
  const email = `smoke-${Date.now()}@example.com`;
  const password = 'SmokePass!2026';
  const reg = await json(await req(`${BASE}/api/auth/identity/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }));
  check('注册受理（不泄露是否已存在）', reg.status === 200 && reg.body?.success === true, JSON.stringify(reg.body));

  const db = require('better-sqlite3')('E:\\Files\\Games\\stockGameOnlinePro\\.local-oauth\\oauth-dev.db', { readonly: true });
  const row = db.prepare('SELECT tokenHash, purpose, usedAt FROM identity_tokens ORDER BY createdAt DESC LIMIT 1').get();
  const identity = db.prepare('SELECT id, status, username FROM identities WHERE email = ?').get(email);
  db.close();
  check('注册建了 pending 身份 + 一次性令牌', !!row && identity?.status === 'pending', `${identity?.status}`);

  // 令牌明文只在邮件里，LogMailer 会把它写进后端日志：从日志里读回来（模拟用户点邮件链接）
  // 注意：PowerShell 的 `*>` 重定向写的是 UTF-16LE，按 utf8 读会全是乱码 —— 这里显式解码。
  const logPath = (process.env.SMOKE_LOG || 'E:\\Files\\_local-be2.log');
  const rawLog = require('node:fs').readFileSync(logPath);
  let log = rawLog.toString('utf8');
  if (log.includes('\u0000')) log = rawLog.toString('utf16le');
  const all = [...log.matchAll(/verify-email\?token=([A-Za-z0-9_%.-]+)/g)];
  check('注册确认邮件里有可用验证链接（LogMailer）', all.length > 0, all.length ? 'found' : 'no link in log');
  if (!all.length) { finish(); return; }
  const verifyToken = decodeURIComponent(all[all.length - 1][1]);

  const verified = await json(await req(`${BASE}/api/auth/identity/verify`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: verifyToken }),
  }));
  const sid = (verified.headers.getSetCookie?.() || []).join('; ').match(/sid=([^;]+)/)?.[1] || '';
  check('邮箱验证后签发会话（域级 Cookie sid）', verified.status === 200 && !!sid, `status=${verified.status}`);

  const me = await json(await req(`${BASE}/api/auth/identity/me`, { headers: { cookie: `sid=${sid}` } }));
  check('GET /me 返回白名单身份字段', me.status === 200 && me.body?.id === identity.id, JSON.stringify(me.body));

  // ③ 未登录访问 authorize → 302 到站点登录页（带 next 回跳）
  const verifier = b64url(randomBytes(32));
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = b64url(randomBytes(16));
  const authUrl = `${BASE}/api/auth/identity/oauth/authorize?` + new URLSearchParams({
    client_id: CLIENT, redirect_uri: REDIRECT, response_type: 'code',
    scope: 'openid profile email saves arcade', state, code_challenge: challenge, code_challenge_method: 'S256',
  });
  const anon = await req(authUrl, { redirect: 'manual' });
  const anonLoc = anon.headers.get('location') || '';
  check('未登录 → 302 到站点登录页并带 next 回跳', anon.status === 302 && anonLoc.includes('/login/?next='), anonLoc.slice(0, 90));

  // ④ 已登录首次访问 → 同意页 HTML
  const consent = await req(authUrl, { headers: { cookie: `sid=${sid}` } });
  const consentHtml = await consent.text();
  check('已登录首次访问 → 渲染同意页（列出 scope）', consent.status === 200 && consentHtml.includes('想访问你的账号') && consentHtml.includes('saves'), `len=${consentHtml.length}`);

  // ⑤ 恶意回调地址 → 400（不跳转）
  const evil = await req(`${BASE}/api/auth/identity/oauth/authorize?` + new URLSearchParams({
    client_id: CLIENT, redirect_uri: 'https://evil.example/cb', response_type: 'code', scope: 'openid',
  }), { headers: { cookie: `sid=${sid}` }, redirect: 'manual' });
  check('未登记的 redirect_uri → 400 且不跳转', evil.status === 400 && !evil.headers.get('location'), `status=${evil.status}`);

  // ⑥ 同意（表单 POST）→ 302 回客户端并带上 code/state
  const approve = await req(`${BASE}/api/auth/identity/oauth/authorize`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: `sid=${sid}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      decision: 'allow', client_id: CLIENT, redirect_uri: REDIRECT,
      scope: 'openid profile email saves arcade', state, code_challenge: challenge, code_challenge_method: 'S256',
    }).toString(),
  });
  const loc = approve.headers.get('location') || '';
  const approveBody = loc ? '' : (await approve.text()).slice(0, 300);
  const code = loc ? new URL(loc).searchParams.get('code') : '';
  check('同意后 302 回客户端并带 code + state', approve.status === 302 && !!code && new URL(loc).searchParams.get('state') === state,
    `status=${approve.status} loc=${loc.slice(0, 110)} ${approveBody}`);

  // ⑦ 授权码换令牌（表单体，走 main.ts 的 raw-body 中间件）
  const tokenRes = await json(await req(`${BASE}/api/auth/identity/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: CLIENT, code, redirect_uri: REDIRECT, code_verifier: verifier }).toString(),
  }));
  check('授权码换令牌成功（表单体）', tokenRes.status === 200 && !!tokenRes.body?.access_token && !!tokenRes.body?.refresh_token, `scope=${tokenRes.body?.scope}`);

  // ⑧ 授权码一次性
  const replay = await json(await req(`${BASE}/api/auth/identity/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: CLIENT, code, redirect_uri: REDIRECT, code_verifier: verifier }).toString(),
  }));
  check('授权码重放被拒（invalid_grant）', replay.status === 400 && replay.body?.error === 'invalid_grant', JSON.stringify(replay.body));

  // ⑨ userinfo：验签 + scope 裁剪
  const access = tokenRes.body.access_token;
  const info = await json(await req(`${BASE}/api/auth/identity/oauth/userinfo`, { headers: { authorization: `Bearer ${access}` } }));
  check('userinfo 返回身份（含 email，因为申请了 email scope）',
    info.status === 200 && info.body?.sub === identity.id && !!info.body?.email, JSON.stringify(info.body));

  // ⑩ 令牌能被 JWKS 公钥本地验签（下游"一次登录、本地验签"的契约）
  const jwks = await json(await req(`${BASE}/api/auth/identity/.well-known/jwks.json`));
  const jwk = jwks.body.keys[0];
  const pub = require('node:crypto').createPublicKey({ key: jwk, format: 'jwk' });
  const [h, p, s] = access.split('.');
  const okSig = require('node:crypto').verify(null, Buffer.from(`${h}.${p}`, 'utf8'), pub, Buffer.from(s, 'base64url'));
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  check('access token 可用 JWKS 公钥本地验签',
    okSig && claims.client_id === CLIENT && claims.iss === 'https://bobbycn.cc', `kid=${jwk.kid}`);

  // ⑪ 刷新令牌轮换 + 重放检测
  const refreshed = await json(await req(`${BASE}/api/auth/identity/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT, refresh_token: tokenRes.body.refresh_token }).toString(),
  }));
  check('刷新令牌换到新 access', refreshed.status === 200 && !!refreshed.body?.access_token, `expires_in=${refreshed.body?.expires_in}`);
  const replayRefresh = await json(await req(`${BASE}/api/auth/identity/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT, refresh_token: tokenRes.body.refresh_token }).toString(),
  }));
  check('刷新令牌重放被拒（且整条授权作废）', replayRefresh.status === 400 && replayRefresh.body?.error === 'invalid_grant', JSON.stringify(replayRefresh.body));

  // ⑫ 云存档：取钥匙 → 写 → 读 → 概览（Bearer + saves scope）
  const keyRes = await json(await req(`${BASE}/api/auth/identity/saves/key`, { headers: { authorization: `Bearer ${access}` } }));
  check('云存档钥匙下发（32 字节，AES-256-GCM）', keyRes.status === 200 && Buffer.from(keyRes.body?.key || '', 'base64').length === 32, keyRes.body?.alg);

  const put = await json(await req(`${BASE}/api/auth/identity/saves?game=zombie-survival&slot=auto`, {
    method: 'PUT', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
    body: JSON.stringify({ data: 'ciphertext-placeholder', meta: { day: 33 } }),
  }));
  check('云存档写入成功', put.status === 200 && put.body?.ok === true, JSON.stringify(put.body));

  const got = await json(await req(`${BASE}/api/auth/identity/saves/one?game=zombie-survival&slot=auto`, { headers: { authorization: `Bearer ${access}` } }));
  check('云存档读回一致（含 meta）', got.status === 200 && got.body?.data === 'ciphertext-placeholder' && got.body?.meta?.day === 33, JSON.stringify(got.body?.meta));

  const summary = await json(await req(`${BASE}/api/auth/identity/saves/summary`, { headers: { authorization: `Bearer ${access}` } }));
  check('云存档概览/迁移状态可读', summary.status === 200 && summary.body?.totalSlots === 1 && summary.body?.needsMigration === false, JSON.stringify(summary.body));

  // ⑬ 无令牌 / 越权 scope 访问存档 → 401
  const noToken = await req(`${BASE}/api/auth/identity/saves/key`);
  check('无令牌访问云存档 → 401', noToken.status === 401, `status=${noToken.status}`);

  const scopeLimited = await json(await req(`${BASE}/api/auth/identity/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT, refresh_token: refreshed.body.refresh_token }).toString(),
  }));
  if (scopeLimited.status === 200) {
    const limited = await json(await req(`${BASE}/api/auth/identity/saves/key`, { headers: { authorization: `Bearer ${scopeLimited.body.access_token}` } }));
    check('同 scope 的令牌照样能读写自己的存档', limited.status === 200, `status=${limited.status}`);
  }

  // ⑭ 撤销授权后：刷新失败 + 已发令牌被 userinfo 拒绝
  const grantRevoke = await json(await req(`${BASE}/api/auth/identity/oauth/revoke-grant`, {
    method: 'POST', headers: { cookie: `sid=${sid}`, 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT }),
  }));
  check('用户解除授权成功', grantRevoke.status === 200 && grantRevoke.body?.revoked === true, JSON.stringify(grantRevoke.body));
  const afterRevoke = await json(await req(`${BASE}/api/auth/identity/oauth/userinfo`, { headers: { authorization: `Bearer ${access}` } }));
  check('解除授权后旧 access token 立刻被拒（userinfo 401）', afterRevoke.status === 401, `status=${afterRevoke.status}`);

  finish();
}

function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
  for (const f of failed) console.log(`FAILED: ${f.name} — ${f.detail}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('冒烟脚本异常：', e); process.exit(2); });
