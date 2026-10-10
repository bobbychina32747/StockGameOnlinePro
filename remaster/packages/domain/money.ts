import { MarketId, RuleError, Side } from './types';
export function integer(value: unknown, name: string, minimum = 0, maximum = 1_000_000_000_000): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RuleError('INVALID_INPUT', `${name}必须为范围内的整数`);
  return value;
}
export function money(value: number): number { return integer(value, '金额', 0); }
export function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || Math.abs(result) > 1_000_000_000_000) throw new RuleError('AMOUNT_OVERFLOW', '金额超出允许范围');
  return result;
}
export function multiply(price: number, quantity: number): number { return money(price * quantity); }
export function fees(market: MarketId, side: Side, turnover: number): number {
  const selling = side === 'sell' || side === 'short';
  if (market === 'CN') return Math.max(500, Math.ceil(turnover * 0.00025)) + (selling ? Math.ceil(turnover * 0.001) : 0);
  if (market === 'HK') return Math.max(5000, Math.ceil(turnover * 0.0003)) + (selling ? Math.ceil(turnover * 0.0013) : 0);
  return selling ? Math.max(1, Math.ceil(turnover * 0.000028)) : 0;
}
export const FX: Record<MarketId, number> = { CN: 1_000_000, HK: 920_000, US: 7_120_000 };
export function exchange(amount: number, from: MarketId, to: MarketId): { received: number; fee: number } {
  money(amount);
  const fee = Math.ceil(amount / 1000);
  return { received: Number(BigInt(amount - fee) * BigInt(FX[from]) / BigInt(FX[to])), fee };
}
