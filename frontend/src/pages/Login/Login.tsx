import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { siteAuthApi, siteLoginUrl, type GameAccountSetup, type GameSession } from '../../services/site-auth';
import { useAuthStore } from '../../store';

export default function Login() {
  const [setup, setSetup] = useState<GameAccountSetup | null>(null);
  const [linking, setLinking] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const finish = (session: GameSession) => {
    useAuthStore.getState().setAuth(session.token, session.user);
    navigate('/', { replace: true });
  };
  const message = (error: any) => {
    const value = error.response?.data?.message;
    return Array.isArray(value) ? value[0] : value || '连接失败，请稍后重试';
  };
  useEffect(() => {
    let active = true;
    const tokenBefore = useAuthStore.getState().token;
    siteAuthApi.session().then(session => {
      if (!active || useAuthStore.getState().token !== tokenBefore) return;
      if ('token' in session) finish(session);
      else setSetup(session);
    }).catch(error => {
      if (active && error.response?.status !== 401) setError(message(error));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const create = async () => {
    setLoading(true); setError('');
    try {
      const session = await siteAuthApi.session(true);
      if ('token' in session) finish(session);
      else setError('请重新登录站点账号');
    } catch (error) { setError(message(error)); }
    finally { setLoading(false); }
  };
  const link = async (event: FormEvent) => {
    event.preventDefault(); setLoading(true); setError('');
    try { finish(await siteAuthApi.link(username, password)); }
    catch (error) { setError(message(error)); }
    finally { setLoading(false); setPassword(''); }
  };

  return <div className="login-page"><div className="login-card">
    <h1>StockSim Pro</h1>
    <p className="subtitle">用 bobbycn.cc 站点账号登录</p>
    {loading && !linking && <p role="status">正在连接站点账号…</p>}
    {setup ? <>
      <p>你好，{setup.identity.username}。请选择游戏账号：</p>
      {linking ? <form onSubmit={link}>
        <p className="subtitle">绑定后保留旧账号的资金、持仓和交易记录。</p>
        <div className="form-group"><label htmlFor="old-username">旧游戏用户名</label>
          <input id="old-username" autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} required maxLength={50} /></div>
        <div className="form-group"><label htmlFor="old-password">旧游戏密码</label>
          <input id="old-password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required /></div>
        <button className="btn btn-primary" disabled={loading}>{loading ? '正在绑定…' : '绑定并进入游戏'}</button>
        <button type="button" className="btn" disabled={loading} onClick={() => { setLinking(false); setPassword(''); setError(''); }}>返回</button>
      </form> : <>
        <button className="btn btn-primary" disabled={loading} onClick={() => setLinking(true)}>绑定旧游戏账号</button>
        <p className="subtitle">首次游玩可创建新账户；已有资产请先绑定旧账号。</p>
        <button className="btn" disabled={loading} onClick={create}>首次游玩，创建游戏账户</button>
      </>}
    </> : !loading && <>
      <p>在站点登录后，将自动返回游戏。已登录的站点账号可直接进入。</p>
      <a className="btn btn-primary" href={siteLoginUrl()}>使用站点账号登录</a>
      <p className="switch">没有站点账号？<a href="https://bobbycn.cc/register/">注册站点账号</a></p>
    </>}
    {setup && <p className="switch"><a href={siteLoginUrl()}>重新登录 / 切换站点账号</a></p>}
    {error && <p className="error" role="alert">{error}</p>}
  </div></div>;
}
