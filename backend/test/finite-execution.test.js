const { MatchingEngine } = require('../dist/src/core/trading-engine/matching-engine');
const { planFiniteExecution } = require('../dist/src/core/trading-engine/finite-execution');

const resting = (id, price, qty, time = 1, extra = {}) => ({orderId:id,accountId:id,side:'sell',price,qty,time,...extra});
const plan = overrides => planFiniteExecution({side:'buy',quantity:100,resting:[],external:[],...overrides});

describe('Finite depth planner', () => {
  test('fills consume only the supplied quantities, with exact cent notional', () => {
    const input={external:[{price:10.01,size:20},{price:10.02,size:30}]};const before=JSON.stringify(input);
    const result=plan(input);expect(result.filled).toBe(50);expect(result.remaining).toBe(50);
    expect(result.totalCost).toBe(500.8);expect(result.slices.reduce((n,s)=>n+s.quantity,0)).toBe(50);
    expect(JSON.stringify(input)).toBe(before);
  });
  test('real and external orders share price priority rather than real-first priority', () => {
    const result=plan({resting:[resting('expensive',10.10,100)],external:[{price:10.01,size:100}]});
    expect(result.slices).toHaveLength(1);expect(result.slices[0].source).toBe('external');
    expect(result.restingAfter[0].qty).toBe(100);expect(result.totalCost).toBe(1001);
  });
  test('iceberg reveal goes behind every existing same-price queue entry', () => {
    const result=plan({quantity:70,resting:[resting('ice',10,20,1,{displayQty:20,hiddenQty:100}),resting('next',10,30,2)],external:[{price:10,size:10,time:3,sequence:999}]});
    expect(result.slices.map(s=>[s.order?.orderId??'external',s.quantity])).toEqual([['ice',20],['next',30],['external',10],['ice',10]]);
    expect(result.restingAfter[0]).toMatchObject({orderId:'ice',qty:10,hiddenQty:80});
    expect(result.restingAfter[0].sequence).toBeGreaterThan(999);
  });
  test('limits, self exclusion, short/cover direction and slice caps are explicit', () => {
    const r=plan({resting:[resting('self',10,100)],excludeAccountId:'self',external:[{price:10.01,size:20},{price:10.02,size:30}],limitPrice:10.01});
    expect(r.filled).toBe(20);expect(r.restingAfter[0].qty).toBe(100);
    const sell=plan({side:'short',external:[{price:9.99,size:50},{price:10,size:50}]});expect(sell.slices[0].price).toBe(10);
    const cap=plan({external:[{price:10,size:20},{price:11,size:30}],maxSlices:1});expect(cap.filled).toBe(20);expect(cap.truncated).toBe(true);
    expect(plan({quantity:20,external:[{price:10,size:20}],maxSlices:1}).truncated).toBe(false);
  });
  test('invalid inputs cannot mutate a book or poison notional arithmetic', () => {
    for(const quantity of [NaN,Infinity,-1,1.5])expect(()=>plan({quantity})).toThrow(RangeError);
    expect(()=>plan({external:[{price:Infinity,size:10}]})).toThrow(RangeError);
    expect(()=>plan({external:[{price:1e12,size:1e9}]})).toThrow(RangeError);
    expect(()=>plan({resting:[resting('hidden',10,0,1,{hiddenQty:5})]})).toThrow(RangeError);
  });
});

function fixture(){const m=new MatchingEngine();m.prices.set('U1',10);m.orderBooks.set('U1',{bids:[{price:9.99,size:40}],asks:[{price:10.01,size:20},{price:10.02,size:30}]});return m;}
describe('Finite live matching',()=>{
  test('repeated orders cannot reuse depleted synthetic quotes',()=>{
    const m=fixture();const first=m.executeMarketOrder('U1','buy',40);
    expect(first.filledQuantity).toBe(40);expect(first.remainingQuantity).toBe(0);
    expect(m.getOrderBook('U1').asks).toEqual([{price:10.02,size:10}]);
    const second=m.executeMarketOrder('U1','buy',40);expect(second.filledQuantity).toBe(10);expect(second.remainingQuantity).toBe(30);
    expect(m.executeMarketOrder('U1','buy',1)).toBeNull();
  });
  test('a known reference price never manufactures liquidity in an empty book',()=>{
    const m=new MatchingEngine();m.prices.set('U1',10);expect(m.executeMarketOrder('U1','buy',1)).toBeNull();
    m.orderBooks.set('U1',{bids:[],asks:[]});expect(m.executeMarketOrderLimited('U1','buy',100,11)).toBeNull();
  });
  test('a non-mutating quote reports the same quantity, notional and cost as execution',()=>{
    const m=fixture();m.placeRestingOrder('U1','far','seller','sell',10.10,10);
    const before=JSON.stringify(m.getOrderBook('U1'));const quote=m.previewMarketOrder('U1','buy',100);
    expect(JSON.stringify(m.getOrderBook('U1'))).toBe(before);const fill=m.executeMarketOrder('U1','buy',100);
    expect(quote.filledQuantity).toBe(fill.filledQuantity);expect(quote.totalCost).toBe(fill.totalCost);
    expect(fill.execution.model).toBe('finite-depth-v1');expect(fill.execution.priceImpactBps).toBeGreaterThan(0);
  });
  test('FOK rejection leaves depth and all virtual counterparties untouched',()=>{
    const m=fixture(),hook=jest.fn();m.setVirtualFillHook(hook);m.placeVirtualOrder('U1','sell',10,10,100,{tag:'AI1'});
    const before=JSON.stringify([...m.realBooks]);const depth=JSON.stringify([...m.orderBooks]);
    expect(m.executeMarketOrderLimited('U1','buy',100,11,'buyer',{requireFull:true,deferVirtualFills:true})).toBeNull();
    expect(JSON.stringify([...m.realBooks])).toBe(before);expect(JSON.stringify([...m.orderBooks])).toBe(depth);expect(hook).not.toHaveBeenCalled();
  });
  test('failed settlement restores exact iceberg and synthetic depth without fictitious AI profits',()=>{
    const m=fixture(),hook=jest.fn();m.setVirtualFillHook(hook);m.placeVirtualOrder('U1','sell',10,10,100,{tag:'AI1'});
    m.placeRestingOrder('U1','ice','seller','sell',10.01,100,{displayQty:10,hiddenQty:90});
    const before=JSON.stringify([...m.realBooks]);const depth=JSON.stringify([...m.orderBooks]);
    const fill=m.executeMarketOrder('U1','buy',45,'buyer',{deferVirtualFills:true});expect(hook).not.toHaveBeenCalled();
    expect(m.rollbackExecution(fill)).toBe(true);expect(m.rollbackExecution(fill)).toBe(false);
    expect(JSON.stringify([...m.realBooks])).toBe(before);expect(JSON.stringify([...m.orderBooks])).toBe(depth);expect(hook).not.toHaveBeenCalled();
  });
  test('successful settlement emits virtual hooks exactly once and releases queued quote updates',()=>{
    const m=fixture(),hook=jest.fn();m.setVirtualFillHook(hook);m.placeVirtualOrder('U1','sell',10,10,100,{tag:'AI1'});
    const fill=m.executeMarketOrder('U1','buy',10,'buyer',{deferVirtualFills:true});
    m.placeRestingOrder('U1','queued','seller','sell',10.5,15);
    expect(m.executeMarketOrder('U1','buy',1)).toBeNull();expect(m.realBooks.get('U1').asks.some(o=>o.orderId==='queued')).toBe(false);
    expect(m.commitExecution(fill)).toBe(true);expect(m.commitExecution(fill)).toBe(false);expect(hook).toHaveBeenCalledTimes(1);
    expect(m.realBooks.get('U1').asks.some(o=>o.orderId==='queued')).toBe(true);
  });
  test('splitting without quote replenishment cannot conjure cheaper or additional liquidity',()=>{
    const lump=fixture(),split=fixture();
    const single=lump.executeMarketOrder('U1','buy',100);const a=split.executeMarketOrder('U1','buy',25),b=split.executeMarketOrder('U1','buy',75);
    expect(a.filledQuantity+b.filledQuantity).toBe(single.filledQuantity);
    expect(a.totalCost+b.totalCost).toBeCloseTo(single.totalCost,2);expect(split.executeMarketOrder('U1','buy',1)).toBeNull();
  });
  test('execution impact uses the best eligible price and excludes self quotes',()=>{
    const m=fixture();m.placeRestingOrder('U1','self','buyer','sell',9.9,100);
    const result=m.executeMarketOrder('U1','buy',10,'buyer');expect(result.execution.touchPrice).toBe(10.01);
    expect(result.execution.priceImpactBps).toBe(0);expect(m.realBooks.get('U1').asks[0].qty).toBe(100);
  });
  test('new arrivals in the same millisecond remain behind a replenished iceberg slice',()=>{
    const clock=jest.spyOn(Date,'now').mockReturnValue(1000);
    try {
      const m=new MatchingEngine();m.placeRestingOrder('U1','ice','seller','sell',10,30,{displayQty:10,hiddenQty:20});
      m.executeMarketOrder('U1','buy',10,'buyer');
      m.placeRestingOrder('U1','later','other-seller','sell',10,10);
      const next=m.executeMarketOrder('U1','buy',10,'buyer');expect(next.counterFills[0].orderId).toBe('ice');
    } finally {clock.mockRestore();}
  });
});
