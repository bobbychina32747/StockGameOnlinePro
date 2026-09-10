/**
 * i18n 核心（Phase G-1）——零依赖实现：不引 i18next（体积），只用 React 18 的 useSyncExternalStore。
 *
 * 设计要点：
 * 1. 字典是静态对象 → `translate()` 是纯函数、可单测；语言状态放在模块级 store（组件外也能读）。
 * 2. 语言持久化在 localStorage（`sgp.lang`）；**默认恒为 zh-CN**，不跟随 navigator.language——
 *    本阶段只有导航/设置两面完成抽取，自动切语言会让界面中英混杂（G-2 覆盖面补齐后再开）。
 * 3. 缺 key 时返回 key 本身（`nav.trading` 这种字样出现在界面上比静默空串更容易被发现），
 *    并由 coverage 门禁在测试期拦截。
 */
import { useCallback, useSyncExternalStore } from 'react';
import { zhCN, type I18nKey } from './dict.zh-CN';
import { en } from './dict.en';
import { zhHant } from './dict.zh-Hant';

export type { I18nKey };

export type Lang = 'zh-CN' | 'en' | 'zh-Hant';

export const DEFAULT_LANG: Lang = 'zh-CN';

/** 语言清单：label 用**各语言自己的写法**（endonym），用户在任何语言下都能认出自己的语言 */
export const LANGS: ReadonlyArray<{ id: Lang; label: string }> = [
    { id: 'zh-CN', label: '简体中文' },
    { id: 'en', label: 'English' },
    { id: 'zh-Hant', label: '繁體中文' },
];

export const DICTS: Record<Lang, Record<I18nKey, string>> = {
    'zh-CN': zhCN,
    en,
    'zh-Hant': zhHant,
};

export const LANG_STORAGE_KEY = 'sgp.lang';

export function isLang(value: unknown): value is Lang {
    return value === 'zh-CN' || value === 'en' || value === 'zh-Hant';
}

function readStoredLang(): Lang {
    try {
        const raw = globalThis.localStorage?.getItem(LANG_STORAGE_KEY);
        return isLang(raw) ? raw : DEFAULT_LANG;
    }
    catch {
        // 隐私模式 / 无 localStorage / SSR：退回默认语言（不影响功能）
        return DEFAULT_LANG;
    }
}

let current: Lang = readStoredLang();
const listeners = new Set<() => void>();

export function getLang(): Lang {
    return current;
}

/** 切换语言：写 localStorage + 同步 <html lang> + 通知订阅者（组件重渲染） */
export function setLang(lang: Lang): void {
    if (!isLang(lang)) return;
    const changed = lang !== current;
    current = lang;
    try {
        globalThis.localStorage?.setItem(LANG_STORAGE_KEY, lang);
    }
    catch { /* 写不进去不影响本次会话的语言生效 */ }
    try {
        if (globalThis.document) globalThis.document.documentElement.lang = lang;
    }
    catch { /* 非浏览器环境忽略 */ }
    if (changed) listeners.forEach((l) => l());
}

export function subscribeLang(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** 首次加载即把 <html lang> 对齐到生效语言（a11y / 字体回退） */
if (typeof globalThis.document !== 'undefined') {
    try {
        globalThis.document.documentElement.lang = current;
    }
    catch { /* 忽略 */ }
}

/**
 * 纯翻译函数：`{name}` 占位替换；缺 key / 空文案返回 key 本身（便于发现漏译）。
 * 占位参数缺失时保留原样的 `{name}`（不写 undefined 进界面）。
 */
export function translate(lang: Lang, key: I18nKey, params?: Record<string, string | number>): string {
    const dict = DICTS[lang] || DICTS[DEFAULT_LANG];
    const raw = dict[key];
    const text = typeof raw === 'string' && raw !== '' ? raw : String(key);
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (whole, name: string) => (params[name] !== undefined ? String(params[name]) : whole));
}

/** 组件入口：返回当前语言、切换函数与绑定语言的 `t`（语言变化时组件自动重渲染） */
export function useI18n() {
    const lang = useSyncExternalStore(subscribeLang, getLang, getLang);
    const t = useCallback(
        (key: I18nKey, params?: Record<string, string | number>) => translate(lang, key, params),
        [lang],
    );
    return { lang, setLang, t };
}

/** 非组件代码用：按当前语言即时翻译 */
export function t(key: I18nKey, params?: Record<string, string | number>): string {
    return translate(current, key, params);
}
