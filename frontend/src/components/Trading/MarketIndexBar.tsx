import { useMarketStore } from '../../store';

const REGIME_LABEL: Record<string, string> = {
  sideways: '震荡整理',
  bull: '牛市行情',
  bear: '熊市调整',
  volatile: '剧烈波动',
};

// 顶部大盘指数条（上证/深证/创业板 模拟指数 + 市场状态）
export function MarketIndexBar() {
  const stocks = useMarketStore((s) => s.stocks);
  const marketRegime = useMarketStore((s) => s.marketRegime);
  const gameDay = useMarketStore((s) => s.gameDay);

  if (stocks.length === 0) return null;

  const avgChange = (filter?: (s: any) => boolean) => {
    const arr = stocks.filter(filter ?? (() => true));
    if (!arr.length) return 0;
    return arr.reduce((sum, s) => sum + (s.changePct ?? 0), 0) / arr.length;
  };

  const indices = [
    { name: '上证指数', base: 3100, change: avgChange() },
    { name: '深证成指', base: 10500, change: avgChange((s) => ['F', 'C', 'R', 'P'].includes(s.symbol[0])) },
    { name: '创业板指', base: 2200, change: avgChange((s) => ['T', 'M', 'E'].includes(s.symbol[0])) },
  ];

  return (
    <div className="market-index-bar">
      {indices.map((idx) => {
        const val = idx.base * (1 + idx.change / 100);
        const up = idx.change >= 0;
        return (
          <span key={idx.name} className={`index-item ${up ? 'up' : 'down'}`}>
            <b>{idx.name}</b>
            <em>{val.toFixed(2)}</em>
            <i>{up ? '+' : ''}{idx.change.toFixed(2)}%</i>
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
