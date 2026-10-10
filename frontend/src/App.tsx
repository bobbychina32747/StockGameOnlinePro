import { Routes, Route, Navigate } from 'react-router-dom';
import { lazy, Suspense, type ReactNode } from 'react';
import { useAuthStore } from './store';
import { AppLayout } from './components/Layout/AppLayout';
import ErrorBoundary from './components/UI/ErrorBoundary';
import { useSiteSession } from './hooks/useSiteSession';
const Login = lazy(() => import('./pages/Login/Login'));
const Dashboard = lazy(() => import('./pages/Dashboard/Dashboard'));
const Ranking = lazy(() => import('./pages/Ranking/Ranking'));
const Profile = lazy(() => import('./pages/Profile/Profile'));
const Backtest = lazy(() => import('./pages/Backtest/Backtest'));
const Transactions = lazy(() => import('./pages/Transactions/Transactions'));

function ProtectedRoute({ children }: { children: ReactNode }) {
  const token = useAuthStore((s) => s.token);
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  const token = useAuthStore((s) => s.token);
  const ready = useSiteSession();
  if (!ready) return <div role="status">正在连接站点账号…</div>;

  return (
    <Suspense fallback={<div role="status" aria-live="polite">加载中…</div>}>
    <Routes>
      <Route path="/login" element={token ? <Navigate to="/" replace /> : <Login />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <ErrorBoundary label="布局">
              <AppLayout />
            </ErrorBoundary>
          </ProtectedRoute>
        }
      >
        <Route
          index
          element={
            <ErrorBoundary label="交易面板">
              <Dashboard />
            </ErrorBoundary>
          }
        />
        <Route
          path="ranking"
          element={
            <ErrorBoundary label="排行榜">
              <Ranking />
            </ErrorBoundary>
          }
        />
        <Route
          path="backtest"
          element={
            <ErrorBoundary label="回测">
              <Backtest />
            </ErrorBoundary>
          }
        />
        <Route
          path="transactions"
          element={
            <ErrorBoundary label="流水">
              <Transactions />
            </ErrorBoundary>
          }
        />
        <Route
          path="profile"
          element={
            <ErrorBoundary label="个人中心">
              <Profile />
            </ErrorBoundary>
          }
        />
      </Route>
    </Routes>
    </Suspense>
  );
}
