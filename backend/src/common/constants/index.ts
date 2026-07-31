

export const MARKET = {
    OPEN_HOUR: 9,
    OPEN_MINUTE: 30,
    CLOSE_HOUR: 16,
    CLOSE_MINUTE: 0,
    TICKS_PER_DAY: 390,
    TICK_INTERVAL_MS: 1000,
};

export const STOCK_POOL = [
    { symbol: 'A', name: '科技先锋', initialPrice: 100, mu: 100, sigma: 0.015, theta: 0.15 },
    { symbol: 'B', name: '金融蓝筹', initialPrice: 80, mu: 80, sigma: 0.012, theta: 0.12 },
];

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
    '宏观经济', '行业景气', '公司特质', '市场情绪', '国际环境', '政策风险',
];

export const NEWS_PROBABILITY = 0.7;

