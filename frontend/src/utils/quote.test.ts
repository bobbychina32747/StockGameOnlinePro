import { liveQuote, marketBreadth } from './quote';

describe('quote.liveQuote', () => {
  const stocks = [
    { symbol: 'T1', name: '测试一', price: 10, dayOpen: 10, changePct: 0.5 },
    { symbol: 'T2', name: '测试二', price: 8, dayOpen: 0, changePct: -2 },
  ];

  it('按 dayOpen 实时计算涨跌幅', () => {
    const q = liveQuote(stocks, { T1: 11 }, 'T1');
    expect(q).toMatchObject({ symbol: 'T1', name: '测试一', price: 11, dayOpen: 10 });
    expect(q.changePct).toBeCloseTo(10, 5);
  });

  it('价格缺失时回退到股票快照价', () => {
    const q = liveQuote(stocks, {}, 'T1');
    expect(q.price).toBe(10);
    expect(q.changePct).toBeCloseTo(0, 5);
  });

  it('dayOpen 为 0 时回退到快照涨跌幅', () => {
    const q = liveQuote(stocks, { T2: 8.5 }, 'T2');
    expect(q.price).toBe(8.5);
    expect(q.changePct).toBe(-2);
  });

  it('股票不存在时 price 取行情映射值，涨跌幅归零', () => {
    const q = liveQuote(stocks, { UNKNOWN: 99 }, 'UNKNOWN');
    expect(q).toMatchObject({ symbol: 'UNKNOWN', price: 99, changePct: 0 });
    expect(q.name).toBeUndefined();
  });
});

describe('quote.marketBreadth', () => {
  it('统计上涨/下跌/平盘家数', () => {
    const stocks = [
      { symbol: 'UP', dayOpen: 10 },
      { symbol: 'DOWN', dayOpen: 10 },
      { symbol: 'FLAT', dayOpen: 10 },
    ];
    const prices = { UP: 10.5, DOWN: 9.5, FLAT: 10 };
    expect(marketBreadth(stocks, prices)).toEqual({ up: 1, down: 1, flat: 1 });
  });
});
