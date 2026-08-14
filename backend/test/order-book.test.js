// P0 真实订单簿单元测试：价格-时间优先、限价封顶、自成交防护、封板排队、部分成交
const { TradingEngineService } = require('../dist/src/core/trading-engine/trading-engine.service');

describe('TradingEngineService 真实订单簿（P0）', () => {
  let engine;

  beforeEach(() => {
    engine = new TradingEngineService(null, null, null, null);
    // 合成深度：模拟 refreshOrderBook 产出（买一 9.9 / 卖一 10.0 附近五档）
    engine.orderBooks.set('T1', {
      bids: [
        { price: 9.99, size: 100 },
        { price: 9.98, size: 200 },
      ],
      asks: [
        { price: 10.01, size: 100 },
        { price: 10.02, size: 200 },
      ],
    });
  });

  describe('placeRestingOrder / matchAgainstBook 价格-时间优先', () => {
    test('买单先吃最低卖价，同价先吃最早挂单', () => {
      engine.placeRestingOrder('T1', 'o1', 'A1', 'sell', 10.1, 100);
      engine.placeRestingOrder('T1', 'o2', 'A2', 'sell', 10.05, 60);
      engine.placeRestingOrder('T1', 'o3', 'A3', 'sell', 10.05, 40);
      const res = engine.matchAgainstBook('T1', 'buy', 150, undefined, 'BUYER');
      expect(res.fills.length).toBe(3);
      expect(res.fills[0]).toMatchObject({ orderId: 'o2', price: 10.05, qty: 60 });
      expect(res.fills[1]).toMatchObject({ orderId: 'o3', price: 10.05, qty: 40 });
      expect(res.fills[2]).toMatchObject({ orderId: 'o1', price: 10.1, qty: 50 });
      expect(res.remaining).toBe(0);
    });

    test('限价封顶：超出限价的档位不成交', () => {
      engine.placeRestingOrder('T1', 'o1', 'A1', 'sell', 10.1, 100);
      engine.placeRestingOrder('T1', 'o2', 'A2', 'sell', 10.05, 60);
      const res = engine.matchAgainstBook('T1', 'buy', 200, 10.05, 'BUYER');
      expect(res.fills.length).toBe(1);
      expect(res.fills[0]).toMatchObject({ orderId: 'o2', qty: 60 });
      expect(res.remaining).toBe(140);
    });

    test('部分成交：档内数量扣减，剩余挂单继续排队', () => {
      engine.placeRestingOrder('T1', 'o1', 'A1', 'sell', 10.0, 100);
      const res = engine.matchAgainstBook('T1', 'buy', 40, undefined, 'BUYER');
      expect(res.fills[0].qty).toBe(40);
      const book = engine.realBooks.get('T1');
      expect(book.asks.length).toBe(1);
      expect(book.asks[0].qty).toBe(60);
    });

    test('自成交防护：不与自己账户的挂单撮合', () => {
      engine.placeRestingOrder('T1', 'o1', 'SELF', 'sell', 10.0, 100);
      const res = engine.matchAgainstBook('T1', 'buy', 50, undefined, 'SELF');
      expect(res.fills.length).toBe(0);
      expect(res.remaining).toBe(50);
    });
  });

  describe('executeMarketOrder / executeMarketOrderLimited 真实优先+合成兜底', () => {
    test('先吃真实挂单再吃合成深度，并返回对手方成交明细', () => {
      engine.placeRestingOrder('T1', 'o1', 'A1', 'sell', 10.0, 60);
      const fill = engine.executeMarketOrder('T1', 'buy', 150, 'BUYER');
      expect(fill.filledQuantity).toBe(150); // 60 真实 + 90 合成(10.01)
      expect(fill.counterFills.length).toBe(1);
      expect(fill.counterFills[0]).toMatchObject({ orderId: 'o1', qty: 60, price: 10.0 });
      // 均价 = (60*10.0 + 90*10.01) / 150
      expect(fill.avgPrice).toBeCloseTo((60 * 10.0 + 90 * 10.01) / 150, 4);
    });

    test('限价撮合：真实挂单按限价封顶，合成档同样受限', () => {
      engine.placeRestingOrder('T1', 'o1', 'A1', 'sell', 10.02, 100);
      const fill = engine.executeMarketOrderLimited('T1', 'buy', 200, 10.01, 'BUYER');
      // 真实 10.02 > 限价 10.01 不成交；合成 10.01 吃 100
      expect(fill.filledQuantity).toBe(100);
      expect(fill.counterFills.length).toBe(0);
      expect(fill.avgPrice).toBeCloseTo(10.01, 4);
    });
  });

  describe('涨跌停封板（A 股 ±10%）', () => {
    test('涨停：合成卖盘清空，市价买无法成交；排队买单可被真实卖单吃掉', () => {
      engine.setDayOpen({ T1: 100 });
      engine.refreshOrderBook('T1', 110); // 涨停价
      const book = engine.getOrderBook('T1');
      expect(book.asks.length).toBe(0); // 封板：无合成卖盘
      const fill = engine.executeMarketOrder('T1', 'buy', 10, 'BUYER');
      expect(fill).toBeNull(); // 封板买不进
      // 真实卖单在涨停价排队 → 买单可成交
      engine.placeRestingOrder('T1', 'o1', 'A1', 'sell', 110, 50);
      const fill2 = engine.executeMarketOrder('T1', 'buy', 10, 'BUYER');
      expect(fill2.filledQuantity).toBe(10);
      expect(fill2.counterFills[0]).toMatchObject({ orderId: 'o1', qty: 10, price: 110 });
    });

    test('跌停：合成买盘清空，市价卖无法成交', () => {
      engine.setDayOpen({ T1: 100 });
      engine.refreshOrderBook('T1', 90); // 跌停价
      const book = engine.getOrderBook('T1');
      expect(book.bids.length).toBe(0);
      const fill = engine.executeMarketOrder('T1', 'sell', 10, 'SELLER');
      expect(fill).toBeNull();
    });

    test('非涨停时合成卖盘正常且不超过涨停价', () => {
      engine.setDayOpen({ T1: 100 });
      engine.refreshOrderBook('T1', 109.5);
      const book = engine.getOrderBook('T1');
      expect(book.asks.length).toBeGreaterThan(0);
      for (const l of book.asks) {
        expect(l.price).toBeLessThanOrEqual(110.0);
      }
    });
  });

  describe('removeRestingOrder 撤单', () => {
    test('整单移除与部分扣减', () => {
      engine.placeRestingOrder('T1', 'o1', 'A1', 'sell', 10.0, 100);
      engine.removeRestingOrder('T1', 'o1', 30);
      expect(engine.realBooks.get('T1').asks[0].qty).toBe(70);
      engine.removeRestingOrder('T1', 'o1');
      expect(engine.realBooks.get('T1').asks.length).toBe(0);
    });
  });

  describe('P2 AI 虚拟订单流', () => {
    test('虚拟挂单进入盘口，AI 市价单吃掉虚拟深度（无账户不结算）', () => {
      engine.placeVirtualOrder('T1', 'sell', 10.0, 100, 999999);
      const fill = engine.executeVirtualMarketOrder('T1', 'buy', 60);
      expect(fill.filledQuantity).toBe(60);
      expect(fill.counterFills[0]).toMatchObject({ orderId: null, price: 10.0, qty: 60 });
      expect(engine.realBooks.get('T1').asks[0].qty).toBe(40);
    });

    test('AI 市价单不吃合成深度（无真实挂单时返回 null）', () => {
      const fill = engine.executeVirtualMarketOrder('T1', 'buy', 60);
      expect(fill).toBeNull();
    });

    test('TTL 到期的虚拟挂单被清理，真实挂单保留', () => {
      engine.placeVirtualOrder('T1', 'sell', 10.0, 100, 10);
      engine.placeRestingOrder('T1', 'o1', 'A1', 'sell', 10.1, 50);
      engine.pruneExpiredVirtualOrders(10);
      const book = engine.realBooks.get('T1');
      expect(book.asks.length).toBe(1);
      expect(book.asks[0].orderId).toBe('o1');
    });

    test('用户市价单可吃掉 AI 虚拟深度，counterFills 含虚拟单（结算时跳过）', () => {
      engine.placeVirtualOrder('T1', 'sell', 10.0, 80, 999999);
      const fill = engine.executeMarketOrder('T1', 'buy', 50, 'BUYER');
      expect(fill.filledQuantity).toBe(50);
      expect(fill.counterFills.length).toBe(1);
      expect(fill.counterFills[0].orderId).toBeNull();
      expect(fill.avgPrice).toBeCloseTo(10.0, 4);
    });
  });
});
