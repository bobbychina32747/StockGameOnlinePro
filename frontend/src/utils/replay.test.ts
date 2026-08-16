import { barsForDay, nextReplaySpeed, replayDaysOf, replayTimeLabelOf } from './replay';

// 本地时区构造，测试与时区无关
const mk = (y: number, mo: number, d: number, h: number, mi: number) => ({ time: new Date(y, mo, d, h, mi), close: 1 });

describe('replay.barsForDay', () => {
  const src = [
    mk(2024, 7, 27, 9, 30),
    mk(2024, 7, 27, 14, 0),
    mk(2024, 7, 28, 9, 31),
  ];

  it('只保留所选交易日的 bar 且保序', () => {
    expect(barsForDay(src, new Date(2024, 7, 27, 12, 0).toDateString()).length).toBe(2);
    expect(barsForDay(src, new Date(2024, 7, 28, 12, 0).toDateString()).length).toBe(1);
  });

  it('无匹配返回空数组', () => {
    expect(barsForDay(src, new Date(2024, 7, 29, 12, 0).toDateString())).toEqual([]);
  });
});

describe('replay.replayDaysOf', () => {
  it('升序去重交易日', () => {
    const days = replayDaysOf([
      mk(2024, 7, 27, 9, 30), mk(2024, 7, 27, 14, 0),
      mk(2024, 7, 28, 9, 31), mk(2024, 7, 28, 15, 0), mk(2024, 7, 29, 9, 32),
    ]);
    expect(days).toEqual([
      new Date(2024, 7, 27, 12, 0).toDateString(),
      new Date(2024, 7, 28, 12, 0).toDateString(),
      new Date(2024, 7, 29, 12, 0).toDateString(),
    ]);
  });
});

describe('replay.nextReplaySpeed', () => {
  it('1→4→16→1 循环', () => {
    expect(nextReplaySpeed(1)).toBe(4);
    expect(nextReplaySpeed(4)).toBe(16);
    expect(nextReplaySpeed(16)).toBe(1);
  });
});

describe('replay.replayTimeLabelOf', () => {
  it('输出 HH:MM 并钳制越界游标', () => {
    const bars = [mk(2024, 7, 27, 9, 35), mk(2024, 7, 27, 14, 7)];
    expect(replayTimeLabelOf(bars, 0)).toBe('9:35');
    expect(replayTimeLabelOf(bars, 1)).toBe('14:07');
    expect(replayTimeLabelOf(bars, 99)).toBe('14:07');
    expect(replayTimeLabelOf([], 0)).toBe('-');
  });
});
