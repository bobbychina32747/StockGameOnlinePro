// Phase F 回归：AI 对手盘在线自适应（团队定稿 C1-C16 / R1-R13）
// 四件套：① 默认值=现状 ② 参数钳制带 ③ 20 游戏日长跑不变量 ④ 固定种子逐点断言
const A = require('../dist/src/core/market-data/ai-opponents');
const { MarketDataService } = require('../dist/src/core/market-data/market-data.service');

describe('Phase F 自适应参数：默认值=现状 + 钳制带', () => {
  test('AI_PARAM_DEFAULTS 逐键等于 Phase E 前的硬编码现状（零回归基线）', () => {
    expect(A.AI_PARAM_DEFAULTS).toEqual({
      activityMul: 1, scaleMul: 1, takeProfit: 0.05, stopLoss: -0.03,
      herdWeight: 1, hotBias: 0, momentumGain: 1, restBudget: 0.6,
    });
    expect(A.defaultAiParams()).toEqual(A.AI_PARAM_DEFAULTS);
    expect(A.defaultAiParams()).not.toBe(A.AI_PARAM_DEFAULTS); // 返回副本，防共享污染
  });

  test('clampParams：越界收敛到带边界、非数值回落默认值（全部有限且在带内）', () => {
    const p = A.clampParams({
      activityMul: 99, scaleMul: -5, takeProfit: NaN, stopLoss: '-0.9',
      herdWeight: undefined, hotBias: 1e9, momentumGain: null, restBudget: 'abc',
    });
    for (const key of Object.keys(A.AI_PARAM_BOUNDS)) {
      const [lo, hi] = A.AI_PARAM_BOUNDS[key];
      expect(Number.isFinite(p[key])).toBe(true);
      expect(p[key]).toBeGreaterThanOrEqual(lo);
      expect(p[key]).toBeLessThanOrEqual(hi);
    }
    // 越界数值 → 贴边界（含数字字符串 '-0.9'）
    expect(p.activityMul).toBe(A.AI_PARAM_BOUNDS.activityMul[1]);
    expect(p.scaleMul).toBe(A.AI_PARAM_BOUNDS.scaleMul[0]);
    expect(p.hotBias).toBe(A.AI_PARAM_BOUNDS.hotBias[1]);
    expect(p.stopLoss).toBe(A.AI_PARAM_BOUNDS.stopLoss[0]);
    // 非数值（NaN/undefined/null/非数字字符串）→ 默认值
    expect(p.takeProfit).toBe(A.AI_PARAM_DEFAULTS.takeProfit);
    expect(p.herdWeight).toBe(A.AI_PARAM_DEFAULTS.herdWeight);
    expect(p.momentumGain).toBe(A.AI_PARAM_DEFAULTS.momentumGain);
    expect(p.restBudget).toBe(A.AI_PARAM_DEFAULTS.restBudget);
    expect(A.clampParams(undefined)).toEqual(A.AI_PARAM_DEFAULTS);
  });
});

describe('Phase F 绩效反馈：表现差 → 更保守（R1 单调性红线）', () => {
  const table = [-1, -0.5, 0, 0.5, 1].map((s) => A.applyPerfFeedback(A.AI_PARAM_DEFAULTS, s));

  test('s=-1 时全部参数不越线：活跃/规模/止盈/羊群 ≤ 默认，止损收紧（|stopLoss| ≤ 默认）', () => {
    const worst = table[0];
    expect(worst.activityMul).toBeLessThanOrEqual(1);
    expect(worst.scaleMul).toBeLessThanOrEqual(1);
    expect(worst.takeProfit).toBeLessThanOrEqual(A.AI_PARAM_DEFAULTS.takeProfit);
    expect(worst.herdWeight).toBeLessThanOrEqual(1);
    expect(Math.abs(worst.stopLoss)).toBeLessThanOrEqual(Math.abs(A.AI_PARAM_DEFAULTS.stopLoss));
  });

  test('s=-1 → +1 单调不减：活跃/规模/止盈/羊群/止损幅度逐点比较', () => {
    for (let i = 1; i < table.length; i++) {
      expect(table[i].activityMul).toBeGreaterThanOrEqual(table[i - 1].activityMul);
      expect(table[i].scaleMul).toBeGreaterThanOrEqual(table[i - 1].scaleMul);
      expect(table[i].takeProfit).toBeGreaterThanOrEqual(table[i - 1].takeProfit);
      expect(table[i].herdWeight).toBeGreaterThanOrEqual(table[i - 1].herdWeight);
      // stopLoss 为负值：止损"放宽"= 绝对值变大（数值更小），故按幅度比较
      expect(Math.abs(table[i].stopLoss)).toBeGreaterThanOrEqual(Math.abs(table[i - 1].stopLoss));
    }
    expect(table[2]).toEqual(A.AI_PARAM_DEFAULTS); // s=0 → 恰好回到默认（稳态无偏置）
  });

  test('perfScoreOf：样本 <3 不调整；中性输入 0；差绩效 < 0 < 好绩效；回撤扣分', () => {
    expect(A.perfScoreOf([], 0.5)).toBe(0);
    expect(A.perfScoreOf([{ equity: 100 }, { equity: 100 }], 0.5)).toBe(0);
    const flat = [100, 100, 100, 100, 100, 100].map((e) => ({ equity: e }));
    expect(A.perfScoreOf(flat, 0.5)).toBe(0);
    const good = [100, 102, 104, 106, 108, 110].map((e) => ({ equity: e }));
    const bad = [100, 98, 96, 94, 92, 90].map((e) => ({ equity: e }));
    expect(A.perfScoreOf(good, 0.7)).toBeGreaterThan(0.5);
    expect(A.perfScoreOf(bad, 0.3)).toBeLessThan(-0.5);
    // 同收益下回撤更大会扣分
    const peaky = [{ equity: 100 }, { equity: 150 }, { equity: 110 }, { equity: 120 }, { equity: 130 }];
    const smooth = [{ equity: 100 }, { equity: 110 }, { equity: 115 }, { equity: 120 }, { equity: 130 }];
    expect(A.perfScoreOf(peaky, 0.5)).toBeLessThan(A.perfScoreOf(smooth, 0.5));
  });
});

describe('Phase F 参数平滑：漂移包络有界（R2/C4）', () => {
  test('单步位移 ≤ ETA × 带宽，且输出恒在带内', () => {
    const target = A.clampParams({
      activityMul: A.AI_PARAM_BOUNDS.activityMul[1], scaleMul: A.AI_PARAM_BOUNDS.scaleMul[1],
      takeProfit: A.AI_PARAM_BOUNDS.takeProfit[1], stopLoss: A.AI_PARAM_BOUNDS.stopLoss[1],
      herdWeight: A.AI_PARAM_BOUNDS.herdWeight[1], hotBias: A.AI_PARAM_BOUNDS.hotBias[1],
      momentumGain: A.AI_PARAM_BOUNDS.momentumGain[1], restBudget: A.AI_PARAM_BOUNDS.restBudget[1],
    });
    const next = A.smoothParams(A.AI_PARAM_DEFAULTS, target);
    for (const key of Object.keys(A.AI_PARAM_BOUNDS)) {
      const [lo, hi] = A.AI_PARAM_BOUNDS[key];
      expect(next[key] - A.AI_PARAM_DEFAULTS[key]).toBeLessThanOrEqual(A.AI_ETA * (hi - lo) + 1e-12);
      expect(next[key]).toBeGreaterThanOrEqual(lo);
      expect(next[key]).toBeLessThanOrEqual(hi);
    }
  });

  test('20 步朝极端目标推进：恒在带内、无 NaN、且逐步单调趋近', () => {
    let cur = A.defaultAiParams();
    const target = A.applyPerfFeedback(A.AI_PARAM_DEFAULTS, 1);
    for (let i = 0; i < 20; i++) {
      const prev = cur;
      cur = A.smoothParams(cur, target);
      for (const key of Object.keys(A.AI_PARAM_BOUNDS)) {
        const [lo, hi] = A.AI_PARAM_BOUNDS[key];
        expect(Number.isFinite(cur[key])).toBe(true);
        expect(cur[key]).toBeGreaterThanOrEqual(lo);
        expect(cur[key]).toBeLessThanOrEqual(hi);
      }
      expect(cur.activityMul).toBeGreaterThanOrEqual(prev.activityMul); // 单调趋近（目标在默认之上）
    }
    expect(cur.activityMul).toBeCloseTo(target.activityMul, 3); // 20 步后基本到位
  });
});

describe('Phase F regime × 波动档系数复合（C8：高波动禁止更激进）', () => {
  test('volBucket=high：activity/scale/tp/herd/hot 复合系数一律 ≤1（含 bull×high）', () => {
    for (const regime of ['bull', 'bear', 'sideways']) {
      const c = A.regimeCoef(regime, 'high');
      for (const k of ['activityK', 'scaleK', 'tpK', 'herdK', 'hotK']) expect(c[k]).toBeLessThanOrEqual(1);
    }
  });

  test('bear/high 档 slK ≥ 1（止损只放宽或持平，不得收紧）', () => {
    for (const regime of ['bull', 'bear', 'sideways']) {
      expect(A.regimeCoef(regime, 'high').slK).toBeGreaterThanOrEqual(1);
      expect(A.regimeCoef(regime, 'normal').slK).toBeGreaterThanOrEqual(1);
      expect(A.regimeCoef(regime, 'low').slK).toBeGreaterThanOrEqual(1);
    }
    expect(A.regimeCoef('bear', 'high').activityK).toBeLessThan(1);
  });

  test('高波动档 hotProb ≤ 0.5（含 hotBias 拉满时）；常态档 ≤ 0.9', () => {
    const agent = A.AI_OPPONENT_DEFS[0];
    const pHot = A.clampParams({ hotBias: A.AI_PARAM_BOUNDS.hotBias[1] });
    expect(A.effectiveParams(agent, pHot, A.regimeCoef('bull', 'high')).hotProb).toBeLessThanOrEqual(0.5);
    expect(A.effectiveParams(agent, pHot, A.regimeCoef('bull', 'normal')).hotProb).toBeLessThanOrEqual(0.9);
    expect(A.regimeCoef('bull', 'high').hotProbCap).toBe(0.5);
  });

  test('effectiveParams：activity ≤ 0.95 上限、scale 为 ≥1 整数、全部字段有限且带内', () => {
    for (const agent of A.AI_OPPONENT_DEFS) {
      const eff = A.effectiveParams(agent, A.applyPerfFeedback(A.AI_PARAM_DEFAULTS, 1), A.regimeCoef('bull', 'low'));
      expect(eff.activity).toBeLessThanOrEqual(A.AI_ACTIVITY_CAP);
      expect(Number.isInteger(eff.scale)).toBe(true);
      expect(eff.scale).toBeGreaterThanOrEqual(1);
      for (const v of Object.values(eff)) expect(Number.isFinite(v)).toBe(true);
      expect(eff.takeProfit).toBeGreaterThanOrEqual(A.AI_PARAM_BOUNDS.takeProfit[0]);
      expect(eff.takeProfit).toBeLessThanOrEqual(A.AI_PARAM_BOUNDS.takeProfit[1]);
      expect(eff.stopLoss).toBeGreaterThanOrEqual(A.AI_PARAM_BOUNDS.stopLoss[0]);
      expect(eff.stopLoss).toBeLessThanOrEqual(A.AI_PARAM_BOUNDS.stopLoss[1]);
    }
  });

  test('volBucketOf：全市场剧烈波动 → high；平静 → low；空输入 → normal', () => {
    expect(A.volBucketOf([])).toBe('normal');
    expect(A.volBucketOf([{ ret: 0.05, vol: 0.02 }, { ret: -0.04, vol: 0.02 }])).toBe('high');
    expect(A.volBucketOf([{ ret: 0.001, vol: 0.01 }, { ret: -0.002, vol: 0.01 }])).toBe('low');
    expect(A.volBucketOf([{ ret: 0.02, vol: 0.03 }])).toBe('normal');
  });
});

describe('Phase F 本地 RF 树权重重加权（C3 零回归 / R8 门槛）', () => {
  const feats = { ret: 0.03, vol: 0.02, ofi: 0.5, cycle: 0, senti: 0.1 };

  test('权重 null 时 rfScoreWeighted 与 rfScore 严格相等；等权数组亦相等', () => {
    expect(A.rfScoreWeighted(feats, null)).toBe(A.rfScore(feats));
    expect(A.rfScoreWeighted(feats, new Array(A.RF_TREES.length).fill(1))).toBe(A.rfScore(feats));
    expect(A.rfScoreWeighted({}, null)).toBe(A.rfScore({}));
  });

  test('adaptTreeWeights：样本 < 门槛恒为 1；样本充足时权重在 [0.5,1.5] 且命中率高者更大', () => {
    const hit = new Array(8).fill(30), miss = new Array(8).fill(30);
    expect(A.adaptTreeWeights(hit, miss)).toEqual(new Array(8).fill(1)); // 60 < 门槛 60 边界 → 视为不足
    const hit2 = new Array(8).fill(90), miss2 = new Array(8).fill(10);
    const w = A.adaptTreeWeights(hit2, miss2);
    expect(w.every((x) => x >= 0.5 && x <= 1.5)).toBe(true);
    expect(w[0]).toBeGreaterThan(1);
    const mixed = A.adaptTreeWeights([80, 10, 0, 0, 0, 0, 0, 0], [20, 90, 0, 0, 0, 0, 0, 0]);
    expect(mixed[0]).toBeGreaterThan(mixed[1]);
    expect(mixed[1]).toBeLessThan(1);
  });

  test('decideDirection：gain 缩放信号（单调不降，存在增益触发档）、herdBias 透传、缺省 opts 与旧行为一致', () => {
    const up = { ret: 0.02, vol: 0.02, ofi: 0.3, cycle: 0, senti: 0.05 };
    const rng = () => 0.5;
    expect(A.decideDirection('trend', up, false, rng)).toBe(A.decideDirection('trend', up, false, rng, { gain: 1 }));
    expect(A.decideDirection('herd', up, true, rng, { herdBias: 1.4 })).toBe(1);
    // 扫描信号区间：高增益方向的看多强度不得低于低增益，且存在增益真正触发方向的档位
    let flipped = false;
    for (let i = 0; i < 60; i++) {
      const feats = { ret: 0.0005 + i * 0.0005, vol: 0.02, ofi: 0.3, cycle: 0, senti: 0.05 };
      const lo = A.decideDirection('trend', feats, false, rng, { gain: 0.5 });
      const hi = A.decideDirection('trend', feats, false, rng, { gain: 1.5 });
      expect(hi).toBeGreaterThanOrEqual(lo);
      if (hi === 1 && lo === 0) flipped = true;
    }
    expect(flipped).toBe(true);
  });
});

describe('Phase F 确定性随机（C6 固定种子逐点断言）', () => {
  test('agentRng：同 (day,tick,agent,salt) 序列逐点相同；换 salt/day 即不同', () => {
    const a = A.agentRng(3, 120, 'AI4', 'pick');
    const b = A.agentRng(3, 120, 'AI4', 'pick');
    const seqA = [a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b()];
    expect(seqA).toEqual(seqB);
    const other = A.agentRng(3, 120, 'AI4', 'qty');
    expect([other(), other(), other(), other()]).not.toEqual(seqA);
    const nextDay = A.agentRng(4, 120, 'AI4', 'pick');
    expect([nextDay(), nextDay(), nextDay(), nextDay()]).not.toEqual(seqA);
    for (const v of seqA) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
  });

  test('mulberry32/hash32：稳定且对分隔符敏感（("a","bc") ≠ ("ab","c")）', () => {
    expect(A.hash32('a|bc')).not.toBe(A.hash32('ab|c'));
    const r1 = A.mulberry32(42), r2 = A.mulberry32(42);
    expect([r1(), r1(), r1()]).toEqual([r2(), r2(), r2()]);
  });

  test('noise 分支固定只消耗 1 个随机数（可复现性修复：原实现调用两次）', () => {
    let calls = 0;
    const counting = () => { calls++; return 0.5; };
    A.decideDirection('noise', { ret: 0, vol: 0.02, ofi: 0, cycle: 0, senti: 0 }, false, counting);
    expect(calls).toBe(1);
  });
});

// ─── 引擎集成：20 游戏日长跑 + 不变量 ───
function makeService(opts = {}) {
  const s = new MarketDataService(null, null, null, null, 'CN');
  const stocks = new Map();
  const specs = [
    ['T1', '银行'], ['T2', '半导体'], ['T3', '白酒'],
  ];
  for (const [symbol, industry] of specs) {
    s.stocks.set(symbol, {
      symbol, name: symbol, industry, market: 'CN', price: 10, intrinsic: 10,
      volatility: 0.02, lastReturn: 0, prevClose: 10, dayOpen: 10, dayHigh: 10, dayLow: 10,
      dayVolume: 0, minuteCounter: 0, baseVolume: 10000, avgVolume: 10000, prevVolume: 10000, lastVolume: 0,
      kline1min: [], kline5min: [], klineDaily: [], current1min: null, current5min: null, currentDaily: null,
      trendCounter: 0, trendDirection: 0, trendAccumulated: 0, isTrending: false,
      fund: null, nextReportDay: 999, pead: null, changePct: 0,
    });
    s.industryCycles.set(industry, 'expansion');
    stocks.set(symbol, s.stocks.get(symbol));
  }
  s.factors = { '宏观经济': 0, '行业景气': 0, '公司特质': 0, '市场情绪': 0, '国际环境': 0, '政策风险': 0, '消费景气': 0 };
  const engine = {
    virtualOrders: [], marketOrders: [],
    pruneExpiredVirtualOrders() { },
    placeVirtualOrder(symbol, side, price, qty, ttl) { engine.virtualOrders.push({ symbol, side, price, qty, ttl }); },
    executeVirtualMarketOrder(symbol, side, qty) {
      const st = stocks.get(symbol);
      const price = Number(st.price);
      const filled = Math.max(1, Math.floor(qty * 0.6));
      engine.marketOrders.push({ symbol, side, qty, price });
      return { filledQuantity: filled, avgPrice: price, totalCost: Number((filled * price).toFixed(2)), counterFills: [] };
    },
  };
  s.engine = engine;
  s.marketRegime = opts.regime || 'sideways';
  return { s, engine, stocks };
}

async function runDays(s, days, ticksPerDay = 60) {
  for (let day = 1; day <= days; day++) {
    s.gameDay = day;
    for (let tick = 1; tick <= ticksPerDay; tick++) {
      s.tickCount = tick;
      // 行情随机游走（长跑压力：价格与波动率持续变化）
      for (const st of s.stocks.values()) {
        st.price = Math.max(1, st.price * (1 + (A.agentRng(day, tick, st.symbol, 'px')() - 0.5) * 0.02));
        st.changePct = ((st.price - st.dayOpen) / st.dayOpen) * 100;
      }
      await s.applyAiTrading();
    }
    s.markAiEquityDaily();
  }
}

describe('Phase F 引擎集成：20 游戏日长跑不变量（C6/C10）', () => {
  test('20 日长跑：无 NaN、账本非负、参数恒在钳制带内、快照长度有界', async () => {
    const { s, engine } = makeService({ regime: 'bull' });
    await runDays(s, 20);
    expect(s.aiLedger.length).toBe(10);
    for (const ledger of s.aiLedger) {
      expect(Number.isFinite(Number(ledger.cash))).toBe(true);
      expect(Number(ledger.cash)).toBeGreaterThanOrEqual(0); // 现金约束：买单受 0.8×cash 限制
      for (const [, pos] of ledger.positions.entries()) expect(Number(pos.qty)).toBeGreaterThanOrEqual(0);
      expect(ledger.equityHistory.length).toBeLessThanOrEqual(60);
      expect(ledger.perfMarks.length).toBeLessThanOrEqual(A.AI_PERF_WINDOW + 1);
      for (const key of Object.keys(A.AI_PARAM_BOUNDS)) {
        const [lo, hi] = A.AI_PARAM_BOUNDS[key];
        expect(ledger.params[key]).toBeGreaterThanOrEqual(lo);
        expect(ledger.params[key]).toBeLessThanOrEqual(hi);
      }
      for (const h of ledger.equityHistory) expect(Number.isFinite(h.equity)).toBe(true);
    }
    expect(engine.virtualOrders.length + engine.marketOrders.length).toBeGreaterThan(0); // 长跑确有交易行为
  });

  test('长跑：买单量恒 ≤ floor(cash×0.8/price)（账本闸门不参与参数化——C9 红线）', async () => {
    const { s, engine } = makeService({ regime: 'bull' });
    const cashBefore = s.aiLedger.map((l) => Number(l.cash));
    await runDays(s, 8, 40);
    let checked = 0;
    for (const o of engine.marketOrders.filter((x) => x.side === 'buy').slice(0, 200)) {
      const cap = Math.floor((Math.max(...cashBefore) * 0.8) / o.price);
      expect(o.qty).toBeLessThanOrEqual(Math.max(cap, 1));
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  test('自适应确实在学习：20 日后至少一个对手盘参数偏离默认且 treeHit 有累计', async () => {
    const { s } = makeService({ regime: 'bull' });
    await runDays(s, 20);
    const moved = s.aiLedger.some((l) => Math.abs(l.params.activityMul - 1) > 1e-6 || Math.abs(l.params.scaleMul - 1) > 1e-6);
    expect(moved).toBe(true);
    expect(s.aiLedger.some((l) => l.treeHit.some((v) => v > 0))).toBe(true);
    expect(s.aiLedger.every((l) => l.treeHit.every((v) => Number.isFinite(v) && v >= 0))).toBe(true);
  });

  test('冷启原子复位（C10）：新服务参数=默认、perfMarks 空、树权重 null、计数清零', () => {
    const { s } = makeService();
    for (const ledger of s.aiLedger) {
      expect(ledger.params).toEqual(A.AI_PARAM_DEFAULTS);
      expect(ledger.perfMarks).toEqual([]);
      expect(ledger.treeWeights).toBe(null);
      expect(ledger.treeHit).toEqual(new Array(A.RF_TREES.length).fill(0));
      expect(ledger.treeMiss).toEqual(new Array(A.RF_TREES.length).fill(0));
    }
    expect(s.aiAdaptiveEnabled).toBe(true); // 默认开启
  });

  test('AI_ADAPTIVE_ENABLED=false：参数保持默认、树权重 null、学习计数不累计（应急回滚态）', async () => {
    process.env.AI_ADAPTIVE_ENABLED = 'false';
    try {
      const { s } = makeService({ regime: 'bear' });
      await runDays(s, 12, 40);
      for (const ledger of s.aiLedger) {
        expect(ledger.params).toEqual(A.AI_PARAM_DEFAULTS);
        expect(ledger.treeWeights).toBe(null);
        expect(ledger.treeHit).toEqual(new Array(A.RF_TREES.length).fill(0));
      }
    } finally {
      delete process.env.AI_ADAPTIVE_ENABLED;
    }
  });

  test('getAiOpponents：暴露聚合档位（level/两个乘数/regime），不含裸参数键（C1）', async () => {
    const { s } = makeService({ regime: 'bear' });
    await runDays(s, 6, 30);
    const list = s.getAiOpponents();
    expect(list.length).toBe(10);
    for (const o of list) {
      expect(o.adaptive).toBeTruthy();
      expect(['aggressive', 'normal', 'cautious']).toContain(o.adaptive.level);
      expect(typeof o.adaptive.activityMul).toBe('number');
      expect(typeof o.adaptive.scaleMul).toBe('number');
      expect(['bull', 'bear', 'sideways']).toContain(o.adaptive.regime);
      expect(['low', 'normal', 'high']).toContain(o.adaptive.vol);
      expect(o.adaptive.volLabel).toBeTruthy();
      expect(o.adaptive.enabled).toBe(true);
      expect(Object.keys(o.adaptive)).not.toContain('takeProfit');
      expect(Object.keys(o.adaptive)).not.toContain('stopLoss');
      expect(Object.keys(o.adaptive)).not.toContain('restBudget');
    }
    expect(list.some((o) => o.adaptive.regimeLabel)).toBe(true);
  });

  test('mindsetOf：档位映射与乘数一致（≥1.15 激进 / ≤0.85 谨慎 / 中间稳健）', () => {
    expect(A.mindsetOf(1.5)).toBe('aggressive');
    expect(A.mindsetOf(0.5)).toBe('cautious');
    expect(A.mindsetOf(1)).toBe('normal');
    expect(A.mindsetOf(NaN)).toBe('normal');
  });
});
