// Factors are dimensionless signals. Convert them to bounded daily returns once.
export function dailyFactorDrift(signal: number) {
    return 0.012 * Math.tanh((Number(signal) || 0) * 0.5);
}

export function dailyValueDrift(price: number, value: number, theta: number) {
    if (!(price > 0) || !(value > 0)) return 0;
    return Math.max(-0.025, Math.min(0.025, Math.max(0, theta) * Math.log(value / price)));
}
