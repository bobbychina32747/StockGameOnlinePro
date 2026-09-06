const { RiskManagerService } = require('../dist/src/core/risk-manager/risk-manager.service');

describe('RiskManagerService 风控逻辑', () => {
  let rm;

  beforeEach(() => {
    rm = new RiskManagerService(null, null, null, null);
  });

  describe('kellyCriterion 凯利公式', () => {
    test('avgLoss=0 返回 0（除零保护）', () => {
      expect(rm.kellyCriterion(0.6, 1, 0)).toBe(0);
    });

    test('正常计算：p=0.6 b=2 → 0.4', () => {
      // kelly = (b*p - q)/b = (2*0.6 - 0.4)/2 = 0.8/2 = 0.4
      expect(rm.kellyCriterion(0.6, 2, 1)).toBeCloseTo(0.4, 6);
    });

    test('负期望 clamp 到 0', () => {
      // p=0.3 b=1 → (1*0.3 - 0.7)/1 = -0.4 → 0
      expect(rm.kellyCriterion(0.3, 1, 1)).toBe(0);
    });

    test('结果始终在 [0,1] 区间', () => {
      const k = rm.kellyCriterion(0.99, 100, 1);
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThanOrEqual(1);
    });
  });

  describe('calculateVaR 历史模拟法', () => {
    test('历史不足返回 0', () => {
      expect(rm.calculateVaR('nonexistent')).toBe(0);
    });

    test('取分位数损失', () => {
      rm.equityHistory.set('acct1', [
        { return: 0.05 },
        { return: -0.03 },
        { return: -0.01 },
        { return: 0.02 },
        { return: -0.06 },
      ]);
      // 排序后 [-0.06,-0.03,-0.01,0.02,0.05]，95% 置信 → idx=floor(5*0.05)=0 → VaR=0.06
      expect(rm.calculateVaR('acct1', 0.95, 20)).toBeCloseTo(0.06, 6);
    });
  });

  describe('computeTier 段位评分（Phase D 数据驱动：收益30/回撤20/盈亏因子20/胜率20/活跃10）', () => {
    test('满分边界 → 王者 100 分', () => {
      const account = { initialEquity: 100000, totalEquity: 150000, peakEquity: 150000, totalTrades: 50 };
      rm.computeTier(account, { totalReturn: 0.5, maxDrawdown: 0, profitFactor: 2, winRate: 1, totalTrades: 50 });
      expect(account.tier).toBe('王者');
      expect(account.tierScore).toBe(100);
    });

    test('零流水账户 → 白银 23 分（回撤保底 0.7 + 活跃保底 0.3，不掉出白银）', () => {
      const account = { initialEquity: 100000, totalEquity: 100000, peakEquity: 100000, totalTrades: 0 };
      rm.computeTier(account, { totalReturn: 0, maxDrawdown: 0, profitFactor: 0, winRate: 0, totalTrades: 0 });
      expect(account.tier).toBe('白银');
      expect(account.tierScore).toBe(23);
    });
  });
});
