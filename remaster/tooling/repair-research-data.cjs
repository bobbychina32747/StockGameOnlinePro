const fs = require('node:fs'), path = require('node:path');
const out = process.argv[2];
async function run() {
  const destination = path.join(out, 'market-samples.ndjson');
  const records = fs.readFileSync(destination, 'utf8').trim().split('\n').map(JSON.parse);
  const candidates = [
    ['EA', 'RBLX', 'US', ['游戏与互动娱乐']],
    ['000300.SS', '000001.SS', 'CN', ['benchmark']]
  ];
  for (const [oldSymbol, symbol, market, sectors] of candidates) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=1633824000&period2=1791580800&interval=1d&events=div%2Csplits`;
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const result = (await response.json()).chart.result[0], quote = result.indicators.quote[0], adjusted = result.indicators.adjclose?.[0]?.adjclose;
    const bars = result.timestamp.map((time, i) => { const f = adjusted?.[i] && quote.close[i] ? adjusted[i] / quote.close[i] : 1;
      return { time: time * 1000, date: new Date(time * 1000).toISOString().slice(0, 10), open: quote.open[i] * f, high: quote.high[i] * f, low: quote.low[i] * f, close: quote.close[i] * f, volume: quote.volume[i] };
    }).filter(bar => bar.close > 0 && bar.open > 0 && bar.volume >= 0 && bar.high >= bar.low);
    console.log(JSON.stringify({ oldSymbol, symbol, bars: bars.length, from: bars[0]?.date, to: bars.at(-1)?.date }));
    if (bars.length < 500) throw new Error('History unavailable: ' + symbol);
    const record = { symbol, market, sectors, source: url, retrievedAt: new Date().toISOString(), currency: result.meta.currency, timezone: result.meta.exchangeTimezoneName, adjusted: true, corporateActions: result.events ?? {}, bars };
    const index = records.findIndex(row => row.symbol === oldSymbol); records[index] = record;
    fs.writeFileSync(destination, records.map(JSON.stringify).join('\n') + '\n', 'utf8');
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
