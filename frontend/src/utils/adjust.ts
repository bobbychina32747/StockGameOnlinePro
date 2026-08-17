// P5 复权口径工具：持仓成本随前/后复权折算（分红除权后成本与盈亏口径联动）。
// f(t) = 累计前复权因子（历史价格 × f(t) = 前复权价）；fNow = 最新累计因子。
export interface AdjustPoint { day: number; factor: number }

export function factorAt(series: AdjustPoint[], day: number): number {
  let f = 1;
  for (const s of series) {
    if (s.day <= day) f = s.factor;
    else break; // 升序序列，之后更大
  }
  return f;
}

export function latestFactor(series: AdjustPoint[]): number {
  return series.length ? series[series.length - 1].factor : 1;
}

// 持仓成本（购买日 lockDay 的原始成本）→ 复权口径成本
export function adjustedCost(cost: number, series: AdjustPoint[], lockDay: number, mode: 'forward' | 'backward' | 'none'): number {
  if (mode === 'none' || !series.length) return cost;
  const f = factorAt(series, lockDay);
  if (mode === 'forward') return cost * f;
  return cost * f / latestFactor(series); // 后复权：除以最新因子
}
