import { useEffect } from 'react';
import { useUIStore } from '../../store';

// Q12 设置面板：主题/默认周期/动画/密度/语音
const TIMEFRAMES = [
  ['intraday', '分时'], ['1min', '1分'], ['5min', '5分'], ['60min', '60分'],
  ['daily', '日线'], ['weekly', '周线'], ['monthly', '月线'],
];

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  const selectedTimeframe = useUIStore((s) => s.selectedTimeframe);
  const setSelectedTimeframe = useUIStore((s) => s.setSelectedTimeframe);
  const animEnabled = useUIStore((s) => s.animEnabled);
  const setAnimEnabled = useUIStore((s) => s.setAnimEnabled);
  const density = useUIStore((s) => s.density);
  const setDensity = useUIStore((s) => s.setDensity);
  const voiceOn = localStorage.getItem('ss.voice') === '1';

  // 密度应用到 body
  useEffect(() => {
    document.body.classList.toggle('density-compact', density === 'compact');
  }, [density]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>⚙️ 设置</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="settings-body">
          <div className="setting-row">
            <span className="setting-label">主题</span>
            <div className="setting-control">
              <button className={`btn btn-sm ${theme === 'dark' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTheme('dark')}>深色</button>
              <button className={`btn btn-sm ${theme === 'light' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTheme('light')}>浅色</button>
            </div>
          </div>
          <div className="setting-row">
            <span className="setting-label">默认周期</span>
            <select
              className="input"
              value={selectedTimeframe}
              onChange={(e) => setSelectedTimeframe(e.target.value)}
              style={{ width: 140 }}
            >
              {TIMEFRAMES.map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </select>
          </div>
          <div className="setting-row">
            <span className="setting-label">数字动画</span>
            <div className="setting-control">
              <button className={`btn btn-sm ${animEnabled ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setAnimEnabled(true)}>开</button>
              <button className={`btn btn-sm ${!animEnabled ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setAnimEnabled(false)}>关</button>
            </div>
          </div>
          <div className="setting-row">
            <span className="setting-label">字体密度</span>
            <div className="setting-control">
              <button className={`btn btn-sm ${density === 'standard' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setDensity('standard')}>标准</button>
              <button className={`btn btn-sm ${density === 'compact' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setDensity('compact')}>紧凑</button>
            </div>
          </div>
          <div className="setting-row">
            <span className="setting-label">语音提醒</span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {voiceOn ? '已开启（波动≥1%播报）' : '已关闭'} · 在 AI 助手卡片切换
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
