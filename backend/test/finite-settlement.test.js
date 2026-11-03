require('reflect-metadata');
const {DataSource}=require('typeorm');
const {TradingEngineService}=require('../dist/src/core/trading-engine/trading-engine.service');
const {OrderService}=require('../dist/src/modules/trading/order.service');
const {MarketDataService}=require('../dist/src/core/market-data/market-data.service');
const entities=Object.fromEntries(['User','Account','Position','Order','Transaction','DividendSnapshot'].map(name=>{
  const file=name.replace(/[A-Z]/g,(c,i)=>(i?'-':'')+c.toLowerCase());
  return [name,require('../dist/src/infrastructure/database/entities/'+file+'.entity')[name]];
}));
const {User,Account,Position,Order,Transaction,DividendSnapshot}=entities;

describe('Finite execution with a real transactional ledger',()=>{
  let db,engine,accounts,positions,orders,transactions,virtualHook,marketHook;
  beforeEach(async()=>{
    db=await new DataSource({type:'sqljs',entities:Object.values(entities),synchronize:true,logging:false}).initialize();
    await db.getRepository(User).save([{id:'buyer-user',username:'synthetic-buyer',password:'synthetic-hash'},
      {id:'seller-user',username:'synthetic-seller',password:'synthetic-hash'}]);
    accounts=db.getRepository(Account);positions=db.getRepository(Position);orders=db.getRepository(Order);transactions=db.getRepository(Transaction);
    await accounts.save([{id:'buyer',userId:'buyer-user',marketMode:'US',cash:100000},
      {id:'seller',userId:'seller-user',marketMode:'US',cash:100000}]);
    await positions.save({id:'seller-position',accountId:'seller',symbol:'U1',longQty:1000,longCost:10});
    engine=new TradingEngineService(orders,accounts,positions,transactions,db.getRepository(DividendSnapshot));
    engine.prices.set('U1',10);
    virtualHook=jest.fn();marketHook=jest.fn();engine.setVirtualFillHook(virtualHook);engine.setUserFillHook(marketHook);
  });
  afterEach(async()=>{await db.destroy();});
  const submit=async(overrides={})=>engine.submitOrder({userId:'buyer-user',accountId:'buyer',symbol:'U1',type:'market',side:'buy',quantity:100,...overrides},await accounts.findOneBy({id:'buyer'}));
  const sellerOrder=async(qty=100,price=10)=>{
    await orders.save({id:'ask',userId:'seller-user',accountId:'seller',symbol:'U1',type:'limit',side:'sell',quantity:qty,price,status:'pending',filledQty:0});
    engine.placeRestingOrder('U1','ask','seller','sell',price,qty);
  };
  test('real counterpart shares and notional balance; the print is published once',async()=>{
    await sellerOrder();const result=await submit();expect(result.success).toBe(true);
    expect((await accounts.findOneBy({id:'buyer'})).cash).toBe(99000);
    const seller=await accounts.findOneBy({id:'seller'});expect(seller.cash).toBeCloseTo(101000-result.settle.fees.totalFees-engine.calcFees('sell',1000,100,'US').totalFees,2);
    expect((await positions.findOneBy({accountId:'buyer',symbol:'U1'})).longQty).toBe(100);
    expect((await positions.findOneBy({accountId:'seller',symbol:'U1'})).longQty).toBe(900);
    expect((await orders.findOneBy({id:'ask'})).status).toBe('filled');expect(await transactions.count()).toBe(2);
    expect(marketHook).toHaveBeenCalledTimes(1);expect((await orders.findOneBy({accountId:'buyer'})).filledQty).toBe(100);
  });
  test('a failed counterparty rolls back the taker, both orders and the entire book',async()=>{
    await sellerOrder();await positions.update({id:'seller-position'},{longQty:0});
    const before=JSON.stringify([...engine.realBooks]);const result=await submit();expect(result.success).toBe(false);
    expect(result.error).toContain('持仓不足');expect(await transactions.count()).toBe(0);
    expect((await accounts.findOneBy({id:'buyer'})).cash).toBe(100000);expect(await positions.countBy({accountId:'buyer'})).toBe(0);
    expect((await orders.findOneBy({id:'ask'})).filledQty).toBe(0);expect(await orders.countBy({accountId:'buyer'})).toBe(0);
    expect(JSON.stringify([...engine.realBooks])).toBe(before);expect(marketHook).not.toHaveBeenCalled();
  });
  test('an injected database write failure restores virtual depth and publishes no profits',async()=>{
    engine.placeVirtualOrder('U1','sell',10,100,100,{tag:'synthetic-ai'});
    const before=JSON.stringify([...engine.realBooks]);
    await db.query("CREATE TRIGGER injected_failure BEFORE INSERT ON transactions BEGIN SELECT RAISE(ABORT,'injected write failure'); END");
    const failed=await submit();expect(failed.success).toBe(false);expect(failed.error).toContain('injected write failure');
    expect((await accounts.findOneBy({id:'buyer'})).cash).toBe(100000);expect(await positions.countBy({accountId:'buyer'})).toBe(0);
    expect(await transactions.count()).toBe(0);expect(await orders.count()).toBe(0);
    expect(JSON.stringify([...engine.realBooks])).toBe(before);expect(virtualHook).not.toHaveBeenCalled();expect(marketHook).not.toHaveBeenCalled();
    await db.query('DROP TRIGGER injected_failure');expect((await submit()).success).toBe(true);expect(virtualHook).toHaveBeenCalledTimes(1);
  });
  test('FOK never changes virtual cash or books when the requested size cannot be filled',async()=>{
    engine.placeVirtualOrder('U1','sell',10,60,100,{tag:'synthetic-ai'});
    const before=JSON.stringify([...engine.realBooks]);expect((await submit({type:'fok',price:10})).success).toBe(false);
    expect(JSON.stringify([...engine.realBooks])).toBe(before);expect(virtualHook).not.toHaveBeenCalled();expect(await transactions.count()).toBe(0);
  });
  test('an iceberg immediately crosses its displayed slice without counting hidden shares as fills',async()=>{
    engine.placeVirtualOrder('U1','sell',10,100,100);
    const result=await submit({type:'iceberg',price:10,quantity:1000,displayQty:100});expect(result.success).toBe(true);
    expect(result.order.filledQty).toBe(100);expect((await positions.findOneBy({accountId:'buyer',symbol:'U1'})).longQty).toBe(100);
    const entry=engine.realBooks.get('U1').bids[0];expect(entry.qty+entry.hiddenQty).toBe(900);expect(entry.qty).toBe(100);
  });
  test('the public preview is non-mutating and matches the submitted finite fill',async()=>{
    engine.orderBooks.set('U1',{bids:[{price:9.99,size:50}],asks:[{price:10.01,size:20},{price:10.02,size:30}]});
    const service=new OrderService(accounts,positions,orders,transactions,engine,db,{});
    const before=JSON.stringify(engine.getOrderBook('U1'));
    const quote=await service.estimateOrder('buyer-user','US',{symbol:'U1',side:'buy',type:'market',quantity:100});
    expect(quote.preview.filledQuantity).toBe(50);expect(JSON.stringify(engine.getOrderBook('U1'))).toBe(before);
    expect(JSON.stringify(quote)).not.toMatch(/counterFills|accountId|orderId/);
    const result=await submit();expect(result.fill.filledQuantity).toBe(quote.preview.filledQuantity);
    expect(result.fill.totalCost).toBe(quote.preview.totalCost);expect(result.settle.fill.totalCost).toBe(500.8);
    expect((await accounts.findOneBy({id:'buyer'})).cash).toBe(99499.2);
  });
  test('liquidation preserves the shares for which no finite bid exists',async()=>{
    engine.orderBooks.set('U1',{bids:[{price:9.99,size:70}],asks:[]});
    await engine.forceLiquidate(await accounts.findOneBy({id:'seller'}));
    expect((await positions.findOneBy({accountId:'seller',symbol:'U1'})).longQty).toBe(930);
    expect(engine.getOrderBook('U1').bids).toHaveLength(0);expect((await transactions.find())[0].quantity).toBe(70);
  });
  test('cent notional is preserved even when the four-decimal display VWAP loses precision',async()=>{
    await accounts.update({id:'buyer'},{cash:10000001});
    engine.orderBooks.set('U1',{bids:[],asks:[{price:10,size:999999},{price:10.01,size:1}]});
    const result=await submit({quantity:1000000});expect(result.success).toBe(true);
    expect(result.fill.avgPrice).toBe(10);expect(result.fill.totalCost).toBe(10000000.01);
    expect(result.settle.fill.totalCost).toBe(10000000.01);
    expect((await accounts.findOneBy({id:'buyer'})).cash).toBe(.99);
  });
  test('concurrent duplicate market submissions settle once inside the execution queue',async()=>{
    engine.placeVirtualOrder('U1','sell',10,1000,100);
    const results=await Promise.all([submit({clientOrderId:'synthetic-repeat'}),submit({clientOrderId:'synthetic-repeat'})]);
    expect(results.every(result=>result.success)).toBe(true);expect(results.filter(result=>result.duplicate)).toHaveLength(1);
    expect(await transactions.count()).toBe(1);expect((await positions.findOneBy({accountId:'buyer',symbol:'U1'})).longQty).toBe(100);
    expect((await accounts.findOneBy({id:'buyer'})).cash).toBe(99000);
  });
});
test('a depth-driven print sets the last matched price without adding another turnover impact',()=>{
 const market=new MarketDataService(null,null,null,null,'US');
 const bar={open:10,high:10,low:10,close:10,volume:100};
 const stock={symbol:'U1',price:10,prevClose:10,dayOpen:10,dayHigh:10,dayLow:10,lastVolume:100,dayVolume:100,
   avgVolume:1000,current1min:{...bar},current5min:{...bar},currentDaily:{...bar}};
 market.stocks.set('U1',stock);
 market.applyUserFill({symbol:'U1',side:'buy',filledQuantity:100,avgPrice:10.015,execution:{model:'finite-depth-v1',lastPrice:10.02}});
 expect(stock.price).toBe(10.02);expect(stock.dayVolume).toBe(200);expect(stock.dayAmount).toBeCloseTo(1001.5,6);
 for(const candle of [stock.current1min,stock.current5min,stock.currentDaily])expect(candle).toMatchObject({close:10.02,high:10.02,volume:200});
});
