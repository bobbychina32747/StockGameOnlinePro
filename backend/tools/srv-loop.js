const fs = require('fs');
const p = 'src/modules/market/market.service.ts';
let s = fs.readFileSync(p, 'utf8');

// 1. 构造器注入
const old1 = "    constructor(marketData, engine, gateway, newsService, riskManager) {\n        this.marketData = marketData;";
if (!s.includes(old1)) { console.log('构造器未匹配'); process.exit(1); }
s = s.replace(old1, "    constructor(marketData, engine, gateway, newsService, riskManager, marketDataHK, marketDataUS) {\n        this.marketData = marketData;\n        this.marketDataHK = marketDataHK;\n        this.marketDataUS = marketDataUS;\n        // 三服务器：全局价格聚合（riskManager 需全部市场价格）\n        this.allPrices = {};\n        this.tickCounterHK = 0;\n        this.tickCounterUS = 0;");

// 2. tick 循环体替换
const old2 = "                // S2 交易时段同步：休市（非9:30-11:30/13:00-15:00或周末）不生成行情\n                if (!this.isTradingTime()) {\n                    return;\n                }\n                const ticks = this.marketData.generateTick();\n                if (ticks.length > 0) {\n                    const prices = {};\n                    ticks.forEach((t) => { prices[t.symbol] = t.price; });\n                    this.engine.updatePrices(prices);\n                    this.engine.refreshOrderBooks(prices);\n                    if (this.riskManager) {\n                        this.riskManager.setMarketPrices(prices);\n                    }\n                    this.gateway.broadcastTick(ticks);\n                    const fills = await this.engine.checkPendingOrders();\n                    fills.forEach((f) => { this.gateway.broadcastFill(f); });\n                    if (this.tickCounter === 0) {";
if (!s.includes(old2)) { console.log('tick 体起始未匹配'); process.exit(1); }
const start = s.indexOf(old2);
const endMarker = "                    this.tickCounter = (this.tickCounter + 1) % 240;";
const endIdx = s.indexOf(endMarker, start);
if (endIdx < 0) { console.log('tick 体结束未匹配'); process.exit(1); }

const B = String.fromCharCode(96); // `
const D = String.fromCharCode(36); // $
const processMarketBody =
"                // S2 交易时段同步：休市不生成行情\n" +
"                if (!this.isTradingTime()) {\n" +
"                    return;\n" +
"                }\n" +
"                // 三服务器：轮流处理 CN/HK/US（各自独立 gameDay/因子/事件）\n" +
"                await this.processMarket('CN', this.marketData, 'tickCounter');\n" +
"                await this.processMarket('HK', this.marketDataHK, 'tickCounterHK');\n" +
"                await this.processMarket('US', this.marketDataUS, 'tickCounterUS');\n" +
"                // 全局价格聚合 → 风控/保证金\n" +
"                if (this.riskManager) {\n" +
"                    this.riskManager.setMarketPrices(this.allPrices);\n" +
"                }\n";
s = s.slice(0, start) + processMarketBody + s.slice(endIdx + endMarker.length);

// 3. processMarket 方法（普通字符串构造，避免模板插值）
const anchor = "    async startTickLoop() {";
const L = [];
L.push("    // 三服务器：单市场 tick 处理（行情生成/开盘事件/日终结算/挂单触发）");
L.push("    async processMarket(market, marketData, counterKey) {");
L.push("        try {");
L.push("            const ticks = marketData.generateTick();");
L.push("            if (ticks.length === 0) return;");
L.push("            const prices = {};");
L.push("            ticks.forEach((t) => { prices[t.symbol] = t.price; });");
L.push("            // 聚合到全局（风控需全市场价格）");
L.push("            Object.assign(this.allPrices, prices);");
L.push("            this.engine.updatePrices(prices);");
L.push("            this.engine.refreshOrderBooks(prices);");
L.push("            this.gateway.broadcastTick(ticks);");
L.push("            const fills = await this.engine.checkPendingOrders();");
L.push("            fills.forEach((f) => { this.gateway.broadcastFill(f); });");
L.push("            const counter = this[counterKey] || 0;");
L.push("            if (counter === 0) {");
L.push("                // 玩法：热点/IPO/黑天鹅（各市场独立）");
L.push("                marketData.startNewDay();");
L.push("                const events = marketData.getDayEvents();");
L.push("                if (events && events.ipo && events.ipo.listed) {");
L.push("                    for (const n of events.ipo.listed) {");
L.push("                        this.gateway.broadcastNews({");
L.push("                            title: " + B + "🚀 新股上市：${n.name}（${n.code}）" + B + ", description: " + B + "发行价 ${n.initialPrice} 元，所属行业 ${n.industry}，今日起可交易" + B + ", type: 'bullish', impact: {}, duration: 1,");
L.push("                        });");
L.push("                        this.logger.log(" + B + "🚀 新股上市: ${n.name}" + B + ");");
L.push("                    }");
L.push("                }");
L.push("                if (events && events.swan) {");
L.push("                    const good = events.swan.direction === 'good';");
L.push("                    this.gateway.broadcastNews({");
L.push("                        title: good ? " + B + "🎉 利好：${events.swan.desc}" + B + " : " + B + "🦊 黑天鹅：${events.swan.desc}" + B + ", description: " + B + "影响：${events.swan.type === 'market' ? '全市场' : events.swan.type === 'industry' ? events.swan.industry + '板块' : events.swan.name} 约 ${events.swan.impact}%" + B + ", type: good ? 'bullish' : 'bearish', impact: {}, duration: 2,");
L.push("                    });");
L.push("                    if (good) this.logger.log(" + B + "🎉 政策红包: ${events.swan.desc}" + B + ");");
L.push("                    else this.logger.warn(" + B + "🦊 黑天鹅: ${events.swan.desc}" + B + ");");
L.push("                }");
L.push("                this.engine.setDayOpen(prices);");
L.push("                await this.engine.resetBoughtToday();");
L.push("                const state = marketData.getState();");
L.push("                // 财报季");
L.push("                if (marketData.gameDay > 0 && marketData.gameDay % 7 === 0) {");
L.push("                    const n = marketData.generateReports();");
L.push("                    if (n > 0) this.logger.log(" + B + "📊 [" + B + " + market + " + B + "] 财报季: ${n} 家公司披露季度财报" + B + ");");
L.push("                }");
L.push("                const news = this.newsService.generateDailyNews(state.marketRegime, marketData.gameDay);");
L.push("                if (news) this.logger.log(" + B + "📰 [" + B + " + market + " + B + "] ${news.title}" + B + ");");
L.push("            }");
L.push("            if (counter === 239) { // 分红/夜间事件");
L.push("                try {");
L.push("                    await this.engine.payDividends(marketData.getDividends(marketData.gameDay));");
L.push("                } catch (e) {");
L.push("                    this.logger.error(" + B + "分红发放失败: ${e.message}" + B + ");");
L.push("                }");
L.push("                const nightEvent = this.newsService.processNightEvent();");
L.push("                if (nightEvent && nightEvent.impact !== 0) {");
L.push("                    const prices = marketData.getPrices();");
L.push("                    for (const sym of Object.keys(prices)) {");
L.push("                        prices[sym] *= (1 + nightEvent.impact);");
L.push("                    }");
L.push("                    this.engine.updatePrices(prices);");
L.push("                }");
L.push("            }");
L.push("            if (counter === 239) { // 日终结算");
L.push("                await marketData.endOfDay();");
L.push("                const day = marketData.gameDay;");
L.push("                if (this.riskManager) {");
L.push("                    await this.riskManager.settleAllAccounts(day);");
L.push("                }");
L.push("                await this.engine.forceLiquidateMarginalAccounts();");
L.push("                this.logger.log(" + B + "📅 [" + B + " + market + " + B + "] 第 ${day} 个交易日结束" + B + ");");
L.push("            }");
L.push("            this[counterKey] = (counter + 1) % 240;");
L.push("        } catch (e) {");
L.push("            this.logger.error(" + B + "[" + B + " + market + " + B + "] Tick处理异常: ${e.message}" + B + ");");
L.push("        }");
L.push("    }");
L.push("    async startTickLoop() {");
const pm = L.join('\n');
if (!s.includes(anchor)) { console.log('startTickLoop 锚点未匹配'); process.exit(1); }
s = s.replace(anchor, pm);
fs.writeFileSync(p, s);
console.log('三循环重构完成');
