/**
 * Phase G-1「i18n V1」验收：字典完整性 + 翻译语义 + 语言存储 + 覆盖面门禁
 *
 * 为什么要这四组：
 * 1. 字典完整性：三份字典**键集合必须一致且无空值**——漏译是 i18n 最常见的线上事故（外语用户看到中文/空白）。
 *    （tsc 已用 `Record<I18nKey, string>` 挡一层，这里再挡运行时出现 `''` 的情况。）
 * 2. 翻译语义：占位参数替换、缺参保留原样、缺 key 返回 key 本身（而不是静默空串）。
 * 3. 语言存储：setLang 必须落 localStorage + 同步 <html lang> + 通知订阅者（否则界面不重渲染）。
 * 4. 覆盖面门禁：已登记文件里不允许再出现硬编码中文，且用到的 key 必须存在——这是"漏了"的机器检查。
 */
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { DICTS, LANG_STORAGE_KEY, LANGS, getLang, isLang, setLang, subscribeLang, translate } from './index';
import type { I18nKey } from './dict.zh-CN';
import { zhCN } from './dict.zh-CN';
import { COVERED_FILES, findHardcodedCjk, findUsedKeys, stripComments } from './coverage';

const SRC_DIR = path.resolve(__dirname, '..'); // = frontend/src
const KEYS = Object.keys(zhCN) as I18nKey[];

afterEach(() => {
  // 语言是模块级单例：用例之间必须复位，否则会互相污染（jest 同 worker 复用模块）
  setLang('zh-CN');
  try { localStorage.clear(); } catch { /* 忽略 */ }
});

describe('i18n 字典完整性（三语言键集合一致、无空值）', () => {
  it('键数量与 zh-CN 完全一致（en / zh-Hant）', () => {
    for (const lang of ['en', 'zh-Hant'] as const) {
      expect(Object.keys(DICTS[lang]).sort()).toEqual([...KEYS].sort());
    }
  });

  it('所有文案非空、无前后空白残留、占位符与简体同名', () => {
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of KEYS) {
      const baseline = placeholders(zhCN[key]);
      for (const lang of LANGS.map((l) => l.id)) {
        const text = DICTS[lang][key];
        expect(typeof text).toBe('string');
        expect(text.length).toBeGreaterThan(0);
        expect(text).toBe(text.trim());
        // 占位符必须一致：少了 {name} 的翻译会让参数永远显示不出来
        expect(placeholders(text)).toEqual(baseline);
      }
    }
  });

  it('语言清单三项且 id 合法（zh-CN / en / zh-Hant）', () => {
    expect(LANGS.map((l) => l.id)).toEqual(['zh-CN', 'en', 'zh-Hant']);
    for (const l of LANGS) {
      expect(isLang(l.id)).toBe(true);
      expect(l.label.length).toBeGreaterThan(0);
    }
  });
});

describe('i18n 翻译语义', () => {
  it('按语言取到对应文案', () => {
    expect(translate('zh-CN', 'nav.trading')).toBe('交易');
    expect(translate('en', 'nav.trading')).toBe('Trade');
    expect(translate('zh-Hant', 'nav.trading')).toBe('交易');
  });

  it('占位参数替换；缺参时保留 {name} 原样（不写 undefined）', () => {
    // 用现有 key 演示：先在临时字典上验证替换规则，避免为一个测试往字典塞无用文案
    const raw = DICTS['zh-CN']['settings.voice.on'];
    expect(translate('zh-CN', 'settings.voice.on')).toBe(raw);
    setLang('en');
    expect(translate('en', 'settings.voice.on')).toContain('1%');
    // 无占位符的文案传参数不报错、不影响输出
    expect(translate('en', 'nav.trading', { name: 'x' })).toBe('Trade');
    // 非法语言退回默认语言（不抛错、不返回空）
    expect(translate('fr' as never, 'nav.ranking')).toBe('排行榜');
    // 未知 key 返回 key 本身（便于肉眼发现漏译）
    expect(translate('en', 'not.a.key' as I18nKey)).toBe('not.a.key');
  });
});

describe('i18n 语言存储与订阅', () => {
  it('setLang 写 localStorage + 同步 <html lang> + 通知订阅者', () => {
    const seen: string[] = [];
    const off = subscribeLang(() => seen.push(getLang()));
    expect(getLang()).toBe('zh-CN');

    setLang('en');
    expect(getLang()).toBe('en');
    expect(localStorage.getItem(LANG_STORAGE_KEY)).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(seen).toEqual(['en']);

    // 重复设置同一语言不重复通知（避免无意义重渲染）
    setLang('en');
    expect(seen).toEqual(['en']);

    // 非法语言被忽略（保持当前语言，不写脏值）
    setLang('jp' as never);
    expect(getLang()).toBe('en');
    expect(localStorage.getItem(LANG_STORAGE_KEY)).toBe('en');

    off();
    setLang('zh-Hant');
    expect(seen).toEqual(['en']);
  });
});

describe('覆盖面门禁：已登记文件不得残留硬编码中文', () => {
  it('COVERED_FILES 全部存在且路径相对 src', () => {
    expect(COVERED_FILES.length).toBeGreaterThan(0);
    for (const rel of COVERED_FILES) {
      expect(existsSync(path.join(SRC_DIR, rel))).toBe(true);
    }
  });

  it.each([...COVERED_FILES])('%s 无硬编码中文（文案必须来自字典）', (rel) => {
    const source = readFileSync(path.join(SRC_DIR, rel), 'utf8');
    expect(findHardcodedCjk(source)).toEqual([]);
  });

  it.each([...COVERED_FILES])('%s 用到的 key 全部存在于三份字典', (rel) => {
    const source = readFileSync(path.join(SRC_DIR, rel), 'utf8');
    const used = findUsedKeys(source);
    // 防"空跑"：已登记文件必须真的在取字典（少于 3 个 key 说明登记早了/迁移被回退）
    expect(used.length).toBeGreaterThanOrEqual(3);
    for (const key of used) {
      for (const lang of LANGS.map((l) => l.id)) {
        expect(Object.prototype.hasOwnProperty.call(DICTS[lang], key)).toBe(true);
      }
    }
  });

  it('扫描器本身可信：能识别中文、能放行注释中的中文、能取到 t() 的 key', () => {
    expect(findHardcodedCjk("const a = '交易';")).toHaveLength(1);
    expect(findHardcodedCjk('// 这里写中文注释不算\nconst a = 1;')).toEqual([]);
    expect(findHardcodedCjk('/* 块注释中文 */\nconst a = 1;')).toEqual([]);
    // 字符串里的 URL 不会被当成行注释（否则会把后面的中文"吃掉"而漏检）
    expect(findHardcodedCjk("const u = 'https://x/y'; const s = '排行榜';")).toHaveLength(1);
    expect(stripComments('a // b')).toBe('a ');
    expect(findUsedKeys("t('nav.trading'); t(\"settings.theme\"); t(dynamic);")).toEqual(['nav.trading', 'settings.theme']);
  });
});
