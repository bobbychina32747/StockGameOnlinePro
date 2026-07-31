import { useMarketStore, useUIStore } from '../../store';
import { CollapsibleCard } from './CollapsibleCard';

// 右侧盘口（买5/卖5，同花顺式）
export function OrderBookPanel() {
  const orderBook = useMarketStore((s) => s.orderBook);
  const selectedSymbol = useUIStore((s) => s.selectedSymbol);

  const ob = orderBook[selectedSymbol] || { asks: [], bids: [], spread: 0 };
  const asks = ob.asks || [];
  const bids = ob.bids || [];

  return (
    <CollapsibleCard title={`📖 盘口深度 (${selectedSymbol})`}>
      <div className="orderbook-levels">
        <div style={{ marginBottom: 4 }}>
          {[...asks].reverse().map((a: any, i: number) => (
            <div key={`a${i}`} className="ob-row ask">
              <span>{a.price != null ? a.price.toFixed(2) : '-'}</span>
              <span>{a.size ?? '-'}</span>
            </div>
          ))}
        </div>
        <div className="ob-spread">
          价差: {ob.spread ?? '-'}
        </div>
        <div style={{ marginTop: 4 }}>
          {bids.map((b: any, i: number) => (
            <div key={`b${i}`} className="ob-row bid">
              <span>{b.price != null ? b.price.toFixed(2) : '-'}</span>
              <span>{b.size ?? '-'}</span>
            </div>
          ))}
        </div>
      </div>
    </CollapsibleCard>
  );
}
