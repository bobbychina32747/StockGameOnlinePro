import { useEffect, useState } from 'react';
import { marketApi } from '../../services/api.client';
import { useMarketStore } from '../../store';
import { marketBreadth } from '../../utils/quote';

const REGIME_LABEL: Record<string, string> = {
  sideways: '震荡整理',
  bull: '牛市行情',
  bear: '熊市调整',
  volatile: '剧烈波动',
};

// A2 时段同步：由 WS tick 的 timestamp（游戏内 tickCount）计算游戏内时间
// TICKS_PER_DAY=390 → 9:30 起每分钟 1 tick，9:30~16:00 连续竞价
function gameSession(tickCount?: number): { label: string; open: boolean } {
  if (tickCount == null) return { label: '--', open: false };
  const dayTick = ((tickCount % 390) + 390) % 390;
  if (dayTick >= 390) return { label: '已收盘', open: false };
  if (dayTick === 0) return { label: '开盘', open: true };
  const mins = 9 * 60 + 30 + dayTick;
  const hh = String(Math.floor(mins / 60)).padStart(2, '0');
  const mm = String(mins % 60).padStart(2, '0');
  return { label: `盘中 ${hh}:${mm}`, open: true };
}

// 顶部大盘指数条 + 涨跌家数（S3）+ 交易时段（A2）+ 市场状态
export function MarketIndexBar() {
  const [indices, setIndices] = useState<any[]>([]);
  const stocks = useMarketStore((s) => s.stocks);
  const marketRegime = useMarketStore((s) => s.marketRegime);
  const gameDay = useMarketStore((s) => s.gameDay);
  const ticks = useMarketStore((s) => s.ticks);
  const lastTick = ticks[ticks.length - 1];
  const session = gameSession(lastTick?.timestamp);

  useEffect(() => {
    let alive = true;
    const load = () => {
      marketApi.indices().then((list) => {
        if (alive && Array.isArray(list)) setIndices(list);
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
