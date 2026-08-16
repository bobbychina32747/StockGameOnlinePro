import { Routes, Route, Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuthStore } from './store';
import { AppLayout } from './components/Layout/AppLayout';
import ErrorBoundary from './components/UI/ErrorBoundary';
import Login from './pages/Login/Login';
import Dashboard from './pages/Dashboard/Dashboard';
import Ranking from './pages/Ranking/Ranking';
import Profile from './pages/Profile/Profile';
import Backtest from './pages/Backtest/Backtest';
import Transactions from './pages/Transactions/Transactions';

function ProtectedRoute({ children }: { children: ReactNode }) {
  const token = useAuthStore((s) => s.token);
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  const token = useAuthStore((s) => s.token);

  return (
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
  );
}
