/**
 * i18n 字典（English）
 *
 * `Record<I18nKey, string>` 是刻意的：漏译 = 编译期报错（tsc 门禁），不依赖运行时检查。
 * 占位符（`{name}`）必须与 dict.zh-CN.ts 保持同名。
 */
import type { I18nKey } from './dict.zh-CN';

export const en: Record<I18nKey, string> = {
    // ─── Navigation ───
    'nav.trading': 'Trade',
    'nav.ranking': 'Ranking',
    'nav.profile': 'Profile',

    // ─── Layout: status area & buttons ───
    'layout.speed.fast': '⏩ Fast replay (1s = 1min)',
    'layout.speed.realtime': '🕐 Live quotes',
    'layout.speed.title': 'TICK_INTERVAL_MS setting',
    'layout.settings': 'Settings',
    'layout.theme.toggle': 'Toggle theme',
    'layout.logout': 'Log out',

    // ─── Top-bar ticker (short names of the demo symbols) ───
    'ticker.t1': 'Xinlan',
    'ticker.c1': 'Xinghua',
    'ticker.e2': 'Dianxin',

    // ─── Settings panel ───
    'settings.title': '⚙️ Settings',
    'settings.theme': 'Theme',
    'settings.theme.dark': 'Dark',
    'settings.theme.light': 'Light',
    'settings.timeframe': 'Default interval',
    'settings.anim': 'Number animation',
    'settings.on': 'On',
    'settings.off': 'Off',
    'settings.density': 'Font density',
    'settings.density.standard': 'Standard',
    'settings.density.compact': 'Compact',
    'settings.voice': 'Voice alerts',
    'settings.voice.on': 'On (announces moves ≥1%)',
    'settings.voice.off': 'Off',
    'settings.voice.hint': 'switch it on the AI assistant card',
    'settings.language': 'Language',

    // ─── Intervals ───
    'timeframe.intraday': 'Intraday',
    'timeframe.1min': '1m',
    'timeframe.5min': '5m',
    'timeframe.60min': '60m',
    'timeframe.daily': 'Daily',
    'timeframe.weekly': 'Weekly',
    'timeframe.monthly': 'Monthly',
};
