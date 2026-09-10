// Phase 13 P1-14 / P1-15 / P1-10 回归：成交价与隔夜跳空的涨跌停口径、分红事件幂等
// ⑤ applyUserFill 冲击价受涨跌停夹紧 + 写入 dayHigh/dayLow
// ⑥ 分红 NaN 拒绝登记、同 (symbol, exDay) 幂等、落库 applied 回填（重启不重复除权）
// ⑦ 隔夜跳空写回开盘价前夹紧（CN ±10% / 新股首日 ±44%/-36%；HK/US 保持既有口径）
const MM = require('../dist/src/core/market-data/market-math');
const { MarketDataService } = require('../dist/src/core/market-data/market-data.service');

function makeStock(over = {}) {
  return Object.assign({
    symbol: 'T1', name: '测试', industry: '银行', market: 'CN', price: 10, intrinsic: 10,
    volatility: 0.02, lastReturn: 0, prevClose: 10, dayOpen: 10, dayHigh: 10, dayLow: 10,
    dayVolume: 0, minuteCounter: 0, baseVolume: 10000, avgVolume: 10000, prevVolume: 10000, lastVolume: 0,
    kline1min: [], kline5min: [], klineDaily: [], current1min: null, current5min: null, currentDaily: null,
    trendCounter: 0, trendDirection: 0, trendAccumulated: 0, isTrending: false,
    fund: null, nextReportDay: 999, pead: null,
  }, over);
}

function makeService(opts = {}) {
  const s = new MarketDataService(null, null, null, null, opts.market || 'CN');
  const stock = makeStock(opts.stock);
  s.stocks.set(stock.symbol, stock);
  s.industryCycles.set('银行', 'expansion');
  s.factors = { '宏观经济': 0, '行业景气': 0, '公司特质': 0, '市场情绪': 0, '国际环境': 0, '政策风险': 0, '消费景气': 0 };
  return { s, stock };
}

// 极小额日均成交额 → 冲击按 1% 上限生效，便于验证"多笔叠加不越带"
const MAX_IMPACT_STOCK = { price: 10, prevClose: 10, dayOpen: 10, dayHigh: 10, dayLow: 10, avgVolume: 1 };

describe('Phase 13 P1-14：applyUserFill 成交价受涨跌停夹紧', () => {
  test('⑤ 单笔大买单：冲击被夹在涨停价（昨收×1.1），不写出越界成交价', () => {
    const { s, stock } = makeService({ stock: { ...MAX_IMPACT_STOCK, price: 10.9 } });
    s.applyUserFill({ symbol: 'T1', side: 'buy', filledQuantity: 1e9, avgPrice: 100 });
    expect(stock.price).toBe(11); // 原始冲击 10.9×1.01=11.009 → 夹回 11
    expect(stock.dayHigh).toBe(11);
  });

  test('⑤ 同一 tick 多笔叠加也不越带（原实现每笔都写回越界价）', () => {
    const { s, stock } = makeService({ stock: { ...MAX_IMPACT_STOCK, price: 10.5 } });
    for (let i = 0; i < 8; i++)
      s.applyUserFill({ symbol: 'T1', side: 'buy', filledQuantity: 1e9, avgPrice: 100 });
    expect(stock.price).toBe(11);
    expect(stock.price).toBeLessThanOrEqual(11 + 1e-9);
    expect(stock.dayHigh).toBe(11);
  });

  test('⑤ 卖方向：夹在跌停价（昨收×0.9）且 dayLow 同步更新', () => {
    const { s, stock } = makeService({ stock: { ...MAX_IMPACT_STOCK, price: 9.2 } });
    for (let i = 0; i < 5; i++)
      s.applyUserFill({ symbol: 'T1', side: 'sell', filledQuantity: 1e9, avgPrice: 100 });
    expect(stock.price).toBe(9);
    expect(stock.dayLow).toBe(9);
  });

  test('⑤ 新股首日：成交价可到 ±44%/-36% 带宽（不被 ±10% 压回）', () => {
    const { s, stock } = makeService({ stock: { ...MAX_IMPACT_STOCK, price: 13.9, listedDay: 0 } });
    s.gameDay = 0;
    s.applyUserFill({ symbol: 'T1', side: 'buy', filledQuantity: 1e9, avgPrice: 100 });
    expect(stock.price).toBeCloseTo(13.9 * 1.01, 6); // 14.039 < 14.4 → 不夹紧
    expect(stock.price).toBeLessThanOrEqual(Number((10 * 1.44).toFixed(4)));
  });

  test('⑤ 非 CN（HK/US）：不夹紧，保持既有行为', () => {
    const { s, stock } = makeService({ market: 'HK', stock: { ...MAX_IMPACT_STOCK, symbol: 'H0001', market: 'HK', price: 10.9 } });
    s.applyUserFill({ symbol: 'H0001', side: 'buy', filledQuantity: 1e9, avgPrice: 100 });
    expect(stock.price).toBeCloseTo(11.009, 6); // 无涨跌停
  });

  test('⑤ 无昨收/无今开时回落现价为基准；缺字段不写 NaN', () => {
    const { s, stock } = makeService({ stock: { price: 10, dayHigh: undefined, dayLow: undefined, avgVolume: 1 } });
    s.applyUserFill({ symbol: 'T1', side: 'buy', filledQuantity: 1e9, avgPrice: 100 });
    expect(Number.isFinite(stock.price)).toBe(true);
    expect(stock.price).toBeLessThanOrEqual(11.0000001); // 基准=现价 10 → 涨停 11
    expect(stock.dayHigh).toBe(stock.price);
    expect(stock.dayLow).toBe(stock.price);
  });
});

describe('Phase 13 P1-15：隔夜跳空开盘价夹紧', () => {
  const realGap = MM.drawOvernightGap;
  const realShock = MM.drawOvernightMarketShock;
  function stubGap(gap) {
    MM.drawOvernightMarketShock = () => 0;
    MM.drawOvernightGap = () => ({ gap, tag: 'gap-up' });
  }
  afterEach(() => {
    MM.drawOvernightGap = realGap;
    MM.drawOvernightMarketShock = realShock;
  });

  test('⑦ CN 普通日：+35% 缺口被夹到涨停价（prevClose×1.1），dayOpen/dayHigh 同源', async () => {
    stubGap(0.35);
    const { s, stock } = makeService();
    await s.endOfDay(true);
    expect(stock.prevClose).toBe(10);   // 昨收 = 今日收盘
    expect(stock.price).toBe(11);       // 原 13.5 → 夹到 11
    expect(stock.dayOpen).toBe(11);
    expect(stock.dayHigh).toBe(11);
    expect(stock.dayLow).toBe(11);
  });

  test('⑦ CN 跌停方向：-35% 缺口被夹到跌停价（prevClose×0.9）', async () => {
    stubGap(-0.35);
    const { s, stock } = makeService();
    await s.endOfDay(true);
    expect(stock.price).toBe(9);
    expect(stock.dayOpen).toBe(9);
  });

  test('⑦ CN 新股首日：带宽放宽到 +44%，13.5 的开盘价不被 ±10% 压回', async () => {
    stubGap(0.35);
    const { s, stock } = makeService();
    stock.listedDay = s.gameDay; // 挂牌当日
    await s.endOfDay(true);
    expect(stock.price).toBeCloseTo(13.5, 6);
  });

  test('⑦ HK/US：保持既有口径（不按 CN 涨跌停夹紧）', async () => {
    stubGap(0.35);
    const { s, stock } = makeService({ market: 'HK', stock: { symbol: 'H0001', market: 'HK' } });
    await s.endOfDay(true);
    expect(stock.price).toBeCloseTo(13.5, 6);
  });
});

describe('Phase 13 P1-10：分红事件落库幂等', () => {
  function fakeRepo() {
    const repo = {
      rows: [], updates: [],
      async findOne({ where }) {
        return repo.rows.find((r) => r.symbol === where.symbol && Number(r.exDay) === Number(where.exDay)) || null;
      },
      // 镜像 init() 的待除权事件加载：只取 applied:false（重启恢复口径）
      async find({ where }) {
        return repo.rows.filter((r) => !where || r.applied === where.applied);
      },
      create(d) { return { ...d }; },
      async save(row) {
        const id = row.id || `DIV-${repo.rows.length + 1}`;
        const stored = { ...row, id };
        const idx = repo.rows.findIndex((r) => r.id === id);
        if (idx >= 0) repo.rows[idx] = stored;
        else repo.rows.push(stored);
        return stored;
      },
      async update(where, patch) {
        repo.updates.push({ where, patch });
        for (const r of repo.rows) {
          const hit = (where.id !== undefined && String(r.id) === String(where.id))
            || (where.id === undefined && r.symbol === where.symbol && Number(r.exDay) === Number(where.exDay));
          if (hit) Object.assign(r, patch);
        }
        return { affected: 1 };
      },
    };
    return repo;
  }

  test('⑥ NaN/非正分红额拒绝登记，price/复权因子不被污染', async () => {
    const { s, stock } = makeService();
    const warns = [];
    s.logger.warn = (m) => warns.push(String(m));
    expect(s.recordDividend('T1', NaN, 5)).toBe(null);
    expect(s.recordDividend('T1', 0, 5)).toBe(null);
    expect(s.recordDividend('T1', -1, 5)).toBe(null);
    expect((s.dividends.get('T1') || []).length).toBe(0);
    expect(await s.applyExRights(6)).toBe(0);
    expect(stock.price).toBe(10);
    expect(Number.isFinite(stock.price)).toBe(true);
    expect(s.adjFactors.get('T1')).toBeUndefined();
    expect(warns.length).toBe(3);
  });

  test('⑥ 同 (symbol, exDay) 重复登记复用同一事件；重复 applyExRights 不二次除权', async () => {
    const { s, stock } = makeService({
      stock: { price: 10, prevClose: 10, dayOpen: 10 },
    });
    const ev1 = s.recordDividend('T1', 2, 5); // exDay=6
    const ev2 = s.recordDividend('T1', 2, 5);
    expect(ev2).toBe(ev1);
    expect(s.dividends.get('T1').length).toBe(1);

    expect(await s.applyExRights(6)).toBe(1);
    expect(stock.price).toBe(8);
    expect(s.adjFactors.get('T1').factor).toBeCloseTo(0.8, 6);
    expect(await s.applyExRights(6)).toBe(0); // 幂等：已 applied
    expect(stock.price).toBe(8);
    expect(s.adjFactors.get('T1').factor).toBeCloseTo(0.8, 6); // 复权因子未二次累计
    expect(s.dividends.get('T1')[0].applied).toBe(true);
  });

  test('⑥ 除权同时下调 prevClose（>0），除权日涨跌幅不含分红缺口', async () => {
    const { s, stock } = makeService({ stock: { price: 10, prevClose: 10, dayOpen: 10 } });
    s.recordDividend('T1', 2, 5);
    await s.applyExRights(6);
    expect(stock.price).toBe(8);
    expect(stock.prevClose).toBe(8);
    expect((stock.price - stock.prevClose) / stock.prevClose).toBeCloseTo(0, 10); // 含分红缺口时会是 -20%
  });

  test('⑥ prevClose 小于分红额时不下调成负数（保底原值）', async () => {
    const { s, stock } = makeService({ stock: { price: 10, prevClose: 1, dayOpen: 1 } });
    s.recordDividend('T1', 2, 5);
    await s.applyExRights(6);
    expect(stock.prevClose).toBe(1);
    expect(stock.prevClose).toBeGreaterThan(0);
  });

  test('⑥ 落库 await 回填 id，除权后 DB 行 applied=true（不再停在 false）', async () => {
    const repo = fakeRepo();
    const { s, stock } = makeService({ stock: { price: 10, prevClose: 10, dayOpen: 10 } });
    s.dividendEventRepo = repo;
    const ev = s.recordDividend('T1', 2, 5);
    await ev.persist; // 落库 Promise 结算（applyExRights 内部也会 await）
    expect(ev.id).toBe('DIV-1');
    expect(repo.rows[0]).toMatchObject({ symbol: 'T1', exDay: 6, applied: false });

    expect(await s.applyExRights(6)).toBe(1);
    expect(stock.price).toBe(8);
    expect(repo.rows[0].applied).toBe(true); // 按 id 精确标记
    expect(repo.updates.some((u) => u.where.id === 'DIV-1' && u.patch.applied === true)).toBe(true);
  });

  test('⑥ 重启恢复：库中已 applied=true 的行不再重复除权，也不重复插入', async () => {
    const repo = fakeRepo();
    const first = makeService({ stock: { price: 10, prevClose: 10, dayOpen: 10 } });
    first.s.dividendEventRepo = repo;
    first.s.recordDividend('T1', 2, 5);
    await first.s.applyExRights(6);

    // 重启：init 只加载 applied:false 的行（此处按同一口径直接读仓储，避免触发 init 的历史生成）
    const { s: second, stock: stock2 } = makeService({ stock: { price: 8, prevClose: 8, dayOpen: 8 } });
    second.dividendEventRepo = repo;
    const pending = await repo.find({ where: { applied: false } });
    for (const e of pending) {
      const list = second.dividends.get(e.symbol) || [];
      list.push({ id: e.id, perShare: Number(e.perShare), announceDay: Number(e.announceDay), exDay: Number(e.exDay), applied: !!e.applied });
      second.dividends.set(e.symbol, list);
    }
    expect(pending.length).toBe(0); // 除权后 DB 行 applied=true → 重启无待除权事件
    expect(second.dividends.size).toBe(0);
    expect(await second.applyExRights(6)).toBe(0);
    expect(stock2.price).toBe(8); // 未被二次除权

    // 同一天再次登记（重复 replay）：命中已有 applied 行 → 直接继承 applied，不重复插入
    const ev = second.recordDividend('T1', 2, 5);
    await ev.persist;
    expect(ev.applied).toBe(true);
    expect(repo.rows.length).toBe(1);
    expect(await second.applyExRights(6)).toBe(0);
    expect(stock2.price).toBe(8);
  });

  test('⑥ 落库未回填 id 时按 (symbol, exDay) 兜底标记 applied', async () => {
    const repo = fakeRepo();
    repo.save = async (row) => ({ ...row, id: undefined }); // 模拟驱动未回填 id
    const { s } = makeService({ stock: { price: 10, prevClose: 10, dayOpen: 10 } });
    s.dividendEventRepo = repo;
    s.recordDividend('T1', 2, 5);
    await s.applyExRights(6);
    expect(repo.updates.some((u) => u.where.symbol === 'T1' && Number(u.where.exDay) === 6 && u.patch.applied === true)).toBe(true);
  });

  test('⑥ 无 repo（内存模式）不崩溃：applyExRights 正常执行', async () => {
    const { s, stock } = makeService({ stock: { price: 10, prevClose: 10, dayOpen: 10 } });
    const ev = s.recordDividend('T1', 1.5, 7); // exDay=8
    await ev.persist;
    expect(await s.applyExRights(8)).toBe(1);
    expect(stock.price).toBeCloseTo(8.5, 6);
  });
});
