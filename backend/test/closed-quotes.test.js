const {MarketDataService}=require('../dist/src/core/market-data/market-data.service');

function market() {
  const md=new MarketDataService(null,null,null,null,'CN');
  md.calendarState={date:'2026-10-15'};md.gameDay=38;
  const stock={symbol:'T1',market:'CN',name:'fixture',price:110,prevClose:100,prevTickPrice:110,
    dayOpen:102,dayHigh:110,dayLow:101,dayVolume:500,dayAmount:53000,lastAmount:1100,
    intrinsic:100,kline1min:[],kline5min:[],klineDaily:[],minuteCounter:239};
  md.stocks.set('T1',stock);
  for(const method of ['evolveIndustryCycles','evolveFundamentalsDaily','runMacroCalendar',
    'applyPersistentNewsImpacts','markAiEquityDaily','updateFxRate','updateMarketRegime','decayFactors'])md[method]=()=>{};
  md.randn=()=>0;
  return {md,stock};
}

test('closing preserves the completed session return and volume until the next opening',async()=>{
  const {md,stock}=market();await md.endOfDay(true);
  const quote=md.getStockList()[0];
  expect(quote.price).toBe(110);expect(quote.previousClose).toBe(100);expect(quote.changePct).toBe(10);
  expect(quote.dayVolume).toBe(500);expect(quote.dayAmount).toBe(53000);
  expect(stock.pendingCalendarPrevClose).toBe(110);
  await md.bindCalendarDate('2026-10-16');
  expect(stock.prevClose).toBe(110);expect(stock.pendingCalendarPrevClose).toBeUndefined();
  expect(stock.dayVolume).toBe(0);expect(stock.dayHigh).toBe(stock.price);
  const open=stock.price;await md.bindCalendarDate('2026-10-16');expect(stock.price).toBe(open);
});

test('overnight limits use the next session reference while the displayed close remains unchanged',async()=>{
  const {md,stock}=market();await md.endOfDay(true);md.applyCalendarNightShock(1);
  expect(stock.pendingCalendarOpen).toBeCloseTo(121);expect(stock.prevClose).toBe(100);
  expect(md.getStockList()[0].changePct).toBe(10);
  await md.bindCalendarDate('2026-10-16');expect(md.getStockList()[0].changePct).toBe(10);
});

test('runtime snapshots persist both session references for restart recovery',async()=>{
  const {md,stock}=market();let saved;md.runtimeStore={save:async(_market,state)=>{saved=state;}};
  await md.endOfDay(true);await md.persistRuntimeState(0,true);
  expect(saved.stocks.T1.prevClose).toBe(100);expect(saved.stocks.T1.pendingCalendarPrevClose).toBe(110);
  const restored=market().md;restored.restoreRuntimeState(saved);
  expect(restored.getStockList()[0].changePct).toBe(10);
  await restored.bindCalendarDate('2026-10-16');expect(restored.stocks.get('T1').prevClose).toBe(110);
});

test('old closed snapshots recover the displayed previous close from dated daily history',async()=>{
  const {md}=market();let saved;md.runtimeStore={save:async(_market,state)=>{saved=state;}};
  await md.endOfDay(true);await md.persistRuntimeState(0,true);
  delete saved.stocks.T1.pendingCalendarPrevClose;saved.stocks.T1.prevClose=110;
  const restored=market().md;
  restored.stocks.get('T1').klineDaily=[
    {time:new Date('2026-10-13T16:00:00Z'),close:100},
    {time:new Date('2026-10-14T16:00:00Z'),close:110},
  ];
  restored.restoreRuntimeState(saved);expect(restored.getStockList()[0].changePct).toBe(10);
  await restored.bindCalendarDate('2026-10-16');expect(restored.stocks.get('T1').prevClose).toBe(110);
});

test('ambiguous old history never invents a previous close during recovery',async()=>{
  const {md}=market();let saved;md.runtimeStore={save:async(_market,state)=>{saved=state;}};
  await md.endOfDay(true);await md.persistRuntimeState(0,true);
  delete saved.stocks.T1.pendingCalendarPrevClose;saved.stocks.T1.prevClose=110;
  const restored=market().md;restored.stocks.get('T1').klineDaily=[
    {time:new Date('2024-02-01T00:00:00Z'),close:100},{time:new Date('2024-02-02T00:00:00Z'),close:110}];
  restored.restoreRuntimeState(saved);expect(restored.stocks.get('T1').prevClose).toBe(110);
});
