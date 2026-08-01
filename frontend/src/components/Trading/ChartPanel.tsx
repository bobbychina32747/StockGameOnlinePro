import { useEffect, useMemo, useRef } from 'react';
import ReactEChartsCore from 'echarts-for-react';
import { useMarketStore, useUIStore } from '../../store';
import { PriceText } from './PriceText';

interface KlineData {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// QoL：分时独立 + 「K线」展开子项（一分线/五分线/...）
const KLINE_TIMEFRAMES = [
  { key: '1min', label: '1分' },
  { key: '5min', label: '5分' },
  { key: '60min', label: '60分' },
  { key: 'daily', label: '日线' },
  { key: 'weekly', label: '周线' },
  { key: 'monthly', label: '月线' },
];

// ─── LoD 动态合并（用户方案）：相邻点变化 ≤ MERGE_PCT% 时合并 ───
// 历史 bar 只读 → 合并判定确定性 → 历史蜡烛/颜色稳定；仅尾桶随实时更新
const MERGE_PCT = 5; // 相邻收盘变化阈值（%），若合并过度可调小
const MIN_KEEP = 60; // 保底：合并后至少保留的根数（防趋势平缓时全并成 1 根）

function mergeOnce(bars: KlineData[], pct: number): KlineData[] {
  const out: KlineData[] = [];
  let cur: KlineData | null = null;
  for (const b of bars) {
    if (!cur) {
      cur = { ...b };
      continue;
    }
    // 动态监测：与最近一点的偏差 ≤ 阈值则合并（OHLC 保形：open 首/close 尾/high max/low min/vol 累加）
    const change = Math.abs(b.close - cur.close) / cur.close;
    if (change <= pct / 100) {
      cur = {
        time: cur.time, open: cur.open, close: b.close,
        high: Math.max(cur.high, b.high), low: Math.min(cur.low, b.low),
        volume: cur.volume + b.volume,
      };
    }
    else {
      out.push(cur);
      cur = { ...b };
    }
  }
  if (cur) out.push(cur);
  return out;
}

function dynamicMerge(bars: KlineData[]): KlineData[] {
  if (bars.length <= 400) return bars; // 数据少不合并
  // 双向调节：合并过少(≤5%太宽)则收窄阈值，过多则放宽，目标 [MIN_KEEP, 400] 根
  let pct = MERGE_PCT;
  let out = mergeOnce(bars, pct);
  let guard = 0;
  while (guard++ < 12) {
    if (out.length > 400) {
      pct *= 1.5;
      out = mergeOnce(bars, pct);
    }
    else if (out.length < MIN_KEEP) {
      pct /= 1.8;
      out = mergeOnce(bars, pct);
    }
    else break;
  }
  return out;
}


// 中间图表区（标题栏 + 分层周期切换 + 分时/K线 + LoD 降采样 + 增量更新）
export function ChartPanel() {
  const klines = useMarketStore((s) => s.klines);
  const prices = useMarketStore((s) => s.prices);
  const stocks = useMarketStore((s) => s.stocks);
  const selectedSymbol = useUIStore((s) => s.selectedSymbol);
  const selectedTimeframe = useUIStore((s) => s.selectedTimeframe);
  const setSelectedTimeframe = useUIStore((s) => s.setSelectedTimeframe);
  const setDetailSymbol = useUIStore((s) => s.setDetailSymbol);

  const klineData: KlineData[] = (klines[selectedSymbol]?.[selectedTimeframe] || []) as KlineData[];
  // 分时图数据源：1min K 线（S1）
  const intradaySrc = (klines[selectedSymbol]?.['1min'] || []) as KlineData[];
  const stock = stocks.find((s: any) => s.symbol === selectedSymbol);
  const price = prices[selectedSymbol];
  const isIntraday = selectedTimeframe === 'intraday';

  // ─── 图表修复：切页重挂载后强制 resize + 监听容器尺寸变化 ───
  const chartRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const t1 = setTimeout(() => chartRef.current?.getEchartsInstance()?.resize(), 120);
    const t2 = setTimeout(() => chartRef.current?.getEchartsInstance()?.resize(), 400);
    const ro = new ResizeObserver(() => chartRef.current?.getEchartsInstance()?.resize());
    ro.observe(el);
    return () => { clearTimeout(t1); clearTimeout(t2); ro.disconnect(); };
  }, [selectedSymbol, selectedTimeframe]);

  const chartOption = useMemo(() => {
    // ─── 分时图（S1）：当日 1min（均匀时间轴，不合并 → 无跨天断裂/分层） ───
    if (isIntraday) {
      // 只取最近一天（按模拟日期），消除跨天价格跳空导致的断裂
      let bars = intradaySrc;
      if (bars.length > 0) {
        const lastDay = new Date(bars[bars.length - 1].time).toDateString();
        bars = bars.filter((k) => new Date(k.time).toDateString() === lastDay);
      }
      if (bars.length === 0) return {};
      const times = bars.map((k) => {
        const d = new Date(k.time);
        return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
      });
      const closes = bars.map((k) => k.close);
      const vols = bars.map((k) => k.volume);
      const prevClose = stock?.dayOpen != null ? Number(stock.dayOpen) : (intradaySrc[0]?.open || closes[0] || 0);
      let cumVol = 0, cumAmt = 0;
      const avgLine = closes.map((c, i) => { cumVol += vols[i]; cumAmt += c * vols[i]; return cumVol ? cumAmt / cumVol : c; });
      const lastColor = closes[closes.length - 1] >= prevClose ? '#e03131' : '#00c853';
      return {
        // merge 更新无动画（无感刷新 + 性能最优）
        animation: false, backgroundColor: 'transparent',
        grid: [
          { left: '8%', right: '8%', top: 30, bottom: 60 },
          { left: '8%', right: '8%', top: '74%', bottom: 16 },
        ],
        xAxis: [
          { type: 'category', data: times, axisLine: { lineStyle: { color: '#2e3240' } }, axisLabel: { color: '#6a6d78', fontSize: 10 } },
          { type: 'category', data: times, gridIndex: 1, axisLine: { lineStyle: { color: '#2e3240' } }, axisLabel: { show: false } },
        ],
        yAxis: [
          { type: 'value', scale: true, splitLine: { lineStyle: { color: '#2e3240', type: 'dashed' } }, axisLabel: { color: '#6a6d78', fontSize: 10, formatter: (v: number) => v.toFixed(2) } },
          { type: 'value', gridIndex: 1, splitLine: { show: false }, axisLabel: { show: false } },
        ],
        series: [
          { type: 'line', data: closes, smooth: false, symbol: 'none', lineStyle: { width: 1.5, color: lastColor }, itemStyle: { color: lastColor }, areaStyle: { color: lastColor + '26' }, name: '价格', markLine: { silent: true, symbol: 'none', data: [{ yAxis: prevClose, lineStyle: { color: '#556080', type: 'dashed' } }], label: { show: false } } },
          { type: 'line', data: avgLine, smooth: true, symbol: 'none', lineStyle: { width: 1, color: '#f59e0b', type: 'dashed' }, name: '均价' },
          { type: 'bar', data: vols, xAxisIndex: 1, yAxisIndex: 1, itemStyle: { color: (pp: any) => (closes[pp.dataIndex] >= prevClose ? 'rgba(224,49,49,0.5)' : 'rgba(0,200,83,0.5)') }, name: '成交量' },
        ],
        tooltip: {
          trigger: 'axis', backgroundColor: '#1e222d', borderColor: '#2e3240', textStyle: { color: '#d1d4dc', fontSize: 12 },
          axisPointer: { type: 'cross', lineStyle: { color: '#556080', type: 'dashed' }, label: { backgroundColor: '#3a3f4e' } },
          formatter: (params: any[]) => {
            if (!params || !params.length) return '';
            const t = params[0].axisValue;
            const line = params.find((x: any) => x.seriesName === '价格');
            const avg = params.find((x: any) => x.seriesName === '均价');
            const vol = params.find((x: any) => x.seriesName === '成交量');
            return `${t}<br/>价格: ${line ? Number(line.value).toFixed(2) : '-'}<br/>均价: ${avg ? Number(avg.value).toFixed(2) : '-'}<br/>量: ${vol ? vol.value : '-'}`;
          },
        },
      };
    }

    // ─── K线分支：LoD 动态合并（历史只读，仅尾桶随实时更新） ───
    const bars = dynamicMerge(klineData);
    const closes = bars.map((k) => k.close);
    const calcMA = (period: number): (number | null)[] => {
      const r: (number | null)[] = new Array(closes.length).fill(null);
      for (let i = period - 1; i < closes.length; i++) {
        let s = 0; for (let j = 0; j < period; j++) s += closes[i - j];
        r[i] = s / period;
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
        u[i] = Number(mid[i]) + 2 * std;
        l[i] = Number(mid[i]) - 2 * std;
      }
      return { upper: u, mid, lower: l };
    };
    const ma5 = calcMA(5), ma10 = calcMA(10), ma20 = calcMA(20);
    const rsi = calcRSI(14);
    const bb = calcBB(20);
    const klineTimes = bars.map((k) => {
      const d = new Date(k.time);
      return selectedTimeframe === 'daily' || selectedTimeframe === 'weekly' || selectedTimeframe === 'monthly'
        ? `${d.getMonth()+1}/${d.getDate()}`
        : `${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`;
    });
    const candleData = bars.map((k) => [k.open, k.close, k.low, k.high]);

    return {
      // merge 更新无动画（无感刷新 + 性能最优）
      animation: false,
      backgroundColor: 'transparent',
      grid: [
        { left: '8%', right: '8%', top: 30, bottom: 60 },
        { left: '8%', right: '8%', top: '74%', bottom: 16 },
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
        // A股：阳线红、阴线绿
        { type: 'candlestick', data: candleData, itemStyle: { color: '#e03131', color0: '#00c853', borderColor: '#e03131', borderColor0: '#00c853' }, name: 'K线' },
        { type: 'line', data: bb.upper, smooth: true, symbol: 'none', lineStyle: { width: 1, color: '#9c27b0', opacity: 0.4 }, name: 'BOLL上' },
        { type: 'line', data: bb.mid, smooth: true, symbol: 'none', lineStyle: { width: 1, color: '#9c27b0' }, name: 'BOLL中' },
        { type: 'line', data: bb.lower, smooth: true, symbol: 'none', lineStyle: { width: 1, color: '#9c27b0', opacity: 0.4 }, areaStyle: { color: 'rgba(156,39,176,0.05)' }, name: 'BOLL下' },
        { type: 'line', data: ma5, smooth: true, symbol: 'none', lineStyle: { width: 1, color: '#ffa726' }, name: 'MA5' },
        { type: 'line', data: ma10, smooth: true, symbol: 'none', lineStyle: { width: 1, color: '#42a5f5' }, name: 'MA10' },
        { type: 'line', data: ma20, smooth: true, symbol: 'none', lineStyle: { width: 1, color: '#ef5350' }, name: 'MA20' },
        { type: 'line', data: rsi, smooth: true, symbol: 'none', xAxisIndex: 1, yAxisIndex: 1, lineStyle: { width: 1, color: '#ab47bc' }, name: 'RSI(14)', markLine: { silent: true, data: [{ yAxis: 70, lineStyle: { color: '#e03131', type: 'dashed' } }, { yAxis: 30, lineStyle: { color: '#00c853', type: 'dashed' } }] } },
      ],
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#1e222d',
        borderColor: '#2e3240',
        textStyle: { color: '#d1d4dc', fontSize: 12 },
        axisPointer: {
          type: 'cross',
          lineStyle: { color: '#556080', type: 'dashed' },
          crossStyle: { color: '#8a93a8' },
          label: { backgroundColor: '#3a3f4e' },
        },
        formatter: (params: any[]) => {
          if (!params || params.length === 0) return '';
          const title = params[0].axisValue;
          const lines = params.map((p: any) => {
            const val = p.value;
            let display: string;
            if (Array.isArray(val)) {
              display = `O: ${Number(val[0]).toFixed(2)}  H: ${Number(val[3]).toFixed(2)}  L: ${Number(val[2]).toFixed(2)}  C: ${Number(val[1]).toFixed(2)}`;
            } else if (typeof val === 'number') {
              display = val.toFixed(2);
            } else if (val != null) {
              display = String(val);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [klineData, selectedTimeframe, intradaySrc, isIntraday]);

  const prevClose = stock?.dayOpen != null ? Number(stock.dayOpen) : (stock?.price ?? price ?? 0);
  const changePct = prevClose > 0 && price != null ? ((price - prevClose) / prevClose) * 100 : 0;
  const up = changePct >= 0;

  // 最新 MA 值（标题下方专业行情条）
  const lastMA = (period: number) => {
    if (klineData.length < period) return null;
    let s = 0;
    for (let i = klineData.length - period; i < klineData.length; i++) s += klineData[i].close;
    return s / period;
  };
  const maVals = [5, 10, 20].map((p) => lastMA(p));
  const lastClose = klineData[klineData.length - 1]?.close;

  return (
    <div className="chart-area">
      <div className="chart-header">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
          <button
            className="chart-symbol-btn"
            title="查看公司资料"
            onClick={() => setDetailSymbol(selectedSymbol)}
          >
            {stock?.name || selectedSymbol}
          </button>
          <span className="chart-code">{stock?.code || selectedSymbol}</span>
          {stock?.industry && <span className="chart-industry">{stock.industry}</span>}
          {price != null && (
            <span className={`chart-price ${up ? 'up' : 'down'}`}>
              <PriceText value={price} />
              <span style={{ marginLeft: 8, fontSize: 12 }}>
                {up ? '+' : ''}{changePct.toFixed(2)}%
              </span>
            </span>
          )}
        </div>
        {/* QoL：分时独立 + K线展开子项 */}
        <div className="chart-tabs">
          <button
            className={isIntraday ? 'active' : ''}
            onClick={() => setSelectedTimeframe('intraday')}
          >
            分时
          </button>
          <button
            className={!isIntraday ? 'active' : ''}
            onClick={() => { if (isIntraday) setSelectedTimeframe('1min'); }}
          >
            K线
          </button>
        </div>
        {!isIntraday && (
          <div className="chart-tabs chart-tabs-sub">
            {KLINE_TIMEFRAMES.map((tf) => (
              <button
                key={tf.key}
                className={selectedTimeframe === tf.key ? 'active' : ''}
                onClick={() => setSelectedTimeframe(tf.key)}
              >
                {tf.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="chart-indicators">
        {isIntraday ? (
          <>
            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>昨收 <b className="up" style={{ marginLeft: 4, fontFamily: 'var(--font-mono)' }}>{intradaySrc[0] ? Number(intradaySrc[0].open).toFixed(2) : '-'}</b></span>
            <span className="chart-listdate">黄色虚线为当日均价线</span>
          </>
        ) : (
          <>
            {maVals.map((v, i) => {
              const cls = lastClose != null && v != null && v > lastClose ? 'down' : 'up';
              return (
                <span key={i} style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                  MA{i === 0 ? 5 : i === 1 ? 10 : 20}
                  <b className={cls} style={{ marginLeft: 4, fontFamily: 'var(--font-mono)' }}>
                    {v != null ? v.toFixed(2) : '-'}
                  </b>
                </span>
              );
            })}
            <span className="chart-listdate">LoD 动态合并（相邻变化 ≤5% 合并），历史只读</span>
          </>
        )}
        {stock?.code && <span className="chart-listdate">上市 {stock.listDate || '-'}</span>}
      </div>
      <div className="chart-container" ref={containerRef}>
        <ReactEChartsCore
          ref={chartRef}
          key={`${selectedSymbol}-${selectedTimeframe}`}
          option={chartOption}
          style={{ height: '100%', width: '100%' }}
        />
      </div>
    </div>
  );
}
