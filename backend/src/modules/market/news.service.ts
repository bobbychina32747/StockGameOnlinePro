var __decorate = function (decorators, target, key?, desc?) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import common_1 = require("@nestjs/common");

import market_data_service_1 = require("../../core/market-data/market-data.service");

import market_gateway_1 = require("./market.gateway");

/**
 * 新闻系统 v2
 * - 分阶段：gameDay<30 元年（上市快乐·俏皮）→ <150 成长（渐正式）→ 成熟（专业财经）
 * - 模板库：40+ 条，占位符 {company}/{code}/{industry}/{C}/{N} 动态填充
 * - 影响：宏观因子冲击 + 定向行业/个股价格冲击（真实嵌入）
 */
let NewsService = class NewsService {
    [key: string]: any;
    constructor(marketData, gateway) {
        this.marketData = marketData;
        this.gateway = gateway;
        this.logger = new common_1.Logger(NewsService.name);
        this.currentNews = null;
        // stage: 0=元年(<30天) 1=成长(<150天) 2=成熟；type: bullish/bearish/neutral
        this.templates = [
            // ═══════ 元年：上市快乐（俏皮、有梗） ═══════
            { stage: [0], cat: 'company', type: 'bullish', title: '{company}今日敲钟上市，老板发话：「上市快乐！」请全公司喝奶茶', desc: '现场气氛组已经就位，{company}的员工人手一杯奶茶合影留念。', impact: { '公司特质': 0.03, '市场情绪': 0.02 }, symbol: true, duration: 2 },
            { stage: [0], cat: 'company', type: 'bullish', title: '{company}上市首日大涨，CFO 表示买辣椒炒肉再也不看价签了', desc: '股吧里一片欢乐：「老板大气，我们跟着吃香的喝辣的！」', impact: { '市场情绪': 0.02 }, duration: 1 },
            { stage: [0], cat: 'company', type: 'neutral', title: '传闻：{company}楼下咖啡店改名「涨停咖啡」', desc: '据说老板是资深股民，开业立了块牌子：本店续命，不负责解套。', impact: { '公司特质': 0.01 }, duration: 1 },
            { stage: [0], cat: 'company', type: 'neutral', title: '{company}发布上市首份财报：营收还行，主要是快乐值拉满', desc: '财报里专门加了一页「员工幸福指数」，董事长表示这是最重要的 KPI。', impact: { '公司特质': 0.02 }, duration: 2 },
            { stage: [0], cat: 'company', type: 'bearish', title: '{company}的吉祥物在楼下发传单，路人不买账，股价略跌', desc: '传单内容「{industry}新贵了解一下」，被网友调侃像微商。', impact: { '市场情绪': -0.015 }, duration: 1 },
            { stage: [0], cat: 'macro', type: 'bullish', title: '央行发言人说：这周先给大家放点水，把情绪托起来', desc: '市场解读为流动性宽松信号，营业部门口的老大爷笑开了花。', impact: { '宏观经济': 0.02, '市场情绪': 0.02 }, duration: 3 },
            { stage: [0], cat: 'macro', type: 'neutral', title: '证监会公告：新股民朋友们，别慌，涨跌都是成长的一部分', desc: '公告最后写着：入市有风险，但成长的道路上我们都在。', impact: { '市场情绪': 0.01 }, duration: 2 },
            { stage: [0], cat: 'macro', type: 'bullish', title: '某知名财经博主发文看好后市，评论区秒变许愿池', desc: '「祝大家都能买到涨停板！」点赞量三小时破十万。', impact: { '市场情绪': 0.025 }, duration: 2 },
            { stage: [0], cat: 'industry', type: 'bullish', title: '{industry}圈疯传新作上线，相关公司股价集体躁动', desc: '据说是一款打磨三年的重磅产品，内部人士称「这次是真的顶」。', impact: { '行业景气': 0.03 }, industry: true, duration: 3 },
            { stage: [0], cat: 'industry', type: 'neutral', title: '圈内饭局流出的消息：{industry}要搞大动作，具体不便透露', desc: '消息一出，吃瓜群众比上市公司还兴奋，股吧热度飙升。', impact: { '行业景气': 0.015 }, industry: true, duration: 2 },
            { stage: [0], cat: 'industry', type: 'bearish', title: '{industry}概念股被「玩梗」炒上热搜后回落', desc: '热度来得快去得也快，昨天追高的朋友今天在群里安静如鸡。', impact: { '市场情绪': -0.02 }, duration: 1 },

            // ═══════ 成长：渐正式 ═══════
            { stage: [1], cat: 'company', type: 'bullish', title: '{company}发布季报：营收同比增长{C}%，净利润增速回升', desc: '管理层在电话会上表示，订单能见度高，全年目标有望超额完成。', impact: { '公司特质': 0.03, '行业景气': 0.01 }, symbol: true, duration: 3 },
            { stage: [1], cat: 'company', type: 'bullish', title: '多家机构将{company}评级上调至「买入」，目标价上调{C}%', desc: '研报认为公司护城河稳固，当前估值具备吸引力，建议逢低布局。', impact: { '公司特质': 0.025, '市场情绪': 0.01 }, symbol: true, duration: 2 },
            { stage: [1], cat: 'company', type: 'neutral', title: '{company}宣布新品发布会定档，渠道备货积极', desc: '渠道反馈预订量超出预期，分析师称需观察实际转化率。', impact: { '公司特质': 0.02 }, symbol: true, duration: 2 },
            { stage: [1], cat: 'company', type: 'bearish', title: '{company}遭大股东减持公告，套现约{C}亿元', desc: '公告称系个人资金需求，市场解读为短期利空，股价承压。', impact: { '公司特质': -0.03 }, symbol: true, duration: 2 },
            { stage: [1], cat: 'macro', type: 'bullish', title: '央行开展中期借贷便利操作，投放{C}亿元流动性', desc: '机构认为货币政策维持宽松基调，对权益市场构成支撑。', impact: { '宏观经济': 0.02, '市场情绪': 0.01 }, duration: 3 },
            { stage: [1], cat: 'macro', type: 'neutral', title: '国家统计局：{industry}景气指数连续两月回升', desc: '数据显示行业订单与产能利用率同步改善，复苏趋势确立。', impact: { '行业景气': 0.02 }, industry: true, duration: 3 },
            { stage: [1], cat: 'macro', type: 'bullish', title: '北向资金连续{N}日净流入，重点加仓{industry}板块', desc: '外资定价权逐步提升，核心资产获增量资金青睐。', impact: { '市场情绪': 0.015 }, industry: true, duration: 2 },
            { stage: [1], cat: 'policy', type: 'neutral', title: '监管部门就{industry}行业融资新规征求意见', desc: '新规旨在规范行业融资行为，中长期利好头部企业。', impact: { '政策风险': 0.01, '行业景气': 0.01 }, industry: true, duration: 4 },
            { stage: [1], cat: 'policy', type: 'bullish', title: '新一批{industry}产业扶持政策落地，补贴力度加大', desc: '符合条件企业可获专项资金支持，产业链相关公司直接受益。', impact: { '行业景气': 0.03, '政策风险': -0.01 }, industry: true, duration: 4 },

            // ═══════ 成熟：专业财经 ═══════
            { stage: [2], cat: 'company', type: 'bullish', title: '{company}披露年报：营收创历史新高，拟每10股派现{C}元', desc: '业绩符合甚至略超预期，分红比例提升彰显股东回报意愿。', impact: { '公司特质': 0.035, '市场情绪': 0.015 }, symbol: true, duration: 4 },
            { stage: [2], cat: 'company', type: 'bullish', title: '{company}宣布回购计划，金额不超过{C}亿元', desc: '回购价格上限较现价溢价约15%，传递管理层信心。', impact: { '公司特质': 0.03 }, symbol: true, duration: 3 },
            { stage: [2], cat: 'company', type: 'neutral', title: '{company}子公司获重大合同，订单金额约{C}亿元', desc: '合同履行周期约两年，对当期业绩影响有限，但打开成长空间。', impact: { '公司特质': 0.02 }, symbol: true, duration: 2 },
            { stage: [2], cat: 'company', type: 'bearish', title: '{company}因会计差错收监管函，股价承压', desc: '公司回应称系口径调整，不影响经营基本面，但市场情绪偏谨慎。', impact: { '公司特质': -0.025 }, symbol: true, duration: 3 },
            { stage: [2], cat: 'macro', type: 'bullish', title: '央行宣布降准{C}个百分点，释放长期资金约{C}万亿元', desc: '这是年内第{C}次降准，机构解读为稳增长政策加码。', impact: { '宏观经济': 0.03, '市场情绪': 0.02 }, duration: 5 },
            { stage: [2], cat: 'macro', type: 'neutral', title: '统计局：三季度GDP同比增长{C}%，好于市场预期', desc: '消费与出口韧性较强，制造业投资保持较高增速。', impact: { '宏观经济': 0.015 }, duration: 3 },
            { stage: [2], cat: 'macro', type: 'bearish', title: '美联储维持利率不变但措辞鹰派，全球风险资产承压', desc: '美债收益率上行，外资流出压力加大，成长板块估值受压制。', impact: { '国际环境': -0.025, '市场情绪': -0.015 }, duration: 4 },
            { stage: [2], cat: 'macro', type: 'bearish', title: '国际油价大幅波动，通胀预期升温', desc: '能源成本上升挤压中下游利润，周期与消费板块受波及。', impact: { '宏观经济': -0.02, '国际环境': -0.01 }, duration: 3 },
            { stage: [2], cat: 'policy', type: 'neutral', title: '全面注册制下退市新规落地，市场分化加剧', desc: '壳价值持续缩水，基本面成为资金最重要的锚。', impact: { '政策风险': 0.01 }, duration: 4 },
            { stage: [2], cat: 'policy', type: 'bearish', title: '证监会：严查场外配资与违规减持', desc: '短期资金面承压，杠杆资金加速离场，指数震荡回调。', impact: { '政策风险': -0.025, '市场情绪': -0.02 }, duration: 3 },
            { stage: [2], cat: 'policy', type: 'bullish', title: '多地出台楼市新政，房地产板块异动拉升', desc: '限购松绑与信贷支持并举，地产链预期回暖。', impact: { '宏观经济': 0.02 }, industry: true, duration: 3 },
            { stage: [2], cat: 'international', type: 'bearish', title: '地缘局势升温，避险资产走高，风险资产承压', desc: '黄金原油走强，全球股市普跌，北向资金转为流出。', impact: { '国际环境': -0.03, '市场情绪': -0.02 }, duration: 4 },
            { stage: [2], cat: 'international', type: 'bullish', title: '主要经济体达成贸易协议，出口链预期改善', desc: '关税压力缓解，出口企业有望直接受益。', impact: { '国际环境': 0.025 }, industry: true, duration: 3 },
        ];
        this.insiderTemplates = [
            { title: '小道消息：{company}即将被举牌收购', description: '（非公开信息）据说有金主正在谈，具体金额不方便透露', impact: { '公司特质': 0.05 }, symbol: true, duration: 2 },
            { title: '内部人士透露：{company}财报大幅超预期', description: '（非公开信息）内部人士表示「数据好得离谱」', impact: { '公司特质': 0.045 }, symbol: true, duration: 1 },
        ];
        this.nightEvents = [
            { name: '美股暴跌', impact: -0.06, probability: 0.08 },
            { name: '政策利好突袭', impact: 0.05, probability: 0.08 },
            { name: '汇率大幅波动', impact: 0.03, probability: 0.12 },
            { name: '国际冲突升级', impact: -0.04, probability: 0.07 },
            { name: '游戏版号批量下发', impact: 0.04, probability: 0.06 },
            { name: '半导体出口新规', impact: -0.05, probability: 0.05 },
            { name: '财报季开启，业绩两极分化', impact: 0.02, probability: 0.10 },
            { name: '油价大涨冲击中下游', impact: -0.03, probability: 0.07 },
            { name: '无重大事件', impact: 0.0, probability: 0.37 },
        ];
    }
    // 填充占位符
    fill(template) {
        const stock = this.marketData.getRandomStock();
        const company = stock?.name || '某公司';
        const code = stock?.code || '000000';
        const industry = stock?.industry || '某行业';
        const rnd = (n) => Math.floor(Math.random() * n);
        const C = ((10 + rnd(40)) / 10).toFixed(1); // 1.0~4.9
        const N = String(2 + rnd(9)); // 2~10
        const sub = (s) => s
            .replace(/\{company\}/g, company)
            .replace(/\{code\}/g, code)
            .replace(/\{industry\}/g, industry)
            .replace(/\{C\}/g, C)
            .replace(/\{N\}/g, N);
        return { title: sub(template.title), description: sub(template.desc || ''), stock };
    }
    generateDailyNews(marketRegime, gameDay = 0) {
        if (Math.random() > 0.72) {
            this.currentNews = null;
            return null;
        }
        const stage = gameDay < 30 ? 0 : gameDay < 150 ? 1 : 2;
        let pool = this.templates.filter((t) => t.stage.includes(stage));
        if (pool.length === 0)
            pool = this.templates;
        // regime 偏好：bull 偏利好、bear 偏利空
        if (marketRegime === 'bull') {
            const fav = pool.filter((t) => t.type !== 'bearish');
            if (fav.length > 0)
                pool = fav;
        }
        else if (marketRegime === 'bear') {
            const fav = pool.filter((t) => t.type !== 'bullish');
            if (fav.length > 0)
                pool = fav;
        }
        const template = pool[Math.floor(Math.random() * pool.length)];
        const filled = this.fill(template);
        const duration = Math.max(1, template.duration + Math.floor(Math.random() * 2) - 1);
        const impact = {};
        for (const [factor, val] of Object.entries(template.impact || {})) {
            impact[factor] = (val as number) * (0.8 + Math.random() * 0.4);
        }
        const news = {
            title: filled.title,
            description: filled.description,
            type: template.type,
            impact,
            duration,
            stage,
            targetedSymbol: template.symbol ? filled.stock?.symbol : null,
            targetedIndustry: template.industry ? filled.stock?.industry : null,
        };
        this.currentNews = news;
        // 宏观因子冲击
        for (const [factor, val] of Object.entries(news.impact)) {
            this.marketData.applyFactorImpulse(factor, val);
        }
        // 定向个股/行业价格冲击（真实嵌入）
        if (news.targetedSymbol || news.targetedIndustry) {
            this.marketData.applyNewsImpact(news);
        }
        this.gateway.broadcastNews(news);
        // 内幕消息（低概率附加）
        if (Math.random() < 0.02) {
            const insider = this.insiderTemplates[Math.floor(Math.random() * this.insiderTemplates.length)];
            const ins = this.fill(insider);
            const insiderNews = {
                title: ins.title,
                description: ins.description,
                type: 'insider',
                impact: { ...insider.impact },
                duration: insider.duration,
                isInsider: true,
                penaltyChance: 0.3,
                targetedSymbol: insider.symbol ? ins.stock?.symbol : null,
            };
            if (insiderNews.targetedSymbol)
                this.marketData.applyNewsImpact(insiderNews);
            this.gateway.broadcastNews(insiderNews);
            this.logger.warn(`内幕消息: ${insiderNews.title}`);
        }
        return news;
    }
    processNightEvent() {
        const rand = Math.random();
        let cumulative = 0;
        for (const event of this.nightEvents) {
            cumulative += event.probability;
            if (rand <= cumulative) {
                if (event.impact !== 0) {
                    this.logger.log(`夜间事件: ${event.name} (${(event.impact * 100).toFixed(1)}%)`);
                    this.gateway.broadcastNews({
                        title: `🌙 ${event.name}`,
                        description: `隔夜影响: ${(event.impact * 100).toFixed(1)}%`,
                        type: 'night',
                        impact: {},
                        duration: 1,
                    });
                }
                return event;
            }
        }
        return null;
    }
    checkInsiderPenalty() {
        return Math.random() < 0.1;
    }
    getCurrentNews() {
        return this.currentNews;
    }
};

export { NewsService };

NewsService = __decorate(
[
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [market_data_service_1.MarketDataService,
        market_gateway_1.MarketGateway])
],
NewsService
);
