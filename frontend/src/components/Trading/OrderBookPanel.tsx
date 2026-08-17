import { useEffect, useState } from 'react';
import { marketApi, tradingApi } from '../../services/api.client';
import { useMarketStore, useUIStore } from '../../store';
import { CollapsibleCard } from './CollapsibleCard';

// 右侧盘口（买5/卖5 + 深度条 A1 + 我的挂单标注 + P4 订单流信号）
export function OrderBookPanel() {
  const orderBook = useMarketStore((s) => s.orderBook);
  const selectedSymbol = useUIStore((s) => s.selectedSymbol);
  const mode = useUIStore((s) => s.marketMode);
  const [pending, setPending] = useState<any[]>([]);
  // P4 订单流信号：OFI + 机构/游资大单净流入（本地 AI 对手盘的真实成交统计）
  const [flow, setFlow] = useState<any>(null);

  // 拉我的挂单（用于盘口标注）
  useEffect(() => {
    let alive = true;
    const load = () => {
      tradingApi.getPending(mode).then((list) => {
        if (alive && Array.isArray(list)) setPending(list);
      }).catch(() => {});
    };
    load();
    const t = setInterval(load, 8000);
    return () => { alive = false; clearInterval(t); };
  }, [mode]);

  // P4 订单流信号轮询
  useEffect(() => {
    let alive = true;
    const load = () => {
      marketApi.flowSignals(selectedSymbol).then((s) => {
        if (alive) setFlow(s);
      }).catch(() => {});
    };
    load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [selectedSymbol]);

  const ob = orderBook[selectedSymbol] || { asks: [], bids: [], spread: 0 };
  const asks = ob.asks || [];
  const bids = ob.bids || [];
  const maxSize = Math.max(1, ...asks.map((a: any) => a.size || 0), ...bids.map((b: any) => b.size || 0));

  // 我的限价挂单（buy→bids 侧，sell→asks 侧）
  const myPending = pending.filter((o) => o.symbol === selectedSymbol && o.price && (o.side === 'buy' || o.side === 'sell'));

  // 合并：深度条 + 我的挂单标星
  const renderRow = (p: number | undefined, size: number | undefined, side: 'bid' | 'ask', isMine: boolean) => (
    <div className={`ob-row ${side} ${isMine ? 'mine' : ''}`}>
      <div className={`ob-depth ${side}`} style={{ width: `${((size || 0) / maxSize) * 100}%` }} />
      <span className="ob-price">{p != null ? p.toFixed(2) : '-'}</span>
      <span className="ob-size">{size ?? '-'}{isMine && <i className="ob-mine-tag">我</i>}</span>
    </div>
  );

  return (
    <CollapsibleCard title={`📖 盘口深度 (${selectedSymbol})`}>
      <div className="orderbook-levels">
        <div style={{ marginBottom: 4 }}>
          {[...asks].reverse().map((a: any, i: number) => {
            const mine = myPending.some((o) => o.side === 'sell' && Math.abs(o.price - a.price) < 0.005);
            return <div key={`a${i}`}>{renderRow(a.price, a.size, 'ask', mine)}</div>;
          })}
        </div>
        <div className="ob-spread">
          价差: {ob.spread ?? '-'}
          {myPending.length > 0 && <span style={{ marginLeft: 8, color: 'var(--color-warning)' }}>· {myPending.length} 笔挂单在盘中</span>}
        </div>
        {/* P4 订单流信号：OFI 买压/卖压 + AI 对手盘大单净流入 */}
        {flow && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
            <span>
              订单流:
              <b className={flow.ofi > 0.15 ? 'up' : flow.ofi < -0.15 ? 'down' : ''} style={{ marginLeft: 4 }}>
                {flow.label}（OFI {flow.ofi > 0 ? '+' : ''}{flow.ofi}）
              </b>
            </span>
            <span>
              主力净流入:
              <b className={flow.bigNetFlow >= 0 ? 'up' : 'down'} style={{ marginLeft: 4, fontFamily: 'var(--font-mono)' }}>
                {flow.bigNetFlow >= 0 ? '+' : ''}{flow.bigNetFlowWan} 万股
              </b>
            </span>
            {flow.shortAvailable != null && (
              <span>
                可融券:
                <b style={{ marginLeft: 4, fontFamily: 'var(--font-mono)' }}>
                  {(flow.shortAvailable / 10000).toFixed(1)}万股·费率 {((flow.shortFeeRate || 0) * 100).toFixed(2)}%/年
                </b>
              </span>
            )}
          </div>
        )}
        <div style={{ marginTop: 4 }}>
          {bids.map((b: any, i: number) => {
            const mine = myPending.some((o) => o.side === 'buy' && Math.abs(o.price - b.price) < 0.005);
            return <div key={`b${i}`}>{renderRow(b.price, b.size, 'bid', mine)}</div>;
          })}
        </div>
        {myPending.length > 0 && (
          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted)' }}>
            我的挂单：
            {myPending.map((o) => (
              <span key={o.id} className={o.side === 'buy' ? 'up' : 'down'} style={{ marginRight: 8, fontFamily: 'var(--font-mono)' }}>
                {o.side === 'buy' ? '买' : '卖'}{o.quantity}股@{o.price}
              </span>
            ))}
          </div>
        )}
      </div>
    </CollapsibleCard>
  );
}
