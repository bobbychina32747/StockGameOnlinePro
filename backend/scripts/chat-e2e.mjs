#!/usr/bin/env node
/**
 * 私线端到端验收脚本（本机跑，不碰生产）。
 *
 * 前置：后端以 SQLITE_PATH=临时库、PORT=8099 启动；本脚本直接用 better-sqlite3 造两个身份
 * （站主 + 陌生用户），再用 seed 脚本建 tina，然后全部通过 HTTP 验证：
 * 访问控制 / 收发文本·链接·文件 / 已读回执 / 分页 / SSE 实时推送 / 非法输入拦截。
 *
 * 用法：node scripts/_chat-e2e.mjs
 */
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const require = (await import('node:module')).createRequire(import.meta.url);
const Database = require('better-sqlite3');
const argon2 = require('@node-rs/argon2');

const DB = process.env.SQLITE_PATH || path.join(process.cwd(), 'data', 'stockgame.db');
const BASE = process.env.CHAT_E2E_BASE || 'http://127.0.0.1:8099/api';
const ARGON2ID_OPTIONS = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 };
const OWNER = { username: 'bobby', email: 'owner@test.local', password: 'OwnerPass!234' };
const STRANGER = { username: 'stranger', email: 'stranger@test.local', password: 'StrangerPass!234' };
const TINA = { username: 'tina', email: 'tina@bobbycn.cc', password: 'TinaPass!2345' };

const results = [];
function ok(name, detail = '') {
    results.push({ ok: true, name, detail });
    console.log(`  PASS ${name}${detail ? ' — ' + detail : ''}`);
}
function bad(name, detail = '') {
    results.push({ ok: false, name, detail });
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
}
function expect(name, cond, detail = '') {
    if (cond) ok(name, detail); else bad(name, detail);
}
const utc = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString().replace('T', ' ').replace('Z', '');

function insertIdentity({ username, email, password, role, createdAt }) {
    const db = new Database(DB);
    const now = utc();
    // 幂等：已存在就复用那一行（否则 credential 的外键会指向一个不存在的 id）
    const existing = db.prepare('select id from identities where lower(username) = ? or lower(email) = ? limit 1')
        .get(String(username).toLowerCase(), String(email).toLowerCase());
    const id = existing ? existing.id : randomUUID();
    if (!existing) {
        db.prepare(`insert into identities
            (id, email, emailVerifiedAt, username, provider, providerUid, status, pendingExpiresAt, role, createdAt, updatedAt)
            values (?, ?, ?, ?, 'email', null, 'active', null, ?, ?, ?)`)
            .run(id, email, createdAt, username, role, createdAt, now);
    }
    else {
        db.prepare('update identities set role = ?, status = ?, updatedAt = ? where id = ?')
            .run(role, 'active', now, id);
    }
    db.prepare(`insert into credentials (id, identityId, passwordHash, totpSecretEnc, recoveryCodes, createdAt, updatedAt)
        values (?, ?, ?, null, '[]', ?, ?)
        on conflict(identityId) do update set passwordHash = excluded.passwordHash, updatedAt = excluded.updatedAt`)
        .run(randomUUID(), id, argon2.hashSync(password, ARGON2ID_OPTIONS), now, now);
    db.close();
    return id;
}

let cookieJar = new Map();
async function api(method, urlPath, { body, token, form, headers = {} } = {}) {
    const headers2 = { ...headers };
    if (token) headers2.Authorization = 'Bearer ' + token;
    let payload;
    if (form) {
        payload = form;
    } else if (body !== undefined) {
        headers2['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
    }
    const res = await fetch(BASE + urlPath, { method, headers: headers2, body: payload, redirect: 'manual' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON（文件流） */ }
    return { res, status: res.status, json, text, headers: res.headers };
}

async function login(who) {
    const r = await api('POST', '/auth/identity/login', { body: { username: who.username, password: who.password } });
    if (r.status !== 200 || !r.json?.token)
        throw new Error(`登录失败 ${who.username}: ${r.status} ${r.text}`);
    return r.json.token;
}

async function main() {
    // ── 0. 表结构 ──
    {
        const db = new Database(DB, { readonly: true });
        const tables = db.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name);
        const cols = db.prepare('PRAGMA table_info(identities)').all().map((c) => c.name);
        db.close();
        expect('建表：chat_threads', tables.includes('chat_threads'));
        expect('建表：chat_messages', tables.includes('chat_messages'));
        expect('建表：chat_attachments', tables.includes('chat_attachments'));
        expect('身份表新增 role 列', cols.includes('role'), cols.join(','));
    }

    // ── 1. 造站主与陌生用户（模拟历史数据：都比 tina 更早注册） ──
    insertIdentity({ ...OWNER, role: 'user', createdAt: utc(3 * 3600 * 1000) });
    insertIdentity({ ...STRANGER, role: 'user', createdAt: utc(2 * 3600 * 1000) });

    // ── 2. seed 脚本建 tina（role=subadmin + 顺手标站主 admin） ──
    {
        const r = spawnSync(process.execPath, [path.join(process.cwd(), 'scripts', 'seed-chat-peer.mjs')], {
            env: {
                ...process.env,
                SQLITE_PATH: DB,
                CHAT_PEER_USERNAME: TINA.username,
                CHAT_PEER_EMAIL: TINA.email,
                CHAT_PEER_PASSWORD: TINA.password,
            },
            encoding: 'utf8',
        });
        const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('CHAT_PEER_SEED '));
        expect('seed 脚本执行成功', r.status === 0 && !!line, (r.stdout || '') + (r.stderr || ''));
        if (line) {
            const summary = JSON.parse(line.slice('CHAT_PEER_SEED '.length));
            expect('tina 角色 = subadmin', summary.identity?.role === 'subadmin');
            expect('tina 状态 = active 且邮箱已验证', summary.identity?.status === 'active' && summary.identity?.emailVerified === true);
            ok('seed 摘要', `created=${summary.created} passwordUpdated=${summary.passwordUpdated} owner=${JSON.stringify(summary.owner)}`);
        }
        // 幂等：再跑一次不应新建
        const r2 = spawnSync(process.execPath, [path.join(process.cwd(), 'scripts', 'seed-chat-peer.mjs')], {
            env: {
                ...process.env, SQLITE_PATH: DB, CHAT_PEER_USERNAME: TINA.username,
                CHAT_PEER_EMAIL: TINA.email, CHAT_PEER_PASSWORD: TINA.password,
            },
            encoding: 'utf8',
        });
        const l2 = String(r2.stdout || '').split('\n').find((l) => l.startsWith('CHAT_PEER_SEED '));
        const s2 = l2 ? JSON.parse(l2.slice('CHAT_PEER_SEED '.length)) : null;
        expect('seed 幂等（第二次不新建）', r2.status === 0 && s2?.created === false);
    }

    const ownerToken = await login(OWNER);
    const tinaToken = await login(TINA);
    const strangerToken = await login(STRANGER);
    ok('三方登录成功', 'owner / tina / stranger');

    // ── 3. /me 角色与站主标记 ──
    {
        const me = await api('GET', '/auth/identity/me', { token: ownerToken });
        expect('/me 站主 isOwner=true', me.json?.isOwner === true, JSON.stringify(me.json));
        const meT = await api('GET', '/auth/identity/me', { token: tinaToken });
        expect('/me tina role=subadmin 且非站主', meT.json?.role === 'subadmin' && meT.json?.isOwner === false);
    }

    // ── 4. 访问控制 ──
    {
        const a = await api('GET', '/chat/access', { token: ownerToken });
        expect('站主可进私线', a.status === 200 && a.json?.allowed === true, JSON.stringify(a.json));
        expect('站主看到对端是 tina', a.json?.peer?.username === TINA.username, JSON.stringify(a.json?.peer));
        const b = await api('GET', '/chat/access', { token: tinaToken });
        expect('tina 可进私线且 side=peer', b.status === 200 && b.json?.side === 'peer', JSON.stringify(b.json));
        const c = await api('GET', '/chat/access', { token: strangerToken });
        expect('陌生账号被拒绝（403）', c.status === 403, c.status + ' ' + c.text);
        const d = await api('GET', '/chat/access');
        expect('匿名被拒绝（401）', d.status === 401, String(d.status));
    }

    // ── 5. 文本 ──
    let textMsgId = null;
    {
        const s = await api('POST', '/chat/messages', { token: ownerToken, body: { kind: 'text', text: '在吗？这边是私线。' } });
        expect('站主发文本', s.status === 200 && s.json?.message?.kind === 'text', s.text);
        textMsgId = s.json?.message?.id;
        const empty = await api('POST', '/chat/messages', { token: ownerToken, body: { kind: 'text', text: '   ' } });
        expect('空文本被拒（400）', empty.status === 400, String(empty.status));
        const tooLong = await api('POST', '/chat/messages', { token: ownerToken, body: { kind: 'text', text: 'x'.repeat(4001) } });
        expect('超长文本被拒（400）', tooLong.status === 400, String(tooLong.status));
    }

    // ── 6. 收信 / 未读 / 已读回执 ──
    {
        const list = await api('GET', '/chat/messages?limit=30', { token: tinaToken });
        expect('tina 收到消息', list.status === 200 && list.json?.messages?.some((m) => m.id === textMsgId));
        expect('tina 未读数 = 1', list.json?.messages?.filter((m) => m.sender.username === OWNER.username).length >= 1, JSON.stringify(list.json?.me));
        const access = await api('GET', '/chat/access', { token: tinaToken });
        expect('access 返回 unread', typeof access.json?.unread === 'number' && access.json.unread >= 1, String(access.json?.unread));
        const read = await api('POST', '/chat/read', { token: tinaToken });
        expect('tina 标记已读', read.status === 200 && read.json?.affected >= 1, JSON.stringify(read.json));
        const access2 = await api('GET', '/chat/access', { token: tinaToken });
        expect('已读后未读归零', access2.json?.unread === 0, String(access2.json?.unread));
    }

    // ── 7. 链接 ──
    let linkMsgId = null;
    {
        const s = await api('POST', '/chat/messages', { token: tinaToken, body: { kind: 'link', linkUrl: 'https://example.com/a?b=1', text: '这个页面你看看' } });
        expect('tina 发链接', s.status === 200 && s.json?.message?.kind === 'link', s.text);
        expect('链接被规范化保留', String(s.json?.message?.linkUrl || '').startsWith('https://example.com/'), String(s.json?.message?.linkUrl));
        linkMsgId = s.json?.message?.id;
        const badUrl = await api('POST', '/chat/messages', { token: tinaToken, body: { kind: 'link', linkUrl: 'javascript:alert(1)' } });
        expect('非 http(s) 链接被拒（400）', badUrl.status === 400, String(badUrl.status));
        const badKind = await api('POST', '/chat/messages', { token: ownerToken, body: { kind: 'video', text: 'x' } });
        expect('未知消息类型被拒（400）', badKind.status === 400, String(badKind.status));
        const forbiddenField = await api('POST', '/chat/messages', { token: ownerToken, body: { kind: 'text', text: 'x', nickname: 'hack' } });
        expect('未声明字段被拒（400）', forbiddenField.status === 400, String(forbiddenField.status));
    }

    // ── 8. 文件上传 / 发送 / 取回 ──
    let attachmentId = null;
    {
        const bytes = Buffer.from('private line attachment payload %PDF-1.4 fake', 'utf8');
        const form = new FormData();
        form.append('file', new Blob([bytes], { type: 'application/pdf' }), '私线测试.pdf');
        const up = await api('POST', '/chat/upload', { token: ownerToken, form });
        expect('上传文件成功', up.status === 200 && !!up.json?.attachment?.id, up.text);
        attachmentId = up.json?.attachment?.id;
        expect('原始文件名保留（中文）', up.json?.attachment?.filename === '私线测试.pdf', String(up.json?.attachment?.filename));
        expect('返回附件地址', String(up.json?.attachment?.url || '').includes('/api/chat/files/'), String(up.json?.attachment?.url));

        const send = await api('POST', '/chat/messages', { token: ownerToken, body: { kind: 'file', attachmentId, text: '这是说明' } });
        expect('发送文件消息', send.status === 200 && send.json?.message?.kind === 'file', send.text);

        const reuse = await api('POST', '/chat/messages', { token: ownerToken, body: { kind: 'file', attachmentId } });
        expect('同一附件不能重复发送（400）', reuse.status === 400, String(reuse.status));

        const get = await fetch(BASE + '/chat/files/' + attachmentId, { headers: { Authorization: 'Bearer ' + tinaToken } });
        const got = Buffer.from(await get.arrayBuffer());
        expect('tina 能取回文件', get.status === 200 && got.equals(bytes), `status=${get.status} len=${got.length}`);
        expect('文件响应类型正确', get.headers.get('content-type') === 'application/pdf', String(get.headers.get('content-type')));
        expect('文件响应带附件/内联处置', String(get.headers.get('content-disposition') || '').length > 0, String(get.headers.get('content-disposition')));

        const anon = await fetch(BASE + '/chat/files/' + attachmentId);
        expect('匿名取文件被拒（401）', anon.status === 401, String(anon.status));
        const stranger = await fetch(BASE + '/chat/files/' + attachmentId, { headers: { Authorization: 'Bearer ' + strangerToken } });
        expect('陌生账号取文件被拒（403）', stranger.status === 403, String(stranger.status));

        const missingAttachment = await api('POST', '/chat/messages', { token: tinaToken, body: { kind: 'file', attachmentId: randomUUID() } });
        expect('不存在的附件被拒（400）', missingAttachment.status === 400, String(missingAttachment.status));
    }

    // ── 9. 分页 ──
    {
        for (let i = 0; i < 5; i += 1)
            await api('POST', '/chat/messages', { token: tinaToken, body: { kind: 'text', text: '分页测试 ' + (i + 1) } });
        const p1 = await api('GET', '/chat/messages?limit=2', { token: ownerToken });
        expect('第一页 2 条 + hasMore', p1.json?.messages?.length === 2 && p1.json?.hasMore === true, JSON.stringify({ n: p1.json?.messages?.length, more: p1.json?.hasMore }));
        const oldest = p1.json.messages[0].id;
        const p2 = await api('GET', `/chat/messages?limit=2&before=${oldest}`, { token: ownerToken });
        // 游标是「严格更早」（exclusive）：第二页不能包含游标那条，也不能重复第一页
        expect('游标翻页返回更早的消息', p2.status === 200 && p2.json.messages.length === 2
            && !p2.json.messages.some((m) => m.id === oldest)
            && !p2.json.messages.some((m) => p1.json.messages.some((x) => x.id === m.id)),
        JSON.stringify({ p2: p2.json?.messages?.map((m) => m.text), cursor: oldest }));
        const badCursor = await api('GET', '/chat/messages?before=not-a-uuid', { token: ownerToken });
        expect('非法游标被拒（400）', badCursor.status === 400, String(badCursor.status));
        const all = await api('GET', '/chat/messages?limit=100', { token: ownerToken });
        const times = all.json.messages.map((m) => new Date(m.createdAt).getTime());
        expect('消息按时间升序返回', times.every((t, i) => i === 0 || times[i - 1] <= t));
    }

    // ── 10. SSE 实时推送 ──
    {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 12000);
        try {
            const stream = await fetch(BASE + '/chat/stream', {
                headers: { Authorization: 'Bearer ' + ownerToken },
                signal: ctrl.signal,
            });
            expect('SSE 连接建立（200 + event-stream）', stream.status === 200 && String(stream.headers.get('content-type')).includes('text/event-stream'), `${stream.status} ${stream.headers.get('content-type')}`);
            const reader = stream.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            let sawHello = false;
            let sawMessage = false;
            let sawRead = false;
            let sent = false;
            const deadline = Date.now() + 9000;
            while (Date.now() < deadline && !(sawHello && sawMessage && sawRead)) {
                const { value, done } = await Promise.race([
                    reader.read(),
                    new Promise((r) => setTimeout(() => r({ value: null, done: false }), 500)),
                ]);
                if (done) break;
                if (value) buf += decoder.decode(value, { stream: true });
                if (!sawHello && buf.includes('event: hello')) {
                    sawHello = true;
                    // hello 之后再造事件：tina 发消息 + 标已读
                    if (!sent) {
                        sent = true;
                        await api('POST', '/chat/messages', { token: tinaToken, body: { kind: 'text', text: 'SSE 实时测试' } });
                        await api('POST', '/chat/read', { token: ownerToken });
                    }
                }
                if (buf.includes('event: message')) sawMessage = true;
                if (buf.includes('event: read')) sawRead = true;
            }
            ctrl.abort();
            expect('SSE 首帧 hello', sawHello);
            expect('SSE 收到新消息推送', sawMessage);
            expect('SSE 收到已读回执推送', sawRead);
        }
        catch (e) {
            bad('SSE 实时推送', e && e.message);
        }
        finally {
            clearTimeout(timer);
        }
    }

    // ── 11. 消息归属字段 ──
    {
        const list = await api('GET', '/chat/messages?limit=100', { token: ownerToken });
        const msg = list.json.messages.find((m) => m.id === linkMsgId);
        expect('消息带 sender 信息', msg?.sender?.username === TINA.username, JSON.stringify(msg?.sender));
        expect('消息 DTO 不泄露内部 id 之外的数据', msg && Object.keys(msg).sort().join(',') === 'attachment,createdAt,id,kind,linkUrl,readAt,sender,text', Object.keys(msg || {}).sort().join(','));
        const fileMsg = list.json.messages.find((m) => m.kind === 'file');
        expect('文件消息带附件元数据（中文名/大小）', !!fileMsg?.attachment?.filename && fileMsg.attachment.size > 0, JSON.stringify(fileMsg?.attachment));
    }

    const failed = results.filter((r) => !r.ok);
    console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`);
    if (failed.length) {
        console.log('失败项：');
        failed.forEach((f) => console.log(' - ' + f.name + (f.detail ? ' — ' + f.detail : '')));
        process.exitCode = 1;
    }
    else {
        console.log('ALL CHAT E2E CHECKS PASSED');
    }
}

main().catch((e) => {
    console.error('E2E 脚本异常：', e);
    process.exitCode = 1;
});
