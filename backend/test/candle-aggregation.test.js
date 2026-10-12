const {fiveMinuteHistory}=require('../dist/src/core/market-data/candle-aggregation');
const {MarketDataService}=require('../dist/src/core/market-data/market-data.service');
const base=Date.UTC(2024,0,2,1,30);
const bar=(minute,open,close,volume=10)=>({time:new Date(base+minute*60000),open,close,high:Math.max(open,close)+1,low:Math.min(open,close)-1,volume});
test('five-minute OHLC replaces a divergent cached candle and includes the first minute opening price',()=>{
 const minutes=[bar(0,100,101),bar(1,101,99),bar(2,99,102),bar(3,102,101),bar(4,101,103)];
 const cached=[{...bar(0,1000,1001),volume:500}];
 const [result]=fiveMinuteHistory(cached,minutes);
 expect(result).toEqual({time:new Date(base),open:100,close:103,high:104,low:98,volume:50});
});
test('partial oldest cache bucket retains complete history; duplicates and lunch are handled independently',()=>{
 const cached=[{...bar(0,100,104),volume:50}];
 const minutes=[bar(3,102,103),bar(4,103,104),bar(120,110,111),bar(120,110,112,20)];
 const result=fiveMinuteHistory(cached,minutes);
 expect(result).toHaveLength(2);expect(result[0].volume).toBe(50);expect(result[1].close).toBe(112);expect(result[1].volume).toBe(20);
});
test('live five-minute creation uses its first one-minute open instead of a stale five-minute cache',()=>{
 const service=new MarketDataService(null,null,null,null,'CN');service.gameDay=30;
 const stock={minuteCounter:5,price:101,lastVolume:10,dayVolume:10,dayOpen:100,dayHigh:101,dayLow:100,
  kline1min:[bar(4,99,100)],kline5min:[bar(0,1000,1000)]};
 service.updateKlines(stock);expect(stock.current5min.open).toBe(100);expect(stock.current5min.high).toBe(101);expect(stock.current5min.low).toBe(100);
});
