import { useEffect, useState } from 'react';
import { marketApi } from '../../services/api.client';
import { useMarketStore } from '../../store';

const REGIME_LABEL: Record<string, string> = {
  sideways: '震荡整理',
  bull: '牛市行情',
  bear: '熊市调整',
  volatile: '剧烈波动',
};

// A股交易时段（本地时间模拟）
function tradingSession(): { label: string; open: boolean } {
  const d = new Date();
  const t = d.getHours() * 60 + d.getMinutes();
  if (t >= 9 * 60 + 25 && t < 9 * 60 + 30) return { label: '集合竞价', open: true };
  if (t >= 9 * 60 + 30 && t <= 11 * 60 + 30) return { label: '连续竞价', open: true };
  if (t > 11 * 60 + 30 && t < 13 * 60) return { label: '午间休市', open: false };
  if (t >= 13 * 60 && t <= 15 * 60) return { label: '连续竞价', open: true };
  return { label: '已收盘', open: false };
}

// 顶部大盘指数条 + 涨跌家数（S3）+ 交易时段（A2）+ 市场状态
export function MarketIndexBar() {
  const [indices, setIndices] = useState<any[]>([]);
  const stocks = useMarketStore((s) => s.stocks);
  const marketRegime = useMarketStore((s) => s.marketRegime);
  const gameDay = useMarketStore((s) => s.gameDay);
  const [session, setSession] = useState(tradingSession());

  useEffect(() => {
    let alive = true;
    const load = () => {
      marketApi.indices().then((list) => {
        if (alive && Array.isArray(list)) setIndices(list);
      }).catch(() => {});
    };
    load();
    const timer = setInterval(load, 5000);
    const st = setInterval(() => setSession(tradingSession()), 10000);
    return () => { alive = false; clearInterval(timer); clearInterval(st); };
  }, []);

  // 涨跌家数（S3）
  const upCount = stocks.filter((s) => (s.changePct ?? 0) > 0).length;
  const downCount = stocks.filter((s) => (s.changePct ?? 0) < 0).length;
  const flatCount = stocks.length - upCount - downCount;

  if (indices.length === 0) return null;

  return (
    <div className="market-index-bar">
      {indices.map((idx) => {
        const up = idx.changePct >= 0;
        return (
          <span key={idx.code} className={`index-item ${up ? 'up' : 'down'}`}>
            <b>{idx.name}</b>
            <em>{idx.value}</em>
            <i>{up ? '+' : ''}{idx.changePct}%</i>
          </span>
        );
      })}
      <span className="index-breadth">
        涨 <b className="up">{upCount}</b>
        <i className="sep">/</i>
        跌 <b className="down">{downCount}</b>
        <i className="sep">/</i>
        平 <b>{flatCount}</b>
      </span>
      <span className="index-regime">
        市场状态：{REGIME_LABEL[marketRegime] || marketRegime}
      </span>
      <span className={`index-session ${session.open ? 'open' : ''}`}>{session.label}</span>
      <span className="index-day">第 {gameDay + 1} 个交易日</span>
    </div>
  );
}
