import { useEffect, useState, memo } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuthStore, useMarketStore, useUIStore } from '../../store';
import { adminApi, marketApi } from '../../services/api.client';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useI18n } from '../../i18n';
import { NotificationContainer } from '../UI/Notification';
import { MarketIndexBar } from '../Trading/MarketIndexBar';
import { NoticeCenter } from './NoticeCenter';
import { SettingsModal } from './SettingsModal';
// Phase C: 顶栏行情条独立 memo 子组件（原 AppLayout 订阅整个 prices 对象 → 每 tick 全树重渲染）
const TopBarTicker = memo(function TopBarTicker() {
  // Phase G-1: 示例标的简称走字典（行情数据里的股票全名仍来自后端，不在此翻译）
  const { t } = useI18n();
  const p1 = useMarketStore((s) => s.prices['T1']);
  const p2 = useMarketStore((s) => s.prices['C1']);
  const p3 = useMarketStore((s) => s.prices['E2']);
  return (
    <>
      {p1 !== undefined && (
        <span>688001 {t('ticker.t1')}: <b>{p1.toFixed(2)}</b></span>
      )}
      {p2 !== undefined && (
        <span>600809 {t('ticker.c1')}: <b>{p2.toFixed(2)}</b></span>
      )}
      {p3 !== undefined && (
        <span>300450 {t('ticker.e2')}: <b>{p3.toFixed(2)}</b></span>
      )}
    </>
  );
});
export function AppLayout() {
  // WS 生命周期挂在布局顶层：路由切换不断线（全站只初始化一次）
  useWebSocket();

  // Phase G-1: 导航/状态区文案走 i18n 字典（默认 zh-CN，切换语言在设置面板）
  const { t } = useI18n();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const latestNews = useUIStore((s) => s.latestNews);
  const navigate = useNavigate();
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);

  const [settingsOpen, setSettingsOpen] = useState(false);
  // P0 时间尺度标识：tickIntervalMs < 30s 视为高速回放（1秒=1分钟），否则实时行情
  const [tickIntervalMs, setTickIntervalMs] = useState<number | null>(null);

  useEffect(() => {
    const sync = () => marketApi.state().then((s: any) => {
      if (s && Number.isFinite(Number(s.tickIntervalMs))) setTickIntervalMs(Number(s.tickIntervalMs));
      // P6 全服休市交易：公开状态同步全局（管理员开启后所有客户端解锁休市下单）
      if (s) useUIStore.setState({ debugGlobal: !!s.offHoursTrading });
      // Phase B: 盘后固定价格交易窗口（CN 15:00-15:30）
      if (s) useUIStore.setState({ postCloseTrading: !!(s.CN && s.CN.isPostCloseTrading) });
    }).catch(() => {});
    sync();
    const id = setInterval(sync, 30000);
    return () => clearInterval(id);
  }, []);

  // 管理员调试模式：布局挂载时同步服务端状态（刷新/直达交易页也生效；非管理员 403 静默忽略）
  useEffect(() => {
    if (user?.role === 'admin') {
      adminApi.debugStatus().then((d: any) => useUIStore.setState({ debugMode: !!d?.debug })).catch(() => {});
    }
  }, [user?.role]);

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
              {t('nav.trading')}
            </NavLink>
            <NavLink to="/ranking" className={({ isActive }) => isActive ? 'active' : ''}>
              {t('nav.ranking')}
            </NavLink>
            <NavLink to="/profile" className={({ isActive }) => isActive ? 'active' : ''}>
              {t('nav.profile')}
            </NavLink>
          </nav>
        </div>

        <div className="status-center">
          {tickIntervalMs !== null && (
            <span className="market-speed-badge" title={t('layout.speed.title')}>
              {tickIntervalMs < 30000 ? t('layout.speed.fast') : t('layout.speed.realtime')}
            </span>
          )}
          <TopBarTicker />
        </div>

        <NoticeCenter />
        <button className="theme-toggle-btn" title={t('layout.settings')} onClick={() => setSettingsOpen(true)}>⚙️</button>
        <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        <button className="theme-toggle-btn" title={t('layout.theme.toggle')} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
        <div className="user-info">
          <span className="username">{user?.username}</span>
          <button className="btn btn-ghost btn-sm" onClick={handleLogout}>
            {t('layout.logout')}
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
