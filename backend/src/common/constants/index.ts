

export const MARKET = {
    OPEN_HOUR: 9,
    OPEN_MINUTE: 30,
    CLOSE_HOUR: 16,
    CLOSE_MINUTE: 0,
    TICKS_PER_DAY: 390,
    TICK_INTERVAL_MS: 1000,
};

export const STOCK_POOL = [
    // 科技（高波动、高景气敏感）
    { symbol: 'T1', name: '芯片先锋', industry: '半导体', initialPrice: 45, mu: 45, sigma: 0.028, theta: 0.10 },
    { symbol: 'T2', name: '云启智能', industry: '人工智能', initialPrice: 120, mu: 120, sigma: 0.032, theta: 0.09 },
    { symbol: 'T3', name: '恒信软件', industry: '软件服务', initialPrice: 35, mu: 35, sigma: 0.025, theta: 0.12 },
    { symbol: 'T4', name: '华讯通信', industry: '通信设备', initialPrice: 18, mu: 18, sigma: 0.022, theta: 0.13 },
    // 金融（低波动、强均值回归）
    { symbol: 'F1', name: '国泰银行', industry: '银行', initialPrice: 11, mu: 11, sigma: 0.010, theta: 0.20 },
    { symbol: 'F2', name: '龙腾证券', industry: '券商', initialPrice: 22, mu: 22, sigma: 0.018, theta: 0.15 },
    { symbol: 'F3', name: '安泰保险', industry: '保险', initialPrice: 38, mu: 38, sigma: 0.014, theta: 0.17 },
    // 医药
    { symbol: 'M1', name: '仁和医药', industry: '创新药', initialPrice: 28, mu: 28, sigma: 0.024, theta: 0.11 },
    { symbol: 'M2', name: '康泰医疗', industry: '医疗器械', initialPrice: 65, mu: 65, sigma: 0.026, theta: 0.10 },
    { symbol: 'M3', name: '博泰疫苗', industry: '生物疫苗', initialPrice: 52, mu: 52, sigma: 0.030, theta: 0.09 },
    // 消费
    { symbol: 'C1', name: '醇香酒业', industry: '白酒', initialPrice: 158, mu: 158, sigma: 0.020, theta: 0.12 },
    { symbol: 'C2', name: '绿源乳业', industry: '食品饮料', initialPrice: 24, mu: 24, sigma: 0.016, theta: 0.14 },
    { symbol: 'C3', name: '雅居家电', industry: '家电', initialPrice: 32, mu: 32, sigma: 0.015, theta: 0.15 },
    // 新能源（高波动、弱回归，易走趋势）
    { symbol: 'E1', name: '光能光伏', industry: '光伏', initialPrice: 26, mu: 26, sigma: 0.030, theta: 0.08 },
    { symbol: 'E2', name: '锂动能源', industry: '锂电池', initialPrice: 42, mu: 42, sigma: 0.034, theta: 0.08 },
    { symbol: 'E3', name: '星驰汽车', industry: '新能源车', initialPrice: 88, mu: 88, sigma: 0.028, theta: 0.10 },
    // 军工 / 周期
    { symbol: 'D1', name: '蓝天航空', industry: '军工', initialPrice: 30, mu: 30, sigma: 0.026, theta: 0.10 },
    { symbol: 'R1', name: '金鼎有色', industry: '有色金属', initialPrice: 15, mu: 15, sigma: 0.022, theta: 0.12 },
    { symbol: 'R2', name: '黑金能源', industry: '煤炭', initialPrice: 9, mu: 9, sigma: 0.020, theta: 0.14 },
    { symbol: 'P1', name: '恒基地产', industry: '房地产', initialPrice: 6, mu: 6, sigma: 0.024, theta: 0.12 },
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

