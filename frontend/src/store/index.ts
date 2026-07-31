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
  setPrices: (prices) => set({ prices }),
  addTick: (tick) =>
    set((state) => ({
      prices: { ...state.prices, [tick.symbol]: tick.price },
      ticks: [...state.ticks.slice(-100), tick],
    })),
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
  latestNews: string;
  setLatestNews: (news: string) => void;
  newsHistory: string[];
  addNews: (news: string) => void;
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
  selectedSymbol: 'A',
  setSelectedSymbol: (s) => set({ selectedSymbol: s }),
  selectedTimeframe: '1min',
  setSelectedTimeframe: (tf) => set({ selectedTimeframe: tf }),
  latestNews: '',
  setLatestNews: (news) => set({ latestNews: news }),
  newsHistory: [],
  addNews: (news) =>
    set((s) => ({
      latestNews: news,
      newsHistory: [news, ...s.newsHistory].slice(0, 20),
    })),
}));
