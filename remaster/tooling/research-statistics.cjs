const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const median = values => { const sorted=[...values].sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2; };
const variance = values => { const average = mean(values); return mean(values.map(value => (value - average) ** 2)); };
const covariance = (a, b) => { const am = mean(a), bm = mean(b); return mean(a.map((value, i) => (value - am) * (b[i] - bm))); };
const correlation = (a, b) => covariance(a, b) / Math.sqrt(variance(a) * variance(b));
function metrics(bars) {
  const returns = bars.slice(1).map((bar, index) => Math.log(bar.close / bars[index].close));
  const average = mean(returns), v = variance(returns);
  return { count: returns.length, dailyVolatility: Math.sqrt(v), excessKurtosis: mean(returns.map(r => (r - average) ** 4)) / v ** 2 - 3,
    absoluteReturnLag1: correlation(returns.slice(1).map(Math.abs), returns.slice(0, -1).map(Math.abs)),
    medianGap: median(bars.slice(1).map((bar, index) => Math.abs(Math.log(bar.open / bars[index].close)))),
    // Retain source closing returns with quality flags; exclude inconsistent ranges from wick calibration.
    meanRange: mean(bars.filter(validOhlc).map(bar => Math.log(bar.high / bar.low))), volumeCorrelation: correlation(bars.slice(1).map(bar => bar.volume), returns.map(Math.abs)) };
}
function regression(stock, benchmark) {
  const market = new Map(benchmark.bars.slice(1).map((bar, i) => [bar.date, Math.log(bar.close / benchmark.bars[i].close)]));
  const paired = stock.bars.slice(1).map((bar, i) => [Math.log(bar.close / stock.bars[i].close), market.get(bar.date)]).filter(row => Number.isFinite(row[1]));
  const ys = paired.map(row => row[0]), xs = paired.map(row => row[1]);
  const beta = covariance(xs, ys) / variance(xs), alpha = mean(ys) - beta * mean(xs);
  return { alpha, beta, residualVolatility: Math.sqrt(variance(ys.map((y, i) => y - alpha - beta * xs[i]))), correlation: correlation(xs, ys) };
}
function fitGjr(series) {
  const normalized = series.map(returns => { const average = mean(returns), sigma = Math.sqrt(variance(returns)); return returns.map(r => (r - average) / sigma); });
  let best = { score: Infinity };
  for (const alpha of [.04, .08, .12]) for (const beta of [.76, .84, .90]) for (const gamma of [.02, .08, .14]) {
    const persistence = alpha + beta + gamma / 2; if (persistence >= .985) continue;
    const omega = 1 - persistence; let score = 0, count = 0;
    for (const returns of normalized) { let v = 1, previous = 0;
      for (let i = 0; i < returns.length; i++) { v = Math.max(.15, Math.min(25, omega + alpha * previous ** 2 + (previous < 0 ? gamma * previous ** 2 : 0) + beta * v));
        if (i >= 20) { score += Math.log(v) + 6 * Math.log(1 + returns[i] ** 2 / (3 * v)); count++; } previous = returns[i]; }
    }
    if (score / count < best.score) best = { alpha, beta, gamma, omega, score: score / count };
  }
  return best;
}
function validOhlc(bar){return bar.low>0&&bar.high>=Math.max(bar.open,bar.close)-1e-5&&bar.low<=Math.min(bar.open,bar.close)+1e-5;}
module.exports = { mean, median, variance, covariance, correlation, metrics, regression, fitGjr, validOhlc };
