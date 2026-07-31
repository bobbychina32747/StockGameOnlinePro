import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';

const API_BASE = '/api';

const api = axios.create({
  baseURL: API_BASE,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
});

// 自动注入 JWT Token
api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = localStorage.getItem('token');
  if (token && config.headers) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// 401 时清除token
api.interceptors.response.use(
  (res) => res,
  (err: AxiosError) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  },
);

// ─── Auth ───
export const authApi = {
  login: (username: string, password: string) =>
    api.post('/auth/login', { username, password }).then((r) => r.data),
  register: (username: string, password: string) =>
    api.post('/auth/register', { username, password }).then((r) => r.data),
};

// ─── Account (所有接口接受 mode 参数) ───
export const accountApi = {
  get: (mode: string = 'US') => api.get(`/account?mode=${mode}`).then((r) => r.data),
  metrics: (mode: string = 'US') => api.get(`/account/metrics?mode=${mode}`).then((r) => r.data),
  history: (mode: string = 'US') => api.get(`/account/history?mode=${mode}`).then((r) => r.data),
  setLeverage: (mode: string, leverage: number) =>
    api.post(`/account/leverage?mode=${mode}`, { leverage }).then((r) => r.data),
  reset: (mode: string, preset: string) =>
    api.post(`/account/reset?mode=${mode}`, { preset }).then((r) => r.data),
};

// ─── Trading (所有接口接受 mode 参数) ───
export const tradingApi = {
  placeOrder: (mode: string, data: {
    symbol: string; type: string; side: string; quantity: number; price?: number; triggerPrice?: number;
  }) => api.post(`/trading/order?mode=${mode}`, data).then((r) => r.data),
  cancelOrder: (mode: string, id: string) =>
    api.delete(`/trading/order/${id}?mode=${mode}`).then((r) => r.data),
  getPending: (mode: string = 'US') =>
    api.get(`/trading/orders/pending?mode=${mode}`).then((r) => r.data),
  getHistory: (mode: string = 'US') =>
    api.get(`/trading/history?mode=${mode}`).then((r) => r.data),
};

// ─── Market ───
export const marketApi = {
  prices: () => api.get('/market/prices').then((r) => r.data),
  stocks: () => api.get('/market/stocks').then((r) => r.data),
  indices: () => api.get('/market/indices').then((r) => r.data),
  reports: (symbol?: string) => api.get(`/market/reports${symbol ? '?symbol=' + symbol : ''}`).then((r) => r.data),
  backtest: (params: any) => api.get('/market/backtest', { params }).then((r) => r.data),
  klines: (symbol: string, timeframe: string) =>
    api.get(`/market/klines?symbol=${symbol}&timeframe=${timeframe}`).then((r) => r.data),
  orderBook: (symbol: string) =>
    api.get(`/market/orderbook?symbol=${symbol}`).then((r) => r.data),
};

// ─── Ranking ───
export const rankingApi = {
  get: (limit = 20, sort?: string) => api.get(`/ranking?limit=${limit}&sort=${sort || 'totalReturn'}`).then((r) => r.data),
};

// ─── Fund ───
export const fundApi = {
  list: () => api.get('/fund').then((r) => r.data),
  subscribe: (id: string, amount: number, mode: string = 'US') =>
    api.post(`/fund/${id}/subscribe?amount=${amount}&mode=${mode}`).then((r) => r.data),
  redeem: (id: string, shares: number, mode: string = 'US') =>
    api.post(`/fund/${id}/redeem?shares=${shares}&mode=${mode}`).then((r) => r.data),
};

export default api;
