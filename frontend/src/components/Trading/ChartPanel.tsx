import { useMemo } from 'react';
import ReactEChartsCore from 'echarts-for-react';
import { useMarketStore, useUIStore } from '../../store';

interface KlineData {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const TIMEFRAMES = [
  { key: '1min', label: '1分' },
  { key: '5min', label: '5分' },
  { key: 'daily', label: '日线' },
];

// 中间图表区（同花顺式：标题栏 + 周期切换 + K线/指标）
export function ChartPanel() {
  const klines = useMarketStore((s) => s.klines);
  const prices = useMarketStore((s) => s.prices);
  const stocks = useMarketStore((s) => s.stocks);
  const selectedSymbol = useUIStore((s) => s.selectedSymbol);
  const selectedTimeframe = useUIStore((s) => s.selectedTimeframe);
  const setSelectedTimeframe = useUIStore((s) => s.setSelectedTimeframe);

  const klineData: KlineData[] = (klines[selectedSymbol]?.[selectedTimeframe] || []) as KlineData[];
  const stock = stocks.find((s: any) => s.symbol === selectedSymbol);
  const price = prices[selectedSymbol];

  const chartOption = useMemo(() => {
    const closes = klineData.map((k) => k.close);
    const calcMA = (period: number): (string | null)[] => {
      const r: (string | null)[] = new Array(closes.length).fill(null);
      for (let i = period - 1; i < closes.length; i++) {
        let s = 0; for (let j = 0; j < period; j++) s += closes[i - j];
        r[i] = (s / period).toFixed(2);
      }
      return r;
    };
    const calcRSI = (period = 14): (number | null)[] => {
      const r: (number | null)[] = new Array(closes.length).fill(null);
      let g = 0, l = 0;
      for (let i = 1; i <= period && i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        if (d >= 0) g += d; else l -= d;
      }
      let ag = g / period, al = l / period;
      if (period < closes.length) r[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
      for (let i = period + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        ag = (ag * (period - 1) + (d >= 0 ? d : 0)) / period;
        al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
        r[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
      }
      return r;
    };
    const calcBB = (period = 20) => {
      const mid = calcMA(period);
      const u = [...mid], l = [...mid];
      for (let i = period - 1; i < closes.length; i++) {
        let sq = 0; for (let j = 0; j < period; j++) sq += (closes[i - j] - Number(mid[i])) ** 2;
        const std = Math.sqrt(sq / period);
        u[i] = (Number(mid[i]) + 2 * std).toFixed(2);
        l[i] = (Number(mid[i]) - 2 * std).toFixed(2);
      }
      return { upper: u, mid, lower: l };
    };
    const ma5 = calcMA(5), ma10 = calcMA(10), ma20 = calcMA(20);
    const rsi = calcRSI(14);
    const bb = calcBB(20);
    const klineTimes = klineData.map((k) => {
      const d = new Date(k.time);
      return selectedTimeframe === 'daily' ? `${d.getMonth()+1}/${d.getDate()}` : `${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`;
    });
    const candleData = klineData.map((k) => [k.open, k.close, k.low, k.high]);

    return {
      animationDuration: 300,
      animationDurationUpdate: 300,
      animationEasingUpdate: 'linear',
      backgroundColor: 'transparent',
      grid: [
        { left: '8%', right: '8%', top: 30, bottom: 90 },
        { left: '8%', right: '8%', top: '74%', bottom: 20 },
      ],
      xAxis: [
        { type: 'category', data: klineTimes, axisLine: { lineStyle: { color: '#2e3240' } }, axisLabel: { color: '#6a6d78', fontSize: 10 } },
        { type: 'category', data: klineTimes, gridIndex: 1, axisLine: { lineStyle: { color: '#2e3240' } }, axisLabel: { color: '#6a6d78', fontSize: 9 } },
      ],
      yAxis: [
        { type: 'value', scale: true, splitLine: { lineStyle: { color: '#2e3240', type: 'dashed' } }, axisLabel: { color: '#6a6d78', fontSize: 10, formatter: (v: number) => v.toFixed(2) } },
        { type: 'value', gridIndex: 1, splitLine: { show: false }, axisLabel: { color: '#6a6d78', fontSize: 9 }, min: 0, max: 100 },
      ],
      series: [
        { type: 'candlestick', data: candleData, itemStyle: { color: '#00c853', color0: '#ff5252', borderColor: '#00c853', borderColor0: '#ff5252' }, name: 'K线' },
        { type: 'line', data: bb.upper, smooth: true, symbol: 'none', lineStyle: { width: 1, color: '#9c27b0', opacity: 0.4 }, name: 'BOLL上' },
        { type: 'line', data: bb.mid, smooth: true, symbol: 'none', lineStyle: { width: 1, color: '#9c27b0' }, name: 'BOLL中' },
        { type: 'line', data: bb.lower, smooth: true, symbol: 'none', lineStyle: { width: 1, color: '#9c27b0', opacity: 0.4 }, areaStyle: { color: 'rgba(156,39,176,0.05)' }, name: 'BOLL下' },
        { type: 'line', data: ma5, smooth: true, symbol: 'none', lineStyle: { width: 1, color: '#ffa726' }, name: 'MA5' },
        { type: 'line', data: ma10, smooth: true, symbol: 'none', lineStyle: { width: 1, color: '#42a5f5' }, name: 'MA10' },
        { type: 'line', data: ma20, smooth: true, symbol: 'none', lineStyle: { width: 1, color: '#ef5350' }, name: 'MA20' },
        { type: 'line', data: rsi, smooth: true, symbol: 'none', xAxisIndex: 1, yAxisIndex: 1, lineStyle: { width: 1, color: '#ab47bc' }, name: 'RSI(14)', markLine: { silent: true, data: [{ yAxis: 70, lineStyle: { color: '#ff5252', type: 'dashed' } }, { yAxis: 30, lineStyle: { color: '#00c853', type: 'dashed' } }] } },
      ],
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#1e222d',
        borderColor: '#2e3240',
        textStyle: { color: '#d1d4dc', fontSize: 12 },
        formatter: (params: any[]) => {
          if (!params || params.length === 0) return '';
          const title = params[0].axisValue;
          const lines = params.map((p: any) => {
            const val = p.value;
            let display: string;
            if (Array.isArray(val)) {
              display = `O: ${val[0].toFixed(2)}  H: ${val[3].toFixed(2)}  L: ${val[2].toFixed(2)}  C: ${val[1].toFixed(2)}`;
            } else if (val != null) {
              display = val.toFixed(2);
            } else {
              display = '-';
            }
            return `${p.marker} ${p.seriesName}: ${display}`;
          });
          return `${title}<br/>${lines.join('<br/>')}`;
        },
      },
      legend: { data: ['MA5', 'MA10', 'MA20', 'BOLL中', 'RSI(14)'], top: 2, textStyle: { color: '#9fa3b0', fontSize: 10 } },
    };
  }, [klineData, selectedTimeframe]);

  const prevClose = stock?.price ?? price ?? 0;
  const changePct = prevClose > 0 && price != null ? ((price - prevClose) / prevClose) * 100 : 0;
  const up = changePct >= 0;

  return (
    <div className="chart-area">
      <div className="chart-header">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span className="chart-symbol">{stock?.name || selectedSymbol}</span>
          <span className="chart-code">{selectedSymbol}</span>
          {stock?.industry && <span className="chart-industry">{stock.industry}</span>}
          {price != null && (
            <span className={`chart-price ${up ? 'up' : 'down'}`}>
              {Number(price).toFixed(2)}
              <span style={{ marginLeft: 8, fontSize: 12 }}>
                {up ? '+' : ''}{changePct.toFixed(2)}%
              </span>
            </span>
          )}
        </div>
        <div className="chart-tabs">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf.key}
              className={selectedTimeframe === tf.key ? 'active' : ''}
              onClick={() => setSelectedTimeframe(tf.key)}
            >
              {tf.label}
            </button>
          ))}
        </div>
      </div>
      <div className="chart-container">
        <ReactEChartsCore option={chartOption} style={{ height: '100%', width: '100%' }} />
      </div>
    </div>
  );
}
