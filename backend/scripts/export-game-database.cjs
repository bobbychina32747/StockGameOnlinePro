const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const GAME_TABLES = Object.freeze(require('../dist/src/common/game-tables.json'));
const quoted = name => '"' + name.replaceAll('"', '""') + '"';

/** Copies game records into a new file; website rows are never selected or written. */
function exportGameDatabase(sourceFile, outputFile) {
    const source = path.resolve(sourceFile), output = path.resolve(outputFile);
    if (source === output || fs.existsSync(output)) throw Error('Output must be a new file, separate from the source');
    const parent = path.dirname(output);
    fs.mkdirSync(parent, { recursive: true });
    const temporary = path.join(parent, '.game-export-' + crypto.randomUUID() + '.sqlite');
    const input = new Database(source, { readonly: true, fileMustExist: true });
    input.defaultSafeIntegers(true);
    let result;
    try {
        input.exec('BEGIN');
        const definitions = GAME_TABLES.flatMap(name => {
            const row = input.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name);
            // Runtime state is absent only in a database that has never saved a snapshot.
            if (!row && name === 'market_runtime_state') return [];
            if (!row?.sql) throw Error('Missing game table: ' + name);
            if (input.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?").get(name)) throw Error('Review game triggers before exporting: ' + name);
            return [{ name, sql: row.sql }];
        });
        result = new Database(temporary);
        result.pragma('foreign_keys=OFF');
        const counts = {};
        result.transaction(() => {
            for (const { name, sql } of definitions) {
                result.exec(sql);
                const columns = input.prepare('PRAGMA table_info(' + quoted(name) + ')').all().map(column => column.name);
                const insert = result.prepare('INSERT INTO ' + quoted(name) + ' (' + columns.map(quoted).join(',') + ') VALUES (' + columns.map(() => '?').join(',') + ')');
                let count = 0;
                for (const row of input.prepare('SELECT * FROM ' + quoted(name)).iterate()) {
                    insert.run(...columns.map(column => row[column]));
                    count++;
                }
                counts[name] = count;
            }
            if (input.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'").get()) {
                for (const row of input.prepare('SELECT name,seq FROM sqlite_sequence').all()) if (GAME_TABLES.includes(row.name)) {
                    result.prepare('DELETE FROM sqlite_sequence WHERE name=?').run(row.name);
                    result.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run(row.name, row.seq);
                }
            }
            for (const { name } of definitions) {
                for (const index of input.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").all(name)) result.exec(index.sql);
            }
        })();
        if (result.pragma('foreign_key_check').length) throw Error('Game foreign key validation failed');
        if (result.pragma('quick_check', { simple: true }) !== 'ok') throw Error('Game integrity validation failed');
        result.close();
        result = null;
        fs.linkSync(temporary, output);
        return { tables: counts, sourceModified: false, siteRecordsSelected: false };
    }
    finally {
        if (result) result.close();
        input.close();
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}
module.exports = { exportGameDatabase, GAME_TABLES };
if (require.main === module) {
    const args = process.argv.slice(2);
    const source = args[args.indexOf('--source') + 1], output = args[args.indexOf('--output') + 1];
    if (!args.includes('--source') || !args.includes('--output') || !source || !output) throw Error('Usage: export-game-database.cjs --source <combined-snapshot> --output <new-game-database>');
    console.log(JSON.stringify(exportGameDatabase(source, output), null, 2));
}
