/**
 * i18n 字典（简体中文）—— Phase G-1「i18n V1」的**唯一真源**
 *
 * 约定：
 * 1. 键名用点分层级（`nav.trading`），扁平结构便于「完整性门禁」比对（见 coverage.ts）。
 * 2. 本文件是键集合的权威来源：`dict.en.ts` / `dict.zh-Hant.ts` 用 `Record<I18nKey, string>` 声明，
 *    **少一个键就是编译期错误**（比运行时缺 key 更早暴露）。
 * 3. 文案里可以带 `{name}` 占位参数（`translate()` 负责替换）；翻译时占位符必须原样保留。
 * 4. 新增文案：先加在这里，再补另两个语言；然后把文件登记进 coverage.ts 的 COVERED_FILES，
 *    门禁会挡住"文件里还有中文没抽出来"和"用了不存在的 key"两种情况。
 */
export const zhCN = {
    // ─── 导航（顶栏）───
    'nav.trading': '交易',
    'nav.ranking': '排行榜',
    'nav.profile': '个人中心',

    // ─── 布局：状态区与按钮 ───
    'layout.speed.fast': '⏩ 高速回放（1秒=1分钟）',
    'layout.speed.realtime': '🕐 实时行情',
    'layout.speed.title': 'TICK_INTERVAL_MS 配置',
    'layout.settings': '设置',
    'layout.theme.toggle': '切换主题',
    'layout.logout': '退出',

    // ─── 顶栏行情条（示例标的简称，行情数据里的全名仍由后端提供）───
    'ticker.t1': '芯澜',
    'ticker.c1': '杏花',
    'ticker.e2': '电芯',

    // ─── 设置面板 ───
    'settings.title': '⚙️ 设置',
    'settings.theme': '主题',
    'settings.theme.dark': '深色',
    'settings.theme.light': '浅色',
    'settings.timeframe': '默认周期',
    'settings.anim': '数字动画',
    'settings.on': '开',
    'settings.off': '关',
    'settings.density': '字体密度',
    'settings.density.standard': '标准',
    'settings.density.compact': '紧凑',
    'settings.voice': '语音提醒',
    'settings.voice.on': '已开启（波动≥1%播报）',
    'settings.voice.off': '已关闭',
    'settings.voice.hint': '在 AI 助手卡片切换',
    'settings.language': '语言',

    // ─── 周期名（设置面板 + 后续图表面复用）───
    'timeframe.intraday': '分时',
    'timeframe.1min': '1分',
    'timeframe.5min': '5分',
    'timeframe.60min': '60分',
    'timeframe.daily': '日线',
    'timeframe.weekly': '周线',
    'timeframe.monthly': '月线',
} as const;

/** 全部合法的文案键（= 简体字典的键集合） */
export type I18nKey = keyof typeof zhCN;
