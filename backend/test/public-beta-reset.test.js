const Database=require('better-sqlite3');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {prepareReset}=require('../scripts/reset-public-beta.cjs');
test('public beta reset preserves login and realm IDs while clearing money, holdings and candles',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sgp-reset-'));
 try{
  const original=path.join(root,'old.db'), replacement=path.join(root,'new.db');
  const d=new Database(original);
  d.exec(`CREATE TABLE users(id TEXT PRIMARY KEY, password TEXT); CREATE TABLE accounts(id TEXT PRIMARY KEY,userId TEXT REFERENCES users(id),marketMode TEXT,cash REAL DEFAULT 100000,borrowed REAL DEFAULT 0,totalPnl REAL DEFAULT 0);
  CREATE TABLE positions(accountId TEXT REFERENCES accounts(id),qty INTEGER); CREATE TABLE klines(price REAL);
  INSERT INTO users VALUES('fixture','synthetic-hash');INSERT INTO accounts VALUES('role','fixture','HK',900,50,-12);INSERT INTO positions VALUES('role',10);INSERT INTO klines VALUES(9999999);`);d.close();
  prepareReset(original,replacement);
  const fresh=new Database(replacement,{readonly:true});const old=new Database(original,{readonly:true});
  expect(fresh.prepare('SELECT * FROM users').get()).toEqual({id:'fixture',password:'synthetic-hash'});
  expect(fresh.prepare('SELECT * FROM accounts').get()).toEqual({id:'role',userId:'fixture',marketMode:'HK',cash:100000,borrowed:0,totalPnl:0});
  expect(fresh.prepare('SELECT COUNT(*) AS n FROM positions').get().n).toBe(0);
  expect(fresh.prepare('SELECT COUNT(*) AS n FROM klines').get().n).toBe(0);
  expect(old.prepare('SELECT price FROM klines').get().price).toBe(9999999);
  fresh.close();old.close();
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
