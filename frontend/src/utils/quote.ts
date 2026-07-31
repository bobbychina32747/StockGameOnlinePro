// Q3 实时行情合并：价格来自 WS tick，涨跌幅/高低基于 dayOpen 实时计算（消除 15s 轮询滞后）
export interface LiveQuote {
  symbol: string;
  name?: string;
  code?: string;
  industry?: string;
  price: number;
  dayOpen?: number;
  changePct: number;
  dayHigh?: number;
  dayLow?: number;
  dayVolume?: number;
}

export function liveQuote(
  stocks: any[],
  prices: Record<string, number>,
  symbol: string
): LiveQuote {
  const s = stocks.find((x: any) => x.symbol === symbol);
  const price = prices[symbol] ?? s?.price;
  const dayOpen = s?.dayOpen != null ? Number(s.dayOpen) : price;
  const changePct =
    dayOpen > 0 && price != null
      ? ((price - dayOpen) / dayOpen) * 100
      : s?.changePct ?? 0;
  return {
    symbol,
    name: s?.name,
    code: s?.code,
    industry: s?.industry,
    price,
    dayOpen: s?.dayOpen,
    changePct,
    dayHigh: s?.dayHigh,
    dayLow: s?.dayLow,
    dayVolume: s?.dayVolume,
  };
}

// 涨跌家数（实时）
export function marketBreadth(
  stocks: any[],
  prices: Record<string, number>
): { up: number; down: number; flat: number } {
  let up = 0, down = 0, flat = 0;
  for (const s of stocks) {
    const q = liveQuote(stocks, prices, s.symbol);
    if (q.changePct > 0) up++;
    else if (q.changePct < 0) down++;
    else flat++;
  }
  return { up, down, flat };
}
