/**
 * i18n 覆盖面门禁的扫描工具（仅测试使用，不进应用包）
 *
 * 为什么需要它：i18n 最大的失败模式不是"翻译错"，而是"漏了"。人工 review 挡不住
 * —— 新写的组件里再冒出一句硬编码中文，肉眼看不出来、运行时也不报错，只有外语用户会看到中文。
 * 所以本模块把"漏"变成两个可判定的机器检查（见 i18n.test.ts）：
 *   ① 已登记文件里**不允许再出现任何中文**（中文字符数必须为 0）——文案只允许来自字典；
 *   ② 已登记文件里 `t('key')` 用到的 key **必须存在于全部三份字典**（漏译 = 编译期已挡，此处兜运行时拼写错误）。
 *
 * COVERED_FILES 是**白名单**：只有完整抽完的文件才登记进来，未登记的文件不参与检查——
 * 这样 i18n 可以按面（导航 → 交易 → 排行）逐批推进，而门禁从第一批起就是真的。
 */

/** 相对 `frontend/src/` 的路径，用 `/` 分隔（与仓库跨平台一致） */
export const COVERED_FILES: ReadonlyArray<string> = [
    'components/Layout/AppLayout.tsx',
    'components/Layout/SettingsModal.tsx',
];

/** 去掉注释（块注释 + 行注释）。`[^:]` 前置守卫避免把 `https://` 里的 `//` 当注释起点。 */
export function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** 去掉注释后仍存在的中文字符位置（返回 `行号: 片段`，便于直接定位） */
export function findHardcodedCjk(source: string): string[] {
    const hits: string[] = [];
    const lines = stripComments(source).split('\n');
    lines.forEach((line, i) => {
        if (CJK.test(line)) hits.push(`${i + 1}: ${line.trim().slice(0, 120)}`);
    });
    return hits;
}

/** 提取源码里 `t('key')` / `t("key")` 用到的 key（去重，保持出现顺序） */
export function findUsedKeys(source: string): string[] {
    const keys = new Set<string>();
    for (const m of stripComments(source).matchAll(/\bt\(\s*['"]([^'"]+)['"]/g)) keys.add(m[1]);
    return [...keys];
}
