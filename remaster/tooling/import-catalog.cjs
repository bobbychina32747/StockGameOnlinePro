const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const shippedCatalog=path.join(root,'remaster/packages/domain/catalog.json');
if(fs.existsSync(shippedCatalog)){const existing=JSON.parse(fs.readFileSync(shippedCatalog,'utf8'));if(existing.instruments?.length>=68){console.log(`Using packaged catalog: ${existing.instruments.length} instruments; no source or player data imported.`);process.exit(0);}throw new Error('Existing catalog is incomplete; refusing to overwrite it');}
const ts = require(path.join(root, 'backend/node_modules/typescript'));
function constants(relative) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const output = {};
  vm.runInNewContext(javascript, { exports: output, require(name) {
    if (name !== '../data/trading-calendar') throw new Error(`Unexpected catalog dependency: ${name}`);
    return constants('backend/src/common/data/trading-calendar.ts');
  } }, { timeout: 1000 });
  return output;
}
const source = constants('backend/src/common/constants/index.ts');
const calendar = constants('backend/src/common/data/trading-calendar.ts');
const instruments = [['CN',source.STOCK_POOL],['HK',source.HK_POOL],['US',source.US_POOL]].flatMap(([market,stocks]) => stocks.map(stock => ({
  symbol: stock.symbol, code: stock.code, name: stock.name, industry: stock.industry, market,
  listedAt: stock.listDate, description: stock.description, initialPrice: Math.round(stock.initialPrice * 100), volatility: stock.sigma
})));
if (instruments.length !== 68) throw new Error(`Expected 68 instruments, received ${instruments.length}`);
const outputPath = path.join(root,'remaster/packages/domain/catalog.json');
if (fs.existsSync(outputPath)) throw new Error('Refusing to replace catalog');
fs.mkdirSync(path.dirname(outputPath), {recursive:true});
fs.writeFileSync(outputPath, JSON.stringify({instruments,calendar:calendar.TRADING_CALENDAR},null,2)+'\n','utf8');
console.log(`Imported ${instruments.length} fictional instruments and calendar data; no player data accessed.`);
