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

let NewsService = class NewsService {
    [key: string]: any;
    constructor(marketData, gateway) {
        this.marketData = marketData;
        this.gateway = gateway;
        this.logger = new common_1.Logger(NewsService.name);
        this.bullishTemplates = [
            { title: '央行降准释放流动性', description: '央行决定下调存款准备金率0.5个百分点', impact: { '宏观经济': 0.025, '市场情绪': 0.02 }, duration: 3 },
            { title: '行业扶持政策出台', description: '国务院发布支持高科技产业发展若干政策', impact: { '行业景气': 0.03, '政策风险': -0.01 }, duration: 4 },
            { title: '公司业绩超预期', description: '公司季度营收同比增长25%，净利润超预期', impact: { '公司特质': 0.035, '市场情绪': 0.01 }, duration: 2 },
            { title: '国际贸易关系缓和', description: '主要经济体宣布暂停加征关税', impact: { '国际环境': 0.02, '宏观经济': 0.01 }, duration: 3 },
        ];
        this.bearishTemplates = [
            { title: '监管层警示市场风险', description: '证监会表示将严查场外配资', impact: { '政策风险': -0.03, '市场情绪': -0.02 }, duration: 3 },
            { title: '公司遭遇重大诉讼', description: '公司因知识产权纠纷被起诉，面临巨额赔偿', impact: { '公司特质': -0.04, '行业景气': -0.01 }, duration: 2 },
            { title: '国际油价暴涨', description: '地缘冲突导致原油供应紧张，油价飙升', impact: { '国际环境': -0.02, '宏观经济': -0.015 }, duration: 4 },
            { title: '行业需求疲软', description: '行业协会报告指出下游需求持续萎缩', impact: { '行业景气': -0.035, '市场情绪': -0.01 }, duration: 5 },
        ];
        this.neutralTemplates = [
            { title: '机构发布中性评级', description: '多家券商给予公司"持有"评级', impact: { '市场情绪': 0.005 }, duration: 2 },
            { title: '公司发布新产品', description: '公司推出新一代产品，市场反响待观察', impact: { '公司特质': 0.02, '行业景气': 0.01 }, duration: 3 },
            { title: '宏观经济数据平淡', description: '统计局公布上月PMI指数持平', impact: { '宏观经济': 0.005 }, duration: 1 },
        ];
        this.insiderTemplates = [
            { title: '小道消息：公司即将被收购', description: '（非公开信息）公司即将被收购', impact: { '公司特质': 0.06 }, duration: 2 },
            { title: '内部人士透露：财报大幅超预期', description: '（非公开信息）内部人士透露财报数据', impact: { '公司特质': 0.05, '市场情绪': 0.02 }, duration: 1 },
        ];
        this.nightEvents = [
            { name: '美股暴跌', impact: -0.06, probability: 0.10 },
            { name: '政策利好突袭', impact: 0.05, probability: 0.10 },
            { name: '汇率大幅波动', impact: 0.03, probability: 0.15 },
            { name: '国际冲突升级', impact: -0.04, probability: 0.08 },
            { name: '无重大事件', impact: 0.0, probability: 0.57 },
        ];
        this.currentNews = null;
    }
    generateDailyNews(marketRegime) {
        if (Math.random() > 0.7) {
            this.currentNews = null;
            return null;
        }
        let pool: any;
        let type: string;
        if (marketRegime === 'bull') {
            pool = this.bullishTemplates;
            type = 'bullish';
        }
        else if (marketRegime === 'bear') {
            pool = this.bearishTemplates;
            type = 'bearish';
        }
        else {
            pool = [...this.bullishTemplates, ...this.bearishTemplates, ...this.neutralTemplates];
            type = 'neutral';
        }
        const template = pool[Math.floor(Math.random() * pool.length)];
        const duration = template.duration + Math.floor(Math.random() * 2) - 1;
        const impact = {};
        for (const [factor, val] of Object.entries(template.impact)) {
            impact[factor] = (val as number) * (0.8 + Math.random() * 0.4);
        }
        const news = {
            title: template.title,
            description: template.description,
            type,
            impact,
            duration: Math.max(1, duration),
        };
        this.currentNews = news;
        for (const [factor, val] of Object.entries(news.impact)) {
            this.marketData.applyFactorImpulse(factor, val);
        }
        this.gateway.broadcastNews(news);
        if (Math.random() < 0.02) {
            const insider = this.insiderTemplates[Math.floor(Math.random() * this.insiderTemplates.length)];
            const insiderNews = {
                title: insider.title,
                description: insider.description,
                type: 'insider',
                impact: { ...insider.impact },
                duration: insider.duration,
                isInsider: true,
                penaltyChance: 0.3,
            };
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

