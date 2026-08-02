

export const MARKET = {
    OPEN_HOUR: 9,
    OPEN_MINUTE: 30,
    CLOSE_HOUR: 16,
    CLOSE_MINUTE: 0,
    TICKS_PER_DAY: 240, // S2 与本地时钟同步：A股真实交易分钟数(9:30-11:30 120 + 13:00-15:00 120)
    TICK_INTERVAL_MS: 1000,
};

export const STOCK_POOL = [
    // 科技（高波动、高景气敏感）
    { symbol: 'T1', name: '芯澜半导体', code: '688001', listDate: '2019-08-12', industry: '半导体', initialPrice: 45, mu: 45, sigma: 0.028, theta: 0.10, description: '专注 AI 推理芯片与低功耗算力，为游戏主机与智能终端提供边缘计算方案，自研架构已流片三代。' },
    { symbol: 'T2', name: '星语智能', code: '300750', listDate: '2016-03-25', industry: '人工智能', initialPrice: 120, mu: 120, sigma: 0.032, theta: 0.09, description: '大语言模型与虚拟角色对话引擎开发商，旗下「星语」平台面向情感陪伴与内容创作，月活过亿。' },
    { symbol: 'T3', name: '帧光软件', code: '688021', listDate: '2018-11-05', industry: '软件服务', initialPrice: 35, mu: 35, sigma: 0.025, theta: 0.12, description: '实时渲染引擎与视频剪辑工具厂商，服务游戏工作室与短视频创作者，引擎授权收入高速增长。' },
    { symbol: 'T4', name: '微波通信', code: '002189', listDate: '2011-06-30', industry: '通信设备', initialPrice: 18, mu: 18, sigma: 0.022, theta: 0.13, description: '5G 射频前端与卫星通信终端供应商，为电竞场馆与低空经济提供高速低时延网络设备。' },
    // 金融（低波动、强均值回归）
    { symbol: 'F1', name: '江城银行', code: '600001', listDate: '1999-12-28', industry: '银行', initialPrice: 11, mu: 11, sigma: 0.010, theta: 0.20, description: '区域股份制商业银行，深耕长三角普惠金融与科创贷，不良率连续五年低于行业均值。' },
    { symbol: 'F2', name: '云帆证券', code: '601788', listDate: '2007-09-21', industry: '券商', initialPrice: 22, mu: 22, sigma: 0.018, theta: 0.15, description: '互联网券商，自研极速交易系统毫秒级撮合，两融与量化经纪业务市占率居前。' },
    { symbol: 'F3', name: '磐石保险', code: '601318', listDate: '2004-06-15', industry: '保险', initialPrice: 38, mu: 38, sigma: 0.014, theta: 0.17, description: '综合金融保险集团，健康险与养老社区布局领先，投资端以长期价值股为主。' },
    // 医药
    { symbol: 'M1', name: '青囊医药', code: '300026', listDate: '2010-04-23', industry: '创新药', initialPrice: 28, mu: 28, sigma: 0.024, theta: 0.11, description: '中药创新与化药仿制并重，聚焦心脑血管与代谢领域，两款创新药进入医保放量期。' },
    { symbol: 'M2', name: '白泽医疗', code: '688029', listDate: '2017-08-18', industry: '医疗器械', initialPrice: 65, mu: 65, sigma: 0.026, theta: 0.10, description: '手术机器人与高端影像设备厂商，微创手术机器人已获证上市，海外装机量快速爬坡。' },
    { symbol: 'M3', name: '澜生生物', code: '688276', listDate: '2019-12-30', industry: '生物疫苗', initialPrice: 52, mu: 52, sigma: 0.030, theta: 0.09, description: 'mRNA 疫苗与细胞治疗平台公司，新一代呼吸道联合疫苗进入临床三期。' },
    // 消费
    { symbol: 'C1', name: '杏花酿', code: '600809', listDate: '1994-03-10', industry: '白酒', initialPrice: 158, mu: 158, sigma: 0.020, theta: 0.12, description: '清香型白酒龙头，百年老窖陈酿，高端系列供不应求，全国化渠道持续下沉。' },
    { symbol: 'C2', name: '牧野食品', code: '600887', listDate: '1996-07-25', industry: '食品饮料', initialPrice: 24, mu: 24, sigma: 0.016, theta: 0.14, description: '乳制品与休闲零食企业，冷链物流全国覆盖，联名 IP 零食深受年轻群体欢迎。' },
    { symbol: 'C3', name: '蓝湾家电', code: '000333', listDate: '2004-03-05', industry: '家电', initialPrice: 32, mu: 32, sigma: 0.015, theta: 0.15, description: '智能家电与清洁机器人厂商，扫地机器人海外市占率第一，全屋智能生态成型。' },
    // 新能源（高波动、弱回归，易走趋势）
    { symbol: 'E1', name: '日曜能源', code: '300274', listDate: '2012-01-12', industry: '光伏', initialPrice: 26, mu: 26, sigma: 0.030, theta: 0.08, description: '光伏逆变器与储能系统龙头，全球出货量连续八年第一，工商业储能订单饱满。' },
    { symbol: 'E2', name: '电芯动力', code: '300450', listDate: '2015-05-14', industry: '锂电池', initialPrice: 42, mu: 42, sigma: 0.034, theta: 0.08, description: '动力电池与固态电解质研发商，半固态电池已装车验证，产能规划翻倍。' },
    { symbol: 'E3', name: '追光汽车', code: '601633', listDate: '2018-09-17', industry: '新能源车', initialPrice: 88, mu: 88, sigma: 0.028, theta: 0.10, description: '智能电动车新势力，主打「游戏座舱」概念，车机可运行 3A 大作，年轻用户占比高。' },
    // 军工 / 周期
    { symbol: 'D1', name: '长空防务', code: '600760', listDate: '2003-11-20', industry: '军工', initialPrice: 30, mu: 30, sigma: 0.026, theta: 0.10, description: '军用无人机与机载雷达制造商，察打一体无人机出口多国，订单能见度高。' },
    { symbol: 'R1', name: '金川有色', code: '601899', listDate: '2008-04-28', industry: '有色金属', initialPrice: 15, mu: 15, sigma: 0.022, theta: 0.12, description: '铜锂资源与稀有金属开采商，拥有亚洲最大铜矿之一，锂盐产能爬坡。' },
    { symbol: 'R2', name: '墨石能源', code: '601225', listDate: '2010-02-08', industry: '煤炭', initialPrice: 9, mu: 9, sigma: 0.020, theta: 0.14, description: '焦煤与清洁能源化工企业，长协价占比高，分红率稳定在 40% 以上。' },
    { symbol: 'P1', name: '广厦置业', code: '600048', listDate: '2002-07-09', industry: '房地产', initialPrice: 6, mu: 6, sigma: 0.024, theta: 0.12, description: '城市更新与长租公寓运营商，聚焦核心城市存量改造，轻资产输出提速。' },
    // 文娱传媒（贴合玩家/创作者兴趣，高情绪敏感）
    { symbol: 'G1', name: '星界游戏', code: '300999', listDate: '2017-11-16', industry: '游戏', initialPrice: 48, mu: 48, sigma: 0.033, theta: 0.08, description: '手游研发发行双轮驱动，旗舰射击手游全球月流水破十亿，海外市场高歌猛进。' },
    { symbol: 'G2', name: '幻光互娱', code: '002777', listDate: '2015-06-08', industry: '影视传媒', initialPrice: 14, mu: 14, sigma: 0.027, theta: 0.11, description: '动画电影与短剧制作商，多部国漫票房口碑双收，虚拟偶像企划上线。' },
    { symbol: 'G3', name: '云端电竞', code: '300233', listDate: '2019-03-21', industry: '电竞', initialPrice: 22, mu: 22, sigma: 0.031, theta: 0.09, description: '电竞赛事运营与俱乐部投资，承办多款主流游戏职业联赛，商业化全面提速。' },
    { symbol: 'G4', name: '像素工坊', code: '688888', listDate: '2016-09-09', industry: '云游戏', initialPrice: 33, mu: 33, sigma: 0.030, theta: 0.09, description: '云游戏与沙盒创作平台，千万玩家共建虚拟世界，UGC 内容生态繁荣。' },
    { symbol: 'G5', name: '天籁音乐', code: '300031', listDate: '2014-04-17', industry: '数字音乐', initialPrice: 12, mu: 12, sigma: 0.021, theta: 0.13, description: '数字音乐与直播平台，版权曲库超五千万，音频社交新业务快速增长。' },
    { symbol: 'V1', name: '霓虹引擎', code: '301666', listDate: '2021-07-30', industry: '游戏引擎', initialPrice: 58, mu: 58, sigma: 0.036, theta: 0.07, description: '自研游戏引擎与 AI NPC 技术商，向独立开发者开放订阅，助力游戏工业化。' },
    { symbol: 'V2', name: '次元文创', code: '600120', listDate: '2013-10-25', industry: '动漫IP', initialPrice: 9, mu: 9, sigma: 0.026, theta: 0.11, description: '动漫 IP 运营与衍生品制造，手握多个国民级动漫形象，谷子经济浪潮受益者。' },
    { symbol: 'V3', name: '速鹰物流', code: '002120', listDate: '2012-05-18', industry: '物流', initialPrice: 7, mu: 7, sigma: 0.019, theta: 0.14, description: '综合物流与供应链服务商，无人机配送试点城市超五十座，时效承诺行业领先。' },
];
// 玩法：IPO 待上市池（每 30 个交易日上市 1-2 只，动态扩充市场）
export const IPO_POOL = [
    { symbol: 'X1', name: '天穹航天', code: '688123', listDate: '', industry: '航天科技', initialPrice: 55, mu: 55, sigma: 0.034, theta: 0.08, description: '商业航天运载与卫星制造，可回收火箭技术验证成功，星座组网提速。' },
    { symbol: 'X2', name: '轻舟电池', code: '300888', listDate: '', industry: '锂电池', initialPrice: 66, mu: 66, sigma: 0.032, theta: 0.09, description: '半固态电池量产先行者，能量密度行业领先，储能订单饱满。' },
    { symbol: 'X3', name: '云鲸数据', code: '688199', listDate: '', industry: '数据要素', initialPrice: 40, mu: 40, sigma: 0.030, theta: 0.10, description: '公共数据授权运营与数据资产入表服务商，数据要素市场化受益者。' },
    { symbol: 'X4', name: '半夏医药', code: '300777', listDate: '', industry: '创新药', initialPrice: 32, mu: 32, sigma: 0.029, theta: 0.10, description: '聚焦肿瘤免疫双抗创新药，多款管线进入临床后期。' },
    { symbol: 'X5', name: '拾光影像', code: '002999', listDate: '', industry: '影视传媒', initialPrice: 18, mu: 18, sigma: 0.028, theta: 0.11, description: '纪录片与院线发行双轮驱动，自制内容口碑票房双丰收。' },
    { symbol: 'X6', name: '极客金融', code: '601666', listDate: '', industry: '金融科技', initialPrice: 28, mu: 28, sigma: 0.027, theta: 0.12, description: '智能风控与量化资管技术服务商，服务数十家持牌机构。' },
    { symbol: 'X7', name: '星环教育', code: '300666', listDate: '', industry: '在线教育', initialPrice: 15, mu: 15, sigma: 0.026, theta: 0.12, description: 'AI 个性化学习平台，素质教育课程订阅快速增长。' },
    { symbol: 'X8', name: '绿洲农业', code: '600777', listDate: '', industry: '农业', initialPrice: 10, mu: 10, sigma: 0.022, theta: 0.13, description: '智慧农业与数字农场运营商，无人化种植示范面积全国领先。' },
];
// 行业对各宏观因子的敏感度（决定板块联动与分化）
export const INDUSTRY_SENSITIVITY: Record<string, Partial<Record<string, number>>> = {
    '半导体': { '行业景气': 1.6, '政策风险': 1.4, '国际环境': 1.3 },
    '人工智能': { '行业景气': 1.8, '国际环境': 1.2 },
    '软件服务': { '行业景气': 1.4, '政策风险': 0.8 },
    '通信设备': { '行业景气': 1.3, '政策风险': 1.0 },
    '银行': { '宏观经济': 1.8, '政策风险': 1.2 },
    '券商': { '市场情绪': 1.8, '宏观经济': 1.4 },
    '保险': { '宏观经济': 1.5, '政策风险': 1.0 },
    '创新药': { '行业景气': 1.5, '政策风险': 1.3 },
    '医疗器械': { '行业景气': 1.4, '公司特质': 1.2 },
    '生物疫苗': { '行业景气': 1.6, '政策风险': 1.4, '公司特质': 1.3 },
    '白酒': { '消费景气': 1.5, '政策风险': 1.2 },
    '食品饮料': { '消费景气': 1.4, '行业景气': 0.8 },
    '家电': { '消费景气': 1.3, '国际环境': 1.0 },
    '光伏': { '行业景气': 1.7, '政策风险': 1.5, '国际环境': 1.4 },
    '锂电池': { '行业景气': 1.8, '国际环境': 1.3 },
    '新能源车': { '行业景气': 1.6, '政策风险': 1.3, '市场情绪': 1.2 },
    '军工': { '政策风险': 1.7, '国际环境': 1.6, '宏观经济': 0.6 },
    '有色金属': { '宏观经济': 1.6, '国际环境': 1.3 },
    '煤炭': { '宏观经济': 1.5, '政策风险': 1.1 },
    '房地产': { '宏观经济': 1.7, '政策风险': 1.6 },
    '游戏': { '市场情绪': 1.8, '行业景气': 1.5, '政策风险': 1.2 },
    '影视传媒': { '市场情绪': 1.6, '消费景气': 1.2 },
    '电竞': { '市场情绪': 1.9, '行业景气': 1.4 },
    '云游戏': { '行业景气': 1.7, '市场情绪': 1.6 },
    '数字音乐': { '市场情绪': 1.5, '消费景气': 1.3 },
    '游戏引擎': { '行业景气': 1.8, '市场情绪': 1.7 },
    '动漫IP': { '消费景气': 1.6, '市场情绪': 1.4 },
    '物流': { '宏观经济': 1.4, '消费景气': 1.2 },
};

export const US_FEES = {
    commissionRate: 0,
    secFeeRate: 0.0000229,
    tafFeePerShare: 0.000119,
    minCommission: 0,
    stampDutyRate: 0,
    transferFeeRate: 0,
    allowShort: true,
    isTPlusOne: false,
    priceLimit: null,
};

export const CN_FEES = {
    commissionRate: 0.00025,
    stampDutyRate: 0.001,
    transferFeeRate: 0.00002,
    minCommission: 5,
    secFeeRate: 0,
    tafFeePerShare: 0,
    allowShort: false,
    isTPlusOne: true,
    priceLimit: 0.10,
};

export const RISK = {
    marginLongRate: 0.5,
    marginShortRate: 0.5,
    maintenanceMargin: 0.3,
    forceLiquidationLevel: 0.2,
    marginInterestRate: 0.0002,
    initialCash: 100000,
    maxLeverage: 3,
};

export const MARKET_STATES = ['bull', 'bear', 'sideways'];

export const STATE_TRANSITIONS = {
    bull: { bull: 0.8, bear: 0.05, sideways: 0.15 },
    bear: { bull: 0.1, bear: 0.75, sideways: 0.15 },
    sideways: { bull: 0.25, bear: 0.25, sideways: 0.5 },
};

export const STATE_PARAMS = {
    bull: { driftBase: 0.0008, volMult: 0.8 },
    bear: { driftBase: -0.0006, volMult: 1.3 },
    sideways: { driftBase: 0.0001, volMult: 1.0 },
};

export const OU_PARAMS = {
    garchAlpha: 0.1,
    garchBeta: 0.85,
    garchOmega: 0.0001,
    jumpIntensity: 0.02,
    jumpStd: 0.02,
    trendPersistence: 0.85,
    trendDetectionBars: 3,
    trendDetectionThreshold: 0.005,
};

export const BLACK_SWAN = {
    probability: 0.02,
    gapRange: [-0.15, 0.20],
};

export const FACTOR_NAMES = [
    '宏观经济', '行业景气', '公司特质', '市场情绪', '国际环境', '政策风险', '消费景气',
];

export const NEWS_PROBABILITY = 0.7;


// S2 真实交易时段（本地时钟）：周一至周五 9:30-11:30 / 13:00-15:00
export function isTradingTimeNow() {
    const now = new Date();
    const day = now.getDay();
    if (day === 0 || day === 6) return false;
    const minutes = now.getHours() * 60 + now.getMinutes();
    return (minutes >= 570 && minutes < 690) || (minutes >= 780 && minutes < 900);
}
