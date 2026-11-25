const test = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {backtest} = require('../dist/packages/engine/backtest');

const bars = Array.from({length: 66}, (_, day) => {
  const open = 5500 + (day < 44 ? 40 * day : 1760 - (day - 44) * 110);
  return {time: Date.UTC(2026, 0, day + 1), day, open, high: open + 10, low: open - 10, close: open + 5, volume: 7900};
});

test('a listed native IPO can trade against maker inventory without a synthetic listing date', () => {
  const stock = {symbol: 'X1', code: '688123', name: '天穹航天', industry: '航天科技', market: 'CN',
    listedAt: '', description: '', initialPrice: 5500, volatility: 0.034};
  const result = backtest('X1', bars, 'ma', 20261010, stock);
  assert.equal(result.curve.length, bars.length);
  assert(result.trades.some(trade => trade.symbol === 'X1' && trade.buyer === 'backtest:CN'));
  assert(result.trades.some(trade => trade.symbol === 'X1' && trade.seller === 'backtest:CN'));
  assert.throws(() => backtest('X1', bars, 'ma', 20261010), {code: 'INVALID_SYMBOL'});
  assert.throws(() => backtest('unknown', bars, 'ma', 20261010, stock), {code: 'INVALID_SYMBOL'});
});

test('catalog backtests retain their complete result when synthetic history generation is skipped', () => {
  const result = backtest('T1', bars, 'ma', 20261010);
  assert.equal(result.trades.length, 7);
  // Digest of the full pre-IPO result, including every fill and equity point.
  assert.equal(createHash('sha256').update(JSON.stringify(result)).digest('hex'),
    '6b66aeb95a079bf381ef054f92df45f181c21546e799f268cf8a2619a6968e90');
});
