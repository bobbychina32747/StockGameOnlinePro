import { useEffect } from 'react';
import { accountApi } from '../../services/api.client';
import { useAccountStore, useMarketStore, useUIStore } from '../../store';
import { CollapsibleCard } from './CollapsibleCard';
import { PriceText } from './PriceText';

// 右侧账户面板：总览 + 模式切换 + 角色预设 + 持仓明细
export function AccountPanel() {
  const { account, positions } = useAccountStore();
  const fetchAccount = useAccountStore((s) => s.fetchAccount);
  const prices = useMarketStore((s) => s.prices);
  const stocks = useMarketStore((s) => s.stocks);
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
      <CollapsibleCard title="💰 账户总览">
        <div className="info-row">
          <span className="label">现金</span>
          <span className="value">{account ? <PriceText value={Number(account.cash)} /> : '---'}</span>
        </div>
        <div className="info-row">
          <span className="label">持仓市值</span>
          <span className="value"><PriceText value={holdValue} /></span>
        </div>
        <div className="info-row">
          <span className="label">总资产</span>
          <span className="value"><PriceText value={totalEquity} /></span>
        </div>
        <div className="info-row">
          <span className="label">杠杆</span>
          <span className="value">{account ? `${account.leverage}x` : '---'}</span>
        </div>
        <div className="info-row">
          <span className="label">今日盈亏</span>
          <span className={`value ${dailyPnl >= 0 ? 'up' : 'down'}`}>
            {dailyPnl >= 0 ? '+' : ''}<PriceText value={dailyPnl} />
          </span>
        </div>
        <div className="info-row">
          <span className="label">总盈亏</span>
          <span className={`value ${totalPnl >= 0 ? 'up' : 'down'}`}>
            {totalPnl >= 0 ? '+' : ''}<PriceText value={totalPnl} />
          </span>
        </div>
        <div className="info-row" style={{ borderTop: '1px solid var(--border-color)', paddingTop: 6, marginTop: 4 }}>
          <span className="label">交易模式</span>
          <span className="value" style={{ fontSize: 11 }}>
            {mode === 'CN' ? '🇨🇳 A股 T+1' : mode === 'HK' ? '🇭🇰 港股 T+0' : '🇺🇸 美股 T+0'}
            <button className="btn btn-ghost btn-sm" style={{ marginLeft: 6 }} onClick={() => switchMode(mode === 'CN' ? 'HK' : mode === 'HK' ? 'US' : 'CN')}>
              {mode === 'CN' ? '切港股' : mode === 'HK' ? '切美股' : '切A股'}
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
    </CollapsibleCard>

      {/* 持仓明细（Q10：当日盈亏 + 多空浮盈 + 盈亏排行） */}
      <CollapsibleCard title="📊 持仓明细">
        {(positions as any[]).length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: '8px 0' }}>暂无持仓</div>
        ) : (
          [...(positions as any[])]
            .sort((a: any, b: any) => {
              const pnlA = (prices[a.symbol] || 0) * a.longQty + (a.shortCost || 0) * a.shortQty - (a.longCost || 0) * a.longQty - (prices[a.symbol] || 0) * a.shortQty;
              const pnlB = (prices[b.symbol] || 0) * b.longQty + (b.shortCost || 0) * b.shortQty - (b.longCost || 0) * b.longQty - (prices[b.symbol] || 0) * b.shortQty;
              return pnlB - pnlA;
            })
            .map((pos: any) => {
            const price = prices[pos.symbol] || 0;
            const stock = stocks.find((x: any) => x.symbol === pos.symbol);
            const dayOpen = stock?.dayOpen || price;
            // 多空合计浮盈
            const pnl = (price - (pos.longCost || 0)) * pos.longQty + ((pos.shortCost || 0) - price) * pos.shortQty;
            const costBase = (pos.longCost || 0) * pos.longQty + (pos.shortCost || 0) * pos.shortQty;
            const pnlPct = costBase > 0 ? (pnl / costBase) * 100 : 0;
            // 当日盈亏（相对今开）
            const dayPnl = (price - dayOpen) * pos.longQty + (dayOpen - price) * pos.shortQty;
            return (
              <div key={pos.symbol} style={{ marginBottom: 8, borderBottom: '1px solid var(--border-subtle)', paddingBottom: 6 }}>
                <div style={{ fontWeight: 600, marginBottom: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span>{pos.symbol}</span>
                  <span className={`value ${pnl >= 0 ? 'up' : 'down'}`} style={{ fontSize: 11 }}>
                    浮盈 {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}（{pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(1)}%）
                  </span>
                </div>
                <div className="info-row">
                  <span className="label">当日盈亏</span>
                  <span className={`value ${dayPnl >= 0 ? 'up' : 'down'}`} style={{ fontSize: 11 }}>
                    {dayPnl >= 0 ? '+' : ''}{dayPnl.toFixed(2)}
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
                {pos.shortCost > 0 && (
                  <div className="info-row">
                    <span className="label">空仓成本</span>
                    <span className="value">{Number(pos.shortCost).toFixed(2)}</span>
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
    </CollapsibleCard>
    </>
  );
}
