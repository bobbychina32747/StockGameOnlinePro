import { useEffect, useState } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuthStore, useMarketStore, useUIStore } from '../../store';
import { marketApi } from '../../services/api.client';
import { useWebSocket } from '../../hooks/useWebSocket';
import { NotificationContainer } from '../UI/Notification';
import { MarketIndexBar } from '../Trading/MarketIndexBar';
import { NoticeCenter } from './NoticeCenter';
import { SettingsModal } from './SettingsModal';
export function AppLayout() {
  // WS 生命周期挂在布局顶层：路由切换不断线（全站只初始化一次）
  useWebSocket();

  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const prices = useMarketStore((s) => s.prices);
  const latestNews = useUIStore((s) => s.latestNews);
  const navigate = useNavigate();
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);

  const [settingsOpen, setSettingsOpen] = useState(false);
  // P0 时间尺度标识：tickIntervalMs < 30s 视为高速回放（1秒=1分钟），否则实时行情
  const [tickIntervalMs, setTickIntervalMs] = useState<number | null>(null);

  useEffect(() => {
    marketApi.state().then((s: any) => {
      if (s && Number.isFinite(Number(s.tickIntervalMs))) setTickIntervalMs(Number(s.tickIntervalMs));
    }).catch(() => {});
  }, []);

  // C3 主题应用
  useEffect(() => {
    document.body.classList.toggle('theme-light', theme === 'light');
  }, [theme]);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="app-layout">
      {/* 顶部栏 */}
      <header className="top-bar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <span className="logo">📈 StockSim Pro</span>
          <nav className="nav-links">
            <NavLink to="/" end className={({ isActive }) => isActive ? 'active' : ''}>
              交易
            </NavLink>
            <NavLink to="/ranking" className={({ isActive }) => isActive ? 'active' : ''}>
              排行榜
            </NavLink>
            <NavLink to="/profile" className={({ isActive }) => isActive ? 'active' : ''}>
              个人中心
            </NavLink>
          </nav>
        </div>

        <div className="status-center">
          {tickIntervalMs !== null && (
            <span className="market-speed-badge" title="TICK_INTERVAL_MS 配置">
              {tickIntervalMs < 30000 ? '⏩ 高速回放（1秒=1分钟）' : '🕐 实时行情'}
            </span>
          )}
          {prices['T1'] && (
            <span>688001 芯澜: <b>{prices['T1'].toFixed(2)}</b></span>
          )}
          {prices['C1'] && (
            <span>600809 杏花: <b>{prices['C1'].toFixed(2)}</b></span>
          )}
          {prices['E2'] && (
            <span>300450 电芯: <b>{prices['E2'].toFixed(2)}</b></span>
          )}
        </div>

        <NoticeCenter />
        <button className="theme-toggle-btn" title="设置" onClick={() => setSettingsOpen(true)}>⚙️</button>
        <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        <button className="theme-toggle-btn" title="切换主题" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
        <div className="user-info">
          <span className="username">{user?.username}</span>
          <button className="btn btn-ghost btn-sm" onClick={handleLogout}>
            退出
          </button>
        </div>
      </header>

      <MarketIndexBar />

      {/* 主内容区 */}
      <div className="app-content">
        <div className="main-area">
          <Outlet />
        </div>
      </div>

      {/* 底部新闻滚动条 */}
      {latestNews && (
        <footer style={{
          height: 28,
          background: 'var(--bg-secondary)',
          borderTop: '1px solid var(--border-color)',
          display: 'flex',
          alignItems: 'center',
          padding: '0 12px',
          fontSize: 11,
          color: 'var(--color-warning)',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
        }}>
          <span style={{ fontWeight: 600, marginRight: 8, flexShrink: 0 }}>📰</span>
          <span style={{ animation: 'none' }}>{latestNews}</span>
        </footer>
      )}

      {/* 通知 */}
      <NotificationContainer />
    </div>
  );
}
