const fs = require('fs');

// ═══ 1. risk-manager：reviews 机制 + 大亏损检测 ═══
let p = 'src/core/risk-manager/risk-manager.service.ts';
let s = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
// 构造器加 reviews（找构造器结尾——settlementQueue 或类似）
const cAnchor = "        this.prices = {};";
if (!s.includes(cAnchor)) {
  // 尝试其他构造器锚点
  const alt = s.match(/constructor\(([^)]*)\) \{/);
  console.log('构造器:', alt ? alt[1].trim() : '未找到');
  process.exit(1);
}
s = s.replace(cAnchor, cAnchor + "\n        // 交易复盘：个人复盘 + 全局复盘（教育卡）\n        this.reviews = new Map();\n        this.globalReviews = [];");

// dailySettlement 大亏损检测（totalEquity 更新后）
const dAnchor = "        account.totalEquity = Number(account.cash) + positions.holdValue;";
if (!s.includes(dAnchor)) { console.log('dailySettlement 锚点未匹配'); process.exit(1); }
s = s.replace(dAnchor, "        account.totalEquity = Number(account.cash) + positions.holdValue;\n        // 复盘：单日大亏损 >10% → 生成教训卡\n        if (Number(account.dayStartEquity) > 0) {\n            const dayRet = (Number(account.totalEquity) - Number(account.dayStartEquity)) / Number(account.dayStartEquity);\n            if (dayRet < -0.1) {\n                this.addReview(account.userId, {\n                    type: '大亏损',\n                    title: `📉 单日亏损 ${(Math.abs(dayRet) * 100).toFixed(1)}%`, desc: `第 ${day} 个交易日，你的账户单日亏损超过 10%`, lesson: '单日巨亏通常是重仓追高或未设止损。建议：①控制单笔仓位 ≤20% ②永远设止损单 ③泡沫期的暴涨回调往往最凶',\n                });\n            }\n        }");

// 方法：addReview / addGlobalReview / getReviews（computeTier 前）
const mAnchor = "    // 段位评分：收益(总收益归一化) + 风控(回撤) + 活跃(交易次数)";
const methods = `    // 交易复盘：个人复盘卡（强平/大亏损）+ 全局复盘（泡沫破灭教育）
    addReview(userId, review) {
        if (!userId)
            return;
        const arr = this.reviews.get(userId) || [];
        arr.unshift({ ...review, time: new Date().toISOString() });
        if (arr.length > 20)
            arr.length = 20;
        this.reviews.set(userId, arr);
    }
    addGlobalReview(review) {
        this.globalReviews.unshift({ ...review, time: new Date().toISOString() });
        if (this.globalReviews.length > 10)
            this.globalReviews.length = 10;
    }
    getReviews(userId) {
        const mine = userId ? (this.reviews.get(userId) || []) : [];
        // 个人复盘优先，全局复盘（教育）随后
        return [...mine, ...this.globalReviews].slice(0, 20);
    }
    // 段位评分：收益(总收益归一化) + 风控(回撤) + 活跃(交易次数)`;
if (!s.includes(mAnchor)) { console.log('方法锚点未匹配'); process.exit(1); }
s = s.replace(mAnchor, methods);
fs.writeFileSync(p, s);
console.log('1. risk-manager 复盘完成');

// ═══ 2. market.service：破灭复盘 + 强平复盘 ═══
p = 'src/modules/market/market.service.ts';
s = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
// 破灭广播里加全局复盘
const bAnchor = "                this.gateway.broadcastNews({\n                    title: `💥 泡沫破灭：${b.industry} 板块崩盘`, description: `${b.reason}，板块股价向内在价值剧烈回归，谨防踩踏`, type: \x27bearish\x27, impact: {}, duration: 2,\n                });\n                this.logger.warn(`💥 [${market}] 泡沫破灭: ${b.industry}（${b.reason}）`);";
if (!s.includes(bAnchor)) { console.log('破灭锚点未匹配'); process.exit(1); }
s = s.replace(bAnchor, bAnchor + "\n                // 复盘：泡沫破灭教育卡（所有玩家可见）\n                if (this.riskManager) {\n                    this.riskManager.addGlobalReview({\n                        type: \x27泡沫破灭\x27,\n                        title: `💥 ${b.industry} 板块泡沫破灭`, desc: `${b.reason}。板块股价正在向内在价值剧烈回归`, lesson: \x27泡沫破灭的教训：板块连续暴涨（涨幅远超基本面）时，任何细小抛售都可能引发连锁崩盘。识别泡沫：关注涨幅是否离谱、回调时是否放量下跌。破灭期不要抄底，等价格回归价值企稳后再介入\x27,\n                    });\n                }");
// 强平复盘（processMarket 日终 forceLiquidate 后——需要拿到 liquidated 列表）
// forceLiquidateMarginalAccounts 返回 liquidated（accountId 数组）——改 processMarket 调用处
const lAnchor = "                await this.engine.forceLiquidateMarginalAccounts();";
if (!s.includes(lAnchor)) { console.log('强平锚点未匹配'); process.exit(1); }
s = s.replace(lAnchor, "                const liquidated = await this.engine.forceLiquidateMarginalAccounts();\n                // 复盘：强平教训卡（定向给被强平用户 + 全局警示）\n                if (this.riskManager && liquidated && liquidated.length > 0) {\n                    for (const l of liquidated) {\n                        const acct = await this.engine.getAccountById(l.accountId);\n                        if (acct) {\n                            this.riskManager.addReview(acct.userId, {\n                                type: \x27强平\x27,\n                                title: \x27💔 账户被强制平仓\x27, desc: `保证金率跌破阈值（${(l.marginLevel * 100).toFixed(1)}%），所有持仓被强平`, lesson: \x27强平的教训：做空/融资仓位要预留充足保证金，保证金率跌破 100% 就会被强平。建议：①控制杠杆 ≤2x ②单边行情别满仓做空 ③及时补足保证金\x27,\n                            });\n                        }\n                    }\n                    this.riskManager.addGlobalReview({\n                        type: \x27市场警示\x27,\n                        title: \x27💔 有玩家被强制平仓\x27, desc: \x27高杠杆玩家因保证金不足被强平，市场风险释放\x27, lesson: \x27杠杆是把双刃剑：暴涨时放大收益，回调时直接出局。新手建议从无杠杆开始\x27,\n                    });\n                }");
fs.writeFileSync(p, s);
console.log('2. market.service 复盘完成');

// ═══ 3. engine：getAccountById 方法 ═══
p = 'src/core/trading-engine/trading-engine.service.ts';
s = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const gAnchor = "    async forceLiquidateMarginalAccounts() {";
if (!s.includes(gAnchor)) { console.log('engine 锚点未匹配'); process.exit(1); }
s = s.replace(gAnchor, "    async getAccountById(accountId) {\n        try {\n            return await this.accountRepo.findOne({ where: { id: accountId } });\n        }\n        catch (e) {\n            return null;\n        }\n    }\n    async forceLiquidateMarginalAccounts() {");
fs.writeFileSync(p, s);
console.log('3. engine getAccountById 完成');
