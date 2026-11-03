const {BestQuoteOrderFlowObserver}=require('../dist/src/core/trading-engine/order-flow');
const {MatchingEngine}=require('../dist/src/core/trading-engine/matching-engine');
const book=(bp,bq,ap,aq)=>({bids:[{price:bp,size:bq}],asks:[{price:ap,size:aq}]});
test('event OFI records size changes, replacements and static QI separately',()=>{
 const observer=new BestQuoteOrderFlowObserver();expect(observer.observe('X',book(10,100,11,100)).eventCount).toBe(0);
 expect(observer.observe('X',book(10,120,11,80))).toMatchObject({eventCount:1,netOrderFlow:40,averageDepth:100,normalizedOfi:.4,queueImbalance:.2});
 const state=observer.observe('X',book(10.5,90,10.9,60));expect(state.netOrderFlow).toBe(70);
 expect(observer.observe('X',book(10.5,90,10.9,60))).toEqual(state);
});
test('rolling storage is bounded and missing-side restoration creates no artificial event',()=>{
 const observer=new BestQuoteOrderFlowObserver({window:2});observer.observe('X',book(10,100,11,100));
 for(const bidQty of [110,130,160])observer.observe('X',book(10,bidQty,11,100));
 expect(observer.get('X')).toMatchObject({eventCount:2,netOrderFlow:50});
 expect(observer.observe('X',{bids:[],asks:[]})).toMatchObject({available:false,eventCount:2,netOrderFlow:50});
 expect(observer.observe('X',book(9,500,12,300))).toMatchObject({available:true,eventCount:2,netOrderFlow:50});
 observer.forget('X');expect(observer.get('X').eventCount).toBe(0);
});
test('rejected and rolled-back executions do not fabricate order flow',()=>{
 const m=new MatchingEngine();m.prices.set('U1',10);m.orderBooks.set('U1',book(9.99,100,10.01,100));
 m.placeVirtualOrder('U1','sell',10.01,10,100);const before=m.getOrderFlow('U1');
 expect(m.executeMarketOrderLimited('U1','buy',1000,11,'buyer',{requireFull:true})).toBeNull();expect(m.getOrderFlow('U1')).toEqual(before);
 const fill=m.executeMarketOrder('U1','buy',20,'buyer',{deferVirtualFills:true});m.rollbackExecution(fill);expect(m.getOrderFlow('U1')).toEqual(before);
 const fill2=m.executeMarketOrder('U1','buy',20,'buyer',{deferVirtualFills:true});m.commitExecution(fill2);expect(m.getOrderFlow('U1').netOrderFlow).toBe(20);
});
