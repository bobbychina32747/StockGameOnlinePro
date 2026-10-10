const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

function migrateGameplaySchema(db) {
  const columns = [
    ['positions', 'boughtDay', 'INTEGER'],
    ['fund_navs', 'settledDay', 'INTEGER'],
    ['fund_navs', 'basketPrices', 'TEXT'],
  ];
  return db.transaction(() => {
    const added = [];
    for (const [table, column, type] of columns) {
      const fields = db.pragma(`table_info(${table})`);
      if (!fields.length) throw new Error(`Missing table: ${table}`);
      if (fields.some(field => field.name === column)) continue;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      added.push(`${table}.${column}`);
    }
    return added;
  })();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--db') throw new Error('Usage: node scripts/migrate-gameplay-schema.cjs --db <sqlite-path>');
  const databasePath = path.resolve(args[1]);
  if (!fs.existsSync(databasePath) || !fs.statSync(databasePath).isFile()) throw new Error('Database file does not exist');
  const backupPath = databasePath + '.before-gameplay-fix.sqlite';
  if (fs.existsSync(backupPath)) throw new Error('Backup already exists; preserve it and choose a fresh verified database copy');
  const db = new Database(databasePath, { fileMustExist: true });
  try {
    await db.backup(backupPath);
    const added = migrateGameplaySchema(db);
    console.log(JSON.stringify({ added, backup: backupPath }));
  } finally { db.close(); }
}

module.exports = { migrateGameplaySchema };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
