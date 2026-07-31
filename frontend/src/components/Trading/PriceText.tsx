import { useEffect, useRef, useState } from 'react';
import { useUIStore } from '../../store';

// 价格文本组件：数字滚动动画 + 瞬时涨跌闪烁（A股红涨绿跌）
// Q13：动画开关（设置面板）关闭时直接显示，零开销
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
  const animEnabled = useUIStore((s) => s.animEnabled);
  const [display, setDisplay] = useState(value);
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  const fromRef = useRef(value);
  const prevRef = useRef(value);

  // 数字滚动动画（开关关闭时直接跳到新值）
  useEffect(() => {
    const from = fromRef.current;
    const to = value;
    if (from === to) return;
    if (!animEnabled) {
      fromRef.current = to;
      setDisplay(to);
      return;
    }
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
  }, [value, duration, animEnabled]);

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
