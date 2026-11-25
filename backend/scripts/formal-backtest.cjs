const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { IPO_POOL } = require(resolve(process.cwd(), 'dist/src/common/constants'));

const containerEngine = resolve(__dirname, '../v2-runtime/packages/engine/backtest.js');
const sourceEngine = resolve(__dirname, '../../remaster/dist/packages/engine/backtest.js');
const engine = require(existsSync(containerEngine) ? containerEngine : sourceEngine);

exports.backtest = function backtest(symbol, bars, strategy, seed) {
    const stock = IPO_POOL.find(item => item.symbol === symbol);
    if (!stock) return engine.backtest(symbol, bars, strategy, seed);

    return engine.backtest(symbol, bars, strategy, seed, {
        symbol: stock.symbol,
        code: stock.code,
        name: stock.name,
        industry: stock.industry,
        market: 'CN',
        listedAt: stock.listDate || '',
        description: stock.description,
        initialPrice: Math.round(stock.initialPrice * 100),
        volatility: stock.sigma,
    });
};
