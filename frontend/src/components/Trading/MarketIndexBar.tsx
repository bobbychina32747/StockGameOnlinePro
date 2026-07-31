import { useEffect, useState } from 'react';
import { marketApi } from '../../services/api.client';
import { useMarketStore } from '../../store';

const REGIME_LABEL: Record<string, string> = {
  sideways: '震荡整理',
  bull: '牛市行情',
  bear: '熊市调整',
  volatile: '剧烈波动',
};

// 顶部大盘指数条（真实后端计算的上证/深证/创业板模拟指数 + 市场状态）
export function MarketIndexBar() {
  const [indices, setIndices] = useState<any[]>([]);
  const marketRegime = useMarketStore((s) => s.marketRegime);
  const gameDay = useMarketStore((s) => s.gameDay);

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
      <span className="index-regime">
        市场状态：{REGIME_LABEL[marketRegime] || marketRegime}
      </span>
      <span className="index-day">第 {gameDay + 1} 个交易日</span>
    </div>
  );
}
