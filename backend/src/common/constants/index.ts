

export const MARKET = {
    OPEN_HOUR: 9,
    OPEN_MINUTE: 30,
    CLOSE_HOUR: 16,
    CLOSE_MINUTE: 0,
    TICKS_PER_DAY: 240, // S2 与本地时钟同步：A股真实交易分钟数(9:30-11:30 120 + 13:00-15:00 120)
    TICK_INTERVAL_MS: 1000,
};

// B1 多市场：A股池（market 默认 CN），港股 HK_POOL / 美股 US_POOL 见下
// B1 多市场：A股池（market 默认 CN），港股 HK_POOL / 美股 US_POOL 见下
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


// B1 港股费率：佣金0.03%最低50 + 印花税0.13%(卖出) + 交易征费0.0027% + 交易费0.005%
export const HK_FEES = {
    commissionRate: 0.0003,
    stampDutyRate: 0.0013,
    transferFeeRate: 0.000077,
    minCommission: 50,
    secFeeRate: 0.000027,
    tafFeePerShare: 0,
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
    // P3 两融细化：维持担保比例三级阈值（保证金率=总权益/借入资金）
    marginWarningLevel: 1.4,
    marginCallLevel: 1.3,
    marginLiquidateLevel: 1.2,
    marginCallTarget: 1.5,
};

// P3 个股折算率/保证金率：按股票代码稳定哈希在区间内取值（做空保证金率 0.5~0.65）
export function shortMarginRateFor(symbol) {
    let h = 0;
    const s = String(symbol || '');
    for (let i = 0; i < s.length; i++)
        h = (h * 31 + s.charCodeAt(i)) % 100000;
    return Number((0.5 + (h % 16) / 100).toFixed(2)); // 0.50 ~ 0.65
}

// P3 跨市场汇率（1 单位本币折合人民币）：CN=1，HK≈0.92，US≈7.12；划转手续费 0.1%
export const FX_CNY_PER_UNIT = { CN: 1, HK: 0.92, US: 7.12 };
export const FX_TRANSFER_FEE_RATE = 0.001;

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
    // P1 厚尾：低频大跳（崩盘/脉冲），每 tick 基准概率 0.0015（约每 3 个交易日 1 次/股），
    // 波动率升高时概率放大；负向偏斜 60%（真实市场下跌跳更常见）
    crashIntensity: 0.0015,
    crashStd: 0.05,
    crashSkew: 0.6,
    trendPersistence: 0.85,
    trendDetectionBars: 3,
    trendDetectionThreshold: 0.005,
};

export const FACTOR_NAMES = [
    '宏观经济', '行业景气', '公司特质', '市场情绪', '国际环境', '政策风险', '消费景气',
];

export const NEWS_PROBABILITY = 0.7;


// S2 真实交易时段（本地时钟）：周一至周五 9:30-11:30 / 13:00-15:00

// B1 港股池（虚构，港股风格：5位代码/中文名）
export const HK_POOL = [
    { market: 'HK', symbol: 'H1', name: '云顶网络', code: '00700', listDate: '2004-06-16', industry: '互联网', initialPrice: 320, mu: 320, sigma: 0.022, theta: 0.12, description: '社交平台与游戏巨头，旗下「云讯」国民级应用覆盖超十亿用户，游戏与广告双轮驱动。' },
    { market: 'HK', symbol: 'H2', name: '金港电信', code: '00941', listDate: '2002-10-09', industry: '通信', initialPrice: 68, mu: 68, sigma: 0.018, theta: 0.10, description: '粤港澳大湾区主导运营商，5G 基建与云计算业务稳步扩张，派息稳定著称。' },
    { market: 'HK', symbol: 'H3', name: '云帆电商', code: '09988', listDate: '2019-11-26', industry: '电商', initialPrice: 88, mu: 88, sigma: 0.026, theta: 0.15, description: '跨境电商平台，海外仓网络覆盖 40+ 国家，新兴市场 GMV 高速增长。' },
    { market: 'HK', symbol: 'H4', name: '美图生活', code: '03690', listDate: '2018-09-20', industry: '消费', initialPrice: 128, mu: 128, sigma: 0.024, theta: 0.14, description: '本地生活服务龙头，外卖与到店业务双线并进，即时零售打开第二曲线。' },
    { market: 'HK', symbol: 'H5', name: '华融银行', code: '01398', listDate: '2005-10-27', industry: '银行', initialPrice: 5.2, mu: 5.2, sigma: 0.012, theta: 0.08, description: '大湾区跨境金融服务平台，绿色金融与数字银行转型，分红率常年领先同业。' },
    { market: 'HK', symbol: 'H6', name: '港能集团', code: '00002', listDate: '1990-01-02', industry: '公用事业', initialPrice: 52, mu: 52, sigma: 0.010, theta: 0.07, description: '香港电力与燃气双牌照运营商，新能源业务占比提升，现金牛属性突出。' },
    { market: 'HK', symbol: 'H7', name: '辉腾医药', code: '01093', listDate: '2000-12-19', industry: '医药', initialPrice: 42, mu: 42, sigma: 0.020, theta: 0.11, description: '创新药出海先锋，多款药物获海外上市批准，license-out 收入持续落地。' },
    { market: 'HK', symbol: 'H8', name: '长桥地产', code: '01113', listDate: '1972-11-01', industry: '地产', initialPrice: 36, mu: 36, sigma: 0.025, theta: 0.16, description: '港岛核心商业地产持有者，写字楼与零售组合穿越周期，低估值高股息。' },
    { market: 'HK', symbol: 'H9', name: '裕丰保险', code: '01299', listDate: '2004-06-24', industry: '保险', initialPrice: 58, mu: 58, sigma: 0.018, theta: 0.10, description: '亚太寿险龙头，代理人渠道转型数字化，健康险与养老险双赛道扩张，内含价值持续增长。' },
    { market: 'HK', symbol: 'H10', name: '环球航运', code: '01919', listDate: '2005-06-30', industry: '航运', initialPrice: 14, mu: 14, sigma: 0.028, theta: 0.16, description: '全球集装箱航运巨头，运力规模前三，运价周期弹性大，长协与自有码头平滑波动。' },
    { market: 'HK', symbol: 'H11', name: '皇冠珠宝', code: '01929', listDate: '2011-12-15', industry: '消费', initialPrice: 9.6, mu: 9.6, sigma: 0.020, theta: 0.12, description: '黄金珠宝零售龙头，门店超 7000 家，婚嫁与保值需求双驱动，金价上行周期受益。' },
    { market: 'HK', symbol: 'H13', name: '恒芯科技', code: '00981', listDate: '2004-03-18', industry: '半导体', initialPrice: 26, mu: 26, sigma: 0.030, theta: 0.15, description: '内地晶圆代工龙头，成熟制程产能满载，国产替代加速，先进封装布局领先。' },
    { market: 'HK', symbol: 'H14', name: '百佳零售', code: '06808', listDate: '2011-07-15', industry: '零售', initialPrice: 3.8, mu: 3.8, sigma: 0.022, theta: 0.13, description: '大卖场与会员店双业态，供应链效率提升，自有品牌占比扩大，O2O 即时达覆盖全城。' },
    { market: 'HK', symbol: 'H15', name: '港汽集团', code: '01728', listDate: '2005-12-20', industry: '汽车', initialPrice: 11.2, mu: 11.2, sigma: 0.026, theta: 0.14, description: '自主品牌乘用车出海先锋，东南亚与中东市占率攀升，混动平台降本增效显著。' },
    { market: 'HK', symbol: 'H16', name: '康达医疗', code: '02269', listDate: '2017-07-18', industry: '医疗', initialPrice: 34, mu: 34, sigma: 0.024, theta: 0.12, description: '高值耗材与影像设备双平台，集采压力消化后创新品种放量，海外认证持续落地。' },
    { market: 'HK', symbol: 'H17', name: '国泰航空', code: '00293', listDate: '1986-05-15', industry: '航空', initialPrice: 8.4, mu: 8.4, sigma: 0.028, theta: 0.16, description: '区域枢纽航空龙头，国际航线恢复至疫情前九成，货运与飞机维修贡献稳定利润。' },
    { market: 'HK', symbol: 'H18', name: '港联交易所', code: '00388', listDate: '2000-06-27', industry: '金融', initialPrice: 285, mu: 285, sigma: 0.020, theta: 0.09, description: '亚太核心交易所集团，现货与衍生品双轮驱动，南向资金持续活跃，互联互通扩容。' },
    { market: 'HK', symbol: 'H19', name: '维他食品', code: '00345', listDate: '1994-03-30', industry: '食品饮料', initialPrice: 7.2, mu: 7.2, sigma: 0.018, theta: 0.10, description: '植物蛋白饮品龙头，内地渠道下沉叠加海外扩张，健康化转型打开估值空间。' },
    { market: 'HK', symbol: 'H20', name: '南海能源', code: '00857', listDate: '2000-04-07', industry: '能源', initialPrice: 6.6, mu: 6.6, sigma: 0.020, theta: 0.11, description: '上游油气生产龙头，储量接替率高，天然气与新能源业务双轨并进，分红稳定。' },
    { market: 'HK', symbol: 'H12', name: '湾区制造', code: '02333', listDate: '2003-12-30', industry: '制造业', initialPrice: 12.8, mu: 12.8, sigma: 0.022, theta: 0.13, description: '高端装备制造集团，工程机械出口全球前五，氢能设备与电动重卡打开第二曲线。' },
];

// B1 美股池（虚构，美股风格：字母代码/英文名，FAANG 大企业特色）
export const US_POOL = [
    { market: 'US', symbol: 'U1', name: 'NovaChip', code: 'NVDA', listDate: '1999-01-22', industry: '半导体', initialPrice: 480, mu: 480, sigma: 0.035, theta: 0.12, description: 'AI 算力芯片霸主，GPU 数据中心营收爆发式增长，先进制程代工产能紧俏。' },
    { market: 'US', symbol: 'U2', name: 'GalaxyNet', code: 'META', listDate: '2012-05-18', industry: '人工智能', initialPrice: 210, mu: 210, sigma: 0.030, theta: 0.13, description: '社交网络与元宇宙平台，AI 推荐引擎提升广告效率，VR 生态初见规模。' },
    { market: 'US', symbol: 'U3', name: 'VoltAuto', code: 'TSLA', listDate: '2010-06-29', industry: '新能源', initialPrice: 180, mu: 180, sigma: 0.040, theta: 0.18, description: '电动车与储能巨头，全球超级工厂产能爬坡，Robotaxi 与机器人业务点燃想象。' },
    { market: 'US', symbol: 'U4', name: 'CloudPeak', code: 'MSFT', listDate: '1986-03-13', industry: '软件', initialPrice: 310, mu: 310, sigma: 0.020, theta: 0.09, description: '云与企业软件双巨头，Copilot 全线渗透，Azure 增速领先主要对手。' },
    { market: 'US', symbol: 'U5', name: 'QuantumPay', code: 'VISA', listDate: '2008-03-19', industry: '金融科技', initialPrice: 260, mu: 260, sigma: 0.018, theta: 0.08, description: '全球支付网络，跨境清算壁垒深，消费复苏与数字钱包打开增量空间。' },
    { market: 'US', symbol: 'U6', name: 'MedForge', code: 'JNJ', listDate: '1944-09-05', industry: '医药', initialPrice: 150, mu: 150, sigma: 0.015, theta: 0.08, description: '医疗健康巨头，制药+器械+消费健康三引擎，创新管线后劲充足。' },
    { market: 'US', symbol: 'U7', name: 'FalconAero', code: 'BA', listDate: '1934-09-05', industry: '军工', initialPrice: 190, mu: 190, sigma: 0.028, theta: 0.14, description: '航空航天与防务龙头，窄体机订单积压创纪录，国防预算上行周期受益。' },
    { market: 'US', symbol: 'U8', name: 'RiverBank', code: 'JPM', listDate: '1969-01-02', industry: '银行', initialPrice: 140, mu: 140, sigma: 0.016, theta: 0.07, description: '全能银行巨头，投行与财富管理双轮驱动，利率高位净息差改善明显。' },
    { market: 'US', symbol: 'U9', name: 'PixelSoft', code: 'AAPL', listDate: '1980-12-12', industry: '消费电子', initialPrice: 175, mu: 175, sigma: 0.022, theta: 0.10, description: '消费电子与生态服务巨头，硬件+软件+服务三位一体，高端市场护城河深厚，现金储备雄厚。' },
    { market: 'US', symbol: 'U10', name: 'AlphaSearch', code: 'GOOGL', listDate: '2004-08-19', industry: '互联网', initialPrice: 142, mu: 142, sigma: 0.024, theta: 0.11, description: '搜索引擎与广告之王，AI 大模型重塑搜索体验，云业务扭亏为盈，Waymo 商业化提速。' },
    { market: 'US', symbol: 'U11', name: 'GoldenFry', code: 'MCD', listDate: '1965-04-21', industry: '餐饮', initialPrice: 250, mu: 250, sigma: 0.014, theta: 0.07, description: '全球快餐连锁之王，特许经营模式轻资产扩张，门店超 4 万家，穿越周期稳健现金流。' },
    { market: 'US', symbol: 'U13', name: 'Amazonia', code: 'AMZN', listDate: '1997-05-15', industry: '电商', initialPrice: 178, mu: 178, sigma: 0.030, theta: 0.13, description: '全球电商与云服务双龙头，Prime 会员粘性深厚，AWS 利润率修复，广告业务高增长。' },
    { market: 'US', symbol: 'U14', name: 'CryptoPay', code: 'PYPL', listDate: '2015-07-20', industry: '金融科技', initialPrice: 62, mu: 62, sigma: 0.028, theta: 0.15, description: '数字支付与钱包巨头，跨境结算网络覆盖全球，商户收单份额领先，成本优化见效。' },
    { market: 'US', symbol: 'U15', name: 'WaltRealm', code: 'DIS', listDate: '1962-09-20', industry: '传媒', initialPrice: 96, mu: 96, sigma: 0.024, theta: 0.12, description: '娱乐帝国，流媒体用户破 2 亿，主题乐园与 IP 授权全链条变现，内容库无出其右。' },
    { market: 'US', symbol: 'U16', name: 'PfizerLab', code: 'PFE', listDate: '1942-06-19', industry: '医药', initialPrice: 28, mu: 28, sigma: 0.018, theta: 0.10, description: '制药巨头，肿瘤与疫苗管线密集，重磅新品获批节奏加快，专利悬崖后重回增长。' },
    { market: 'US', symbol: 'U17', name: 'HomeCraft', code: 'HD', listDate: '1981-09-22', industry: '零售', initialPrice: 335, mu: 335, sigma: 0.016, theta: 0.08, description: '家装建材零售龙头，门店网络全美第一，专业客户业务高增长，股息连续 14 年上调。' },
    { market: 'US', symbol: 'U18', name: 'StreamRealm', code: 'NFLX', listDate: '2002-05-23', industry: '传媒', initialPrice: 610, mu: 610, sigma: 0.032, theta: 0.14, description: '流媒体之王，全球订阅用户超 2.7 亿，广告分层模式打开 ARPU 空间，原创内容护城河。' },
    { market: 'US', symbol: 'U19', name: 'IntelCore', code: 'INTC', listDate: '1971-10-13', industry: '半导体', initialPrice: 44, mu: 44, sigma: 0.030, theta: 0.16, description: '老牌芯片巨头，代工业务转型关键期，先进制程追赶与 AI 芯片放量决定未来三年。' },
    { market: 'US', symbol: 'U20', name: 'CocaRiver', code: 'KO', listDate: '1919-09-05', industry: '食品饮料', initialPrice: 61, mu: 61, sigma: 0.012, theta: 0.06, description: '饮料之王，全球品牌渗透无出其右，瓶装水与咖啡矩阵扩张，股息连续 60 年上调。' },
    { market: 'US', symbol: 'U12', name: 'EverGreen Energy', code: 'XOM', listDate: '1920-01-01', industry: '能源', initialPrice: 105, mu: 105, sigma: 0.020, theta: 0.12, description: '油气与化工能源巨头，上游资源储量全球领先，LNG 出口业务扩张，股息与回购回馈股东。' },
];

export function isTradingTimeNow() {
    const now = new Date();
    const day = now.getDay();
    if (day === 0 || day === 6) return false;
    const minutes = now.getHours() * 60 + now.getMinutes();
    return (minutes >= 570 && minutes < 690) || (minutes >= 780 && minutes < 900);
}

// P1 各市场独立交易时段与节假日历（分钟制；weekdays 0=周日..6=周六；sessions 为 [开始分钟, 结束分钟) 区间）
// 数据源：src/common/data/trading-calendar.ts（唯一权威副本，含美股夏令时与跨午夜交易日归属）
// 兼容保留 MARKET_SESSIONS 导出（holidays 为全部年份扁平合并，便于旧代码/测试直接 contains）
import calendar_1 = require("../data/trading-calendar");
const CAL = calendar_1.TRADING_CALENDAR;
const flatHolidays = (m: 'CN' | 'HK' | 'US'): string[] => Object.values(CAL[m].holidays).reduce<string[]>((a, arr) => a.concat(arr), []);
export const MARKET_SESSIONS = {
    CN: {
        weekdays: CAL.CN.weekdays,
        sessions: CAL.CN.sessions,
        holidays: flatHolidays('CN'),
    },
    HK: {
        weekdays: CAL.HK.weekdays,
        sessions: CAL.HK.sessions,
        holidays: flatHolidays('HK'),
    },
    US: {
        weekdays: CAL.US.weekdays,
        sessions: CAL.US.sessions,
        holidays: flatHolidays('US'),
    },
};

export function isHolidayFor(mode, date) {
    if (!CAL[mode])
        return false;
    return calendar_1.isMarketHoliday(mode, date);
}

export function usSessionsFor(date) {
    return calendar_1.usSessionsFor(date || new Date());
}

// P4 修复：调试模式（无视限制）休市期的 tick 节奏——高速回放 1s/tick，
// 否则按配置 TICK_INTERVAL_MS（1000 高速 / 60000 真实分钟级）
export function tickDelayMs(isMarketActive, anyTrading, configuredMs) {
    if (isMarketActive && !anyTrading)
        return 1000;
    return configuredMs;
}

export function isUsDaylightSaving(date) {
    return calendar_1.isUsDaylightSaving(date || new Date());
}

// P2: 盘前集合竞价申报窗口（仅 A 股 9:15-9:30，其中 9:15-9:25 可申报、9:25 撮合）
export function isAuctionTimeFor(mode, now?) {
    return auctionStageFor(mode, now) !== null;
}

// P1 三阶段竞价规则（仅 A 股）：
// - 'cancelable' 9:15-9:20  可申报、可撤单
// - 'locked'     9:20-9:25  可申报、不可撤单
// - 'matching'   9:25-9:30  撮合阶段：不可申报、不可撤单
export function auctionStageFor(mode, now?) {
    if (mode !== 'CN')
        return null;
    const d = now || new Date();
    if (!CAL.CN.weekdays.includes(d.getDay()))
        return null;
    if (calendar_1.isMarketHoliday('CN', d))
        return null;
    const minutes = d.getHours() * 60 + d.getMinutes();
    if (minutes >= 555 && minutes < 560)
        return 'cancelable';
    if (minutes >= 560 && minutes < 565)
        return 'locked';
    if (minutes >= 565 && minutes < 570)
        return 'matching';
    return null;
}

// P1: 按市场判断是否处于交易时段（mode: CN/HK/US；未知/缺省回退 CN 保持向后兼容）
// 美股：夏令时/冬令时动态时段 + 跨午夜交易日按美东日期判节假日
export function isTradingTimeFor(mode, now?) {
    const m = (mode && CAL[mode] ? mode : 'CN');
    const cfg = MARKET_SESSIONS[m];
    const raw = now || new Date();
    const d = calendar_1.marketDateFor(m, raw);
    if (!cfg.weekdays.includes(d.getDay()))
        return false;
    if (calendar_1.isMarketHoliday(m, raw))
        return false;
    const minutes = raw.getHours() * 60 + raw.getMinutes();
    const sessions = m === 'US' ? calendar_1.usSessionsFor(raw) : cfg.sessions;
    for (const s of sessions) {
        if (minutes >= s[0] && minutes < s[1])
            return true;
    }
    return false;
}

// B1 行业传导矩阵：行业间联动（源 → 目标: 关联度 0~1），每 5 tick 按动量传导
export const INDUSTRY_LINKS: Record<string, Record<string, number>> = {
    半导体: { 人工智能: 0.5, 软件: 0.4, 消费电子: 0.4 },
    人工智能: { 半导体: 0.5, 软件: 0.4, 互联网: 0.3, 游戏: 0.3 },
    软件: { 半导体: 0.3, 人工智能: 0.4, 互联网: 0.3 },
    互联网: { 软件: 0.3, 人工智能: 0.3, 游戏: 0.4, 电商: 0.4, 传媒: 0.3 },
    游戏: { 互联网: 0.4, 人工智能: 0.3, 传媒: 0.4, 动漫: 0.5 },
    传媒: { 游戏: 0.4, 互联网: 0.3, 消费: 0.2 },
    消费电子: { 半导体: 0.4, 软件: 0.3, 消费: 0.3 },
    新能源: { 汽车: 0.5, 锂电池: 0.5, 能源: 0.3 },
    汽车: { 新能源: 0.5, 制造业: 0.3, 锂电池: 0.4 },
    能源: { 新能源: 0.3, 公用事业: 0.3, 资源: 0.4 },
    锂电池: { 新能源: 0.5, 汽车: 0.4, 半导体: 0.2 },
    银行: { 保险: 0.4, 地产: 0.3, 金融科技: 0.4, 金融: 0.4 },
    保险: { 银行: 0.4, 地产: 0.2, 金融: 0.4 },
    金融: { 银行: 0.4, 保险: 0.4, 地产: 0.3, 金融科技: 0.4 },
    地产: { 银行: 0.3, 保险: 0.2, 消费: 0.2, 制造业: 0.2 },
    金融科技: { 银行: 0.4, 互联网: 0.3, 软件: 0.3 },
    消费: { 餐饮: 0.5, 电商: 0.3, 食品饮料: 0.4, 零售: 0.4, 白酒: 0.4 },
    餐饮: { 消费: 0.5, 食品饮料: 0.4, 零售: 0.3 },
    食品饮料: { 消费: 0.4, 餐饮: 0.4, 零售: 0.3 },
    零售: { 消费: 0.4, 电商: 0.4, 食品饮料: 0.3 },
    白酒: { 消费: 0.4, 食品饮料: 0.3, 零售: 0.2 },
    电商: { 消费: 0.3, 互联网: 0.4, 零售: 0.4, 物流: 0.4 },
    物流: { 电商: 0.4, 消费: 0.2, 航运: 0.3, 制造业: 0.2 },
    航运: { 物流: 0.3, 资源: 0.3, 能源: 0.3, 制造业: 0.2 },
    医药: { 医疗: 0.4, 生物科技: 0.3, 消费: 0.2 },
    医疗: { 医药: 0.4, 生物科技: 0.3, 制造业: 0.2 },
    生物科技: { 医药: 0.3, 医疗: 0.3, 人工智能: 0.2 },
    军工: { 航空: 0.4, 制造业: 0.3, 半导体: 0.3 },
    航空: { 军工: 0.4, 能源: 0.3, 消费: 0.2, 旅游: 0.3 },
    公用事业: { 能源: 0.3, 新能源: 0.3, 地产: 0.2 },
    通信: { 互联网: 0.3, 半导体: 0.3, 软件: 0.3 },
    资源: { 能源: 0.4, 航运: 0.3, 制造业: 0.3 },
    制造业: { 汽车: 0.3, 军工: 0.3, 新能源: 0.2, 半导体: 0.2 },
    动漫: { 游戏: 0.5, 传媒: 0.4, 消费: 0.2 },
    旅游: { 消费: 0.3, 航空: 0.3, 零售: 0.2 },
};
