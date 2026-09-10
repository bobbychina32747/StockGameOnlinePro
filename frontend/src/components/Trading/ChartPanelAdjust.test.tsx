// 回归用例：ChartPanel 复权函数（useCallback + useMemo 依赖修复的直测）
// 原缺陷：applyAdjustment 是每次渲染新建的闭包且未进依赖数组，adjMode 切换后 useMemo 可能命中旧缓存
import { applyAdjustmentPure } from './ChartPanel';

// 复权基准日是本地时间 2024-01-01 00:00（day 0），故这里用本地时间构造：day 差值 = 自然日差，不受时区影响
const bar = (localIso: string, open: number) => ({
  time: new Date(localIso), open, high: open + 1, low: open - 1, close: open + 0.5, volume: 100,
});

const BARS = [bar('2024-01-01T12:00:00', 10), bar('2024-01-11T12:00:00', 10)];
const STOCK = { adjustmentSeries: [{ day: 0, factor: 1 }, { day: 10, factor: 1.5 }] };

describe('ChartPanel 复权（applyAdjustmentPure）', () => {
  it('none 原样返回（含引用不变），无分红序列时也原样返回', () => {
    expect(applyAdjustmentPure(BARS, 'none', STOCK)).toBe(BARS);
    expect(applyAdjustmentPure(BARS, 'forward', {})).toBe(BARS);
  });

  it('forward 按各自日期取累计因子，backward 再除以最新因子', () => {
    const fwd = applyAdjustmentPure(BARS, 'forward', STOCK);
    expect(fwd[0].open).toBe(10);   // day 0 → factor 1，保持不变
    expect(fwd[1].open).toBe(15);   // day 10 → factor 1.5

    const bwd = applyAdjustmentPure(BARS, 'backward', STOCK);
    expect(bwd[0].open).toBeCloseTo(10 / 1.5, 6);
    expect(bwd[1].open).toBeCloseTo(15 / 1.5, 6);
  });

  it('同一份输入在相同 adjMode 下结果稳定（可安全作为 useMemo 依赖的纯函数）', () => {
    expect(applyAdjustmentPure(BARS, 'forward', STOCK)).toEqual(applyAdjustmentPure(BARS, 'forward', STOCK));
  });
});
