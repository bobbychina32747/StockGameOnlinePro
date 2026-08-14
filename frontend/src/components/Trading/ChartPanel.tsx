import { useEffect, useMemo, useRef, useState } from 'react';
import ReactEChartsCore from 'echarts-for-react';
import { useMarketStore, useUIStore } from '../../store';
import { PriceText } from './PriceText';
import { isTradingTimeFor } from '../../utils/marketSessions';

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

// ─── LoD 降采样（视图宽度驱动）：按目标桶数均匀分桶合并，OHLC 保形（open 首/close 尾/high max/low min/vol 累加） ───
// 渲染点数 = min(原始点数, 目标桶数)，把几万根 K 线压到与视图宽度匹配的几百根，性能提升数倍

// ─── 成交量 y 轴上限：95 分位 × 1.5（防单根大单/用户成交撑爆比例，超出截断） ───
function volYMax(vals: number[]): number {
  if (!vals.length) return 1000;
  const sorted = [...vals].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  return Math.max(1000, Math.ceil(p95 * 1.5));
}

// ─── LoD 降采样：按固定桶宽贪心分桶（历史桶定稿即冻结，仅尾桶随实时数据增长） ───
// 桶宽由调用方缓存，只在容器宽度变化时重算 → 数据追加不改变历史桶边界，避免图表历史蜡烛跳动
function lodResample(bars: KlineData[], bucketSize: number): KlineData[] {
  if (!bars.length || bucketSize <= 1) return bars;
  const out: KlineData[] = [];
  for (let i = 0; i < bars.length; i += bucketSize) {
    const end = Math.min(i + bucketSize, bars.length);
    let high = -Infinity, low = Infinity, vol = 0;
    for (let j = i; j < end; j++) {
      if (bars[j].high > high) high = bars[j].high;
      if (bars[j].low < low) low = bars[j].low;
      vol += bars[j].volume;
    }
    out.push({ time: bars[i].time, open: bars[i].open, close: bars[end - 1].close, high, low, volume: vol });
  }
  return out;
}

export function ChartPanel() {
  const klines = useMarketStore((s) => s.klines);
  const prices = useMarketStore((s) => s.prices);
  const stocks = useMarketStore((s) => s.stocks);
  const selectedSymbol = useUIStore((s) => s.selectedSymbol);
  const selectedTimeframe = useUIStore((s) => s.selectedTimeframe);
  const setSelectedTimeframeRaw = useUIStore((s) => s.setSelectedTimeframe);
  const setSelectedTimeframe = (tf: string) => { setSelectedTimeframeRaw(tf); if (tf !== 'intraday') useUIStore.getState().tutorialEvent('timeframe'); };
  const setDetailSymbol = useUIStore((s) => s.setDetailSymbol);
  const debugMode = useUIStore((s) => s.debugMode);
  const debugGlobal = useUIStore((s) => s.debugGlobal);
  const marketMode = useUIStore((s) => s.marketMode);

  const stock = stocks.find((s: any) => s.symbol === selectedSymbol);
  // P1 复权：前复权模式下按各 bar 时点因子折算历史价格（消除分红跳空）
  const [adjMode, setAdjMode] = useState<'none' | 'forward'>('forward');
  const applyAdjustment = (bars: KlineData[]): KlineData[] => {
    if (adjMode !== 'forward') return bars;
    const series: { day: number; factor: number }[] = (stock as any)?.adjustmentSeries || [];
    if (!series || series.length === 0) return bars;
    const base = new Date(2024, 0, 1).getTime();
    return bars.map((b) => {
      const day = Math.floor((new Date(b.time).getTime() - base) / 86400000);
      let f = 1;
      for (const s of series) {
        if (s.day <= day) f = s.factor;
        else break;
      }
      return f === 1 ? b : { ...b, open: b.open * f, high: b.high * f, low: b.low * f, close: b.close * f };
    });
  };
  const klineData: KlineData[] = useMemo(() => applyAdjustment((klines[selectedSymbol]?.[selectedTimeframe] || []) as KlineData[]), [klines, selectedSymbol, selectedTimeframe, adjMode, stock]);
  // 分时图数据源：1min K 线
  const intradaySrc: KlineData[] = useMemo(() => applyAdjustment((klines[selectedSymbol]?.['1min'] || []) as KlineData[]), [klines, selectedSymbol, adjMode, stock]);
  const price = prices[selectedSymbol];
  const isIntraday = selectedTimeframe === 'intraday';

  // P5 亮色主题适配：图表轴/网格/提示框/滑条颜色随主题切换
  const theme = useUIStore((s) => s.theme);
  const isLight = theme === 'light';
  const CH = {
    axisLine: isLight ? '#e0e5eb' : '#2e3240',
    axisLabel: isLight ? '#5b6472' : '#6a6d78',
    tooltipBg: isLight ? '#ffffff' : '#1e222d',
    tooltipText: isLight ? '#101828' : '#d1d4dc',
    crossLine: isLight ? '#9aa4b2' : '#556080',
    crossStyle: isLight ? '#b6c0cd' : '#8a93a8',
    crossLabelBg: isLight ? '#eef1f5' : '#3a3f4e',
    legend: isLight ? '#5b6472' : '#9fa3b0',
    sliderBg: isLight ? '#eef1f5' : '#171922',
    sliderFiller: isLight ? 'rgba(29, 78, 216, 0.15)' : 'rgba(47,111,237,0.15)',
    sliderHandle: isLight ? '#1d4ed8' : '#2f6fed',
    up: isLight ? '#dc2626' : '#e03131',
    down: isLight ? '#059669' : '#00c853',
    volUp: isLight ? 'rgba(220, 38, 38, 0.4)' : 'rgba(224, 49, 49, 0.5)',
    volDown: isLight ? 'rgba(5, 150, 105, 0.4)' : 'rgba(0, 200, 83, 0.5)',
  };

  // ─── 休市超大遮罩（P1 按市场独立时段；调试模式下不显示） ───
  const [marketClosed, setMarketClosed] = useState(!isTradingTimeFor(marketMode));
  useEffect(() => {
    setMarketClosed(!isTradingTimeFor(marketMode));
    const id = setInterval(() => setMarketClosed(!isTradingTimeFor(marketMode)), 10000);
    return () => clearInterval(id);
  }, [marketMode]);
  const nextOpenText = () => {
    const m = marketMode || 'CN';
    const now = new Date();
    const day = now.getDay();
    const minutes = now.getHours() * 60 + now.getMinutes();
    if (m === 'US') {
      return (day === 0 || day === 6 || (minutes >= 240 && minutes < 1290)) ? '下次开盘：今日 21:30' : '下次开盘：明日 21:30';
    }
    if (day === 0 || day === 6 || minutes >= (m === 'HK' ? 960 : 900)) return '下次开盘：明日 9:30';
    if (minutes < 570) return '下次开盘：今日 9:30';
    if ((m === 'HK' && minutes >= 720 && minutes < 780) || (minutes >= 690 && minutes < 780)) return '下次开盘：今日 13:00';
    return '下次开盘：今日 13:00';
  };

  // ─── 图表修复：切页重挂载后强制 resize + 监听容器尺寸变化 ───
  const chartRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(800);
  // LoD 桶宽缓存：仅在容器宽度（目标桶数）变化时重算，数据追加只增长尾桶，保证历史蜡烛稳定
  const bucketSizeRef = useRef(1);
  const lastTargetRef = useRef(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const t1 = setTimeout(() => chartRef.current?.getEchartsInstance()?.resize(), 120);
    const t2 = setTimeout(() => chartRef.current?.getEchartsInstance()?.resize(), 400);
    const ro = new ResizeObserver((entries) => {
      chartRef.current?.getEchartsInstance()?.resize();
      const w = entries[0]?.contentRect?.width;
      if (w && w > 0) setContainerWidth(w);
    });
    ro.observe(el);
    return () => { clearTimeout(t1); clearTimeout(t2); ro.disconnect(); };
  }, [selectedSymbol, selectedTimeframe]);

  // ─── 受控缩放：用户缩放时保存 start/end，每次 option 更新都用当前值（不被重置） ───
  const [zoom, setZoom] = useState({ start: 40, end: 100 });
  const onChartEvents = {
    datazoom: (params: any) => {
      const b = params?.batch?.[0];
      if (b && b.start != null && b.end != null) setZoom({ start: b.start, end: b.end });
      else if (params?.start != null && params?.end != null) setZoom({ start: params.start, end: params.end });
    },
  };

  const chartOption = useMemo(() => {
  // ─── 分时图（S1）：当日 1min（均匀时间轴，不合并 → 无跨天断裂/分层） ───
    if (isIntraday) {
      // 只取最近一天（按模拟日期），消除跨天价格跳空导致的断裂
      let bars = intradaySrc;
      if (bars.length > 0) {
        const lastDay = new Date(bars[bars.length - 1].time).toDateString();
        bars = bars.filter((k) => new Date(k.time).toDateString() === lastDay);
      }
      // 分时：当天数据不合并（≤390 点直接画，保持均匀时间轴）
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
      const lastColor = closes[closes.length - 1] >= prevClose ? CH.up : CH.down;
      return {
        // merge 更新无动画（无感刷新 + 性能最优）
        animation: false, backgroundColor: 'transparent',
        grid: [
          { left: '8%', right: '8%', top: 30, bottom: 60 },
          { left: '8%', right: '8%', top: '74%', bottom: 16 },
        ],
        xAxis: [
          { type: 'category', data: times, axisLine: { lineStyle: { color: CH.axisLine } }, axisLabel: { color: CH.axisLabel, fontSize: 10 } },
          { type: 'category', data: times, gridIndex: 1, axisLine: { lineStyle: { color: CH.axisLine } }, axisLabel: { show: false } },
        ],
        yAxis: [
          { type: 'value', scale: true, splitLine: { lineStyle: { color: CH.axisLine, type: 'dashed' } }, axisLabel: { color: CH.axisLabel, fontSize: 10, formatter: (v: number) => v.toFixed(2) } },
          { type: 'value', gridIndex: 1, splitLine: { show: false }, axisLabel: { show: false }, max: volYMax(vols) },
        ],
        series: [
          { type: 'line', data: closes, smooth: false, symbol: 'none', lineStyle: { width: 1.5, color: lastColor }, itemStyle: { color: lastColor }, areaStyle: { color: lastColor + '26' }, name: '价格', markLine: { silent: true, symbol: 'none', data: [{ yAxis: prevClose, lineStyle: { color: CH.crossLine, type: 'dashed' } }], label: { show: false } } },
          { type: 'line', data: avgLine, smooth: true, symbol: 'none', lineStyle: { width: 1, color: '#f59e0b', type: 'dashed' }, name: '均价' },
          { type: 'bar', data: vols, xAxisIndex: 1, yAxisIndex: 1, itemStyle: { color: (pp: any) => (closes[pp.dataIndex] >= prevClose ? CH.volUp : CH.volDown) }, name: '成交量' },
        ],
        tooltip: {
          trigger: 'axis', backgroundColor: CH.tooltipBg, borderColor: CH.axisLine, textStyle: { color: CH.tooltipText, fontSize: 12 },
          axisPointer: { type: 'cross', lineStyle: { color: CH.crossLine, type: 'dashed' }, label: { backgroundColor: CH.crossLabelBg } },
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

    // ─── K线分支：LoD 降采样（按视图宽度，把几万根压到几百根） ───
    // 桶宽只在容器宽度变化时重算；数据追加只增长尾桶，历史桶定稿即冻结（不随实时数据跳动）
    const targetCount = Math.max(50, Math.round(containerWidth / 2));
    let bars: KlineData[];
    if (klineData.length <= targetCount) {
      bars = klineData;
    }
    else {
      if (lastTargetRef.current !== targetCount) {
        lastTargetRef.current = targetCount;
        bucketSizeRef.current = Math.max(1, Math.floor(klineData.length / targetCount));
      }
      bars = lodResample(klineData, bucketSizeRef.current);
    }
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
        { left: '8%', right: '8%', top: 30, bottom: 90 },
        { left: '8%', right: '8%', top: '74%', bottom: 20 },
      ],
      xAxis: [
        { type: 'category', data: klineTimes, axisLine: { lineStyle: { color: CH.axisLine } }, axisLabel: { color: CH.axisLabel, fontSize: 10 } },
        { type: 'category', data: klineTimes, gridIndex: 1, axisLine: { lineStyle: { color: CH.axisLine } }, axisLabel: { color: CH.axisLabel, fontSize: 9 } },
      ],
      yAxis: [
        { type: 'value', scale: true, splitLine: { lineStyle: { color: CH.axisLine, type: 'dashed' } }, axisLabel: { color: CH.axisLabel, fontSize: 10, formatter: (v: number) => v.toFixed(2) } },
        { type: 'value', gridIndex: 1, splitLine: { show: false }, axisLabel: { color: CH.axisLabel, fontSize: 9 }, min: 0, max: 100 },
      ],
      series: [
        // A股：阳线红、阴线绿
        { type: 'candlestick', data: candleData, itemStyle: { color: CH.up, color0: CH.down, borderColor: CH.up, borderColor0: CH.down }, name: 'K线' },
        { type: 'line', data: bb.upper, smooth: true, symbol: 'none', lineStyle: { width: 1, color: '#9c27b0', opacity: 0.4 }, name: 'BOLL上' },
        { type: 'line', data: bb.mid, smooth: true, symbol: 'none', lineStyle: { width: 1, color: '#9c27b0' }, name: 'BOLL中' },
        { type: 'line', data: bb.lower, smooth: true, symbol: 'none', lineStyle: { width: 1, color: '#9c27b0', opacity: 0.4 }, areaStyle: { color: 'rgba(156,39,176,0.05)' }, name: 'BOLL下' },
        { type: 'line', data: ma5, smooth: true, symbol: 'none', lineStyle: { width: 1, color: '#ffa726' }, name: 'MA5' },
        { type: 'line', data: ma10, smooth: true, symbol: 'none', lineStyle: { width: 1, color: '#42a5f5' }, name: 'MA10' },
        { type: 'line', data: ma20, smooth: true, symbol: 'none', lineStyle: { width: 1, color: '#ef5350' }, name: 'MA20' },
        { type: 'line', data: rsi, smooth: true, symbol: 'none', xAxisIndex: 1, yAxisIndex: 1, lineStyle: { width: 1, color: '#ab47bc' }, name: 'RSI(14)', markLine: { silent: true, data: [{ yAxis: 70, lineStyle: { color: CH.up, type: 'dashed' } }, { yAxis: 30, lineStyle: { color: CH.down, type: 'dashed' } }] } },
      ],
      tooltip: {
        trigger: 'axis',
        backgroundColor: CH.tooltipBg,
        borderColor: CH.axisLine,
        textStyle: { color: CH.tooltipText, fontSize: 12 },
        axisPointer: {
          type: 'cross',
          lineStyle: { color: CH.crossLine, type: 'dashed' },
          crossStyle: { color: CH.crossStyle },
          label: { backgroundColor: CH.crossLabelBg },
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
      legend: { data: ['MA5', 'MA10', 'MA20', 'BOLL中', 'RSI(14)'], top: 2, textStyle: { color: CH.legend, fontSize: 10 } },
      // 受控缩放：start/end 来自用户当前缩放（merge 更新不会重置）
      dataZoom: [
        { type: 'inside', ...zoom },
        { type: 'slider', height: 14, bottom: 4, ...zoom, borderColor: CH.axisLine, backgroundColor: CH.sliderBg, fillerColor: CH.sliderFiller, handleStyle: { color: CH.sliderHandle }, textStyle: { color: '#6a6d78', fontSize: 9 } },
      ],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [klineData, selectedTimeframe, intradaySrc, isIntraday, zoom, containerWidth, theme]);

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
            <span className="chart-listdate">LoD 降采样（按视图宽度合并，性能优化）</span>
          </>
        )}
        {stock?.code && <span className="chart-listdate">上市 {stock.listDate || '-'}</span>}
        {(stock as any)?.adjustmentSeries?.length > 0 && (
          <button
            className="btn btn-ghost btn-sm"
            style={{ fontSize: 11, padding: '1px 6px' }}
            title="前复权：历史价格按分红折算，消除除权跳空"
            onClick={() => setAdjMode(adjMode === 'forward' ? 'none' : 'forward')}
          >
            {adjMode === 'forward' ? '前复权' : '不复权'}
          </button>
        )}
      </div>
      <div className="chart-container" ref={containerRef}>
        <ReactEChartsCore
          ref={chartRef}
          key={`${selectedSymbol}-${selectedTimeframe}`}
          option={chartOption}
          onEvents={onChartEvents}
          style={{ height: '100%', width: '100%' }}
        />
      </div>
      {/* 休市超大遮罩（调试模式/开盘时自动隐藏） */}
      {marketClosed && !debugMode && !debugGlobal && (
        <div className="market-closed-overlay">
          <div className="mco-title">📴 已休市</div>
          <div className="mco-sub">交易时段 9:30 - 11:30 / 13:00 - 15:00（工作日）</div>
          <div className="mco-next">{nextOpenText()}</div>
          <div className="mco-tip">当前为模拟历史数据，开盘后实时更新</div>
        </div>
      )}
    </div>
  );
}
