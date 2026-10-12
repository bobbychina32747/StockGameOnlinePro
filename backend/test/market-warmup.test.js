require('reflect-metadata');
const {MarketService}=require('../dist/src/modules/market/market.service');
const {MarketDataService}=require('../dist/src/core/market-data/market-data.service');
const {TradingEngineService}=require('../dist/src/core/trading-engine/trading-engine.service');
test('startup seeds executable maker quotes for AI without waiting ten minute ticks',()=>{
 const engine=new TradingEngineService(null,null,null,null,null);
 const market=new MarketDataService(null,null,null,engine,'US');
 market.stocks.set('U1',{symbol:'U1',price:100,volatility:.02,prevClose:100,dayOpen:100});
 MarketService.prototype.warmUpMarket.call({engine,logger:{warn:message=>{throw new Error(message);}}},market);
 const fill=engine.executeVirtualMarketOrder('U1','buy',100);
 expect(fill?.filledQuantity).toBe(100);
 expect(fill.avgPrice).toBeGreaterThan(100);expect(fill.avgPrice).toBeLessThan(101);
});
