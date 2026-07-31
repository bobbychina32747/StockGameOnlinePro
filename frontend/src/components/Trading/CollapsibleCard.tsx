import { useState } from 'react';

// 可折叠卡片：点击标题收起/展开（右侧面板手风琴式）
export function CollapsibleCard({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="card">
      <h3
        onClick={() => setOpen(!open)}
        style={{ cursor: 'pointer', userSelect: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <span>{title}</span>
        <span className="collapse-arrow">{open ? '▾' : '▸'}</span>
      </h3>
      {open && children}
    </div>
  );
}
