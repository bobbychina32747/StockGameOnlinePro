const { aiEntryScore, aiPortfolioRisk } = require('../dist/src/core/market-data/ai-risk-policy');
const { MarketDataService } = require('../dist/src/core/market-data/market-data.service');
const A = require('../dist/src/core/market-data/ai-opponents');

test('下跌途中拒绝抄底，出现实际反弹才允许均值回归入场', () => {
  const stock = { price: 9.5, kline1min: Array.from({length:90}, (_, i) => ({close:10-i*.0055})) };
  expect(aiEntryScore('meanrev', stock, {ret:-.05, ofi:-.3}, false)).toBe(-Infinity);
  stock.kline1min = Array.from({length:90}, () => ({close:9.48}));
  expect(aiEntryScore('meanrev', stock, {ret:-.05, ofi:.1}, false)).toBeGreaterThan(0);
});

test('组合和单股额度包含跨标的挂买单，回撤后收缩总敞口', () => {
  const ledger = {cash:6000, initialCash:10000, positions:new Map([['A',{qty:200,cost:10}]])};
  const risk = aiPortfolioRisk(ledger, new Map([['A',{price:10}]]), [
    {symbol:'B',side:'buy',qty:100,filledQty:20,price:10},
    {symbol:'C',side:'buy',qty:20,price:20},
    {symbol:'A',side:'sell',qty:100,price:10},
  ], 'bull');
  expect(risk.equity).toBe(8000);
  expect(risk.exposureLimit).toBe(800);
  expect(risk.pendingBuys).toBe(1200);
  expect(risk.bySymbol.get('B')).toBe(800);
  expect(risk.singleLimit).toBe(240);
});

test('大股票池中止损先于参与率抽签，不依赖随机选到亏损持仓', async () => {
  const service = new MarketDataService(null,null,null,null,'CN');
  service.aiAdaptiveEnabled = false;
  service.aiAgents = [{id:'AI1',type:'机构',strategy:'trend',activity:0,scale:100,cash:10000}];
  const ledger = service.aiLedger[0];
  ledger.cash = 10000; ledger.initialCash = 11000;
  ledger.positions = new Map([['T99',{qty:100,cost:10}]]);
  for(let i=0;i<138;i++) service.stocks.set('T'+i, {symbol:'T'+i, industry:'银行',price:i===99?9:10,dayOpen:10,prevClose:10,volatility:.02,kline1min:[]});
  const orders=[];
  service.engine={setVirtualFillHook(){},pruneExpiredVirtualOrders(){},getOrderBook(){return {bids:[],asks:[]}},executeVirtualMarketOrder(symbol,side,qty){orders.push({symbol,side,qty});return null;}};
  await service.applyAiTrading();
  expect(orders).toHaveLength(1);
  expect(orders[0]).toMatchObject({symbol:'T99',side:'sell'});
  expect(orders[0].qty).toBeLessThanOrEqual(100);
  expect(ledger.cash).toBe(10000); // 未成交不凭空改变收益。
});

test('学习命中率由后续价格验证，不把自身方向当正确答案', async () => {
  const service = new MarketDataService(null,null,null,null,'CN');
  service.aiAgents=[{id:'AI1',type:'机构',strategy:'trend',activity:0,scale:100,cash:10000}];
  const ledger=service.aiLedger[0];
  service.stocks.set('T1',{symbol:'T1',industry:'银行',price:9,dayOpen:10,volatility:.02,kline1min:[]});
  ledger.treePrediction={tick:0,symbol:'T1',price:10,votes:A.RF_TREES.map(()=>1)};
  service.tickCount=11; await service.applyAiTrading();
  expect(ledger.treeMiss.every(v=>v===0)).toBe(true);
  service.tickCount=12; await service.applyAiTrading();
  expect(ledger.treeMiss.every(v=>v===1)).toBe(true);
  expect(ledger.treeHit.every(v=>v===0)).toBe(true);
});
