import { useEffect, useState } from 'react';
import { marketApi } from '../../services/api.client';
import { useMarketStore, useUIStore } from '../../store';
import { marketBreadth } from '../../utils/quote';

const REGIME_LABEL: Record<string, string> = {
  sideways: '震荡整理',
  bull: '牛市行情',
  bear: '熊市调整',
  volatile: '剧烈波动',
};

// S2 时段与本地时钟完全同步：真实A股时段（周一至周五 9:30-11:30 / 13:00-15:00）
function gameSession(): { label: string; open: boolean } {
  const now = new Date();
  const day = now.getDay();
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (day === 0 || day === 6) return { label: '周末休市', open: false };
  if (minutes >= 570 && minutes < 690) {
    const t = minutes - 570;
    return { label: '盘中 ' + String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'), open: true };
  }
  if (minutes >= 690 && minutes < 780) return { label: '午间休市', open: false };
  if (minutes >= 780 && minutes < 900) {
    const t = minutes - 780;
    return { label: '盘中 ' + String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'), open: true };
  }
  if (minutes >= 900) return { label: '已收盘', open: false };
  return { label: '未开盘', open: false };
}

// 顶部大盘指数条 + 涨跌家数（S3）+ 交易时段（A2）+ 市场状态
export function MarketIndexBar() {
  const [indices, setIndices] = useState<any[]>([]);
  const [hotTopics, setHotTopics] = useState<any[]>([]);
  const stocks = useMarketStore((s) => s.stocks);
  const marketRegime = useMarketStore((s) => s.marketRegime);
  const marketMode = useUIStore((s) => s.marketMode);
  const gameDay = useMarketStore((s) => s.gameDay);
  const session = gameSession();

  useEffect(() => {
    let alive = true;
    const load = () => {
      marketApi.indices().then((list) => {
        if (alive && Array.isArray(list)) setIndices(list);
      }).catch(() => {});
      marketApi.state().then((st) => {
        if (alive && Array.isArray(st?.hotTopics)) setHotTopics(st.hotTopics);
      }).catch(() => {});
    };
    load();
    const timer = setInterval(load, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  // 涨跌家数（S3，Q3 实时）
  const prices = useMarketStore((s) => s.prices);
  const breadth = marketBreadth(stocks, prices);
  const upCount = breadth.up, downCount = breadth.down, flatCount = breadth.flat;

  if (indices.length === 0) return null;

  return (
    <div className="market-index-bar">
      {indices.filter((idx) => !idx.market || idx.market === marketMode).map((idx) => {
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
      {hotTopics.length > 0 && (
        <span className="index-hot">
          🔥 热点：{hotTopics.map((h) => (
            <b key={h.industry}>{h.industry} <em style={{ color: 'var(--color-up)' }}>+{(h.strength * 100).toFixed(1)}%</em></b>
          ))}
        </span>
      )}
      <span className="index-regime">
        市场状态：{REGIME_LABEL[marketRegime] || marketRegime}
      </span>
      <span className={`index-session ${session.open ? 'open' : ''}`}>{session.label}</span>
      <span className="index-day">第 {gameDay + 1} 个交易日</span>
    </div>
  );
}
