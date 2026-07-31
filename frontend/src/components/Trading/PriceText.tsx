import { useEffect, useRef, useState } from 'react';

// 价格文本组件：数字滚动动画 + 瞬时涨跌闪烁（A股红涨绿跌）
// - 数字变化时从旧值平滑滚动到新值
// - 每次 tick 变化时背景闪一下红（涨）或绿（跌）
// - 颜色由外部 className 控制（up/down），flash 由内部管理
export function PriceText({
  value,
  decimals = 2,
  duration = 450,
  className = '',
  prefix = '',
  suffix = '',
}: {
  value: number;
  decimals?: number;
  duration?: number;
  className?: string;
  prefix?: string;
  suffix?: string;
}) {
  const [display, setDisplay] = useState(value);
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  const fromRef = useRef(value);
  const prevRef = useRef(value);

  // 数字滚动动画
  useEffect(() => {
    const from = fromRef.current;
    const to = value;
    if (from === to) return;
    fromRef.current = to;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + (to - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);

  // 涨跌闪烁
  useEffect(() => {
    const prev = prevRef.current;
    if (value !== prev) {
      prevRef.current = value;
      setFlash(value > prev ? 'up' : 'down');
      const t = setTimeout(() => setFlash(null), 650);
      return () => clearTimeout(t);
    }
  }, [value]);

  const cls = ['price-text', flash ? `flash-${flash}` : '', className].filter(Boolean).join(' ');
  return (
    <span className={cls}>
      {prefix}{display.toFixed(decimals)}{suffix}
    </span>
  );
}
