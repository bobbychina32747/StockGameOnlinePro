const fs = require('node:fs'), path = require('node:path');
const universe = require('../packages/domain/research-universe.json');
const { mean, median, variance, metrics, regression, fitGjr } = require('./research-statistics.cjs');
const out = process.argv[2]; if (!out) throw new Error('Research directory required');
const records = fs.readFileSync(path.join(out, 'market-samples.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
const samples = new Map(records.map(record => [record.symbol, record]));
const cutoff = '2025-10-01'; const profiles = {}, detail = [];
const clamp = (x, low, high) => Math.max(low, Math.min(high, x));
for (const [industry, symbols] of Object.entries(universe)) {
  profiles[industry] = {};
  for (const market of ['CN', 'HK', 'US']) {
    const benchmark = samples.get({ CN: '000001.SS', HK: '^HSI', US: '^GSPC' }[market]);
    const trainingBenchmark = { ...benchmark, bars: benchmark.bars.filter(bar => bar.date < cutoff) };
    const selected = symbols.map(symbol => samples.get(symbol)).filter(record => record?.market === market);
    if (selected.length !== 2) throw new Error(`${industry}/${market}: expected 2 reference stocks`);
    const rows = selected.map(record => {
      const training = { ...record, bars: record.bars.filter(bar => bar.date < cutoff) };
      if (training.bars.length < 250) throw new Error('Insufficient training observations: ' + record.symbol);
      const summary = metrics(training.bars); const exposure = regression(training, trainingBenchmark);
      detail.push({ symbol: record.symbol, industry, market, source: record.source, retrievedAt: record.retrievedAt,
        trainingFrom: training.bars[0].date, trainingTo: training.bars.at(-1).date, training: summary, exposure,
        holdout: metrics(record.bars.filter(bar => bar.date >= cutoff)) });
      return { training, summary, exposure };
    });
    const sigma = median(rows.map(row => row.summary.dailyVolatility));
    const marketWeight = clamp(median(rows.map(row => row.exposure.correlation)), .05, .85);
    const gapScale = clamp(median(rows.map(row => row.summary.medianGap / row.summary.dailyVolatility)) / .56, .1, 1.0);
    const rangeRatio = median(rows.map(row => row.summary.meanRange / row.summary.dailyVolatility));
    profiles[industry][market] = {
      references: selected.map(row => row.symbol), observations: rows.reduce((sum, row) => sum + row.summary.count, 0),
      dailyVolatility: clamp(sigma, .006, .07), marketWeight, sectorWeight: .3 * Math.sqrt(1 - marketWeight ** 2),
      gapScale, intradayFraction:clamp(median(rows.map(row=>Math.sqrt(variance(row.training.bars.map(bar=>Math.log(bar.close/bar.open))))/row.summary.dailyVolatility)),.35,1.25),
      wickScale: clamp((rangeRatio - .8 - gapScale * .3) / 1.6, .08, .5),
      gjr: fitGjr(rows.map(row => row.training.bars.slice(1).map((bar, i) => Math.log(bar.close / row.training.bars[i].close)))),
      observed: { excessKurtosis: median(rows.map(row => row.summary.excessKurtosis)), absoluteReturnLag1: median(rows.map(row => row.summary.absoluteReturnLag1)), rangeRatio }
    };
  }
}
const artifact = { version: 1, collectedAt: new Date().toISOString(), trainingCutoffExclusive: cutoff, holdoutFrom: cutoff,
  method: 'Adjusted daily OHLCV; market correlation and robust gap/range ratios; bounded Student-t(5) GJR likelihood grid. Two references per industry and market. Daily calibration does not identify intraday microstructure.', profiles };
function assertFinite(value){if(typeof value==='number'&&!Number.isFinite(value))throw new Error('Non-finite calibration parameter');if(value&&typeof value==='object')Object.values(value).forEach(assertFinite);}
assertFinite(artifact);
fs.writeFileSync(path.join(__dirname, '../packages/domain/sector-calibration.json'), JSON.stringify(artifact, null, 2) + '\n');
fs.writeFileSync(path.join(out, 'sector-statistics.json'), JSON.stringify(detail, null, 2) + '\n');
console.log(JSON.stringify({ sectors: Object.keys(profiles).length, profiles: detail.length / 2, stocks: detail.length,
  dailyBars: records.reduce((sum, row) => sum + row.bars.length, 0), trainingCutoff: cutoff, holdoutExcludedFromFit: true }));
