// Run against the installed production driver without opening any player database.
require('reflect-metadata');
const assert = require('node:assert/strict');
const { DataSource } = require('typeorm');
const { TradingEngineService } = require('../dist/src/core/trading-engine/trading-engine.service');
const entities = Object.fromEntries(['User', 'Account', 'Position', 'Order', 'Transaction', 'DividendSnapshot'].map(name => {
  const file = name.replace(/[A-Z]/g, (char, index) => (index ? '-' : '') + char.toLowerCase());
  return [name, require('../dist/src/infrastructure/database/entities/' + file + '.entity')[name]];
}));

(async () => {
  const db = await new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: Object.values(entities), synchronize: true, logging: false }).initialize();
  try {
    const { User, Account, Position, Order, Transaction, DividendSnapshot } = entities;
    await db.getRepository(User).save({ id: 'synthetic-user', username: 'synthetic-execution-check', password: 'synthetic-unused-hash' });
    const accounts = db.getRepository(Account), positions = db.getRepository(Position), orders = db.getRepository(Order), transactions = db.getRepository(Transaction);
    await accounts.save({ id: 'synthetic-account', userId: 'synthetic-user', cash: 100000, marketMode: 'US' });
    const engine = new TradingEngineService(orders, accounts, positions, transactions, db.getRepository(DividendSnapshot));
    engine.prices.set('U1', 10);
    engine.placeVirtualOrder('U1', 'sell', 10.01, 50, 100, { tag: 'synthetic-ai' });
    let virtualCallbacks = 0, prints = 0;
    engine.setVirtualFillHook(() => { virtualCallbacks++; }); engine.setUserFillHook(() => { prints++; });
    const before = JSON.stringify([...engine.realBooks]);
    const submit = async (type = 'market') => engine.submitOrder({ userId: 'synthetic-user', accountId: 'synthetic-account', symbol: 'U1', type, side: 'buy', quantity: 100, price: 11 }, await accounts.findOneBy({ id: 'synthetic-account' }));
    assert.equal((await submit('fok')).success, false);
    assert.equal(JSON.stringify([...engine.realBooks]), before); assert.equal(virtualCallbacks, 0);
    await db.query("CREATE TRIGGER injected_failure BEFORE INSERT ON transactions BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END");
    const failed = await submit(); assert.equal(failed.success, false); assert.match(failed.error, /synthetic write failure/);
    assert.equal((await accounts.findOneBy({ id: 'synthetic-account' })).cash, 100000);
    assert.equal(await transactions.count(), 0); assert.equal(await positions.count(), 0); assert.equal(await orders.count(), 0);
    assert.equal(JSON.stringify([...engine.realBooks]), before); assert.equal(virtualCallbacks, 0); assert.equal(prints, 0);
    await db.query('DROP TRIGGER injected_failure');
    const succeeded = await submit(); assert.equal(succeeded.success, true); assert.equal(succeeded.fill.filledQuantity, 50); assert.equal(succeeded.fill.remainingQuantity, 50);
    assert.equal(succeeded.fill.totalCost, 500.5); assert.equal((await accounts.findOneBy({ id: 'synthetic-account' })).cash, 99499.5);
    assert.equal(virtualCallbacks, 1); assert.equal(prints, 1); assert.equal(engine.executeMarketOrder('U1', 'buy', 1), null);
    console.log(JSON.stringify({ passed: true, driver: 'better-sqlite3', database: ':memory:', finiteDepth: true, fokNoMutation: true, writeFailureRollsBack: true, deferredVirtualCallbacks: true, playerDatabaseOpened: false }));
  } finally { await db.destroy(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
