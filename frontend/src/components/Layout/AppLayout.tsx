import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuthStore, useMarketStore, useUIStore } from '../../store';
import { NotificationContainer } from '../UI/Notification';
export function AppLayout() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const prices = useMarketStore((s) => s.prices);
  const latestNews = useUIStore((s) => s.latestNews);
  const navigate = useNavigate();

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
          {prices['T1'] && (
            <span>芯片: <b>{prices['T1'].toFixed(2)}</b></span>
          )}
          {prices['C1'] && (
            <span>白酒: <b>{prices['C1'].toFixed(2)}</b></span>
          )}
          {prices['E2'] && (
            <span>锂电: <b>{prices['E2'].toFixed(2)}</b></span>
          )}
        </div>

        <div className="user-info">
          <span className="username">{user?.username}</span>
          <button className="btn btn-ghost btn-sm" onClick={handleLogout}>
            退出
          </button>
        </div>
      </header>

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
