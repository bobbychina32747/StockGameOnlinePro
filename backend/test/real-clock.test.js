const {realMarketClock,realTradingTime}=require('../dist/src/common/data/trading-calendar');
const {isTradingTimeFor}=require('../dist/src/common/constants');
const {MarketDataService}=require('../dist/src/core/market-data/market-data.service');
const {AuthService}=require('../dist/src/modules/auth/auth.service');
const {JwtService}=require('@nestjs/jwt');
const bcrypt=require('bcrypt');

test.each([
 ['CN','2026-10-13T01:29:00Z','pre-open',null],
 ['CN','2026-10-13T01:30:00Z','continuous',0],
 ['CN','2026-10-13T03:30:00Z','closed',null],
 ['CN','2026-10-13T05:00:00Z','continuous',120],
 ['CN','2026-10-13T07:00:00Z','post-close',null],
 ['CN','2026-10-10T02:00:00Z','closed',null],
 ['CN','2026-10-01T02:00:00Z','closed',null],
 ['HK','2026-10-13T04:00:00Z','closed',null],
 ['HK','2026-10-19T02:00:00Z','closed',null],
 ['HK','2026-02-16T02:00:00Z','continuous',30],
 ['HK','2026-02-16T05:00:00Z','closed',null],
 ['US','2026-10-13T13:30:00Z','continuous',0],
 ['US','2026-10-14T00:00:00Z','closed',null],
 ['US','2026-11-02T14:30:00Z','continuous',0],
 ['US','2026-11-27T18:00:00Z','closed',null],
 ['US','2026-07-03T14:00:00Z','closed',null],
])('%s clock at %s matches trading validation', (market,time,phase,minute)=>{
 const clock=realMarketClock(market,new Date(time));
 expect(clock.phase).toBe(phase);expect(clock.minute).toBe(minute);
 expect(isTradingTimeFor(market,new Date(time))).toBe(phase==='continuous');
 expect(Date.parse(clock.nextOpen)).toBeGreaterThan(Date.parse(time));
});

test('exchange dates, lunch resumption and DST produce UTC candle timestamps',()=>{
 expect(realTradingTime('CN','2026-10-13',120).toISOString()).toBe('2026-10-13T05:00:00.000Z');
 expect(realTradingTime('US','2026-10-13',0).toISOString()).toBe('2026-10-13T13:30:00.000Z');
 expect(realTradingTime('US','2026-11-02',0).toISOString()).toBe('2026-11-02T14:30:00.000Z');
 expect(realMarketClock('US',new Date('2026-10-14T00:00:00Z')).date).toBe('2026-10-13');
 expect(realMarketClock('CN',new Date('2026-10-13T04:00:00Z')).status).toBe('break');
});

test('calendar migration preserves old candles and AI ledger; new bars use real dates',async()=>{
 const md=new MarketDataService(null,null,null,null,'CN');md.gameDay=35;
 const old={time:new Date('2024-02-05T02:00:00Z'),open:10,high:10,low:10,close:10,volume:5};
 const st={symbol:'T',price:10,prevClose:10,dayOpen:10,dayHigh:10,dayLow:10,dayVolume:5,
   kline1min:[],kline5min:[],klineDaily:[],current1min:{...old},current5min:{...old},currentDaily:{...old}};
 md.stocks.set('T',st);const ledger=JSON.stringify(md.aiLedger);
 await md.bindCalendarDate('2026-10-13');md.setTradingMinute(40);
 st.price=10.02;st.lastVolume=100;md.updateKlines(st);
 expect(st.kline1min[0].time).toEqual(old.time);expect(st.current1min.time.toISOString()).toBe('2026-10-13T02:10:00.000Z');
 expect(st.currentDaily.time.toISOString()).toBe('2026-10-12T16:00:00.000Z');
 expect(md.gameDay).toBe(35);expect(JSON.stringify(md.aiLedger)).toBe(ledger);
 const bar=st.current1min;await md.bindCalendarDate('2026-10-13');expect(st.current1min).toBe(bar);
});

test('native remembered login signs exactly seven days without altering default login TTL',async()=>{
 const spy=jest.spyOn(bcrypt,'compare').mockResolvedValue(true);
 try {
  const jwt=new JwtService({secret:'synthetic-test-key',signOptions:{expiresIn:'24h'}});
  const svc=new AuthService({findOne:async()=>({id:'test',username:'trader',password:'synthetic-hash',role:'user',isActive:true})},{},jwt);
  const normal=jwt.verify((await svc.login('trader','synthetic-password')).token);
  const remembered=jwt.verify((await svc.login('trader','synthetic-password','test',false,true)).token);
  expect(normal.exp-normal.iat).toBe(86400);expect(remembered.exp-remembered.iat).toBe(604800);
 } finally {spy.mockRestore();}
});
