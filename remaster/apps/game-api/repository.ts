import { createHash } from 'node:crypto';
import { CommandResult, GameCommand, RuleError, World } from '../../packages/domain/types';
import { active } from '../../packages/engine/matching';
const Sqlite = require('better-sqlite3');
export class WorldRepository {
  readonly db: any;
  failAt?: string;
  constructor(filename: string) {
    this.db=new Sqlite(filename);this.db.pragma('journal_mode = WAL');this.db.pragma('busy_timeout = 5000');this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_info(version INTEGER NOT NULL);
      INSERT INTO schema_info SELECT 2 WHERE NOT EXISTS (SELECT 1 FROM schema_info);
      CREATE TABLE IF NOT EXISTS world(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands(scope TEXT NOT NULL,key TEXT NOT NULL,hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(scope,key));
      CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS orders_account ON orders(account_id);
      CREATE TABLE IF NOT EXISTS trades(id TEXT PRIMARY KEY,buyer TEXT NOT NULL,seller TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,reference TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ledger_account ON ledger(account_id);
      CREATE TABLE IF NOT EXISTS outbox(version INTEGER PRIMARY KEY,payload TEXT NOT NULL,delivered INTEGER NOT NULL DEFAULT 0);
    `);
    if(this.db.prepare('SELECT version FROM schema_info').get()?.version!==2) throw new Error('Unsupported remaster schema');
  }
  load(): World | null { const row=this.db.prepare('SELECT state FROM world WHERE id=1').get();return row?JSON.parse(row.state):null; }
  initialize(world: World): void { this.db.prepare('INSERT OR IGNORE INTO world(id,version,state) VALUES(1,?,?)').run(world.version,JSON.stringify(world)); }
  cached(scope: string, key: string, command: GameCommand): CommandResult | null {
    const row=this.db.prepare('SELECT hash,result FROM commands WHERE scope=? AND key=?').get(scope,key);
    if(!row) return null;if(row.hash!==digest(command)) throw new RuleError('COMMAND_CONFLICT','同一幂等键不能用于不同请求');return JSON.parse(row.result);
  }
  commit(previous: World, world: World, scope: string, key: string, command: GameCommand, result: CommandResult): void {
    this.db.transaction(()=>{
      const version=this.db.prepare('SELECT version FROM world WHERE id=1').get()?.version;
      if(version!==previous.version) throw new Error('Writer fencing: world version changed');
      this.db.prepare('INSERT INTO commands(scope,key,hash,result) VALUES(?,?,?,?)').run(scope,key,digest(command),JSON.stringify(result));this.inject('command');
      if(world.version===previous.version) return;
      this.db.prepare('UPDATE world SET version=?,state=? WHERE id=1 AND version=?').run(world.version,JSON.stringify(world),previous.version);this.inject('world');
      const orderWrite=this.db.prepare('INSERT INTO orders(id,account_id,status,payload) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload');
      for(const order of Object.values(world.orders)) {
        const before=previous.orders[order.id];if(before&&JSON.stringify(before)===JSON.stringify(order)) continue;
        orderWrite.run(order.id,order.accountId,order.status,JSON.stringify(order));
      }
      for(const before of Object.values(previous.orders)) if(!world.orders[before.id]&&active(before)) orderWrite.run(before.id,before.accountId,'cancelled',JSON.stringify({...before,status:'cancelled'}));
      this.inject('orders');
      const tradeWrite=this.db.prepare('INSERT OR IGNORE INTO trades VALUES(?,?,?,?)');
      for(const trade of world.trades.filter(item=>numericId(item.id)>previous.nextId)) tradeWrite.run(trade.id,trade.buyer,trade.seller,JSON.stringify(trade));this.inject('trades');
      const ledgerWrite=this.db.prepare('INSERT OR IGNORE INTO ledger VALUES(?,?,?,?)');
      for(const entry of world.ledger.filter(item=>numericId(item.id)>previous.nextId)) ledgerWrite.run(entry.id,entry.accountId,entry.reference,JSON.stringify(entry));this.inject('ledger');
      this.db.prepare('INSERT INTO outbox(version,payload) VALUES(?,?)').run(world.version,JSON.stringify({protocolVersion:2,kind:'committed',worldVersion:world.version,sequence:world.version}));this.inject('outbox');
    })();
  }
  private inject(point: string): void { if(this.failAt===point) throw new Error(`Injected storage failure: ${point}`); }
  history(table: 'orders'|'trades'|'ledger', accountId: string): unknown[] {
    const query=table==='trades'?'SELECT payload FROM trades WHERE buyer=? OR seller=? ORDER BY rowid DESC LIMIT 500':table==='orders'?'SELECT payload FROM orders WHERE account_id=? ORDER BY rowid DESC LIMIT 500':'SELECT payload FROM ledger WHERE account_id=? ORDER BY rowid DESC LIMIT 1000';
    const rows=table==='trades'?this.db.prepare(query).all(accountId,accountId):this.db.prepare(query).all(accountId);
    return rows.map((row:any)=>JSON.parse(row.payload));
  }
  pendingEvents(after: number): unknown[] { return this.db.prepare('SELECT payload FROM outbox WHERE version>? ORDER BY version LIMIT 200').all(after).map((row:any)=>JSON.parse(row.payload)); }
  markDelivered(version: number): void { this.db.prepare('UPDATE outbox SET delivered=1 WHERE version<=?').run(version); }
  close(): void { this.db.close(); }
}
function numericId(id: string): number { return Number(id.slice(id.lastIndexOf('-')+1)); }
export function digest(value: unknown): string { return createHash('sha256').update(stable(value)).digest('hex'); }
function stable(value: unknown): string {
  if(Array.isArray(value)) return '['+value.map(stable).join(',')+']';
  if(value&&typeof value==='object') return '{'+Object.entries(value).filter(([,item])=>item!==undefined).sort(([left],[right])=>left.localeCompare(right)).map(([key,item])=>JSON.stringify(key)+':'+stable(item)).join(',')+'}';
  return JSON.stringify(value)??'null';
}
