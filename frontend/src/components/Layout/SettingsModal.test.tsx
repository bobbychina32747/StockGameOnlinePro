// Phase G-1 回归：设置面板的语言切换必须真正"就地生效"——
// 点 English 后面板文案立刻变英文（不能要求刷新页面），并落 localStorage 供下次进入沿用；
// 切回简体同理。原缺陷风险：语言只写进 localStorage 但没通知订阅者 → 界面不重渲染。
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SettingsModal } from './SettingsModal';
import { LANG_STORAGE_KEY, getLang, setLang } from '../../i18n';

describe('SettingsModal 语言切换（i18n V1）', () => {
  afterEach(() => {
    cleanup();
    setLang('zh-CN');
    try { localStorage.clear(); } catch { /* 忽略 */ }
  });

  it('默认简体：面板文案为中文', () => {
    render(<SettingsModal open onClose={() => {}} />);
    expect(screen.getByText('⚙️ 设置')).toBeTruthy();
    expect(screen.getByText('主题')).toBeTruthy();
    expect(screen.getByText('语言')).toBeTruthy();
  });

  it('点 English 就地切英文并持久化；点回简体恢复', () => {
    render(<SettingsModal open onClose={() => {}} />);

    fireEvent.click(screen.getByTestId('lang-en'));
    expect(getLang()).toBe('en');
    expect(localStorage.getItem(LANG_STORAGE_KEY)).toBe('en');
    expect(screen.getByText('⚙️ Settings')).toBeTruthy();
    expect(screen.getByText('Language')).toBeTruthy();
    expect(screen.queryByText('⚙️ 设置')).toBeNull();
    // 周期下拉同样被本地化（value 不变、显示名变化）
    expect(screen.getByText('Daily')).toBeTruthy();

    fireEvent.click(screen.getByTestId('lang-zh-Hant'));
    expect(getLang()).toBe('zh-Hant');
    expect(screen.getByText('⚙️ 設定')).toBeTruthy();
    expect(screen.getByText('語言')).toBeTruthy();
  });

  it('关闭状态不渲染面板内容（open=false 早退）', () => {
    render(<SettingsModal open={false} onClose={() => {}} />);
    expect(screen.queryByText('语言')).toBeNull();
  });
});
