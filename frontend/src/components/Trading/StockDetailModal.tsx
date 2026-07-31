import { useMarketStore, useUIStore } from '../../store';
import { PriceText } from './PriceText';

// 公司资料弹窗（F10 简化版）：代码/上市日期/行业/简介/模拟市值/交易数据
export function StockDetailModal() {
  const detailSymbol = useUIStore((s) => s.detailSymbol);
  const setDetailSymbol = useUIStore((s) => s.setDetailSymbol);
  const stocks = useMarketStore((s) => s.stocks);
  const prices = useMarketStore((s) => s.prices);

  if (!detailSymbol) return null;

  const s = stocks.find((x: any) => x.symbol === detailSymbol);
  if (!s) return null;

  const price = prices[s.symbol] ?? s.price;
  const changePct = s.changePct ?? 0;
  const up = changePct >= 0;
  // 模拟总股本（按代码哈希生成一个稳定的"流通股本"，亿股）
  const shares = (parseInt(s.code || '0', 10) % 90 + 10) / 10; // 1.0 ~ 9.9 亿股
  const marketCap = price * shares * 1e8; // 元

  return (
    <div className="modal-overlay" onClick={() => setDetailSymbol(null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2 className="modal-title">{s.name}</h2>
            <span className="chart-code">{s.code}</span>
            <span className="chart-industry" style={{ marginLeft: 8 }}>{s.industry}</span>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => setDetailSymbol(null)}>✕</button>
        </div>

        <div className={`modal-price ${up ? 'up' : 'down'}`}>
          <PriceText value={price} className="modal-price-num" />
          <span className="modal-change">
            {up ? '+' : ''}{changePct.toFixed(2)}%
          </span>
        </div>

        <div className="modal-stats">
          <div className="modal-stat">
            <span className="label">上市日期</span>
            <span className="value">{s.listDate || '-'}</span>
          </div>
          <div className="modal-stat">
            <span className="label">所属行业</span>
            <span className="value">{s.industry || '-'}</span>
          </div>
          <div className="modal-stat">
            <span className="label">模拟总市值</span>
            <span className="value">≈ {(marketCap / 1e8).toFixed(1)} 亿元</span>
          </div>
          <div className="modal-stat">
            <span className="label">流通股本</span>
            <span className="value">{shares.toFixed(1)} 亿股</span>
          </div>
          <div className="modal-stat">
            <span className="label">今日开盘</span>
            <span className="value">{Number(s.dayOpen ?? price).toFixed(2)}</span>
          </div>
          <div className="modal-stat">
            <span className="label">今日最高</span>
            <span className="value up">{Number(s.dayHigh ?? price).toFixed(2)}</span>
          </div>
          <div className="modal-stat">
            <span className="label">今日最低</span>
            <span className="value down">{Number(s.dayLow ?? price).toFixed(2)}</span>
          </div>
          <div className="modal-stat">
            <span className="label">成交额(模拟)</span>
            <span className="value">{(price * (s.dayVolume || 0) / 1e4).toFixed(2)} 万</span>
          </div>
        </div>

        <div className="modal-section">
          <h4>公司简介</h4>
          <p className="modal-desc">{s.description || '暂无简介'}</p>
        </div>
      </div>
    </div>
  );
}
