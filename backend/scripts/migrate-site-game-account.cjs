const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

function migrateSiteGameAccount(db) {
  return db.transaction(() => {
    const columns = db.pragma('table_info(users)');
    if (!columns.length) throw new Error('Missing table: users');
    const added = !columns.some(column => column.name === 'identityId');
    if (added) db.exec('ALTER TABLE users ADD COLUMN identityId varchar(36)');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS IDX_users_site_identity ON users(identityId)');
    return { added };
  })();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--db') throw new Error('Usage: node scripts/migrate-site-game-account.cjs --db <sqlite-path>');
  const databasePath = path.resolve(args[1]);
  if (!fs.existsSync(databasePath) || !fs.statSync(databasePath).isFile()) throw new Error('Database file does not exist');
  const backupPath = databasePath + '.before-site-game-account.sqlite';
  if (fs.existsSync(backupPath)) throw new Error('Backup already exists; preserve it before proceeding');
  const db = new Database(databasePath, { fileMustExist: true });
  try {
    await db.backup(backupPath);
    console.log(JSON.stringify({ ...migrateSiteGameAccount(db), backup: backupPath }));
  } finally { db.close(); }
}

module.exports = { migrateSiteGameAccount };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
