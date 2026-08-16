// 开发调试辅助：注入一个临时管理员账号（用完即删）。
// 用法：node scripts/dev-insert-debug-admin.mjs            # 注入
//       node scripts/dev-insert-debug-admin.mjs remove     # 清理
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');

const db = new Database('data/stockgame.db');

if (process.argv[2] === 'remove') {
  db.prepare("DELETE FROM positions WHERE accountId = 'acct-debugadmin-cn'").run();
  db.prepare("DELETE FROM orders WHERE accountId = 'acct-debugadmin-cn'").run();
  db.prepare("DELETE FROM transactions WHERE accountId = 'acct-debugadmin-cn'").run();
  db.prepare("DELETE FROM accounts WHERE userId = 'debugadmin-1'").run();
  db.prepare("DELETE FROM users WHERE username = 'debugadmin'").run();
  console.log('debugadmin removed');
  db.close();
  process.exit(0);
}

const hash = bcrypt.hashSync('debugpass123', 10);
try {
  db.prepare("DELETE FROM users WHERE username = 'debugadmin'").run();
  db.prepare("INSERT INTO users (id, username, password, role, isActive, createdAt) VALUES ('debugadmin-1','debugadmin',?,'admin',1,datetime('now'))").run(hash);
  console.log('debugadmin inserted');
} catch (e) {
  console.log('insert fail:', e.message);
}
try {
  db.prepare("DELETE FROM accounts WHERE userId = 'debugadmin-1'").run();
  db.prepare("INSERT INTO accounts (id, userId, marketMode, cash, totalEquity, peakEquity, initialEquity, dayStartEquity, leverage, currentDay, dailyPnl, totalPnl, tier, tierScore, totalTrades, createdAt, updatedAt) VALUES ('acct-debugadmin-cn','debugadmin-1','CN',100000,100000,100000,100000,100000,1,0,0,0,'青铜',0,0,datetime('now'),datetime('now'))").run();
  console.log('debugadmin CN account inserted');
} catch (e) {
  console.log('account fail:', e.message);
}
db.close();
