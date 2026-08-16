// P1 盘后回放加速器：纯逻辑（交易日切分 / 倍速循环 / 时间标签），与 ChartPanel UI 解耦可单测

export interface TimeBar {
  time: Date | string;
}

// 按交易日切分 1min 序列（时间按本地日历天分组，升序保序）
export function barsForDay<T extends TimeBar>(src: T[], day: string): T[] {
  return src.filter((k) => new Date(k.time).toDateString() === day);
}

// 升序去重的交易日列表
export function replayDaysOf<T extends TimeBar>(src: T[]): string[] {
  const days: string[] = [];
  for (const k of src) {
    const ds = new Date(k.time).toDateString();
    if (days[days.length - 1] !== ds) days.push(ds);
  }
  return days;
}

// 倍速循环：1x → 4x → 16x → 1x
export function nextReplaySpeed(current: number): number {
  return current === 1 ? 4 : current === 4 ? 16 : 1;
}

// 当前游标 bar 的 HH:MM 标签（越界钳制）
export function replayTimeLabelOf(bars: TimeBar[], index: number): string {
  if (!bars.length) return '-';
  const d = new Date(bars[Math.max(0, Math.min(index, bars.length - 1))].time);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}
