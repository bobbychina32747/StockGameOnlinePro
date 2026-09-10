// Phase F-2 证据：orders(status,type) 复合索引对 checkPendingOrders 扫描路径的影响
// 用临时库副本（绝不触碰 backend/data/stockgame.db），输出 EXPLAIN QUERY PLAN + 计时对比
// 数据分布按真实形态：绝大多数订单已成交/已撤（filled/cancelled），挂单（pending）仅占少数
const fs = require('node:fs');
const Database = require('E:/Files/Games/stockGameOnlinePro/backend/node_modules/better-sqlite3');

const src = 'E:/Files/.agent-work/sgp-iter/smoke.db';
const dst = 'E:/Files/.agent-work/sgp-iter/evidence-orders.db';
fs.copyFileSync(src, dst);
const db = new Database(dst);
db.pragma('foreign_keys = OFF');

const QUERY = "SELECT * FROM orders WHERE status='pending' AND type IN ('limit','stop','stop-limit') AND postClose=0";
const plan = () => db.prepare('EXPLAIN QUERY PLAN ' + QUERY).all().map((r) => r.detail).join(' | ');
const timeIt = (n = 300) => {
  const stmt = db.prepare(QUERY);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) stmt.all();
  return Number(process.hrtime.bigint() - t0) / 1e6 / n;
};

// 造量：30000 条历史订单，其中 4% 为 pending+limit（真实形态：挂单是长尾）
const insert = db.prepare('INSERT INTO orders (id, userId, accountId, symbol, type, side, price, quantity, filledQty, status, postClose, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
db.transaction((n) => {
  for (let i = 0; i < n; i++) {
    const pending = i % 25 === 0;
    insert.run('F' + i, 'U1', 'AC1', 'T1', pending ? 'limit' : 'market', 'buy', 10, 100, 0, pending ? 'pending' : 'filled', 0, new Date().toISOString());
  }
})(30000);

const seeded = { plan: plan(), ms: timeIt() };
const idxBefore = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='orders'").all().map((r) => r.name).join(',');
db.exec('CREATE INDEX IF NOT EXISTS IDX_orders_status_type ON orders (status, type)');
db.exec('ANALYZE');
const after = { plan: plan(), ms: timeIt() };
const pendingCount = db.prepare("SELECT COUNT(*) c FROM orders WHERE status='pending' AND type='limit' AND postClose=0").get().c;
const total = db.prepare('SELECT COUNT(*) c FROM orders').get().c;

const out = [
  '── Phase F-2 证据：orders(status,type) 复合索引（临时库副本，真实 103MB 库未被触碰）──',
  `样本：orders 共 ${total} 行（造量 +30000，其中 pending+limit ${pendingCount} 行 = ${(pendingCount / total * 100).toFixed(1)}%）`,
  `建索引前 orders 索引清单：${idxBefore || '(无)'}`,
  '',
  `[1] 未建 (status,type)：${seeded.plan}`,
  `    平均耗时 ${seeded.ms.toFixed(3)} ms/次（300 次采样）`,
  `[2] 建 (status,type) 后：${after.plan}`,
  `    平均耗时 ${after.ms.toFixed(3)} ms/次（300 次采样）`,
  '',
  `结论（按实测计划字符串判定）：${after.plan.includes('SEARCH') && !after.plan.includes('SCAN') ? '查询计划由 SCAN 变为 SEARCH（索引命中）' : '本次采样下 SQLite 仍选择全表扫描'}` +
  `；耗时 ${seeded.ms.toFixed(3)} ms → ${after.ms.toFixed(3)} ms。`,
  '注：索引是否被选中取决于 status 选择性与表规模；挂单占比高的极端盘面 SQLite 可能仍走全扫（此时全扫等价或更优），本索引面向"长尾挂单 + 大表"的真实形态。',
].join('\n');
fs.writeFileSync('E:/Files/.agent-work/sgp-iter/index-evidence.txt', out, 'utf8');
console.log(out);
