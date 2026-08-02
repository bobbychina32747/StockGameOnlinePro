import { useEffect, useMemo, useState } from 'react';
import { marketApi } from '../../services/api.client';
import { useMarketStore, useUIStore } from '../../store';
import { PriceText } from './PriceText';
import { liveQuote } from '../../utils/quote';

type ViewMode = 'all' | 'fav' | 'board';

// 左侧股票列表：自选/全部/行业板块 三视图 + 搜索 + 星标（S2/S6）
export function StockListPanel() {
  const stocks = useMarketStore((s) => s.stocks);
  const setStocks = useMarketStore((s) => s.setStocks);
  const prices = useMarketStore((s) => s.prices);
  const selectedSymbol = useUIStore((s) => s.selectedSymbol);
  const marketMode = useUIStore((s) => s.marketMode);
  const setSelectedSymbol = useUIStore((s) => s.setSelectedSymbol);
  const setDetailSymbol = useUIStore((s) => s.setDetailSymbol);
  const favoriteSymbols = useUIStore((s) => s.favoriteSymbols);
  const toggleFavorite = useUIStore((s) => s.toggleFavorite);

  const [view, setView] = useState<ViewMode>('all');
  const [query, setQuery] = useState('');

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

  // B1 多市场：按当前市场过滤（HK/US/CN），自选视图跨市场
  const sorted = useMemo(() => {
    const all = [...stocks].sort((a, b) => (a.symbol < b.symbol ? -1 : 1));
    return all.filter((s) => !s.market || s.market === marketMode);
  }, [stocks, marketMode]);

  // 搜索过滤（代码/名称）
  const filtered = useMemo(() => {
    if (!query.trim()) return sorted;
    const q = query.trim().toLowerCase();
    return sorted.filter((s) =>
      (s.code || '').toLowerCase().includes(q) ||
      (s.name || '').toLowerCase().includes(q) ||
      s.symbol.toLowerCase().includes(q)
    );
  }, [sorted, query]);

  const list = view === 'fav'
    ? filtered.filter((s) => favoriteSymbols.includes(s.symbol))
    : filtered;
  // B1 自选跨市场：若当前市场无自选股，显示全部自选（跨市场）
  const favAll = useMemo(() => stocks.filter((s) => favoriteSymbols.includes(s.symbol)), [stocks, favoriteSymbols]);
  const effectiveList = view === 'fav' && list.length === 0 && favAll.length > 0 ? favAll : list;

  // 行业板块聚合（S2）
  const boards = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const s of sorted) {
      const arr = map.get(s.industry) || [];
      arr.push(s);
      map.set(s.industry, arr);
    }
    return [...map.entries()].map(([industry, arr]) => {
      const avg = arr.reduce((sum, s) => sum + liveQuote(sorted, prices, s.symbol).changePct, 0) / arr.length;
      const upCount = arr.filter((s) => liveQuote(sorted, prices, s.symbol).changePct > 0).length;
      const leader = [...arr].sort((a, b) => liveQuote(sorted, prices, b.symbol).changePct - liveQuote(sorted, prices, a.symbol).changePct)[0];
      return { industry, avg, upCount, total: arr.length, leader };
    }).sort((a, b) => b.avg - a.avg);
  }, [sorted]);

  return (
    <div className="stock-list-panel">
      <div className="stock-list-tabs">
        {([['all', '全部'], ['fav', '自选'], ['board', '板块']] as [ViewMode, string][]).map(([k, label]) => (
          <button key={k} className={view === k ? 'active' : ''} onClick={() => setView(k)}>
            {label}{k === 'fav' && favoriteSymbols.length > 0 ? `(${favoriteSymbols.length})` : ''}
          </button>
        ))}
      </div>
      {view !== 'board' && (
        <input
          className="stock-search"
          placeholder="搜索代码 / 名称..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      {view === 'board' ? (
        <div className="stock-list-body">
          {boards.map((b) => {
            const up = b.avg >= 0;
            return (
              <div
                key={b.industry}
                className="board-row"
                onClick={() => { setQuery(b.leader.symbol); setView('all'); }}
              >
                <span className="board-name">{b.industry}</span>
                <span className="board-count">{b.upCount}/{b.total}涨</span>
                <span className="board-change">
                  <b className={up ? 'up' : 'down'} style={{ fontFamily: 'var(--font-mono)' }}>
                    {up ? '+' : ''}{b.avg.toFixed(2)}%
                  </b>
                </span>
                <span className="board-leader" title="领涨股">{b.leader?.name}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <>
          <div className="stock-list-header">
            <span>代码</span>
            <span>名称</span>
            <span style={{ textAlign: 'right' }}>现价</span>
            <span style={{ textAlign: 'right' }}>涨跌%</span>
          </div>
          <div className="stock-list-body">
            {list.length === 0 && (
              <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 12 }}>
                {view === 'fav' ? '暂无自选，点击列表名称旁 ☆ 添加' : '加载中...'}
              </div>
            )}
            {effectiveList.map((s) => {
              const q = liveQuote(stocks, prices, s.symbol);
              const price = q.price;
              const changePct = q.changePct;
              const up = changePct >= 0;
              // C2 涨跌停可视化（CN 模式 ±10%）：基于今开价计算
              const dayOpen = Number(s.dayOpen) || Number(s.price) || price;
              const limitUp = marketMode === 'CN' ? dayOpen * 1.1 : null;
              const limitDown = marketMode === 'CN' ? dayOpen * 0.9 : null;
              const limitTag = limitUp && price >= limitUp ? '涨停' : limitDown && price <= limitDown ? '跌停' : null;
              const isFav = favoriteSymbols.includes(s.symbol);
              return (
                <div
                  key={s.symbol}
                  className={`stock-list-row ${selectedSymbol === s.symbol ? 'active' : ''}`}
                  onClick={() => setSelectedSymbol(s.symbol)}
                >
                  <span className="stock-symbol">{s.code || s.symbol}</span>
                  <span className="stock-name" title={s.industry}>
                    {s.name}
                    <button
                      className={`stock-fav-btn ${isFav ? 'fav' : ''}`}
                      title={isFav ? '取消自选' : '加自选'}
                      onClick={(e) => { e.stopPropagation(); toggleFavorite(s.symbol); }}
                    >
                      {isFav ? '★' : '☆'}
                    </button>
                    <button
                      className="stock-info-btn"
                      title="公司资料"
                      onClick={(e) => { e.stopPropagation(); setDetailSymbol(s.symbol); }}
                    >
                      ℹ
                    </button>
                  </span>
                  <span className={`stock-price ${up ? 'up' : 'down'}`}>
                    <PriceText value={price} />
                  </span>
                  <span className={`stock-change ${up ? 'up' : 'down'}`}>
                    {up ? '+' : ''}{changePct.toFixed(2)}%
                  </span>
                  {limitTag && <span className={`limit-badge ${limitTag === '涨停' ? 'up' : 'down'}`}>{limitTag}</span>}
                  {Number(s.bubble) > 1.3 && (
                    <span className={`bubble-badge ${Number(s.bubble) > 2 ? 'danger' : 'warn'}`} title={`板块泡沫度 ${Number(s.bubble).toFixed(2)}x（价格/内在价值），小心破灭`}>
                      {Number(s.bubble) > 2 ? '💥 泡沫高危' : '🔥 泡沫'}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
