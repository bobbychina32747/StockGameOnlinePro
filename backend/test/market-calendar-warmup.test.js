require('reflect-metadata');
const { DataSource } = require('typeorm');
const { Stock } = require('../dist/src/infrastructure/database/entities/stock.entity');
const { Kline } = require('../dist/src/infrastructure/database/entities/kline.entity');
const { DividendEvent } = require('../dist/src/infrastructure/database/entities/dividend-event.entity');
const constants = require('../dist/src/common/constants');
const { MarketDataService } = require('../dist/src/core/market-data/market-data.service');
const { TradingEngineService } = require('../dist/src/core/trading-engine/trading-engine.service');
const { exchangeParts } = require('../dist/src/common/data/trading-calendar');

test('native cold history ends at the last real completed session and restores without regeneration', async () => {
    const pool = [...constants.US_POOL];
    constants.US_POOL.splice(1);
    const db = new DataSource({type:'better-sqlite3',database:':memory:',entities:[Stock,Kline,DividendEvent],synchronize:true});
    const createMarket = () => new MarketDataService(db.getRepository(Stock),db.getRepository(Kline),db.getRepository(DividendEvent),new TradingEngineService(null,null,null,null,null),'US');
    try {
        await db.initialize();
        const market = createMarket();
        market.logger = {log(){},debug(){},warn(){},error(message){throw Error(message);}};
        await market.init({calendarNow:new Date('2026-11-27T18:00:00Z')});
        expect(market.calendarState.closedDate).toBe('2026-11-27');
        const stock = market.stocks.values().next().value;
        const bars = stock.kline1min;
        expect(bars.length).toBeGreaterThan(60);
        const last = bars[bars.length-1];
        expect(exchangeParts('US',new Date(last.time))).toEqual({date:'2026-11-27',minute:779});
        expect(bars.filter(bar => exchangeParts('US',new Date(bar.time)).date === '2026-11-27')).toHaveLength(210);
        expect(bars.some(bar => exchangeParts('US',new Date(bar.time)).date === '2026-11-26')).toBe(false);
        for(const timeframe of ['kline1min','kline5min'])for(const bar of stock[timeframe]) {
            expect([bar.open,bar.high,bar.low,bar.close,bar.volume].every(Number.isFinite)).toBe(true);
            expect(bar.low).toBeLessThanOrEqual(Math.min(bar.open,bar.close));
            expect(bar.high).toBeGreaterThanOrEqual(Math.max(bar.open,bar.close));
            expect(bar.volume).toBeGreaterThanOrEqual(0);
        }
        expect(stock.price).toBe(last.close);
        const restored = createMarket();
        restored.logger=market.logger;
        restored.generateTick=jest.fn(()=>{throw Error('Restored history must not be regenerated');});
        await restored.init({calendarNow:new Date('2026-11-30T16:00:00Z')});
        expect(restored.generateTick).not.toHaveBeenCalled();
        expect(restored.calendarState.closedDate).toBe('2026-11-27');
        expect(restored.stocks.get(stock.symbol).price).toBe(stock.price);
    } finally {
        if(db.isInitialized)await db.destroy();
        constants.US_POOL.splice(0,constants.US_POOL.length,...pool);
    }
},60000);
