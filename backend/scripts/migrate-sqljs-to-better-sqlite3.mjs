// P0 数据库迁移校验脚本：sql.js 导出的 .db 是标准 SQLite 文件，better-sqlite3 可直接打开。
// 无需复制数据。本脚本做四件事：备份 → 完整性校验 → 逐表行数核对 → 切换 WAL。
// 用法：node scripts/migrate-sqljs-to-better-sqlite3.mjs [db路径]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const dbPath = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve('data/stockgame.db');

if (!fs.existsSync(dbPath)) {
  console.error(`[迁移] 数据库不存在: ${dbPath}`);
  process.exit(1);
}

// 1) 备份（仅当迁移目标就是原文件时才有意义，保留回滚路径）
const backupPath = dbPath + '.pre-better-sqlite3.bak';
fs.copyFileSync(dbPath, backupPath);
console.log(`[迁移] 已备份: ${backupPath}`);

// 2) 打开 + 完整性校验
const db = new Database(dbPath);
const integrity = db.pragma('integrity_check', { simple: true });
if (integrity !== 'ok') {
  console.error(`[迁移] integrity_check 失败: ${integrity}`);
  db.close();
  process.exit(1);
}
console.log('[迁移] integrity_check: ok');

// 3) 逐表行数核对
const tables = [
  'users', 'accounts', 'positions', 'orders', 'transactions',
  'klines', 'stocks', 'daily_snapshots', 'fund_holdings',
];
let total = 0;
for (const t of tables) {
  let n = 0;
  try {
    n = db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c;
  } catch {
    console.log(`[迁移] ${t}: 表不存在（首次启动将由 synchronize 自动建表）`);
    continue;
  }
  total += n;
  console.log(`[迁移] ${t}: ${n} 行`);
}

// 4) 切换 WAL（持久化在库文件内，此后所有连接默认生效）
const mode = db.pragma('journal_mode = WAL', { simple: true });
db.pragma('busy_timeout = 5000');
console.log(`[迁移] journal_mode: ${mode}`);
db.close();

console.log(`[迁移] 完成：共 ${total} 行数据校验通过，可直接以 DB_TYPE=sqlite（better-sqlite3）启动`);
