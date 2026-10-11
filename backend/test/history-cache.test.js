require('reflect-metadata');
const {DataSource}=require('typeorm');
const {Kline}=require('../dist/src/infrastructure/database/entities/kline.entity');
const {restoreHistoryCache,HISTORY_CACHE_LIMITS}=require('../dist/src/core/market-data/history-cache');
const {MarketDataService}=require('../dist/src/core/market-data/market-data.service');

test('large persisted history restores a bounded cache instrument by instrument without deleting archive or resetting other instruments',async()=>{
 const source=new DataSource({type:'better-sqlite3',database:':memory:',entities:[Kline],synchronize:true});await source.initialize();
 try{
  const repository=source.getRepository(Kline);const batch=[];const base=Date.UTC(2024,0,1);
  for(const symbol of ['T1','T2'])for(const [timeframe,count] of [['1min',1700],['5min',1300],['daily',20]]){
   for(let i=0;i<count;i++)batch.push({symbol,timeframe,time:new Date(base+i*(timeframe==='daily'?86400000:60000)),open:10,high:12,low:9,close:11,volume:100});
  }
  for(let i=0;i<batch.length;i+=500)await repository.insert(batch.slice(i,i+500));
  const context={stocks:new Map(['T1','T2'].map(symbol=>[symbol,{symbol,kline1min:[],kline5min:[],klineDaily:[]}])),gameDay:0};
  let peakRows=0;const loaded=await restoreHistoryCache(repository,['T1','T2'],(symbol,rows)=>{
   peakRows=Math.max(peakRows,rows.length);MarketDataService.prototype.restoreFromHistory.call(context,rows,symbol);
  });
  expect(loaded).toBe(2*(HISTORY_CACHE_LIMITS['1min']+HISTORY_CACHE_LIMITS['5min']+20));
  expect(peakRows).toBe(HISTORY_CACHE_LIMITS['1min']+HISTORY_CACHE_LIMITS['5min']+20);
  for(const stock of context.stocks.values()){
   expect(stock.kline1min.length).toBe(1440);expect(stock.kline5min.length).toBe(1200);expect(stock.klineDaily.length).toBe(20);
   expect(stock.kline1min[0].time.getTime()).toBe(base+260*60000);
   expect(stock.kline1min.at(-1).time.getTime()).toBe(base+1699*60000);
  }
  expect(context.gameDay).toBe(20);expect(await repository.count()).toBe(batch.length);
 }finally{await source.destroy();}
},20000);

test('thirty simulated trading days keep minute caches bounded with continuous latest prices and volume',()=>{
 const base=Date.UTC(2024,0,1);const context={gameDay:0,tradingTime:(day,minute)=>new Date(base+(day*240+minute)*60000)};
 const stock={minuteCounter:0,price:100,lastVolume:10,dayVolume:0,dayOpen:100,dayHigh:110,dayLow:90,kline1min:[],kline5min:[]};
 for(let i=0;i<7200;i++){
  context.gameDay=Math.floor(i/240);stock.minuteCounter=i%240;stock.price=100+i/1000;
  if(stock.minuteCounter===0)stock.currentDaily=null;
  MarketDataService.prototype.updateKlines.call(context,stock);
 }
 expect(stock.kline1min.length).toBe(1440);expect(stock.kline5min.length).toBe(1200);
 expect(stock.current1min.open).toBe(stock.kline1min.at(-1).close);
 expect(stock.current1min.close).toBe(107.199);expect(stock.current1min.volume).toBe(10);
 expect(stock.current5min.volume).toBe(50);
 expect(stock.kline1min.at(-1).time.getTime()).toBe(base+7198*60000);
});
