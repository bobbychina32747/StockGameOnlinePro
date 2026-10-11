const {STOCK_POOL,HK_POOL,US_POOL}=require('../dist/src/common/constants');
const {symbolMarket}=require('../dist/src/common/market-utils');
const {unifiedInstruments,calibratedShock}=require('../dist/src/common/unified-market');
const {AccountService}=require('../dist/src/modules/account/account.service');
const {DebugModeService}=require('../dist/src/common/debug-mode/debug-mode.service');
describe('统一正式版：原账本与校准股票池',()=>{
 test('正式模型与独立研究引擎使用相同版本的行业目录和日内校准参数',()=>{
  expect(require('../src/common/unified-catalog.json')).toEqual(require('../../remaster/packages/domain/catalog.json'));
  expect(require('../src/common/unified-intraday.json')).toEqual(require('../../remaster/packages/domain/intraday-calibration.json'));
 });
 test('连续模拟只由显式部署配置开启，保留默认真实交易时段',()=>{
  expect(new DebugModeService().getGlobalBypass()).toBe(false);
  const mode=new DebugModeService({get:()=> 'true'});expect(mode.getGlobalBypass()).toBe(true);expect(mode.canBypassHours('fixture-player')).toBe(true);
 });
 test('每区至少138支、23个基础行业各6支；新增代码仍受原交易引擎跨市场闸门保护',()=>{
  for(const [market,pool]of [['CN',STOCK_POOL],['HK',HK_POOL],['US',US_POOL]]){
   expect(pool.length).toBeGreaterThanOrEqual(138);expect(new Set(pool.map(row=>row.symbol)).size).toBe(pool.length);
   const sectors=new Map();for(const row of unifiedInstruments.values())if(row.market===market){expect(symbolMarket(row.symbol)).toBe(market);sectors.set(row.industry,(sectors.get(row.industry)||0)+1);}
   expect(sectors.size).toBe(23);expect([...sectors.values()].every(count=>count===6)).toBe(true);
  }
  expect(STOCK_POOL.some(row=>row.symbol==='T1')).toBe(true);expect(HK_POOL.some(row=>row.symbol==='H1')).toBe(true);
 });
 test('校准模型生成不等幅的分钟冲击，且负冲击后条件波动率更高',()=>{
  let seed=1234;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return(seed+1)/4294967297;};
  const normal=()=>Math.sqrt(-2*Math.log(random()))*Math.cos(2*Math.PI*random());
  const row={symbol:'T1',minuteCounter:0};const values=[];
  for(let i=0;i<4000;i++){row.minuteCounter=i%240;values.push(calibratedShock(row,normal,240,'CN',normal(),normal()));}
  expect(values.every(Number.isFinite)).toBe(true);expect(new Set(values).size).toBeGreaterThan(3900);
  const sorted=values.map(Math.abs).sort((a,b)=>a-b);expect(sorted[3990]/sorted[2000]).toBeGreaterThan(4);
  const positive={symbol:'T1',minuteCounter:100,calibratedVariance:{variance:1,shock:3}};
  const negative={symbol:'T1',minuteCounter:100,calibratedVariance:{variance:1,shock:-3}};
  calibratedShock(positive,normal,240,'CN',0,0);calibratedShock(negative,normal,240,'CN',0,0);
  expect(negative.calibratedVariance.variance).toBeGreaterThan(positive.calibratedVariance.variance);
 });
 test('只读账本快照保留所有挂单，包括300条历史窗口之外的挂单；不调用save',async()=>{
  const account={id:'old-account',cash:12345.67,borrowed:10.01};const positions=[{symbol:'T1',longQty:100,shortQty:0,longCost:10}];
  const holding={fundId:'fund-2',shares:12.12345678,totalInvested:12,firstBuyDay:10};const pending=Array.from({length:310},(_,i)=>({id:'old-'+i,status:'pending'}));
  const noWrite=()=>{throw Error('Unexpected ledger write');};const repo=(value)=>({find:async()=>value,save:noWrite});
  const accountRepo={findOne:async()=>account,find:async()=>[account],save:noWrite};let calls=0;
  const orders={find:async()=>++calls===1?pending.slice(0,300):pending,save:noWrite};
  const risk={getEquityHistory:()=>[{day:10,equity:10000}],calculateMetrics:async()=>({}),getReviews:()=>[]};
  const engine={runExclusive:fn=>fn(),prices:new Map([['T1',12.3456]])};
  const service=new AccountService(accountRepo,repo(positions),repo([]),repo([holding]),orders,repo([]),risk,engine,{},repo([]),{});
  const view=await service.getUnifiedLedger('fixture-user','CN');expect(view.account).toBe(account);expect(view.funds[0]).toEqual(holding);
  expect(view.orders.length).toBe(310);expect(view.positions).toBe(positions);expect(view.positionValue).toBeCloseTo(1234.56);
  await expect(service.getUnifiedLedger('fixture-user','XX')).rejects.toThrow('区服');
 });
});
