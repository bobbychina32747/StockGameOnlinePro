const {test}=require('node:test');const assert=require('node:assert/strict');
const {createWorld,account,equity}=require('../dist/packages/engine/world');
const {transition}=require('../dist/packages/engine/engine');
const {refreshLiquidity}=require('../dist/packages/engine/participants');
const {cloneWorld}=require('../dist/packages/engine/matching');
const {realClock,LENGTH}=require('../dist/packages/engine/calendar');
const {digest,WorldRepository}=require('../dist/apps/game-api/repository');
const {GameService}=require('../dist/apps/game-api/service');
function fixture(market='US') {let world=createWorld(123);world=transition(world,{kind:'create-player',owner:'test-player',name:'测试玩家'},'create-player').world;refreshLiquidity(world,market);return world;}
test('catalog, calendars and cross-midnight US session use authoritative timezone',()=>{
 assert.deepEqual(LENGTH,{CN:240,HK:330,US:390});
 assert.equal(realClock('US',new Date('2026-10-09T01:00:00+08:00')).date,'2026-10-08');
 assert.equal(realClock('US',new Date('2026-10-09T01:00:00+08:00')).minute,210);
 assert.equal(realClock('CN',new Date('2026-10-09T12:00:00+08:00')).phase,'closed');
 assert.equal(realClock('CN',new Date('2026-10-09T09:19:00+08:00')).phase,'auction-open');
 assert.equal(realClock('CN',new Date('2026-10-09T09:22:00+08:00')).phase,'auction-locked');
 assert.equal(realClock('CN',new Date('2026-10-09T09:27:00+08:00')).phase,'pre-open');
});
test('same seed and commands produce identical world hashes',()=>{
 const initial=fixture();const first=transition(initial,{kind:'tick',market:'US'},'tick-00001').world;
 const second=transition(cloneWorld(initial),{kind:'tick',market:'US'},'tick-00001').world;
 assert.equal(digest(first),digest(second));assert.equal(Object.keys(first.instruments).length,138);
});
test('a real two-sided trade preserves cash and stock quantity and records volume once',()=>{
 const world=fixture();const symbol=Object.values(world.instruments).find(stock=>stock.market==='US').symbol;
 const before=Object.values(world.accounts).reduce((sum,item)=>sum+item.cash+item.collateral,0);
 const next=transition(world,{kind:'order',owner:'test-player',market:'US',input:{symbol,side:'buy',type:'market',quantity:10}},'buy-market-1');
 assert.equal(next.result.order.filled,10);assert.equal(next.world.quotes[symbol].volume-world.quotes[symbol].volume,10);
 assert.equal(Object.values(next.world.accounts).reduce((sum,item)=>sum+item.cash+item.collateral,0),before);
 assert.equal(account(next.world,'test-player','US').positions[symbol].lots[0].quantity,10);
});
test('CN T+1 survives snapshots and rejects same-day sale',()=>{
 const world=fixture('CN');const symbol='T1';const bought=transition(world,{kind:'order',owner:'test-player',market:'CN',input:{symbol,side:'buy',type:'market',quantity:10}},'buy-cn-001').world;
 const restored=JSON.parse(JSON.stringify(bought));assert.throws(()=>transition(restored,{kind:'order',owner:'test-player',market:'CN',input:{symbol,side:'sell',type:'market',quantity:10}},'sell-cn-01'),/T\+1/);
 restored.markets.CN.clock.day++;assert.equal(transition(restored,{kind:'order',owner:'test-player',market:'CN',input:{symbol,side:'sell',type:'market',quantity:10}},'sell-cn-02').result.order.filled,10);
});
test('FOK cancels without partial settlement; IOC settles available quantity only',()=>{
 const world=fixture();const instrument=Object.values(world.instruments).filter(stock=>stock.market==='US').sort((left,right)=>left.initialPrice-right.initialPrice)[0];
 const price=Math.max(...Object.values(world.orders).filter(order=>order.symbol===instrument.symbol&&order.side==='sell').map(order=>order.price));
 const cancelled=transition(world,{kind:'order',owner:'test-player',market:'US',input:{symbol:instrument.symbol,side:'buy',type:'fok',quantity:3000,price}},'fok-no-fill');
 assert.equal(cancelled.result.order.status,'cancelled');assert.equal(cancelled.result.order.filled,0);assert.equal(account(cancelled.world,'test-player','US').cash,account(world,'test-player','US').cash);
 const partial=transition(world,{kind:'order',owner:'test-player',market:'US',input:{symbol:instrument.symbol,side:'buy',type:'ioc',quantity:3000,price}},'ioc-partial');
 const depth=Object.values(world.orders).filter(order=>order.symbol===instrument.symbol&&order.side==='sell').reduce((sum,order)=>sum+order.remaining,0);
 assert.equal(partial.result.order.filled,depth);assert.equal(partial.result.order.status,'cancelled');
});
test('short collateral is released per instrument rather than account total',()=>{
 let world=fixture();const symbols=Object.values(world.instruments).filter(stock=>stock.market==='US').slice(0,2).map(stock=>stock.symbol);
 for(const symbol of symbols) world=transition(world,{kind:'order',owner:'test-player',market:'US',input:{symbol,side:'short',type:'market',quantity:10}},`short-${symbol}`).world;
 const unrelated=account(world,'test-player','US').positions[symbols[1]].collateral;
 world=transition(world,{kind:'order',owner:'test-player',market:'US',input:{symbol:symbols[0],side:'cover',type:'market',quantity:10}},'cover-first').world;
 assert.equal(account(world,'test-player','US').collateral,unrelated);
});
test('market order command retry is persisted once, and different payload conflicts',async()=>{
 const repository=new WorldRepository(':memory:');const service=new GameService(repository,123);await service.execute({kind:'create-player',owner:'test-player',name:'测试玩家'},'create-player');
 refreshLiquidity(service.world,'US');repository.db.prepare('UPDATE world SET state=? WHERE id=1').run(JSON.stringify(service.world));
 const symbol=Object.values(service.world.instruments).find(stock=>stock.market==='US').symbol;const command={kind:'order',owner:'test-player',market:'US',input:{symbol,side:'buy',type:'market',quantity:10}};
 const results=await Promise.all(Array.from({length:6},()=>service.execute(command,'same-market-key')));assert(results.every(result=>result.order.id===results[0].order.id));assert.equal(repository.db.prepare('SELECT COUNT(*) AS count FROM trades WHERE buyer=?').get('test-player:US').count,1);
 await assert.rejects(()=>service.execute({...command,input:{...command.input,quantity:11}},'same-market-key'),/不同请求/);repository.close();
});
test('fault at every transaction stage rolls back both assets and command; retry executes once',async()=>{
 for(const point of ['command','world','orders','trades','ledger','outbox']) {
  const repository=new WorldRepository(':memory:');const service=new GameService(repository,123);await service.execute({kind:'create-player',owner:'test-player',name:'测试玩家'},'create-player');
  refreshLiquidity(service.world,'US');repository.db.prepare('UPDATE world SET state=? WHERE id=1').run(JSON.stringify(service.world));
  const snapshot=digest(service.world);repository.failAt=point;
  const symbol=Object.values(service.world.instruments).find(stock=>stock.market==='US').symbol;const command={kind:'order',owner:'test-player',market:'US',input:{symbol,side:'buy',type:'market',quantity:10}};
  await assert.rejects(()=>service.execute(command,'faulted-command'),/Injected/);assert.equal(digest(repository.load()),snapshot);assert.equal(repository.db.prepare('SELECT COUNT(*) AS count FROM commands WHERE key=?').get('faulted-command').count,0);
  repository.failAt=undefined;assert.equal((await service.execute(command,'faulted-command')).order.filled,10);repository.close();
 }
});
test('committed transaction survives crash before memory apply, then retry uses cached result',async()=>{
 const repository=new WorldRepository(':memory:');const service=new GameService(repository,123);service.afterCommitHook=()=>{throw new Error('memory crash');};
 await assert.rejects(()=>service.execute({kind:'create-player',owner:'test-player',name:'测试玩家'},'create-player'),/memory crash/);
 service.afterCommitHook=undefined;assert(account(service.world,'test-player','CN'));assert.equal((await service.execute({kind:'create-player',owner:'test-player',name:'测试玩家'},'create-player')).version,1);repository.close();
});
test('stale writer generation cannot commit a queued command',async()=>{
 const repository=new WorldRepository(':memory:');const service=new GameService(repository,123);const pending=service.execute({kind:'create-player',owner:'test-player',name:'测试玩家'},'create-player');service.fence();
 await assert.rejects(()=>pending,/fenced/);assert.equal(service.world.version,0);repository.close();
});
