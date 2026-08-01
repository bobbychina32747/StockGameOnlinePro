import { create } from 'zustand';
import api from '../services/api.client';

// ─── 用户/认证 Store ───
interface AuthState {
  token: string | null;
  user: { id: string; username: string; role: string } | null;
  setAuth: (token: string, user: { id: string; username: string; role: string }) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: localStorage.getItem('token'),
  user: JSON.parse(localStorage.getItem('user') || 'null'),
  setAuth: (token, user) => {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    set({ token, user });
  },
  logout: () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    set({ token: null, user: null });
  },
}));

// ─── 行情数据 Store ───
interface TickData {
  symbol: string;
  price: number;
  volume: number;
  timestamp: number;
}

interface MarketState {
  prices: Record<string, number>;
  ticks: TickData[];
  klines: Record<string, Record<string, any[]>>;
  orderBook: Record<string, any>;
  marketRegime: string;
  gameDay: number;
  stocks: any[];
  setStocks: (stocks: any[]) => void;
  setPrices: (prices: Record<string, number>) => void;
  addTick: (tick: TickData) => void;
  setKlines: (symbol: string, tf: string, data: any[]) => void;
  setOrderBook: (symbol: string, book: any) => void;
}

export const useMarketStore = create<MarketState>((set) => ({
  prices: {},
  ticks: [],
  klines: {},
  orderBook: {},
  marketRegime: 'sideways',
  gameDay: 0,
  stocks: [],
  setStocks: (stocks) => set({ stocks }),
  setPrices: (prices) => set({ prices }),
  addTick: (tick) =>
    set((state) => {
      const prices = { ...state.prices, [tick.symbol]: tick.price };
      const ticks = [...state.ticks.slice(-100), tick];
      // Q5：由 tick 实时维护 1min K 线（tick=1分钟，后端 bar 时间公式同步复现）
      const gameDay = Math.floor(tick.timestamp / 390);
      const dayTick = tick.timestamp % 390;
      const time = new Date(2024, 0, 1 + gameDay, 9, 30 + dayTick).toISOString();
      const klines = { ...state.klines };
      const symKlines = { ...(klines[tick.symbol] || {}) };
      const arr = (symKlines['1min'] || []).slice();
      const last = arr[arr.length - 1];
      if (last && new Date(last.time).getTime() === new Date(time).getTime()) {
        // 同一分钟：更新 close/high/low，累加 volume
        arr[arr.length - 1] = {
          ...last,
          close: tick.price,
          high: Math.max(last.high, tick.price),
          low: Math.min(last.low, tick.price),
          volume: last.volume + tick.volume,
        };
      } else {
        arr.push({ time, open: tick.price, high: tick.price, low: tick.price, close: tick.price, volume: tick.volume });
        // 大 cap：session 内头部不滚动（防 LoD 头部桶重排 = 历史只读）
        if (arr.length > 50000) arr.shift();
      }
      symKlines['1min'] = arr;
      klines[tick.symbol] = symKlines;
      return { prices, ticks, klines };
    }),
  setKlines: (symbol, tf, data) =>
    set((state) => ({
      klines: {
        ...state.klines,
        [symbol]: { ...(state.klines[symbol] || {}), [tf]: data },
      },
    })),
  setOrderBook: (symbol, book) =>
    set((state) => ({ orderBook: { ...state.orderBook, [symbol]: book } })),
}));

// ─── 账户 Store ───
interface AccountState {
  account: any | null;
  positions: any[];
  fetchAccount: (mode?: string) => Promise<void>;
  setAccount: (data: any) => void;
}

export const useAccountStore = create<AccountState>((set) => ({
  account: null,
  positions: [],
  fetchAccount: async (mode: string = 'US') => {
    try {
      const data = await api.get(`/account?mode=${mode}`).then((r) => r.data);
      set({ account: data.account, positions: data.positions || [] });
    } catch (e) {
      console.error('获取账户失败', e);
    }
  },
  setAccount: (data) => set({ account: data.account, positions: data.positions || [] }),
}));

// ─── UI Store ───
interface UIState {
  notifications: { id: number; message: string; type: 'info' | 'success' | 'error' }[];
  addNotification: (message: string, type?: 'info' | 'success' | 'error') => void;
  removeNotification: (id: number) => void;
  selectedSymbol: string;
  setSelectedSymbol: (s: string) => void;
  selectedTimeframe: string;
  setSelectedTimeframe: (tf: string) => void;
  marketMode: string;
  setMarketMode: (mode: string) => void;
  detailSymbol: string | null;
  setDetailSymbol: (s: string | null) => void;
  latestNews: string;
  setLatestNews: (news: string) => void;
  newsHistory: string[];
  addNews: (news: string) => void;
  favoriteSymbols: string[];
  toggleFavorite: (s: string) => void;
  notices: any[];
  addNotice: (item: any) => void;
  markNoticesRead: () => void;
  animEnabled: boolean;
  setAnimEnabled: (v: boolean) => void;
  density: 'standard' | 'compact';
  setDensity: (d: 'standard' | 'compact') => void;
  theme: 'dark' | 'light';
  setTheme: (t: 'dark' | 'light') => void;
}

export const useUIStore = create<UIState>((set) => ({
  notifications: [],
  addNotification: (message, type = 'info') => {
    const id = Date.now();
    set((s) => ({ notifications: [...s.notifications, { id, message, type }] }));
    setTimeout(() => {
      set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) }));
    }, 3000);
  },
  removeNotification: (id) =>
    set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) })),
  selectedSymbol: localStorage.getItem('ss.symbol') || 'T1',
  setSelectedSymbol: (s) => { localStorage.setItem('ss.symbol', s); set({ selectedSymbol: s }); },
  selectedTimeframe: localStorage.getItem('ss.tf') || '1min',
  setSelectedTimeframe: (tf) => { localStorage.setItem('ss.tf', tf); set({ selectedTimeframe: tf }); },
  marketMode: localStorage.getItem('ss.mode') || 'US',
  setMarketMode: (mode) => { localStorage.setItem('ss.mode', mode); set({ marketMode: mode }); },
  detailSymbol: null,
  setDetailSymbol: (s) => set({ detailSymbol: s }),
  latestNews: '',
  setLatestNews: (news) => set({ latestNews: news }),
  newsHistory: [],
  favoriteSymbols: (localStorage.getItem('ss.fav') || '').split(',').filter(Boolean),
  toggleFavorite: (sym) =>
    set((s) => {
      const fav = s.favoriteSymbols.includes(sym)
        ? s.favoriteSymbols.filter((x) => x !== sym)
        : [...s.favoriteSymbols, sym];
      localStorage.setItem('ss.fav', fav.join(','));
      return { favoriteSymbols: fav };
    }),
  theme: (localStorage.getItem('ss.theme') as any) || 'dark',
  setTheme: (t) => { localStorage.setItem('ss.theme', t); set({ theme: t }); },
  // Q6 通知中心（localStorage 持久化，cap 50）
  notices: JSON.parse(localStorage.getItem('ss.notices') || '[]'),
  addNotice: (item) =>
    set((s) => {
      const notices = [{ id: Date.now() + Math.random(), read: false, time: Date.now(), ...item }, ...s.notices].slice(0, 50);
      localStorage.setItem('ss.notices', JSON.stringify(notices));
      return { notices };
    }),
  markNoticesRead: () =>
    set((s) => {
      const notices = s.notices.map((n) => ({ ...n, read: true }));
      localStorage.setItem('ss.notices', JSON.stringify(notices));
      return { notices };
    }),
  // Q12 设置：动画开关 + 字体密度
  animEnabled: localStorage.getItem('ss.anim') !== '0',
  setAnimEnabled: (v) => { localStorage.setItem('ss.anim', v ? '1' : '0'); set({ animEnabled: v }); },
  density: (localStorage.getItem('ss.density') as any) || 'standard',
  setDensity: (d) => { localStorage.setItem('ss.density', d); set({ density: d }); },
  addNews: (news) =>
    set((s) => ({
      latestNews: news,
      newsHistory: [news, ...s.newsHistory].slice(0, 20),
    })),
}));
