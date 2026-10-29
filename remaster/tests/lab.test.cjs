const {test}=require('node:test');
const assert=require('node:assert/strict');
const {FiniteOrderBook}=require('../dist/packages/engine/lab-book');
const {eventOFI,calculateLabMetrics,compareLabReports}=require('../dist/packages/engine/lab-metrics');
const {runLab,replayLab,exportLab,verifyLabExport,LAB_DEFAULTS,normalizeLabConfig,plannedSlices}=require('../dist/packages/engine/lab');

const account=(id,cash=10000000,inventory=1000,role='noise')=>({id,role,cash,inventory,initialCash:cash,initialInventory:inventory,targetInventory:inventory});
let sequence=0;
const order=(actor,side,quantity,price,id)=>({kind:'order',sequence:++sequence,tick:0,actor,id:id??`test-${sequence}`,side,quantity,...(price===undefined?{}:{price})});
function conservation(book){
 const a=book.getAccounts();
 assert.ok(a.every(x=>Number.isSafeInteger(x.cash)&&x.cash>=0&&Number.isSafeInteger(x.inventory)&&x.inventory>=0));
 assert.equal(a.reduce((n,x)=>n+x.cash,book.getFeePool()),a.reduce((n,x)=>n+x.initialCash,0));
 assert.equal(a.reduce((n,x)=>n+x.inventory,0),a.reduce((n,x)=>n+x.initialInventory,0));
}
test('laboratory finite book consumes actual FIFO depth and cannot fill an empty book',()=>{
 const b=new FiniteOrderBook([account('s1'),account('s2'),account('buyer')],0);
 b.submit(order('s1','sell',20,10001));b.submit(order('s2','sell',30,10001));
 const fill=b.submit(order('buyer','buy',70));
 assert.deepEqual(fill.trades.map(t=>[t.seller,t.quantity,t.price]),[['s1',20,10001],['s2',30,10001]]);
 assert.equal(fill.filled,50);assert.equal(fill.unfilled,20);assert.equal(fill.resting,0);
 assert.equal(b.submit(order('buyer','buy',1)).filled,0);assert.equal(b.snapshot().ask,null);
 conservation(b);
});
test('laboratory reservations, fees, cancellations and self-trade protection conserve resources',()=>{
 const b=new FiniteOrderBook([account('a',100100,20),account('b',1000000,50)]);
 const first=order('a','buy',10,10000);assert.equal(b.submit(first).resting,10);
 assert.equal(b.submit(order('a','buy',1,10000)).filled,0);
 assert.equal(b.getOrders('a').length,1);
 assert.equal(b.cancel('b',first.id),0);assert.equal(b.cancel('a',first.id),10);
 b.submit(order('a','sell',15,10000));
 const self=b.submit(order('a','buy',10));assert.equal(self.filled,0);assert.equal(self.resting,0);
 const oversell=b.submit(order('a','sell',6));assert.equal(oversell.filled,0);
 const fill=b.submit(order('b','buy',30));assert.equal(fill.filled,15);
 assert.equal(fill.trades[0].buyerFee,75);assert.equal(fill.trades[0].sellerFee,75);
 assert.equal(b.getFeePool(),150);conservation(b);
});
test('laboratory fee rounding cannot overspend across fragmented fills; getters do not leak mutation',()=>{
 const b=new FiniteOrderBook([account('a',202,0),account('b',0,1),account('c',0,1)],5);
 b.submit(order('b','sell',1,100));b.submit(order('c','sell',1,100));
 const r=b.submit(order('a','buy',3));assert.equal(r.filled,2);assert.equal(r.unfilled,1);
 assert.equal(b.getAccounts().find(a=>a.id==='a').cash,0);conservation(b);
 const copy=b.getAccounts();copy[0].cash=999;assert.notEqual(b.getAccounts()[0].cash,999);
 const trades=b.getTrades();trades[0].price=999;assert.equal(b.getTrades()[0].price,100);
});
test('laboratory malformed orders leave the book unchanged',()=>{
 const b=new FiniteOrderBook([account('a'),account('b')]);b.submit(order('a','sell',10,10000));
 const before=JSON.stringify([b.getAccounts(),b.getOrders(),b.getTrades()]);
 for(const bad of [{quantity:NaN},{quantity:-1},{quantity:1.5},{price:Infinity},{price:0},{actor:'missing'},{side:'short'},{sequence:NaN}]){
  const r=b.submit({...order('b','buy',1,10000),...bad});assert.equal(r.filled,0);
  assert.equal(JSON.stringify([b.getAccounts(),b.getOrders(),b.getTrades()]),before);
 }
 assert.throws(()=>new FiniteOrderBook([account('a'),account('a')]));
});
test('event OFI counts queue additions and cancellations separately from static imbalance',()=>{
 const b=new FiniteOrderBook([account('a'),account('b')],0);const empty=b.snapshot();
 const bid=order('a','buy',20,9900);b.submit(bid);const bids=b.snapshot();assert.equal(eventOFI(empty,bids),20);
 b.submit(order('b','sell',30,10100));const both=b.snapshot();assert.equal(eventOFI(bids,both),-30);
 b.cancel('a',bid.id);assert.equal(eventOFI(both,b.snapshot()),-20);
});
test('best-level quantities and every quote change are tracked when a market order sweeps levels',()=>{
 let flow=0;const b=new FiniteOrderBook([account('a'),account('b')],0,(before,after)=>{flow+=eventOFI(before,after);});
 b.submit(order('a','sell',20,10000));b.submit(order('a','sell',30,10001));
 assert.equal(b.snapshot().askSize,20);assert.equal(b.snapshot().asks.reduce((n,x)=>n+x.quantity,0),50);
 flow=0;b.submit(order('b','buy',50));assert.equal(flow,50);
 assert.throws(()=>b.snapshot(NaN));assert.throws(()=>b.snapshot(0));
});
test('fully filled and cancelled order identifiers cannot be replayed as new orders',()=>{
 const b=new FiniteOrderBook([account('a'),account('b')],0);
 const first=order('a','sell',10,10000);b.submit(first);b.submit(order('b','buy',10));
 assert.equal(b.submit({...first,sequence:++sequence}).resting,0);
 const second=order('a','buy',10,9900);b.submit(second);b.cancel('a',second.id);
 assert.equal(b.submit({...second,sequence:++sequence}).resting,0);
});
test('execution schedules submit exactly the target without consulting future volume',()=>{
 for(const side of ['buy','sell'])for(const quantity of [1,13,3000,20000])for(const policy of ['lump','twap','vwap']){
  const c=normalizeLabConfig({side,quantity});const slices=plannedSlices(c,policy);
  assert.equal([...slices.values()].reduce((a,b)=>a+b,0),quantity);
  assert.ok([...slices].every(([tick,q])=>tick>=Math.floor(c.ticks*.2)&&tick<Math.floor(c.ticks*.7)&&Number.isInteger(q)&&q>0));
 }
 assert.throws(()=>normalizeLabConfig({ticks:Infinity}));assert.throws(()=>normalizeLabConfig({seed:-1}));assert.throws(()=>normalizeLabConfig({quantity:20001}));
});
test('buy and sell shortfall examples include fees and the cost of the unfilled target',()=>{
 const point=(tick,mid)=>({tick,mid,last:mid,fundamental:mid,publicValue:mid,bid:mid-10,ask:mid+10,spread:20,bidDepth:100,askDepth:100,imbalance:0,ofi:0,volume:0,twoSided:true,makerInventory:0});
 for(const [side,fillPrice,fee,terminal,expected] of [['buy',10100,101,11000,821.01],['sell',9900,99,9000,820.99]]){
  const config={...LAB_DEFAULTS,ticks:60,quantity:100,side};
  const trade={id:'hand-example',tick:12,sequence:1,price:fillPrice,quantity:20,buyer:side==='buy'?'parent':'other',seller:side==='buy'?'other':'parent',buyerFee:fee,sellerFee:fee,aggressor:'parent',restingOrder:'example'};
  const m=calculateLabMetrics(config,'lump',[point(11,10000),point(59,terminal)],[trade],[account('parent',10000000,100,'parent'),account('other')]);
  assert.equal(m.filled,20);assert.equal(m.fillRatio,.2);assert.equal(m.fees,fee);
  assert.ok(Math.abs(m.opportunityCostBps-800)<1e-9);assert.ok(Math.abs(m.implementationShortfallBps-expected)<1e-9);
 }
});
test('a deterministic mixed-order stream never spends reserved cash or reserved stock',()=>{
 const accounts=Array.from({length:5},(_,i)=>account('agent-'+i,1000000,100));const b=new FiniteOrderBook(accounts);
 let state=4271;const next=()=>state=(Math.imul(state,1664525)+1013904223)>>>0;
 for(let i=0;i<1000;i++){
  const actor='agent-'+next()%5,existing=b.getOrders(actor);
  if(i%5===0&&existing.length)b.cancel(actor,existing[0].id);
  else b.submit(order(actor,next()%2?'buy':'sell',1+next()%50,next()%3?9500+next()%1000:undefined));
  conservation(b);
  const orders=b.getOrders();for(const a of b.getAccounts()){
   const own=orders.filter(o=>o.actor===a.id);
   assert.ok(own.filter(o=>o.side==='sell').reduce((n,o)=>n+o.remaining,0)<=a.inventory);
   assert.ok(own.filter(o=>o.side==='buy').reduce((n,o)=>n+o.remaining*(o.price+Math.ceil(o.price*5/10000)),0)<=a.cash);
  }
 }
});

let cached;
const fixture=()=>cached??=runLab({...LAB_DEFAULTS,ticks:90});
test('same seed reproduces every event, ledger entry, metric and SHA-256; a different seed changes paths',async()=>{
 const a=await fixture(),b=await runLab(a.config),c=await runLab({...a.config,seed:a.config.seed+1});
 assert.deepEqual(a,b);assert.notEqual(a.reports.baseline.digest,c.reports.baseline.digest);
 assert.ok(Object.values(a.reports).every(r=>/^[a-f0-9]{64}$/.test(r.digest)));
});
test('recorded events mechanically replay to the same complete reports; exports reject tampering',async()=>{
 const a=await fixture(),file=JSON.parse(JSON.stringify(exportLab(a)));
 assert.deepEqual(await verifyLabExport(file),a);
 for(const r of Object.values(a.reports))assert.deepEqual(await replayLab(r.tape),r);
 file.tapes.lump.events.find(e=>e.kind==='order').quantity++;
 await assert.rejects(()=>verifyLabExport(file),/LAB_DIGEST/);
 const broken=JSON.parse(JSON.stringify(a.reports.baseline.tape));broken.events[0].sequence=2;
 await assert.rejects(()=>replayLab(broken),/LAB_SEQUENCE/);
 broken.version='future-version';await assert.rejects(()=>replayLab(broken),/LAB_VERSION/);
});
test('private and delayed public paths are shared across policies and never set the transaction price directly',async()=>{
 const result=await fixture();const base=result.reports.baseline;
 for(const r of Object.values(result.reports)){
  assert.deepEqual(r.points.map(p=>p.fundamental),base.points.map(p=>p.fundamental));
  assert.deepEqual(r.points.map(p=>p.publicValue),base.points.map(p=>p.publicValue));
  r.points.forEach((p,i)=>assert.equal(p.publicValue,i<r.config.informationDelay?10000:r.points[i-r.config.informationDelay].fundamental));
  const submitted=new Map();
  for(const e of r.tape.events)if(e.kind==='order')submitted.set(e.id,e);
  for(const t of r.trades){const resting=submitted.get(t.restingOrder);assert.ok(resting);assert.equal(t.price,resting.price);}
  assert.equal(r.accounts.reduce((n,a)=>n+a.cash,r.feePool),r.accounts.reduce((n,a)=>n+a.initialCash,0));
  assert.equal(r.accounts.reduce((n,a)=>n+a.inventory,0),r.accounts.reduce((n,a)=>n+a.initialInventory,0));
  assert.ok(r.accounts.every(a=>a.cash>=0&&a.inventory>=0));
  assert.equal(r.points.reduce((n,p)=>n+p.volume,0),r.trades.reduce((n,t)=>n+t.quantity,0));
 }
 assert.ok(result.reports.lump.metrics.filled<result.config.quantity);
 assert.equal(base.metrics.filled,0);assert.equal(base.metrics.executionCostBps,null);
});
test('thin, sell-side and maximum-size experiments remain finite; unfilled shares affect shortfall',async()=>{
 const r=await runLab({seed:0,ticks:60,quantity:20000,side:'sell',quoteSize:10,replenishEvery:30,informedCount:0,newsJumpBps:-300});
 assert.equal(r.reports.lump.metrics.fillRatio<1,true);
 assert.ok(!JSON.stringify(r).includes('null,"implementationShortfallBps":null'));
 for(const report of Object.values(r.reports)){
  const m=report.metrics;assert.ok(Number.isFinite(m.implementationShortfallBps));assert.ok(m.filled<=m.requested);
  if(m.filled)assert.ok(Math.abs(m.implementationShortfallBps-(m.executionCostBps*m.fillRatio+m.opportunityCostBps))<1e-8);
 }
});
test('sparse metrics expose missing observations instead of fabricated correlations',()=>{
 const m=calculateLabMetrics({...LAB_DEFAULTS},'baseline',[],[],[]);
 assert.equal(m.averagePrice,null);assert.equal(m.marketVwap,null);assert.equal(m.ofiReturnCorrelation,null);
 assert.equal(m.absoluteReturnAutocorrelation,null);assert.equal(m.averageSpreadBps,null);
 assert.ok(m.roleMarkouts.every(r=>r.fiveTickMarkoutBps===null));
 const reports=Object.fromEntries(['baseline','lump','twap','vwap'].map(p=>[p,{config:LAB_DEFAULTS,points:[]}]));
 assert.ok(compareLabReports(reports).every(c=>c.peakImpactBps===null&&c.terminalImpactBps===null&&c.recoveryHalfLifeTicks===null));
});
test('replay rejects extra fields, missing samples, malformed actors and oversized tapes',async()=>{
 const r=await fixture();const fresh=()=>JSON.parse(JSON.stringify(r.reports.lump.tape));
 let tape=fresh();tape.config.constructor='unexpected';await assert.rejects(()=>replayLab(tape),/LAB_FIELDS/);
 tape=fresh();tape.events.pop();await assert.rejects(()=>replayLab(tape),/LAB_SEQUENCE/);
 tape=fresh();tape.events.find(e=>e.kind==='order').actor='live-player';await assert.rejects(()=>replayLab(tape),/LAB_ACTOR/);
 tape=fresh();tape.events=new Array(20001).fill(tape.events[0]);await assert.rejects(()=>replayLab(tape),/LAB_EVENTS/);
 tape=fresh();delete tape.config.seed;await assert.rejects(()=>replayLab(tape),/LAB_CONFIG/);
});
