#!/usr/bin/env node
/**
 * 站内私线：创建/更新「受邀朋友」账号（默认 tina，role=subadmin）。
 *
 * 为什么要单独一个脚本：
 *   · 身份模块的注册流程必须走邮箱验证（pending → 邮件点链接），而站主想要的是
 *     「我直接建好一个账号给她，她拿用户名+密码就能登录」。
 *   · 生产库在容器数据卷里（/app/data/stockgame.db），脚本要能在两种环境跑：
 *     本机开发（backend/ 目录下）与容器内（docker exec，cwd=/app）。
 *
 * 用法（本机）：
 *   set CHAT_PEER_PASSWORD=... ; node scripts/seed-chat-peer.mjs
 * 用法（服务器容器内）：
 *   sudo docker cp /tmp/seed-chat-peer.mjs sgp-backend:/tmp/seed-chat-peer.mjs
 *   sudo docker exec -e CHAT_PEER_USERNAME=tina -e CHAT_PEER_EMAIL=tina@bobbycn.cc \
 *        -e CHAT_PEER_PASSWORD=... sgp-backend node /tmp/seed-chat-peer.mjs
 *
 * 幂等：重复执行只会把该账号的口令重置成给定值，并纠正 role/status；不会新建重复行。
 * 绝不打印口令；只打印脱敏摘要。
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);

/** 兼容「脚本在 backend/ 下跑」与「脚本在容器 /tmp 下、模块在 /app/node_modules」两种情况 */
function loadDep(name) {
    const candidates = [
        name,
        path.join(process.cwd(), 'node_modules', name),
        '/app/node_modules/' + name,
    ];
    let lastErr;
    for (const c of candidates) {
        try {
            return require(c);
        }
        catch (e) {
            lastErr = e;
        }
    }
    throw new Error(`加载依赖失败：${name}（最后一个错误：${lastErr && lastErr.message}）`);
}

const Database = loadDep('better-sqlite3');
const argon2 = loadDep('@node-rs/argon2');

// 与 src/modules/identity/password.service.ts 的 ARGON2ID_OPTIONS 保持一致
const ARGON2ID_OPTIONS = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 };

function env(name, fallback = '') {
    const v = process.env[name];
    return v === undefined || v === '' ? fallback : String(v);
}

/** TypeORM 的 datetime 在 SQLite 里存 UTC 字符串 "YYYY-MM-DD HH:mm:ss.SSS" */
function utcNow() {
    return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function mask(v) {
    const s = String(v || '');
    if (!s)
        return '';
    if (s.length <= 3)
        return s[0] + '**';
    return s.slice(0, 2) + '**' + s.slice(-2);
}

function main() {
    const username = env('CHAT_PEER_USERNAME', 'tina').trim().toLowerCase();
    const email = env('CHAT_PEER_EMAIL', 'tina@bobbycn.cc').trim().toLowerCase();
    const password = env('CHAT_PEER_PASSWORD');
    const dbPath = env('SQLITE_PATH', path.join(process.cwd(), 'data', 'stockgame.db'));
    const markOwner = env('CHAT_MARK_OWNER', '1') !== '0';

    if (!/^[a-z0-9_-]{2,32}$/.test(username))
        throw new Error('CHAT_PEER_USERNAME 只允许 2-32 位小写字母/数字/下划线/连字符');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
        throw new Error('CHAT_PEER_EMAIL 不是合法邮箱');
    if (!password || password.length < 10)
        throw new Error('CHAT_PEER_PASSWORD 必须提供且至少 10 位（这是能登录站点的口令，别用弱口令）');
    if (!fs.existsSync(dbPath))
        throw new Error(`数据库不存在：${dbPath}（先让后端启动过一次以建表）`);

    const db = new Database(dbPath);
    db.pragma('busy_timeout = 8000');

    const hasTable = db.prepare("select name from sqlite_master where type='table' and name='identities'").get();
    if (!hasTable)
        throw new Error('identities 表不存在：请先启动一次后端（DB_SYNCHRONIZE=true 时会自动建表）');

    // ① 角色列兜底迁移：线上老库没有 role 列时补上（TypeORM synchronize 也会补，但脚本可能先跑）
    const cols = db.prepare('PRAGMA table_info(identities)').all().map((c) => c.name);
    let migratedRoleColumn = false;
    if (!cols.includes('role')) {
        db.exec("ALTER TABLE identities ADD COLUMN role varchar(16) NOT NULL DEFAULT 'user'");
        migratedRoleColumn = true;
    }

    const findByIdentity = db.prepare('select * from identities where lower(username) = ? or lower(email) = ? limit 1');
    const findById = db.prepare('select * from identities where id = ?');
    const findCredential = db.prepare('select * from credentials where identityId = ? limit 1');
    const now = utcNow();

    let identity = findByIdentity.get(username, email);
    let created = false;

    if (identity) {
        // 邮箱冲突检查：不允许把别人（尤其站主）的邮箱抢过来
        if (identity.email && identity.email.toLowerCase() !== email) {
            const emailOwner = db.prepare('select id,username from identities where lower(email) = ? limit 1').get(email);
            if (emailOwner && emailOwner.id !== identity.id)
                throw new Error(`邮箱 ${email} 已被另一个身份（${mask(emailOwner.username)}）占用，请换一个 CHAT_PEER_EMAIL`);
        }
        db.prepare(`update identities
                       set username = ?, email = ?, status = 'active', role = 'subadmin',
                           emailVerifiedAt = coalesce(emailVerifiedAt, ?), pendingExpiresAt = null,
                           provider = coalesce(provider, 'email'), updatedAt = ?
                     where id = ?`)
            .run(username, email, now, now, identity.id);
    }
    else {
        const emailOwner = db.prepare('select id from identities where lower(email) = ? limit 1').get(email);
        if (emailOwner)
            throw new Error(`邮箱 ${email} 已存在（不是这个名字的账号），请换一个 CHAT_PEER_EMAIL`);
        const id = randomUUID();
        db.prepare(`insert into identities
                      (id, email, emailVerifiedAt, username, provider, providerUid, status, pendingExpiresAt, role, createdAt, updatedAt)
                      values (?, ?, ?, ?, 'email', null, 'active', null, 'subadmin', ?, ?)`)
            .run(id, email, now, username, now, now);
        identity = findById.get(id);
        created = true;
    }

    // ② 口令：每次执行都重置为给定值（幂等部署/换口令都靠这条），argon2id 与后端同参数
    const passwordHash = argon2.hashSync(password, ARGON2ID_OPTIONS);
    const credential = findCredential.get(identity.id);
    let passwordUpdated = false;
    if (credential) {
        if (credential.passwordHash !== passwordHash) {
            db.prepare('update credentials set passwordHash = ?, updatedAt = ? where id = ?').run(passwordHash, now, credential.id);
            passwordUpdated = true;
        }
    }
    else {
        db.prepare(`insert into credentials (id, identityId, passwordHash, totpSecretEnc, recoveryCodes, createdAt, updatedAt)
                    values (?, ?, ?, null, '[]', ?, ?)`)
            .run(randomUUID(), identity.id, passwordHash, now, now);
        passwordUpdated = true;
    }

    // ③ 顺手把「最早注册且已验证」的那个身份标成 role=admin（不改判据，只是让 /me 的角色显示准确）
    let ownerMarked = null;
    if (markOwner) {
        const oldest = db.prepare("select id, username, email, role from identities where status = 'active' and id <> ? order by createdAt asc limit 1").get(identity.id);
        if (oldest && oldest.role !== 'admin') {
            db.prepare("update identities set role = 'admin', updatedAt = ? where id = ?").run(now, oldest.id);
            ownerMarked = { id: oldest.id, username: mask(oldest.username), email: mask(oldest.email) };
        }
        else if (oldest) {
            ownerMarked = { id: oldest.id, username: mask(oldest.username), email: mask(oldest.email) };
        }
    }

    const finalRow = findById.get(identity.id);
    db.close();

    const summary = {
        ok: true,
        database: dbPath,
        migratedRoleColumn,
        created,
        identity: {
            id: finalRow.id,
            username: finalRow.username,
            email: finalRow.email,
            role: finalRow.role,
            status: finalRow.status,
            emailVerified: !!finalRow.emailVerifiedAt,
        },
        passwordUpdated,
        owner: ownerMarked,
    };
    process.stdout.write('CHAT_PEER_SEED ' + JSON.stringify(summary) + '\n');
    if (created)
        console.log(`已创建账号 ${finalRow.username}（role=${finalRow.role}），口令已设置（不显示明文）`);
    else
        console.log(`账号 ${finalRow.username} 已存在，role=${finalRow.role}，口令${passwordUpdated ? '已重置' : '未变化'}`);
}

main();
