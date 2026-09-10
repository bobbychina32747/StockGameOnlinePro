/**
 * i18n 字典（繁體中文）
 *
 * 与 en 同样用 `Record<I18nKey, string>` 钉死键集合；占位符（`{name}`）与简体保持同名。
 * 用词按台港习惯（設定 / 語言 / 排行 / 週線 / 字型密度）。
 */
import type { I18nKey } from './dict.zh-CN';

export const zhHant: Record<I18nKey, string> = {
    // ─── 導覽列 ───
    'nav.trading': '交易',
    'nav.ranking': '排行榜',
    'nav.profile': '個人中心',

    // ─── 版面：狀態區與按鈕 ───
    'layout.speed.fast': '⏩ 高速回放（1秒=1分鐘）',
    'layout.speed.realtime': '🕐 即時行情',
    'layout.speed.title': 'TICK_INTERVAL_MS 設定',
    'layout.settings': '設定',
    'layout.theme.toggle': '切換主題',
    'layout.logout': '登出',

    // ─── 頂欄行情列（示例標的簡稱）───
    'ticker.t1': '芯瀾',
    'ticker.c1': '杏花',
    'ticker.e2': '電芯',

    // ─── 設定面板 ───
    'settings.title': '⚙️ 設定',
    'settings.theme': '主題',
    'settings.theme.dark': '深色',
    'settings.theme.light': '淺色',
    'settings.timeframe': '預設週期',
    'settings.anim': '數字動畫',
    'settings.on': '開',
    'settings.off': '關',
    'settings.density': '字型密度',
    'settings.density.standard': '標準',
    'settings.density.compact': '緊湊',
    'settings.voice': '語音提醒',
    'settings.voice.on': '已開啟（波動≥1% 播報）',
    'settings.voice.off': '已關閉',
    'settings.voice.hint': '在 AI 助手卡片切換',
    'settings.language': '語言',

    // ─── 週期名 ───
    'timeframe.intraday': '分時',
    'timeframe.1min': '1分',
    'timeframe.5min': '5分',
    'timeframe.60min': '60分',
    'timeframe.daily': '日線',
    'timeframe.weekly': '週線',
    'timeframe.monthly': '月線',
};
