const { TradingEngineService } = require('../dist/src/core/trading-engine/trading-engine.service');

describe('TradingEngineService.validateOrder 订单校验', () => {
  let engine;
  let positionRepo;

  beforeEach(() => {
    positionRepo = { findOne: jest.fn().mockResolvedValue(null) };
    engine = new TradingEngineService(null, null, positionRepo, null);
    engine.prices.set('T1', 100);
  });

  test('数量 <= 0 拒绝', async () => {
    const r = await engine.validateOrder({ quantity: 0, type: 'market', side: 'buy', symbol: 'T1' }, { id: 'a', cash: 100000 });
    expect(r.valid).toBe(false);
  });

  test('限价单缺少价格拒绝', async () => {
    const r = await engine.validateOrder({ quantity: 100, type: 'limit', side: 'buy', symbol: 'T1' }, { id: 'a', cash: 100000 });
    expect(r.valid).toBe(false);
  });

  test('买入资金不足拒绝', async () => {
    const r = await engine.validateOrder({ quantity: 200, type: 'market', side: 'buy', symbol: 'T1' }, { id: 'a', cash: 1000 });
    expect(r.valid).toBe(false);
    expect(r.error).toContain('资金不足');
  });

  test('做空保证金不足拒绝', async () => {
    const r = await engine.validateOrder({ quantity: 200, type: 'market', side: 'short', symbol: 'T1' }, { id: 'a', cash: 1000 });
    expect(r.valid).toBe(false);
    expect(r.error).toContain('保证金不足');
  });

  test('A股 T+1：当日买入次日才能卖', async () => {
    positionRepo.findOne.mockResolvedValue({ longQty: 100, boughtToday: 80 });
    const r = await engine.validateOrder({ quantity: 50, type: 'market', side: 'sell', symbol: 'T1' }, { id: 'a', cash: 100000, marketMode: 'CN' });
    expect(r.valid).toBe(false);
    expect(r.error).toContain('T+1');
  });

  test('持仓不足拒绝', async () => {
    positionRepo.findOne.mockResolvedValue({ longQty: 10, boughtToday: 0 });
    const r = await engine.validateOrder({ quantity: 50, type: 'market', side: 'sell', symbol: 'T1' }, { id: 'a', cash: 100000, marketMode: 'US' });
    expect(r.valid).toBe(false);
    expect(r.error).toContain('持仓不足');
  });

  test('正常买单通过', async () => {
    const r = await engine.validateOrder({ quantity: 100, type: 'market', side: 'buy', symbol: 'T1' }, { id: 'a', cash: 100000 });
    expect(r.valid).toBe(true);
  });
});
