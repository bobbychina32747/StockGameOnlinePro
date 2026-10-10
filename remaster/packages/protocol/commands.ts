import { GameCommand, MARKETS, MarketId, OrderInput, RuleError } from '../domain/types';
export function marketId(value: unknown): MarketId { if(!MARKETS.includes(value as MarketId)) throw new RuleError('INVALID_MARKET','市场必须为 CN、HK 或 US');return value as MarketId; }
function record(value: unknown): Record<string,unknown> { if(!value||typeof value!=='object'||Array.isArray(value)) throw new RuleError('INVALID_INPUT','请求必须为对象');return value as Record<string,unknown>; }
export function parseCommand(value: unknown, owner: string): GameCommand {
  const body=record(value);const market=body.market===undefined?undefined:marketId(body.market);
  switch(body.kind) {
    case 'order': {
      const input=record(body.input);
      return {kind:'order',owner,market:marketId(market),input:{symbol:input.symbol,side:input.side,type:input.type,quantity:input.quantity,price:input.price,triggerPrice:input.triggerPrice,displayQuantity:input.displayQuantity} as OrderInput};
    }
    case 'cancel': if(typeof body.orderId!=='string'||body.orderId.length>100) throw new RuleError('INVALID_INPUT','订单ID无效');return {kind:'cancel',owner,orderId:body.orderId};
    case 'transfer': return {kind:'transfer',owner,from:marketId(body.from),to:marketId(body.to),amount:body.amount as number};
    case 'leverage': return {kind:'leverage',owner,market:marketId(market),leverage:body.leverage as number};
    case 'repay': return {kind:'repay',owner,market:marketId(market),amount:body.amount as number};
    case 'fund': return {kind:'fund',owner,market:marketId(market),fund:body.fund as 'money'|'etf',action:body.action as 'buy'|'sell',amount:body.amount as number};
    case 'reset': return {kind:'reset',owner,market:marketId(market)};
    case 'season': return {kind:'season',owner,market:marketId(market),type:body.type as 'week'|'month'|'fortnight'};
    default: throw new RuleError('UNKNOWN_COMMAND','不支持的游戏命令');
  }
}
export function commandKey(value: unknown): string { if(typeof value!=='string'||!/^[\w:-]{8,100}$/.test(value)) throw new RuleError('INVALID_COMMAND_KEY','命令必须提供 8–100 字符的幂等键');return value; }
