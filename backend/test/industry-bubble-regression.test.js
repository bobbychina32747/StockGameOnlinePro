const C=require('../dist/src/common/constants');
const {MarketDataService}=require('../dist/src/core/market-data/market-data.service');
const {aiEntryScore}=require('../dist/src/core/market-data/ai-risk-policy');

test('legacy symbols share the 23 canonical sectors; every realm sector has at least six stocks',()=>{
 for(const pool of [C.STOCK_POOL,C.HK_POOL,C.US_POOL]){
  const counts=new Map();for(const row of pool)counts.set(row.industry,(counts.get(row.industry)||0)+1);
  expect(counts.size).toBe(23);expect(Math.min(...counts.values())).toBeGreaterThanOrEqual(6);
 }
 expect(C.IPO_POOL.every(row=>C.STOCK_POOL.some(base=>base.industry===row.industry))).toBe(true);
});

function service(price=100,intrinsic=100){
 const s=new MarketDataService(null,null,null,null,'CN');s.marketRegime='sideways';s.gameDay=10;
 const st={symbol:'TEST',market:'CN',industry:'银行',price,intrinsic,dayOpen:price,prevClose:price,dayHigh:price,dayLow:price,dayVolume:0,volatility:.02,avgVolume:1000,minuteCounter:0,kline1min:[],kline5min:[],klineDaily:[],trendCounter:0,trendDirection:0,trendAccumulated:0,isTrending:false};
 s.stocks.set(st.symbol,st);s.poolBySymbol.set(st.symbol,{mu:price,theta:0});
 s.randn=()=>0;s.calcJump=()=>({small:0,big:0});s.calcOFIImpact=()=>0;s.calcFactorImpact=()=>0;s.updateVolatility=()=>{};
 return {s,st};
}

test('regime drift scales by one trading day, rather than adding a daily bias every minute',async()=>{
 const {s,st}=service();s.marketRegime='bull';await s.generateTick();
 expect(st.price/100-1).toBeCloseTo(C.STATE_PARAMS.bull.driftBase/240,8);
});

test('burst pressure has a daily time scale and cannot be cleared by one fairly valued member',async()=>{
 const {s,st}=service(200,50);s.triggerBurst('银行','test');
 s.stocks.set('OTHER',{...st,symbol:'OTHER',price:50,intrinsic:50,dayOpen:50,prevClose:50,kline1min:[],kline5min:[],klineDaily:[]});
 s.poolBySymbol.set('OTHER',{mu:50,theta:.15});
 await s.generateTick();
 expect(st.price/200-1).toBeGreaterThan(-.001);
 expect(s.burstingIndustries.has('银行')).toBe(true);
 s.burstingIndustries.delete('银行');s.triggerBurst('银行','repeat');
 expect(s.getBurstEvents()).toHaveLength(1);
 s.gameDay+=3;s.triggerBurst('银行','new event');expect(s.getBurstEvents()).toHaveLength(1);
});

test('AI cannot buy substantially overpriced bubble stocks even during feature warmup',()=>{
 expect(aiEntryScore('momentum',{price:200,intrinsic:50,kline1min:[]},{ret:.03,ofi:.5},true)).toBe(-Infinity);
});

test('industry contagion cannot repeatedly multiply daily losses or poison tick-return feedback',()=>{
 const {s,st}=service();s.market='HK';st.symbol='H_TEST';st.market='HK';st.industry='软件与云服务';
 st.dayOpen=200;st.lastReturn=0;
 s.stocks.set('SOURCE',{...st,symbol:'H_SOURCE',industry:'半导体',price:100,dayOpen:200});
 for(let i=0;i<330;i++)s.updateIndustryLinks();
 expect(st.price).toBeGreaterThan(99.49);
 expect(Math.abs(st.lastReturn)).toBeLessThan(.006);
});

test('industry transmission respects CN daily price bands and updates candles consistently',()=>{
 const {s,st}=service(110,100);st.prevClose=100;st.dayOpen=100;st.industry='软件与云服务';st.lastReturn=0;
 st.current1min={open:110,high:110,low:110,close:110};
 s.stocks.set('SOURCE',{...st,symbol:'SOURCE',industry:'半导体',price:110});
 s.updateIndustryLinks();expect(st.price).toBe(110);expect(st.current1min.close).toBe(st.price);
 expect(st.lastReturn).toBe(0);
});

test('blocked limit moves are zero observable returns and an opposite move can reopen the stock',async()=>{
 const {s,st}=service(110,110);st.prevClose=100;st.dayOpen=100;
 s.calcJump=()=>({small:0,big:.1});await s.generateTick();
 expect(st.price).toBe(110);expect(st.lastReturn).toBe(0);expect(st.trendCounter).toBe(0);
 s.calcJump=()=>({small:0,big:-.01});await s.generateTick();
 expect(st.price).toBeLessThan(110);expect(st.lastReturn).toBeCloseTo(-.01,5);
});

test('immediate and decaying news obey daily limits and keep candle extrema and actual returns consistent',()=>{
 const {s,st}=service(109.99,110);st.prevClose=100;st.dayOpen=100;
 st.current1min={open:109.99,high:109.99,low:109.99,close:109.99};
 st.current5min={...st.current1min};st.currentDaily={...st.current1min};
 s.applyNewsImpact({type:'bullish',targetedSymbol:'TEST',duration:3,title:'fixture'});
 expect(st.price).toBe(110);expect(st.lastReturn).toBeCloseTo(110/109.99-1,10);
 for(const bar of [st.current1min,st.current5min,st.currentDaily]){
  expect(bar.close).toBe(110);expect(bar.high).toBe(110);expect(bar.low).toBe(109.99);
 }
 s.newsImpacts=[{mode:'symbol',symbol:'TEST',initial:2,daysLeft:1,totalDays:1,decay:.7}];
 s.applyPersistentNewsImpacts();expect(st.price).toBe(110);expect(st.lastReturn).toBe(0);
 s.newsImpacts=[{mode:'industry',industry:'银行',initial:-2,daysLeft:1,totalDays:1,decay:.7}];
 s.applyPersistentNewsImpacts();expect(st.price).toBe(90);expect(st.dayLow).toBe(90);
});

test('overnight event preserves the actual previous close and HK has no CN daily band',()=>{
 const {s,st}=service();s.applyMarketwideShock(-.5);
 expect(st.price).toBe(90);expect(st.prevClose).toBe(100);expect(st.dayOpen).toBe(90);
 st.market='HK';s.applyEventPrice(st,50);expect(st.price).toBe(50);
});

test('night events follow the closing candle and cannot rewrite the previous close',async()=>{
 const {MarketService}=require('../dist/src/modules/market/market.service');
 const {s,st}=service();let ended=false;
 s.getDividends=()=>[];s.endOfDay=async()=>{ended=true;st.prevClose=st.price;s.gameDay++;};
 const context={closingDays:{},engine:{snapshotDividendHolders:async()=>{},payDividends:async()=>{},updatePrices:()=>{},forceLiquidateMarginalAccounts:async()=>[]},
  newsService:{processNightEvent:()=>{expect(ended).toBe(true);return {impact:-.5,name:'fixture'};}},
  enqueueNews:()=>{},flushNewsQueue:()=>{},timeStage:(_,work)=>work(),logger:{log:()=>{},error:message=>{throw Error(message);}}};
 await MarketService.prototype.finishMarketDay.call(context,'CN',s);
 expect(st.prevClose).toBe(100);expect(st.price).toBe(90);
});
