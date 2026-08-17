import { adjustedCost, factorAt, latestFactor } from './adjust';

const series = [
  { day: 100, factor: 0.95 },
  { day: 200, factor: 0.9 },
  { day: 300, factor: 0.85 },
];

describe('adjust.factorAt / latestFactor', () => {
  it('按购买日取累计因子', () => {
    expect(factorAt(series, 50)).toBe(1);
    expect(factorAt(series, 150)).toBeCloseTo(0.95, 10);
    expect(factorAt(series, 999)).toBeCloseTo(0.85, 10);
    expect(latestFactor(series)).toBeCloseTo(0.85, 10);
  });
});

describe('adjust.adjustedCost 持仓成本复权口径', () => {
  it('不复权 = 原始成本', () => {
    expect(adjustedCost(10, series, 150, 'none')).toBe(10);
  });

  it('前复权 = 成本 × f(lockDay)', () => {
    expect(adjustedCost(10, series, 150, 'forward')).toBeCloseTo(9.5, 10);
    expect(adjustedCost(10, series, 50, 'forward')).toBe(10);
  });

  it('后复权 = 成本 × f(lockDay) / fNow', () => {
    expect(adjustedCost(10, series, 150, 'backward')).toBeCloseTo(9.5 / 0.85, 10);
  });

  it('无除权序列时不变', () => {
    expect(adjustedCost(10, [], 150, 'forward')).toBe(10);
  });
});
