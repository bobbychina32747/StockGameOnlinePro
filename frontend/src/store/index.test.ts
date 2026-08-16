import { useMarketStore, useUIStore } from './index';

describe('useMarketStore.addTick', () => {
  beforeEach(() => {
    useMarketStore.setState({ prices: {}, ticks: [], klines: {} });
  });

  it('合法 tick 更新价格并生成 1min K 线', () => {
    useMarketStore.getState().addTick({ symbol: 'T1', price: 10.5, volume: 100, timestamp: 5 });
    const s = useMarketStore.getState();
    expect(s.prices.T1).toBe(10.5);
    expect(s.klines.T1['1min']).toHaveLength(1);
    expect(s.klines.T1['1min'][0]).toMatchObject({ open: 10.5, close: 10.5, volume: 100 });
  });

  it('同一分钟 tick 合并 close/high/low 并累加 volume', () => {
    const st = useMarketStore.getState();
    st.addTick({ symbol: 'T1', price: 10, volume: 10, timestamp: 5 });
    st.addTick({ symbol: 'T1', price: 11, volume: 20, timestamp: 5 });
    st.addTick({ symbol: 'T1', price: 9, volume: 30, timestamp: 5 });
    const bar = useMarketStore.getState().klines.T1['1min'][0];
    expect(bar).toMatchObject({ open: 10, high: 11, low: 9, close: 9, volume: 60 });
  });

  it('不同分钟开新 K 线', () => {
    const st = useMarketStore.getState();
    st.addTick({ symbol: 'T1', price: 10, volume: 10, timestamp: 5 });
    st.addTick({ symbol: 'T1', price: 11, volume: 10, timestamp: 6 });
    expect(useMarketStore.getState().klines.T1['1min']).toHaveLength(2);
  });

  it('非法 tick（NaN/负数价格/异常 timestamp）被忽略', () => {
    const st = useMarketStore.getState();
    st.addTick({ symbol: 'T1', price: NaN, volume: 10, timestamp: 5 });
    st.addTick({ symbol: 'T1', price: -1, volume: 10, timestamp: 5 });
    st.addTick({ symbol: 'T1', price: 10, volume: 10, timestamp: -1 });
    st.addTick({ symbol: 'T1', price: 10, volume: 10, timestamp: 1e12 });
    const s = useMarketStore.getState();
    expect(s.ticks).toHaveLength(0);
    expect(Object.keys(s.prices)).toHaveLength(0);
  });
});

describe('useUIStore', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('toggleFavorite 增删自选并持久化', () => {
    useUIStore.setState({ favoriteSymbols: [] });
    useUIStore.getState().toggleFavorite('T1');
    expect(useUIStore.getState().favoriteSymbols).toEqual(['T1']);
    expect(localStorage.getItem('ss.fav')).toBe('T1');
    useUIStore.getState().toggleFavorite('T1');
    expect(useUIStore.getState().favoriteSymbols).toEqual([]);
  });

  it('setTheme 切换主题并持久化', () => {
    useUIStore.getState().setTheme('light');
    expect(useUIStore.getState().theme).toBe('light');
    expect(localStorage.getItem('ss.theme')).toBe('light');
  });

  it('addNotification 自动 3 秒移除', () => {
    jest.useFakeTimers();
    useUIStore.setState({ notifications: [] });
    useUIStore.getState().addNotification('测试通知', 'info');
    expect(useUIStore.getState().notifications).toHaveLength(1);
    jest.advanceTimersByTime(3000);
    expect(useUIStore.getState().notifications).toHaveLength(0);
    jest.useRealTimers();
  });
});
