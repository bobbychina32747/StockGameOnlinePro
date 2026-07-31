import { useEffect, useRef, useState } from 'react';
import { useUIStore } from '../../store';

const TYPE_ICON: Record<string, string> = {
  fill: '✅',
  news: '📰',
  achievement: '🏅',
  report: '📊',
  risk: '⚠️',
};

const fmt = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// Q6 通知中心：顶栏铃铛 + 未读角标 + 下拉面板
export function NoticeCenter() {
  const notices = useUIStore((s) => s.notices);
  const markNoticesRead = useUIStore((s) => s.markNoticesRead);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const unread = notices.filter((n) => !n.read).length;

  return (
    <div className="notice-center" ref={ref}>
      <button
        className="notice-bell"
        title="通知中心"
        onClick={() => {
          setOpen(!open);
          if (!open) setTimeout(() => markNoticesRead(), 800);
        }}
      >
        🔔
        {unread > 0 && <span className="notice-badge">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="notice-panel">
          <div className="notice-panel-header">
            <b>通知中心</b>
            <span>{notices.length} 条</span>
          </div>
          <div className="notice-list">
            {notices.length === 0 && (
              <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
                暂无通知
              </div>
            )}
            {notices.map((n) => (
              <div key={n.id} className={`notice-item ${n.read ? '' : 'unread'}`}>
                <span className="notice-icon">{TYPE_ICON[n.type] || '📌'}</span>
                <div className="notice-body">
                  <b>{n.title}</b>
                  <i>{n.desc}</i>
                </div>
                <span className="notice-time">{fmt(n.time)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
