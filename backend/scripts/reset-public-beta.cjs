// Run only with the backend stopped and after approval to reset public-beta assets.
// Credentials stay inside SQLite; no account contents are exported or logged.
const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const preserved = new Set(['users','accounts','identities','credentials','sessions','identity_tokens',
  'identity_secrets','app_secrets','oauth_clients','oauth_codes','oauth_grants','oauth_refresh_tokens',
  'arcade_links','blog_posts','blog_comments','blog_views','game_saves']);
const cleared = new Set(['achievements','daily_snapshots','dividend_events','dividend_snapshots',
  'fund_holdings','fund_navs','klines','orders','positions','reset_audit_logs',
  'season_entries','seasons','stocks','transactions','market_runtime_state']);
const quote = name => '"'+name.replaceAll('"','""')+'"';

function prepareReset(original, replacement) {
  if (fs.existsSync(replacement)) throw new Error('Replacement already exists; refusing overwrite');
  const source = new Database(original, {readonly:true, fileMustExist:true});
  const target = new Database(replacement);
  try {
    const tables = source.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    for (const {name} of tables) if (!preserved.has(name) && !cleared.has(name)) throw new Error('Unclassified table: '+name);
    target.prepare('ATTACH DATABASE ? AS original').run(original);
    target.transaction(() => {
      for (const {sql} of tables) target.exec(sql);
      for (const {name} of tables.filter(row=>preserved.has(row.name))) {
        target.exec(`INSERT INTO main.${quote(name)} SELECT * FROM original.${quote(name)}`);
        const a=source.prepare(`SELECT COUNT(*) AS n FROM ${quote(name)}`).get().n;
        const b=target.prepare(`SELECT COUNT(*) AS n FROM main.${quote(name)}`).get().n;
        if (a!==b) throw new Error('Identity row count changed: '+name);
      }
      if (tables.some(row=>row.name==='accounts')) {
        const identityColumns=new Set(['id','userId','marketMode','createdAt','updatedAt']);
        const assignments=target.prepare('PRAGMA main.table_info(accounts)').all()
          .filter(column=>!identityColumns.has(column.name))
          .map(column=>{
            if (column.dflt_value==null) throw new Error('Account field without reset default: '+column.name);
            return quote(column.name)+' = '+column.dflt_value;
          });
        target.exec('UPDATE main.accounts SET '+assignments.join(', '));
      }
      for(const row of source.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all()) target.exec(row.sql);
    })();
    // An unqualified integrity pragma also visits attached databases. Validate
    // only the new database, never rescan the multi-GB historical archive here.
    if (target.pragma('main.foreign_key_check').length) throw new Error('Reset has broken foreign keys');
    if (target.pragma('main.quick_check',{simple:true})!=='ok') throw new Error('Reset database integrity check failed');
    for(const {name} of tables.filter(row=>cleared.has(row.name))) {
      if(target.prepare(`SELECT COUNT(*) AS n FROM main.${quote(name)}`).get().n!==0) throw new Error('Game table was not cleared');
    }
    return {preservedTables:tables.filter(row=>preserved.has(row.name)).length,
      clearedTables:tables.filter(row=>cleared.has(row.name)).length,
      accounts:target.prepare('SELECT COUNT(*) AS n FROM main.accounts').get().n};
  } finally { target.close(); source.close(); }
}

function activateReset(original, backupDirectory) {
  if (fs.existsSync(backupDirectory)) throw new Error('Backup already exists; refusing overwrite');
  const replacement=original+'.reset-ready';
  const result=prepareReset(original,replacement);
  fs.mkdirSync(backupDirectory,{recursive:true,mode:0o700});
  for(const suffix of ['','-wal','-shm']) if(fs.existsSync(original+suffix)) {
    fs.renameSync(original+suffix,path.join(backupDirectory,path.basename(original)+suffix));
  }
  fs.renameSync(replacement,original);
  console.log(JSON.stringify({...result,initialCash:100000,backupDirectory}));
}
module.exports={prepareReset,activateReset};
if(require.main===module) {
  if(process.env.CONFIRMED_PUBLIC_BETA_RESET!=='keep-accounts-reset-assets') throw new Error('Explicit reset scope is required');
  activateReset('/app/data/stockgame.db','/app/data/public-beta-before-reset-20261012');
}
