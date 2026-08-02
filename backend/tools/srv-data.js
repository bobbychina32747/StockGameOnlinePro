const fs = require('fs');
const p = 'src/core/market-data/market-data.service.ts';
let s = fs.readFileSync(p, 'utf8');

// 1. 构造器加 market 参数
const old1 = "    constructor(stockRepo, klineRepo, engine) {\n        this.stockRepo = stockRepo;";
if (!s.includes(old1)) { console.log('构造器未匹配'); process.exit(1); }
s = s.replace(old1, "    constructor(stockRepo, klineRepo, engine, market = 'CN') {\n        this.stockRepo = stockRepo;\n        this.market = market; // 三服务器：CN/HK/US 独立实例");

// 2. init 池过滤
const old2 = "        // B1 多市场：统一池 = A股 + 港股 + 美股\n        const ALL_POOL = [...constants_1.STOCK_POOL, ...constants_1.HK_POOL, ...constants_1.US_POOL];";
if (!s.includes(old2)) { console.log('ALL_POOL 未匹配'); process.exit(1); }
s = s.replace(old2, "        // B1 多市场：统一池（init 按本服务器市场过滤）\n        const ALL_POOL = [...constants_1.STOCK_POOL, ...constants_1.HK_POOL, ...constants_1.US_POOL];\n        const POOL_FOR_THIS = this.market === 'HK' ? constants_1.HK_POOL : this.market === 'US' ? constants_1.US_POOL : ALL_POOL.filter((c) => !c.market || c.market === 'CN');");

// 3. ALL_POOL 使用点 → POOL_FOR_THIS
s = s.replace("        const poolSymbols = new Set(ALL_POOL.map((c) => c.symbol));", "        const poolSymbols = new Set(POOL_FOR_THIS.map((c) => c.symbol));");
s = s.replace("        for (const cfg of ALL_POOL) {\n            if (existingSymbols.has(cfg.symbol)) continue;", "        for (const cfg of POOL_FOR_THIS) {\n            if (existingSymbols.has(cfg.symbol)) continue;");
s = s.replace("        for (const cfg of ALL_POOL) {\n            this.poolBySymbol.set(cfg.symbol, cfg);\n        }", "        for (const cfg of POOL_FOR_THIS) {\n            this.poolBySymbol.set(cfg.symbol, cfg);\n        }");
s = s.replace("            for (const cfg of ALL_POOL) {\n                await this.stockRepo.query(", "            for (const cfg of POOL_FOR_THIS) {\n                await this.stockRepo.query(");

// 4. 历史恢复：只恢复本市场（HK 实例只恢复 H 股票）
const old4 = "        const historyRows = await this.klineRepo.find({ order: { time: 'ASC' } });";
if (!s.includes(old4)) { console.log('history 未匹配'); process.exit(1); }
s = s.replace(old4, "        const allHistory = await this.klineRepo.find({ order: { time: 'ASC' } });\n        // 三服务器：仅恢复本市场的 K 线（各实例 stocks 只含自己市场）\n        const historyRows = allHistory.filter((r) => this.stocks.has(r.symbol));");

// 5. getIndices：按本市场过滤 defs（CN 实例显示 CN 指数，HK 只显示恒生等）
const old5 = "        const defs = [\n            { code: '000001', name: '上证指数', base: 3100, filter: () => true },";
if (!s.includes(old5)) { console.log('getIndices 未匹配'); process.exit(1); }
s = s.replace(old5, "        // 三服务器：仅显示本市场指数\n        const defs = [\n            { code: '000001', name: '上证指数', base: 3100, market: 'CN', filter: () => true },");
// 各指数 def 加 market 标记
s = s.replace("{ code: '399001', name: '深证成指', base: 10500, filter:", "{ code: '399001', name: '深证成指', base: 10500, market: 'CN', filter:");
s = s.replace("{ code: '399006', name: '创业板指', base: 2200, filter:", "{ code: '399006', name: '创业板指', base: 2200, market: 'CN', filter:");
s = s.replace("{ code: '000688', name: '科创50', base: 950, filter:", "{ code: '000688', name: '科创50', base: 950, market: 'CN', filter:");
s = s.replace("{ code: '399999', name: '中证文娱', base: 1200, filter:", "{ code: '399999', name: '中证文娱', base: 1200, market: 'CN', filter:");
s = s.replace("{ code: 'HSI', name: '恒生指数', market: 'HK', base: 18500,", "{ code: 'HSI', name: '恒生指数', market: 'HK', base: 18500,");
s = s.replace("{ code: 'NDX', name: '纳斯达克', market: 'US', base: 16500,", "{ code: 'NDX', name: '纳斯达克', market: 'US', base: 16500,");
s = s.replace("{ code: 'DJI', name: '道琼斯', market: 'US', base: 38500,", "{ code: 'DJI', name: '道琼斯', market: 'US', base: 38500,");
// 过滤：def.market 匹配本实例（无 market 标记的 CN defs 已有 market:'CN'）
const old6 = "        return defs.map((d) => {";
if (!s.includes(old6)) { console.log('defs map 未匹配'); process.exit(1); }
s = s.replace(old6, "        return defs.filter((d) => d.market === this.market || (d.market === 'CN' && this.market === 'CN')).map((d) => {");

fs.writeFileSync(p, s);
console.log('market-data 三服务器参数完成');
