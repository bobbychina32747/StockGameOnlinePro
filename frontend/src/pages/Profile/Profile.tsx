import { useEffect, useState } from 'react';
import { accountApi } from '../../services/api.client';
import { useAuthStore } from '../../store';
import { AchievementBoard } from '../../components/Trading/AchievementBoard';
import { EquityCurve } from '../../components/Trading/EquityCurve';

export default function Profile() {
  const user = useAuthStore((s) => s.user);
  const [metrics, setMetrics] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchMetrics = async () => {
      try {
        const data = await accountApi.metrics();
        setMetrics(data);
      } catch (e) {
        console.error('获取绩效失败', e);
      } finally {
        setLoading(false);
      }
    };
    fetchMetrics();
  }, []);

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
        </div>
      )}

      {/* Q4 历史净值曲线 */}
      <EquityCurve />

      {/* B3 成就系统 */}
      {perf && <AchievementBoard perf={perf} />}
    </div>
  );
}
