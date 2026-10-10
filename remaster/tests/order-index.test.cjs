const {test}=require('node:test');const assert=require('node:assert/strict');
const {createWorld}=require('../dist/packages/engine/world');
const {symbolOrders,accountOrders,registerOrder}=require('../dist/packages/engine/order-index');
test('order indexes preserve live status, isolate restored worlds and exclude removed orders',()=>{
 const world=createWorld(123);const order={id:'index-test',symbol:'T1',accountId:'index-account',status:'pending'};
 assert.equal(symbolOrders(world,'T1').length,0);
 world.orders[order.id]=order;registerOrder(world,order);
 assert.deepEqual(symbolOrders(world,'T1'),[order]);assert.deepEqual(accountOrders(world,order.accountId),[order]);
 order.status='cancelled';assert.equal(symbolOrders(world,'T1')[0].status,'cancelled');
 const restored=JSON.parse(JSON.stringify(world));restored.orders[order.id].status='partial';
 assert.equal(symbolOrders(restored,'T1')[0].status,'partial');assert.equal(symbolOrders(world,'T1')[0].status,'cancelled');
 delete world.orders[order.id];assert.equal(symbolOrders(world,'T1').length,0);assert.equal(accountOrders(world,order.accountId).length,0);
 world.orders=restored.orders;assert.equal(symbolOrders(world,'T1')[0].status,'partial');
});
