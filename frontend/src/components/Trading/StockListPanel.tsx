import { useEffect } from 'react';
import { marketApi } from '../../services/api.client';
import { useMarketStore, useUIStore } from '../../store';

// 左侧股票列表（同花顺式：名称/现价/涨跌幅，点击切换）
export function StockListPanel() {
  const stocks = useMarketStore((s) => s.stocks);
  const setStocks = useMarketStore((s) => s.setStocks);
  const prices = useMarketStore((s) => s.prices);
  const selectedSymbol = useUIStore((s) => s.selectedSymbol);
  const setSelectedSymbol = useUIStore((s) => s.setSelectedSymbol);

  // 行情列表定时刷新（涨跌幅/今开高低随价格更新）
  useEffect(() => {
    const load = () => {
      marketApi.stocks().then((list) => {
        if (Array.isArray(list)) setStocks(list);
      }).catch(() => {});
    };
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [setStocks]);

  const sorted = [...stocks].sort((a, b) => (a.symbol < b.symbol ? -1 : 1));

  return (
    <div className="stock-list-panel">
      <div className="stock-list-header">
        <span>代码</span>
        <span>名称</span>
        <span style={{ textAlign: 'right' }}>现价</span>
        <span style={{ textAlign: 'right' }}>涨跌%</span>
      </div>
      <div className="stock-list-body">
        {sorted.length === 0 && (
          <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 12 }}>加载中...</div>
        )}
        {sorted.map((s) => {
          const price = prices[s.symbol] ?? s.price;
          const changePct = s.changePct ?? 0;
          const up = changePct >= 0;
          return (
            <div
              key={s.symbol}
              className={`stock-list-row ${selectedSymbol === s.symbol ? 'active' : ''}`}
              onClick={() => setSelectedSymbol(s.symbol)}
            >
              <span className="stock-symbol">{s.symbol}</span>
              <span className="stock-name" title={s.industry}>{s.name}</span>
              <span className={`stock-price ${up ? 'up' : 'down'}`}>
                {Number(price).toFixed(2)}
              </span>
              <span className={`stock-change ${up ? 'up' : 'down'}`}>
                {up ? '+' : ''}{changePct.toFixed(2)}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
