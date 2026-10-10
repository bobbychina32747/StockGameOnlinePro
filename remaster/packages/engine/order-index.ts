import { Order, World } from '../domain/types';
interface Index {orders:World['orders'];symbols:Map<string,Set<Order>>;accounts:Map<string,Set<Order>>}
const indexes=new WeakMap<World,Index>();
function add(index:Index,order:Order):void {
  if(!index.symbols.has(order.symbol))index.symbols.set(order.symbol,new Set());index.symbols.get(order.symbol)!.add(order);
  if(!index.accounts.has(order.accountId))index.accounts.set(order.accountId,new Set());index.accounts.get(order.accountId)!.add(order);
}
function get(world:World):Index {
  let index=indexes.get(world);if(!index||index.orders!==world.orders){index={orders:world.orders,symbols:new Map(),accounts:new Map()};for(const order of Object.values(world.orders))add(index,order);indexes.set(world,index);}return index;
}
export function registerOrder(world:World,order:Order):void {add(get(world),order);}
export function symbolOrders(world:World,symbol:string):Order[] {return [...(get(world).symbols.get(symbol)??[])].filter(order=>world.orders[order.id]===order);}
export function accountOrders(world:World,accountId:string):Order[] {return [...(get(world).accounts.get(accountId)??[])].filter(order=>world.orders[order.id]===order);}
