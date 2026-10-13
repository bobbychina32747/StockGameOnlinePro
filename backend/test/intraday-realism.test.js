const {calibratedShock}=require('../dist/src/common/unified-market');
const {calibratedVolume}=require('../dist/src/common/volume-model');
const {MarketDataService}=require('../dist/src/core/market-data/market-data.service');
const profiles=require('../dist/src/common/unified-intraday-risk.json').profiles;
const stock=()=>({symbol:'T1',industry:'半导体',price:100,prevClose:100,dayOpen:100,dayHigh:100,dayLow:100,
 volatility:.02,baseVolume:10000,avgVolume:10000,lastReturn:0,lastVolume:100,dayVolume:100,dayAmount:10000,
 minuteCounter:0,kline1min:[],kline5min:[],klineDaily:[],current1min:null,current5min:null,currentDaily:null});
test('intraday variance profiles cover every market-sector and remain stationary',()=>{
 expect(Object.keys(profiles)).toHaveLength(69);
 for(const p of Object.values(profiles)){
  expect(p.alpha+p.beta+p.gamma/2).toBeLessThan(1);expect(p.omega).toBeGreaterThan(0);
  expect(p.trainBars).toBeGreaterThan(100);expect(p.holdoutBars).toBeGreaterThan(100);
 }
});
test('conditional variance responds to observed jumps and limit-clamped returns instead of hidden noise only',()=>{
 const quiet={...stock(),minuteCounter:100},news={...stock(),minuteCounter:100,lastReturn:-.015};
 calibratedShock(quiet,()=>0,240,'CN',0,0);calibratedShock(news,()=>0,240,'CN',0,0);
 expect(news.calibratedVariance.variance).toBeGreaterThan(quiet.calibratedVariance.variance*1.3);
 for(let i=0;i<200;i++){news.lastReturn=0;calibratedShock(news,()=>0,240,'CN',0,0);}
 expect(news.calibratedVariance.variance).toBeGreaterThanOrEqual(.15);expect(news.calibratedVariance.variance).toBeLessThan(1);
});
test('larger observable moves produce larger volume without cancelling the conditional volatility level',()=>{
 const low={...stock(),lastReturn:.001,minuteCounter:100},high={...stock(),lastReturn:.01,volatility:.2,minuteCounter:100};
 expect(calibratedVolume(high,'CN',240,()=>0)).toBeGreaterThan(calibratedVolume(low,'CN',240,()=>0));
 const a={...stock(),lastReturn:.003},b={...a,volatility:.2};
 expect(calibratedVolume(a,'CN',240,()=>0)).toBe(calibratedVolume(b,'CN',240,()=>0));
});
test('minute extrema produce shadows and are shared with five-minute and daily candles inside daily bands',()=>{
 const s=new MarketDataService(null,null,null,null,'CN'),st=stock();let i=0;s.randn=()=>++i%2?2:-2;
 s.updateKlines(st);
 expect(st.current1min.high).toBeGreaterThan(100);expect(st.current1min.low).toBeLessThan(100);
 expect(st.current1min.high).toBeLessThanOrEqual(110);expect(st.current1min.low).toBeGreaterThanOrEqual(90);
 expect(st.current5min.high).toBe(st.current1min.high);expect(st.currentDaily.low).toBe(st.current1min.low);
 expect(st.dayHigh).toBe(st.current1min.high);expect(st.dayLow).toBe(st.current1min.low);
});
test('in-minute news activity updates volume and amount in all aggregates; unchanged or overnight events do not invent previous-bar trades',()=>{
 const s=new MarketDataService(null,null,null,null,'CN'),st=stock();s.randn=()=>0;s.updateKlines(st);
 s.applyEventPrice(st,102);const extra=st.lastVolume-100;expect(extra).toBeGreaterThan(0);
 expect(st.dayVolume).toBe(st.lastVolume);expect(st.dayAmount).toBeCloseTo(10000+extra*101);
 for(const b of [st.current1min,st.current5min,st.currentDaily]){expect(b.volume).toBe(st.lastVolume);expect(b.close).toBe(102);}
 s.applyEventPrice(st,102);expect(st.lastVolume).toBe(100+extra);
 st.current1min=st.current5min=st.currentDaily=null;s.applyEventPrice(st,103);expect(st.lastVolume).toBe(100+extra);
});
