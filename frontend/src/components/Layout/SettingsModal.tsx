import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useUIStore } from '../../store';
import { LANGS, useI18n, type I18nKey } from '../../i18n';

// Q12 设置面板：主题/默认周期/动画/密度/语音
// Phase G-1: 文案走 i18n 字典；周期名同样取字典（key 由 value 拼出，先登记在 dict.zh-CN 的 timeframe.* 下）
const TIMEFRAMES = ['intraday', '1min', '5min', '60min', 'daily', 'weekly', 'monthly'] as const;

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { lang, setLang, t } = useI18n();
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

  // P0 修复（弹窗不可见/无遮罩）：必须 portal 到 document.body。
  // 根因：本组件挂在 <header class="top-bar"> 内部，而 .top-bar 带 backdrop-filter —— 按 CSS 规范，
  // 带 filter/backdrop-filter 的元素会成为其后代 position:fixed 的**包含块**，于是 .modal-overlay 的
  // inset:0 只等于顶栏那一条（实测遮罩高 72px 而非整屏 900px）：没有背景遮罩、点窗外不关闭，
  // 弹窗纵向位置还被顶栏高度牵着走（内容变高时可能整块跑到视口上方看不见）。
  // portal 到 body 后包含块重新变回视口，遮罩恢复整屏。
  const content = (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{t('settings.title')}</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="settings-body">
          <div className="setting-row">
            <span className="setting-label">{t('settings.language')}</span>
            <div className="setting-control">
              {LANGS.map((l) => (
                <button
                  key={l.id}
                  data-testid={`lang-${l.id}`}
                  className={`btn btn-sm ${lang === l.id ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setLang(l.id)}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </div>
          <div className="setting-row">
            <span className="setting-label">{t('settings.theme')}</span>
            <div className="setting-control">
              <button className={`btn btn-sm ${theme === 'dark' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTheme('dark')}>{t('settings.theme.dark')}</button>
              <button className={`btn btn-sm ${theme === 'light' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTheme('light')}>{t('settings.theme.light')}</button>
            </div>
          </div>
          <div className="setting-row">
            <span className="setting-label">{t('settings.timeframe')}</span>
            <select
              className="input"
              value={selectedTimeframe}
              onChange={(e) => setSelectedTimeframe(e.target.value)}
              style={{ width: 140 }}
            >
              {TIMEFRAMES.map((k) => (
                <option key={k} value={k}>{t(`timeframe.${k}` as I18nKey)}</option>
              ))}
            </select>
          </div>
          <div className="setting-row">
            <span className="setting-label">{t('settings.anim')}</span>
            <div className="setting-control">
              <button className={`btn btn-sm ${animEnabled ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setAnimEnabled(true)}>{t('settings.on')}</button>
              <button className={`btn btn-sm ${!animEnabled ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setAnimEnabled(false)}>{t('settings.off')}</button>
            </div>
          </div>
          <div className="setting-row">
            <span className="setting-label">{t('settings.density')}</span>
            <div className="setting-control">
              <button className={`btn btn-sm ${density === 'standard' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setDensity('standard')}>{t('settings.density.standard')}</button>
              <button className={`btn btn-sm ${density === 'compact' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setDensity('compact')}>{t('settings.density.compact')}</button>
            </div>
          </div>
          <div className="setting-row">
            <span className="setting-label">{t('settings.voice')}</span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {voiceOn ? t('settings.voice.on') : t('settings.voice.off')} · {t('settings.voice.hint')}
            </span>
          </div>
        </div>
      </div>
    </div>
  );

  return typeof document === 'undefined' ? content : createPortal(content, document.body);
}
