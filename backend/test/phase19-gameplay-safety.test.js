const { AccountService } = require('../dist/src/modules/account/account.service');
const { FundService } = require('../dist/src/modules/fund/fund.service');
const { TradingEngineService } = require('../dist/src/core/trading-engine/trading-engine.service');
const { MarketService } = require('../dist/src/modules/market/market.service');
const { MarketDataService } = require('../dist/src/core/market-data/market-data.service');
const { tradingMinuteIndex, tradingMinutesFor, gameTradingTime } = require('../dist/src/common/data/trading-calendar');

function repo(seed = []) {
  const rows = structuredClone(seed);
  return {
    rows,
    find: jest.fn(async (q) => rows.filter(r => Object.entries(q?.where || {}).every(([k, v]) => r[k] === v))),
    async findOne(q) { return (await this.find(q))[0] || null; },
    create: v => v,
    save: jest.fn(async (v) => {
      const index = rows.findIndex(r => v.id ? r.id === v.id : r.fundId === v.fundId);
      if (index >= 0) rows[index] = v; else rows.push(v);
      return v;
    }),
  };
}
const account = (id, over = {}) => ({ id, userId: 'u', marketMode: 'US', cash: 10000, leverage: 1, borrowed: 0, shortCollateral: 0, ...over });
const position = (symbol, over = {}) => ({ id: symbol, accountId: 'a', symbol, longQty: 0, shortQty: 100, longCost: 0, shortCost: 10, boughtToday: 0, ...over });
const fill = (quantity = 100, price = 10) => ({ filledQuantity: quantity, avgPrice: price, totalCost: quantity * price });
function engine(accounts, positions = []) {
  const e = new TradingEngineService(repo(), accounts, repo(positions), repo(), repo());
  e.logger.log = e.logger.warn = () => {};
  return e;
}
function accountService(accounts, positions = [], ds) {
  const svc = new AccountService(accounts, repo(positions), repo(), repo(), repo(), repo(), null, { runExclusive: fn => fn() }, null, repo(), { isBlocked: async () => false }, ds);
  svc.logger.log = svc.logger.warn = () => {};
  return svc;
}

describe('gameplay money invariants', () => {
  test.each([0.0049, 0.014, 0.00001])('rejects sub-cent transfer %s without touching balances', async amount => {
    const accounts = repo([account('cn', { marketMode: 'CN', cash: 100 }), account('hk', { marketMode: 'HK', cash: 100 })]);
    expect((await accountService(accounts).transferCash('u', 'CN', 'HK', amount)).success).toBe(false);
    expect(accounts.rows.map(a => a.cash)).toEqual([100, 100]);
    expect(accounts.save).not.toHaveBeenCalled();
  });

  test('valid transfers save both accounts in one transaction and never round the credit up', async () => {
    const accounts = repo([account('cn', { marketMode: 'CN', cash: 100 }), account('hk', { marketMode: 'HK', cash: 100 })]);
    const save = jest.fn(async () => {});
    const ds = { transaction: jest.fn(fn => fn({ save })) };
    const result = await accountService(accounts, [], ds).transferCash('u', 'CN', 'HK', 1);
    expect(result).toEqual({ success: true, received: 1.08 });
    expect(ds.transaction).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(2);
    expect(accounts.save).not.toHaveBeenCalled();
  });

  test('a failure writing the credit rolls back the debit in a real SQLite transaction', async () => {
    const { DataSource, EntitySchema } = require('typeorm');
    class Ledger {}
    const schema = new EntitySchema({ name: 'Ledger', target: Ledger, columns: {
      id: { type: String, primary: true }, userId: { type: String }, marketMode: { type: String }, cash: { type: Number },
    } });
    const ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [schema], synchronize: true });
    await ds.initialize();
    try {
      const accounts = ds.getRepository(Ledger);
      await accounts.save(accounts.create([{ id: 'cn', userId: 'u', marketMode: 'CN', cash: 100 }, { id: 'hk', userId: 'u', marketMode: 'HK', cash: 100 }]));
      const failing = { transaction: fn => ds.transaction(async manager => {
        let saves = 0;
        return fn({ save: row => ++saves === 2 ? Promise.reject(new Error('credit write failed')) : manager.save(row) });
      }) };
      const svc = accountService(accounts, [], failing);
      await expect(svc.transferCash('u', 'CN', 'HK', 1)).rejects.toThrow('credit write failed');
      expect((await accounts.find()).map(row => row.cash)).toEqual([100, 100]);
    } finally { await ds.destroy(); }
  });

  test('closing one of two shorts preserves the other collateral and equity', async () => {
    const accounts = repo([account('a', { shortCollateral: 1500 })]);
    const e = engine(accounts, [position('U1'), position('U2', { shortCost: 20 })]);
    const initialEquity = 10000 + 1500 - 3000;
    const expectedRelease = e.shortCollateralRelease(accounts.rows[0], e.positionRepo.rows, 'U1', 100);
    expect(expectedRelease).toBeGreaterThan(0);
    expect(expectedRelease).toBeLessThan(1500);
    const result = await e.settleFill('a', 'U1', 'cover', { symbol: 'U1', ...fill() }, 'US');
    expect(result.success).toBe(true);
    expect(accounts.rows[0].shortCollateral).toBeCloseTo(1500 - expectedRelease);
    expect(e.positionRepo.rows.find(p => p.symbol === 'U2').shortQty).toBe(100);
    expect(accounts.rows[0].cash + accounts.rows[0].shortCollateral - 2000).toBeCloseTo(initialEquity - result.fees.totalFees, 2);
  });

  test.each(['full', 'partial'])('%s liquidation preserves collateral of an unfilled short', async path => {
    const accounts = repo([account('a', { shortCollateral: 1500 })]);
    const e = engine(accounts, [position('U1'), position('U2', { shortCost: 20 })]);
    e.prices.set('U1', 10); e.prices.set('U2', 20);
    const qty = path === 'full' ? 100 : 50;
    const released = e.shortCollateralRelease(accounts.rows[0], e.positionRepo.rows, 'U1', qty);
    e.executeMarketOrder = (symbol) => symbol === 'U1' ? fill(qty) : null;
    if (path === 'full') await e.forceLiquidateInner(accounts.rows[0]);
    else await e.forceLiquidateToTargetInner(accounts.rows[0], 999);
    expect(accounts.rows[0].shortCollateral).toBeCloseTo(1500 - released);
    expect(e.positionRepo.rows.find(p => p.symbol === 'U2').shortQty).toBe(100);
  });

  test('leveraged cash includes fees in validation, auction checks and settlement', async () => {
    const accounts = repo([account('a', { marketMode: 'CN', cash: 505, leverage: 2 })]);
    const e = engine(accounts);
    e.prices.set('T1', 10.04);
    const order = { symbol: 'T1', type: 'market', side: 'buy', quantity: 100 };
    expect((await e.validateOrder(order, accounts.rows[0])).valid).toBe(false);
    expect((await e.precheckFill('a', 'T1', 'buy', fill(100, 10.04))).success).toBe(false);
    expect((await e.settleFill('a', 'T1', 'buy', fill(100, 10.04), 'CN')).success).toBe(false);
    expect(accounts.rows[0].cash).toBe(505);
  });

  test('zero quantity rows allow reset; an actual short still blocks reset', async () => {
    const accounts = repo([account('a', { currentDay: 2, lastResetDay: 0 })]);
    const svc = accountService(accounts, [position('U1', { shortQty: 0 })]);
    expect((await svc.resetAccount('u', 'US', '散户')).success).toBe(true);
    const blocked = accountService(repo([account('a', { currentDay: 2 })]), [position('U1')]);
    expect((await blocked.resetAccount('u', 'US', '散户')).success).toBe(false);
  });
});

describe('T+1 transaction day', () => {
  test('HK and US cannot unlock CN; a CN restart cannot unlock same-day purchases', async () => {
    const e = engine(repo(), [position('T1', { longQty: 100, shortQty: 0, boughtToday: 100, boughtDay: 4 })]);
    await e.resetBoughtToday('HK', 5);
    await e.resetBoughtToday('US', 5);
    await e.resetBoughtToday('CN', 4);
    expect(e.positionRepo.rows[0].boughtToday).toBe(100);
    await e.resetBoughtToday('CN', 5);
    expect(e.positionRepo.rows[0].boughtToday).toBe(0);
  });

  test('legacy unknown purchase day is preserved when starting mid-session', async () => {
    const e = engine(repo(), [position('T1', { longQty: 100, shortQty: 0, boughtToday: 100 })]);
    await e.resetBoughtToday('CN', 4, false);
    expect(e.positionRepo.rows[0]).toMatchObject({ boughtToday: 100, boughtDay: 4 });
    await e.resetBoughtToday('CN', 5, true);
    expect(e.positionRepo.rows[0].boughtToday).toBe(0);
  });
});

function funds(navRows = [], prices = { T1: 10, T2: 20 }) {
  const nr = repo(navRows);
  const md = { gameDay: 0, getPrevCloses: () => prices, getDividends: () => [] };
  const svc = new FundService(repo(), repo(), { runExclusive: fn => fn() }, md, null, undefined, nr);
  svc.logger.warn = svc.logger.error = () => {};
  return { svc, nr, md };
}
describe('fund closing NAV', () => {
  test('real time passing does not accrue returns; ETF follows positive and negative basket returns', async () => {
    jest.useFakeTimers();
    try {
      const { svc } = funds();
      await svc.onModuleInit();
      jest.advanceTimersByTime(86400000);
      expect(svc.getFund('fund-1').nav).toBe(4.5);
      await svc.updateNavs(1, { T1: 9, T2: 18 });
      expect(svc.getFund('fund-1').nav).toBeCloseTo(4.05);
      await svc.updateNavs(2, { T1: 9.9, T2: 19.8 });
      expect(svc.getFund('fund-1').nav).toBeCloseTo(4.455);
    } finally { jest.useRealTimers(); }
  });

  test('concurrent duplicate closes and restarting do not repeat returns', async () => {
    const { svc, nr } = funds([{ fundId: 'fund-1', nav: 5.2 }]);
    await svc.onModuleInit();
    await Promise.all([svc.updateNavs(1, { T1: 11, T2: 22 }), svc.updateNavs(1, { T1: 11, T2: 22 })]);
    expect(svc.getFund('fund-1').nav).toBeCloseTo(5.72);
    const restarted = funds(nr.rows);
    await restarted.svc.onModuleInit();
    await restarted.svc.updateNavs(1, { T1: 11, T2: 22 });
    expect(restarted.svc.getFund('fund-1').nav).toBeCloseTo(5.72);
  });

  test('NAV write failure keeps in-memory quotes unchanged and the same day can retry', async () => {
    const { svc, nr } = funds();
    await svc.onModuleInit();
    nr.save.mockRejectedValueOnce(new Error('db locked'));
    await expect(svc.updateNavs(1, { T1: 11, T2: 22 })).rejects.toThrow('db locked');
    expect(svc.getFund('fund-1').nav).toBe(4.5);
    await svc.updateNavs(1, { T1: 11, T2: 22 });
    expect(svc.getFund('fund-1').nav).toBeCloseTo(4.95);
  });

  test('cash fund accrues 2.5% over 252 game days, not real minutes', async () => {
    const { svc } = funds();
    for (let day = 1; day <= 252; day++) await svc.updateNavs(day, { T1: 10, T2: 20 });
    expect(svc.getFund('fund-2').nav).toBeCloseTo(1.025, 5);
  });
});

function market(debug = true) {
  const md = {
    gameDay: 0, tickCount: 0,
    generateTick: jest.fn(async () => [{ symbol: 'U1', price: 10, volume: 100 }]),
    setTradingMinute: jest.fn(), getPrices: () => ({ U1: 10 }),
    getVolatilities: () => ({}), postTickProcessing: async () => {},
    applyExRights: async () => {}, getPrevCloses: () => ({}), startNewDay: async () => {},
    getDayEvents: () => null, getBurstEvents: () => [], getState: () => ({}), generateReports: () => 0,
    getDividends: () => [],
    endOfDay: jest.fn(async () => { md.gameDay++; }),
  };
  const e = {
    runExclusive: fn => fn(),
    updatePrices: () => {}, setVolatilities: () => {}, refreshOrderBooks: () => {},
    resetBoughtToday: jest.fn(), cancelAfterHoursOrders: async () => {}, setPrevCloses: () => {},
    checkPendingOrders: async () => [], setDayOpen: () => {}, snapshotDividendHolders: async () => {},
    payDividends: async () => {}, forceLiquidateMarginalAccounts: jest.fn(async () => []),
  };
  const risk = { setMarketPrices: () => {}, settleAllAccounts: jest.fn() };
  const svc = new MarketService(md, e, { broadcastTick: () => {} }, { generateDailyNews: () => null, processNightEvent: () => null }, risk, md, md, { isMarketActive: () => debug }, { get: (_, d) => d });
  svc.runOpeningAuctions = async () => {};
  svc.logger.error = jest.fn(); svc.logger.log = svc.logger.warn = () => {};
  return { svc, md, e, risk };
}
describe('market session boundaries', () => {
  test('a failed account close resumes the same day without advancing the market twice', async () => {
    const { svc, md, risk } = market();
    risk.settleAllAccounts.mockRejectedValueOnce(new Error('database unavailable'));
    svc.tickCounter = 239;
    await svc.processMarket('CN', md, 'tickCounter');
    expect(md.gameDay).toBe(1);
    await svc.processMarket('CN', md, 'tickCounter');
    expect(md.endOfDay).toHaveBeenCalledTimes(1);
    expect(risk.settleAllAccounts.mock.calls).toEqual([[1, 'CN'], [1, 'CN']]);
  });

  test('US real-time midnight stays on the same session and closes after 04:00', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-18T23:59:00'));
    try {
      const { svc, md, e } = market(false);
      await svc.processMarket('US', md, 'tickCounterUS');
      jest.setSystemTime(new Date('2026-08-19T00:00:00'));
      await svc.processMarket('US', md, 'tickCounterUS');
      expect(md.setTradingMinute.mock.calls).toEqual([[149], [150]]);
      expect(md.gameDay).toBe(0);
      jest.setSystemTime(new Date('2026-08-19T03:59:00'));
      await svc.processMarket('US', md, 'tickCounterUS');
      expect(md.endOfDay).not.toHaveBeenCalled();
      jest.setSystemTime(new Date('2026-08-19T04:00:00'));
      await svc.processMarket('US', md, 'tickCounterUS');
      await svc.processMarket('US', md, 'tickCounterUS');
      expect(md.endOfDay).toHaveBeenCalledTimes(1);
      expect(e.resetBoughtToday).not.toHaveBeenCalled();
      expect(svc.logger.error).not.toHaveBeenCalled();
    } finally { jest.useRealTimers(); }
  });
  test.each([['CN', 240], ['HK', 330], ['US', 390]])('%s only closes at its own final minute (%s)', async (mode, duration) => {
    const { svc, md, e, risk } = market();
    const key = mode === 'CN' ? 'tickCounter' : `tickCounter${mode}`;
    svc[key] = 239;
    await svc.processMarket(mode, md, key);
    expect(md.endOfDay).toHaveBeenCalledTimes(mode === 'CN' ? 1 : 0);
    if (mode !== 'CN') {
      svc[key] = duration - 1;
      await svc.processMarket(mode, md, key);
      expect(md.endOfDay).toHaveBeenCalledTimes(1);
      expect(e.resetBoughtToday).not.toHaveBeenCalled();
    }
    expect(risk.settleAllAccounts).toHaveBeenCalledWith(1, mode);
    expect(e.forceLiquidateMarginalAccounts).toHaveBeenCalledWith(mode);
    expect(svc[key]).toBe(0);
    expect(svc.logger.error).not.toHaveBeenCalled();
  });

  test('real-time HK starts at 14:30 index 240 and does not restart the day or duplicate the minute', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-18T14:30:00'));
    try {
      const { svc, md } = market(false);
      await svc.processMarket('HK', md, 'tickCounterHK');
      await svc.processMarket('HK', md, 'tickCounterHK');
      expect(md.setTradingMinute).toHaveBeenCalledWith(240);
      expect(md.generateTick).toHaveBeenCalledTimes(1);
      expect(md.endOfDay).not.toHaveBeenCalled();
      jest.setSystemTime(new Date('2026-08-18T16:00:01'));
      await svc.processMarket('HK', md, 'tickCounterHK');
      await svc.processMarket('HK', md, 'tickCounterHK');
      expect(md.endOfDay).toHaveBeenCalledTimes(1);
      expect(svc.logger.error).not.toHaveBeenCalled();
    } finally { jest.useRealTimers(); }
  });

  test('US midnight minute index is continuous in summer and winter', () => {
    expect(tradingMinuteIndex('US', new Date('2026-08-19T00:00:00'))).toBe(150);
    expect(tradingMinuteIndex('US', new Date('2026-12-09T00:00:00'))).toBe(90);
    expect(tradingMinutesFor('US')).toBe(390);
    const last = gameTradingTime('HK', 0, 329);
    expect([last.getHours(), last.getMinutes()]).toEqual([15, 59]);
    const summer = gameTradingTime('US', 0, 389, new Date('2026-08-18T12:00:00'));
    expect([summer.getDate(), summer.getHours(), summer.getMinutes()]).toEqual([2, 3, 59]);
  });

  test('backend chart timestamps follow each market session', () => {
    const hk = new MarketDataService(repo(), repo(), repo(), {}, 'HK');
    const time = hk.tradingTime(0, 150);
    expect([time.getHours(), time.getMinutes()]).toEqual([13, 0]);
  });
});

describe('SQLite gameplay schema upgrade', () => {
  test('nullable columns preserve stored NAV and migration is repeatable', () => {
    const Database = require('better-sqlite3');
    const { migrateGameplaySchema } = require('../scripts/migrate-gameplay-schema.cjs');
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE positions (id TEXT PRIMARY KEY, boughtToday INTEGER); CREATE TABLE fund_navs (fundId TEXT PRIMARY KEY, nav REAL);');
      db.prepare('INSERT INTO fund_navs VALUES (?, ?)').run('fund-1', 5.2);
      expect(migrateGameplaySchema(db)).toHaveLength(3);
      expect(db.prepare('SELECT nav, settledDay, basketPrices FROM fund_navs').get()).toEqual({ nav: 5.2, settledDay: null, basketPrices: null });
      expect(migrateGameplaySchema(db)).toEqual([]);
    } finally { db.close(); }
  });

  test('missing tables roll back the entire schema change', () => {
    const Database = require('better-sqlite3');
    const { migrateGameplaySchema } = require('../scripts/migrate-gameplay-schema.cjs');
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE positions (id TEXT PRIMARY KEY)');
      expect(() => migrateGameplaySchema(db)).toThrow('Missing table');
      expect(db.pragma('table_info(positions)').map(row => row.name)).toEqual(['id']);
    } finally { db.close(); }
  });
});
