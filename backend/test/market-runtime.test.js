const Database=require('better-sqlite3');
const {MarketRuntimeStore}=require('../dist/src/core/market-data/runtime-state');
const {MarketDataService}=require('../dist/src/core/market-data/market-data.service');
const {aiEntryScore}=require('../dist/src/core/market-data/ai-risk-policy');

test('SQLite restart retains actual AI cash, cost, loss, risk cooldown and market clock',async()=>{
 const db=new Database(':memory:');
 const manager={query:async(sql,params=[])=>{const q=db.prepare(sql);return q.reader?q.all(...params):q.run(...params);}};
 const a=new MarketDataService(null,null,null,null,'CN');
 a.runtimeStore=new MarketRuntimeStore(manager);a.gameDay=40;a.tickCount=999;
 a.stocks.set('TEST',{symbol:'TEST',price:90,prevClose:100,dayOpen:100,dayHigh:100,dayLow:90,intrinsic:100,
 minuteCounter:123,kline1min:[{time:new Date(2024,1,10),open:91,high:91,low:90,close:90,volume:12}],current1min:null,current5min:null,currentDaily:null});
 Object.assign(a.stocks.get('TEST'),{volumeState:{shock:.25},eventVolumeState:{boost:1.84,remaining:12},lastAmount:1234,dayAmount:5678});
 const l=a.aiLedger[0];l.cash-=10000;l.positions.set('TEST',{qty:100,cost:100});l.fills=3;
 l.riskRecovery={resumeDay:42,anchor:l.cash+900};l.entryTicks={TEST:995};
 l.restingOrders=[{side:'buy',qty:4,price:90}];
 await a.persistRuntimeState(123,true);
 const saved=await new MarketRuntimeStore(manager).load('CN');
 const b=new MarketDataService(null,null,null,null,'CN');b.gameDay=40;
 b.stocks.set('TEST',{price:100,kline1min:[]});b.restoreRuntimeState(saved);
 expect(b.aiLedger[0].cash).toBe(l.cash);expect(b.aiLedger[0].initialCash).toBe(l.initialCash);
 expect(b.aiLedger[0].positions.get('TEST')).toEqual({qty:100,cost:100});
 expect(b.aiLedger[0].riskRecovery).toEqual(l.riskRecovery);expect(b.aiLedger[0].entryTicks).toEqual(l.entryTicks);
 expect(b.aiLedger[0].restingOrders).toEqual([]);expect(b.aiLedger[0].fills).toBe(3);
 expect(b.getResumeCounter()).toBe(123);expect(b.tickCount).toBe(999);
 expect(b.stocks.get('TEST').volumeState).toEqual({shock:.25});
 expect(b.stocks.get('TEST').eventVolumeState).toEqual({boost:1.84,remaining:12});
 expect(b.stocks.get('TEST').dayAmount).toBe(5678);
 expect(b.stocks.get('TEST').price).toBe(90);expect(b.stocks.get('TEST').kline1min[0].time).toBeInstanceOf(Date);
 expect(b.getAiOpponents().find(row=>row.id==='AI1').pnlPct).toBeLessThan(0);
 const invalid={...saved,market:'HK'};expect(()=>b.restoreRuntimeState(invalid)).toThrow();
 expect(b.aiLedger[0].cash).toBe(l.cash);db.close();
});

test('expensive trend entry needs completed, moderate momentum; value strategies still reject it',()=>{
 const st={price:201,intrinsic:50,kline1min:Array.from({length:90},(_,i)=>({close:198+i*.03}))};
 expect(aiEntryScore('momentum',st,{ret:.02,ofi:.2},true)).toBeGreaterThan(0);
 expect(aiEntryScore('meanrev',st,{ret:-.01,ofi:.2},true)).toBe(-Infinity);
 st.price=220;expect(aiEntryScore('momentum',st,{ret:.1,ofi:.2},true)).toBe(-Infinity);
 st.price=180;expect(aiEntryScore('momentum',st,{ret:-.02,ofi:.2},true)).toBe(-Infinity);
});
