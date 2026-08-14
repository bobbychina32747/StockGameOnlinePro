import { useEffect, useState } from 'react';
import { accountApi, adminApi } from '../../services/api.client';
import { useAuthStore, useUIStore } from '../../store';
import { AchievementBoard } from '../../components/Trading/AchievementBoard';
import { EquityCurve } from '../../components/Trading/EquityCurve';

const TIER_ICON: Record<string, string> = { 王者: '🐉', 大师: '👑', 钻石: '🔷', 铂金: '💎', 黄金: '🥇', 白银: '🥈', 青铜: '🥉' };

export default function Profile() {
  const user = useAuthStore((s) => s.user);
  // B1 多市场：绩效指标跟随当前市场模式
  const marketMode = useUIStore((s) => s.marketMode);
  const [metrics, setMetrics] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [debugOn, setDebugOn] = useState(false);
  const [reviews, setReviews] = useState<any[]>([]);

  // 交易复盘：拉取教训卡（个人 + 全局）
  useEffect(() => {
    accountApi.reviews().then((list) => { if (Array.isArray(list)) setReviews(list); }).catch(() => {});
    const t = setInterval(() => {
      accountApi.reviews().then((list) => { if (Array.isArray(list)) setReviews(list); }).catch(() => {});
    }, 30000);
    return () => clearInterval(t);
  }, []);

  // 管理员：读取调试模式状态（同步到全局 store，供下单面板/休市遮罩使用）
  const [debugGlobalOn, setDebugGlobalOn] = useState(false);
  useEffect(() => {
    if (user?.role === 'admin') {
      adminApi.debugStatus().then((d: any) => {
        setDebugOn(!!d?.debug);
        setDebugGlobalOn(!!d?.globalBypass);
        useUIStore.setState({ debugMode: !!d?.debug, debugGlobal: !!d?.globalBypass });
      }).catch(() => {});
    }
  }, [user?.role]);

  const setDebugMode = useUIStore((s) => s.setDebugMode);
  const toggleDebug = async () => {
    const next = !debugOn;
    try {
      const r = await adminApi.debug(next);
      setDebugOn(!!r?.debug);
      setDebugMode(!!r?.debug);
    } catch (e) {
      console.error('切换调试模式失败', e);
    }
  };

  // P6 全服休市交易：开启后所有用户均可休市下单（行情全时生成）
  const toggleDebugGlobal = async () => {
    const next = !debugGlobalOn;
    try {
      const r = await adminApi.debugGlobal(next);
      setDebugGlobalOn(!!r?.globalBypass);
      useUIStore.setState({ debugGlobal: !!r?.globalBypass });
      if (next) useUIStore.setState({ debugMode: true });
    } catch (e) {
      console.error('切换全服休市交易失败', e);
    }
  };

  useEffect(() => {
    const fetchMetrics = async () => {
      try {
        const data = await accountApi.metrics(marketMode);
        setMetrics(data);
      } catch (e) {
        console.error('获取绩效失败', e);
      } finally {
        setLoading(false);
      }
    };
    fetchMetrics();
  }, [marketMode]);

  if (loading) {
    return (
      <div className="profile-page">
        <div style={{ textAlign: 'center', padding: 40 }}>
          <div className="spinner" />
        </div>
      </div>
    );
  }

  const account = metrics?.account;
  const perf = metrics?.metrics;

  return (
    <div className="profile-page">
      <h2>👤 个人中心</h2>

      {/* 基本信息 */}
      <div className="card" style={{ marginBottom: 12 }}>
        <h3>基本信息</h3>
        <div className="info-row">
          <span className="label">用户名</span>
          <span className="value">{user?.username}</span>
        </div>
        <div className="info-row">
          <span className="label">角色</span>
          <span className="value">{user?.role === 'admin' ? '管理员' : '用户'}</span>
        </div>
        <div className="info-row">
          <span className="label">段位</span>
          <span className="value" style={{ fontSize: 15 }}>
            {TIER_ICON[account?.tier || '青铜']} {account?.tier || '青铜'}
            {account?.tierScore != null && <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 6 }}>评分 {account.tierScore}</span>}
          </span>
        </div>
        {/* 管理员调试模式：休市期间可生成行情/下单 */}
        {user?.role === 'admin' && (
          <div className="info-row" style={{ marginTop: 10, alignItems: 'center' }}>
            <span className="label">🧪 调试模式</span>
            <span className="value" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                className={`btn btn-sm ${debugOn ? 'btn-primary' : 'btn-ghost'}`}
                onClick={toggleDebug}
              >
                {debugOn ? '🔓 已开启（休市可交易）' : '🔒 已关闭'}
              </button>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>开启后休市期间也生成行情、可下单（仅管理员本人）</span>
            </span>
          </div>
        )}
        {/* P6 全服休市交易：所有用户休市可下单 */}
        {user?.role === 'admin' && (
          <div className="info-row" style={{ marginTop: 10, alignItems: 'center' }}>
            <span className="label">🌐 全服休市交易</span>
            <span className="value" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                className={`btn btn-sm ${debugGlobalOn ? 'btn-primary' : 'btn-ghost'}`}
                onClick={toggleDebugGlobal}
              >
                {debugGlobalOn ? '🔓 已开启（全服可休市下单）' : '🔒 已关闭'}
              </button>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>开启后所有用户休市期间均可下单，行情全时生成</span>
            </span>
          </div>
        )}
      </div>

      {/* 账户信息 */}
      <div className="card" style={{ marginBottom: 12 }}>
        <h3>账户信息</h3>
        <div className="info-row">
          <span className="label">初始资金</span>
          <span className="value">
            ¥{account ? Number(account.initialEquity).toLocaleString('zh-CN', { minimumFractionDigits: 2 }) : '---'}
          </span>
        </div>
        <div className="info-row">
          <span className="label">当前资产</span>
          <span className="value">
            ¥{account ? Number(account.totalEquity).toLocaleString('zh-CN', { minimumFractionDigits: 2 }) : '---'}
          </span>
        </div>
        <div className="info-row">
          <span className="label">峰值资产</span>
          <span className="value">
            ¥{account ? Number(account.peakEquity).toLocaleString('zh-CN', { minimumFractionDigits: 2 }) : '---'}
          </span>
        </div>
        <div className="info-row">
          <span className="label">杠杆倍数</span>
          <span className="value">{account ? `${account.leverage}x` : '---'}</span>
        </div>
      </div>

      {/* 绩效指标 */}
      {perf && (
        <div className="card">
          <h3>📊 绩效指标</h3>
          <div className="info-row">
            <span className="label">总收益率</span>
            <span className={`value ${Number(perf.totalReturn) >= 0 ? 'up' : 'down'}`}>
              {perf.totalReturn}
            </span>
          </div>
          <div className="info-row">
            <span className="label">夏普比率</span>
            <span className="value">{perf.sharpeRatio}</span>
          </div>
          <div className="info-row">
            <span className="label">最大回撤</span>
            <span className="value down">{perf.maxDrawdown}</span>
          </div>
          <div className="info-row">
            <span className="label">年化波动率</span>
            <span className="value">{perf.volatility}</span>
          </div>
          <div className="info-row">
            <span className="label">卡玛比率</span>
            <span className="value">{perf.calmarRatio}</span>
          </div>
          <div className="info-row">
            <span className="label">盈利日占比</span>
            <span className={Number(perf.winRate) >= 0.5 ? 'value up' : 'value down'}>
              {perf.winRate != null ? (Number(perf.winRate) * 100).toFixed(1) + '%' : '---'}
            </span>
          </div>
          <div className="info-row">
            <span className="label">累计成交笔数</span>
            <span className="value">{perf.totalTrades != null ? perf.totalTrades : '---'}</span>
          </div>
        </div>
      )}

      {/* Q4 历史净值曲线 */}
      <EquityCurve />

      {/* B3 成就系统 */}
      {perf && <AchievementBoard perf={perf} />}

      {/* 🧠 交易复盘：吃一堑长一智 */}
      <div className="card">
        <h3>🧠 交易复盘</h3>
        {reviews.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: '6px 0' }}>
            暂无复盘记录。亏损/强平/泡沫破灭后，这里会给出教训分析。
          </div>
        ) : (
          reviews.map((r, i) => (
            <div key={i} className="review-card">
              <div className="review-head">
                <span style={{ fontSize: 13, fontWeight: 600 }}>{r.title}</span>
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                  {new Date(r.time).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{r.desc}</div>
              <div className="review-lesson">💡 {r.lesson}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
