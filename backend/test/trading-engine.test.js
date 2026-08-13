const { TradingEngineService } = require('../dist/src/core/trading-engine/trading-engine.service');

describe('TradingEngineService 核心逻辑', () => {
  let engine;

  beforeEach(() => {
    // 构造器只初始化内存结构（orderBooks/prices），不访问 repository
    engine = new TradingEngineService(null, null, null, null);
  });

  describe('calcFees 三市场费率', () => {
    test('A股买入：佣金最低5元、无印花税', () => {
      const f = engine.calcFees('buy', 10000, 100, 'CN');
      expect(f.commission).toBeCloseTo(5, 4);
      expect(f.stampDuty).toBeCloseTo(0, 4);
      expect(f.transferFee).toBeCloseTo(0.2, 4);
      expect(f.totalFees).toBeCloseTo(5.2, 4);
    });

    test('A股卖出：加收印花税0.1%', () => {
      const f = engine.calcFees('sell', 10000, 100, 'CN');
      expect(f.commission).toBeCloseTo(5, 4);
      expect(f.stampDuty).toBeCloseTo(10, 4);
      expect(f.totalFees).toBeCloseTo(15.2, 4);
    });

    test('港股买入：佣金最低50元', () => {
      const f = engine.calcFees('buy', 100000, 1000, 'HK');
      expect(f.commission).toBeCloseTo(50, 4);
      expect(f.stampDuty).toBeCloseTo(0, 4);
      expect(f.transferFee).toBeCloseTo(7.7, 4);
      expect(f.totalFees).toBeCloseTo(57.7, 4);
    });

    test('美股买入：零佣金零费用', () => {
      const f = engine.calcFees('buy', 10000, 100, 'US');
      expect(f.totalFees).toBeCloseTo(0, 4);
    });

    test('美股卖出：SEC费 + TAF费', () => {
      const f = engine.calcFees('sell', 10000, 100, 'US');
      expect(f.secFee).toBeCloseTo(0.229, 4);
      expect(f.tafFee).toBeCloseTo(0.0119, 4);
      expect(f.totalFees).toBeCloseTo(0.2409, 4);
    });
  });

  describe('updatePosition 持仓更新', () => {
    test('买入：加权平均成本 + boughtToday 累加', () => {
      const pos = { longQty: 100, longCost: 10, shortQty: 0, shortCost: 0, boughtToday: 0 };
      engine.updatePosition(pos, 'buy', { avgPrice: 12, filledQuantity: 50 });
      expect(pos.longQty).toBe(150);
      expect(pos.longCost).toBeCloseTo(10.6667, 4);
      expect(pos.boughtToday).toBe(50);
    });

    test('部分卖出：longQty 减少、成本不变', () => {
      const pos = { longQty: 100, longCost: 10, shortQty: 0, shortCost: 0, boughtToday: 0 };
      engine.updatePosition(pos, 'sell', { avgPrice: 12, filledQuantity: 60 });
      expect(pos.longQty).toBe(40);
      expect(pos.longCost).toBeCloseTo(10, 4);
    });

    test('全部卖出：清空持仓', () => {
      const pos = { longQty: 100, longCost: 10, shortQty: 0, shortCost: 0, boughtToday: 0 };
      engine.updatePosition(pos, 'sell', { avgPrice: 12, filledQuantity: 100 });
      expect(pos.longQty).toBe(0);
      expect(pos.longCost).toBe(0);
    });

    test('做空：shortQty 与成本累加', () => {
      const pos = { longQty: 0, longCost: 0, shortQty: 0, shortCost: 0, boughtToday: 0 };
      engine.updatePosition(pos, 'short', { avgPrice: 20, filledQuantity: 30 });
      expect(pos.shortQty).toBe(30);
      expect(pos.shortCost).toBeCloseTo(20, 4);
    });
  });

  describe('executeMarketOrder 市价撮合', () => {
    test('买入吃多档 ask、部分成交', () => {
      engine.orderBooks.set('TEST', {
        bids: [{ price: 9.9, size: 100 }],
        asks: [{ price: 10.0, size: 100 }, { price: 10.1, size: 200 }],
      });
      const fill = engine.executeMarketOrder('TEST', 'buy', 150);
      expect(fill.filledQuantity).toBe(150);
      expect(fill.avgPrice).toBeCloseTo(10.0333, 4);
      expect(fill.totalCost).toBeCloseTo(1505, 2);
    });

    test('空盘口返回 null', () => {
      expect(engine.executeMarketOrder('T1', 'buy', 100)).toBeNull();
    });
  });
});
