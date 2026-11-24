const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { DataSource, EntitySchema } = require('typeorm');
const { assertGameEnvironment, assertGameDatabase, prepareGameDatabase } = require('../dist/src/common/game-boundary');
const { exportGameDatabase, GAME_TABLES } = require('../scripts/export-game-database.cjs');

test('production environment rejects site-only secrets without exposing their values', () => {
    expect(() => assertGameEnvironment({ JWT_SECRET: 'game-secret', SITE_IDENTITY_URL: 'http://site:8010' }, true)).not.toThrow();
    let message;
    try { assertGameEnvironment({ IDENTITY_JWT_PRIVATE_KEY: 'synthetic-private-value' }, true); } catch (error) { message = error.message; }
    expect(message).toContain('IDENTITY_JWT_PRIVATE_KEY');
    expect(message).not.toContain('synthetic-private-value');
});

test('native production guard rejects a mixed database before ORM synchronization', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sgp-mixed-guard-'));
    const filename = path.join(directory, 'combined.sqlite');
    let db = new Database(filename);
    db.exec("CREATE TABLE users(id TEXT PRIMARY KEY, cash REAL); INSERT INTO users VALUES('keep-player',12345.67); CREATE TABLE identities(id TEXT PRIMARY KEY)");
    db.close();
    const source = new DataSource({ type: 'better-sqlite3', database: filename, synchronize: true,
        entities: [new EntitySchema({ name: 'User', tableName: 'users', columns: { id: {type:String,primary:true}, newField: {type:String} } })],
        prepareDatabase: database => prepareGameDatabase(database, true) });
    try {
        await expect(source.initialize()).rejects.toThrow('outside the game boundary');
        db = new Database(filename, {readonly:true});
        expect(db.prepare('SELECT cash FROM users WHERE id=?').get('keep-player').cash).toBe(12345.67);
        expect(db.prepare('PRAGMA table_info(users)').all().map(row => row.name)).toEqual(['id','cash']);
    } finally { if(source.isInitialized)await source.destroy(); if(db.open)db.close(); fs.rmSync(directory,{recursive:true,force:true}); }
});

test('game export preserves all game records and 64-bit integers without copying site bytes', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sgp-game-export-'));
    const source = path.join(directory,'combined.sqlite'), output = path.join(directory,'game.sqlite');
    const huge = 9007199254740993n;
    let input = new Database(source), result;
    try {
        for(const table of GAME_TABLES) {
            input.exec('CREATE TABLE "'+table+'" (id INTEGER PRIMARY KEY AUTOINCREMENT, value INTEGER, cash REAL)');
            input.prepare('INSERT INTO "'+table+'"(value,cash) VALUES(?,?)').run(huge,12345.67);
        }
        input.exec("UPDATE sqlite_sequence SET seq=99 WHERE name='users'; CREATE TABLE credentials(id TEXT,value TEXT); INSERT INTO credentials VALUES('site','synthetic-private-sentinel')");
        input.close();
        const before=fs.readFileSync(source);
        const receipt=exportGameDatabase(source,output);
        expect(receipt.siteRecordsSelected).toBe(false);expect(fs.readFileSync(source)).toEqual(before);
        expect(fs.readFileSync(output).includes(Buffer.from('synthetic-private-sentinel'))).toBe(false);
        result=new Database(output);result.defaultSafeIntegers(true);
        expect(result.prepare('SELECT value,cash FROM accounts').get()).toEqual({value:huge,cash:12345.67});
        expect(result.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get('users').seq).toBe(99n);
        expect(()=>assertGameDatabase(result,true)).not.toThrow();
        expect(()=>exportGameDatabase(source,output)).toThrow('new file');
    }finally{if(input.open)input.close();if(result?.open)result.close();fs.rmSync(directory,{recursive:true,force:true});}
});
