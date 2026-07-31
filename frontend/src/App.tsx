import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './store';
import { AppLayout } from './components/Layout/AppLayout';
import Login from './pages/Login/Login';
import Dashboard from './pages/Dashboard/Dashboard';
import Ranking from './pages/Ranking/Ranking';
import Profile from './pages/Profile/Profile';
import Backtest from './pages/Backtest/Backtest';
import Transactions from './pages/Transactions/Transactions';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
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
            <AppLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="ranking" element={<Ranking />} />
        <Route path="backtest" element={<Backtest />} />
        <Route path="transactions" element={<Transactions />} />
        <Route path="profile" element={<Profile />} />
      </Route>
    </Routes>
  );
}
