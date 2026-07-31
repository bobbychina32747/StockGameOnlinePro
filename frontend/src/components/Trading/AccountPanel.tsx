import { useEffect } from 'react';
import { accountApi } from '../../services/api.client';
import { useAccountStore, useMarketStore, useUIStore } from '../../store';

// 右侧账户面板：总览 + 模式切换 + 角色预设 + 持仓明细
export function AccountPanel() {
  const { account, positions } = useAccountStore();
  const fetchAccount = useAccountStore((s) => s.fetchAccount);
  const prices = useMarketStore((s) => s.prices);
  const mode = useUIStore((s) => s.marketMode);
  const setMarketMode = useUIStore((s) => s.setMarketMode);
  const addNotification = useUIStore((s) => s.addNotification);

  const isCN = mode === 'CN';

  useEffect(() => {
    fetchAccount(mode);
    // 账户数据定时刷新（tick 驱动行情，权益随之变化）
    const timer = setInterval(() => fetchAccount(mode), 30000);
    return () => clearInterval(timer);
  }, [mode, fetchAccount]);

  const switchMode = async (newMode: string) => {
    setMarketMode(newMode);
    await fetchAccount(newMode);
  };

  const resetPreset = async (preset: string) => {
    await accountApi.reset(mode, preset);
    await fetchAccount(mode);
    addNotification(`已重置为${preset}`, 'success');
  };

  const holdValue = (positions as any[]).reduce((sum: number, p: any) =>
    sum + (p.longQty - p.shortQty) * (prices[p.symbol] || 0), 0);
  const totalEquity = account ? Number(account.cash) + holdValue : 0;
  const dailyPnl = account ? totalEquity - Number(account.dayStartEquity) : 0;
  const totalPnl = account ? totalEquity - Number(account.initialEquity) : 0;

  return (
    <>
      <div className="card">
        <h3>💰 账户总览</h3>
        <div className="info-row">
          <span className="label">现金</span>
          <span className="value">{account ? Number(account.cash).toLocaleString('zh-CN', { minimumFractionDigits: 2 }) : '---'}</span>
        </div>
        <div className="info-row">
          <span className="label">持仓市值</span>
          <span className="value">{holdValue.toFixed(2)}</span>
        </div>
        <div className="info-row">
          <span className="label">总资产</span>
          <span className="value">{totalEquity.toFixed(2)}</span>
        </div>
        <div className="info-row">
          <span className="label">杠杆</span>
          <span className="value">{account ? `${account.leverage}x` : '---'}</span>
        </div>
        <div className="info-row">
          <span className="label">今日盈亏</span>
          <span className={`value ${dailyPnl >= 0 ? 'up' : 'down'}`}>
            {dailyPnl >= 0 ? '+' : ''}{dailyPnl.toFixed(2)}
          </span>
        </div>
        <div className="info-row">
          <span className="label">总盈亏</span>
          <span className={`value ${totalPnl >= 0 ? 'up' : 'down'}`}>
            {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(2)}
          </span>
        </div>
        <div className="info-row" style={{ borderTop: '1px solid var(--border-color)', paddingTop: 6, marginTop: 4 }}>
          <span className="label">交易模式</span>
          <span className="value" style={{ fontSize: 11 }}>
            {isCN ? '🇨🇳 A股 T+1' : '🇺🇸 美股 T+0'}
            <button className="btn btn-ghost btn-sm" style={{ marginLeft: 6 }} onClick={() => switchMode(isCN ? 'US' : 'CN')}>
              {isCN ? '切美股' : '切A股'}
            </button>
          </span>
        </div>
        {isCN && (
          <div className="info-row">
            <span className="label" style={{ color: 'var(--color-warning)' }}>⚠️ T+1规则</span>
            <span className="value" style={{ fontSize: 11, color: 'var(--color-warning)' }}>当日买入次日方可卖出</span>
          </div>
        )}
        <div className="info-row" style={{ borderTop: '1px solid var(--border-color)', paddingTop: 6, marginTop: 4 }}>
          <span className="label">角色预设</span>
        </div>
        <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
          {['散户', '机构', '日内交易者'].map((preset) => (
            <button key={preset} className="btn btn-sm btn-ghost" onClick={() => resetPreset(preset)}>
              {preset}
            </button>
          ))}
        </div>
      </div>

      {/* 持仓明细 */}
      <div className="card">
        <h3>📊 持仓明细</h3>
        {(positions as any[]).length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: '8px 0' }}>暂无持仓</div>
        ) : (
          (positions as any[]).map((pos: any) => {
            const price = prices[pos.symbol] || 0;
            const pnl = price > 0 && pos.longQty > 0 ? (price - pos.longCost) * pos.longQty : 0;
            return (
              <div key={pos.symbol} style={{ marginBottom: 8, borderBottom: '1px solid var(--border-subtle)', paddingBottom: 6 }}>
                <div style={{ fontWeight: 600, marginBottom: 2, display: 'flex', justifyContent: 'space-between' }}>
                  <span>{pos.symbol}</span>
                  <span className={`value ${pnl >= 0 ? 'up' : 'down'}`} style={{ fontSize: 11 }}>
                    浮盈亏 {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}
                  </span>
                </div>
                <div className="info-row">
                  <span className="label">多仓</span>
                  <span className="value">{pos.longQty} 股</span>
                </div>
                <div className="info-row">
                  <span className="label">空仓</span>
                  <span className="value">{pos.shortQty} 股</span>
                </div>
                {pos.longCost > 0 && (
                  <div className="info-row">
                    <span className="label">多仓成本</span>
                    <span className="value">{Number(pos.longCost).toFixed(2)}</span>
                  </div>
                )}
                {isCN && (
                  <div className="info-row">
                    <span className="label">今日可卖</span>
                    <span className="value" style={{ color: 'var(--color-warning)' }}>{Math.max(0, pos.longQty - (pos.boughtToday || 0))} 股</span>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
