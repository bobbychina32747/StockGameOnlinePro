import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi } from '../../services/api.client';
import { useAuthStore } from '../../store';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isRegister, setIsRegister] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const setAuth = useAuthStore((s) => s.setAuth);
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const fn = isRegister ? authApi.register : authApi.login;
      const data = await fn(username, password);
      setAuth(data.token, { id: data.user.id, username: data.user.username, role: data.user.role });
      navigate('/');
    } catch (err: any) {
      const msg = err?.response?.data?.message || '操作失败，请重试';
      setError(Array.isArray(msg) ? msg[0] : msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>StockSim Pro</h1>
        <p className="subtitle">专业炒股模拟交易平台</p>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>用户名</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="输入用户名"
              required
            />
          </div>

          <div className="form-group">
            <label>密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="输入密码"
              required
            />
          </div>

          {error && <div className="error">{error}</div>}

          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? '处理中...' : isRegister ? '注册' : '登录'}
          </button>
        </form>

        <div className="switch">
          {isRegister ? (
            <>已有账号？<a onClick={() => { setIsRegister(false); setError(''); }}>去登录</a></>
          ) : (
            <>没有账号？<a onClick={() => { setIsRegister(true); setError(''); }}>去注册</a></>
          )}
        </div>
      </div>
    </div>
  );
}
