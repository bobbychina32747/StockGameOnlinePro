import { Injectable, Logger } from '@nestjs/common';

import { MarketDataService } from '../../core/market-data/market-data.service';

import { MarketGateway } from './market.gateway';

import { NEWS_TEMPLATES } from './news-templates';

// 阶段化新闻模板（{company}/{code}/{industry}/{C}/{N} 占位符由 fill 填充）
interface NewsTemplate {
    stage: number[];
    type: string;
    title: string;
    desc?: string;
    impact?: Record<string, number>;
    symbol?: boolean;
    industry?: boolean;
    duration: number;
}

// 内幕消息模板（低概率附加，无 stage）
interface InsiderTemplate {
    title: string;
    desc?: string;
    // 内幕消息模板历史上用 description 字段（与 NEWS_TEMPLATES 的 desc 并存）——两者都保留，避免改字面量
    description?: string;
    impact: Record<string, number>;
    symbol?: boolean;
    duration: number;
}

interface InsiderNews {
    title: string;
    description: string;
    type: string;
    impact: Record<string, number>;
    duration: number;
    isInsider: boolean;
    penaltyChance: number;
    targetedSymbol: string | null;
}

interface NewsItem {
    title: string;
    description: string;
    type: string;
    impact: Record<string, number>;
    duration: number;
    stage: number;
    targetedSymbol: string | null;
    targetedIndustry: string | null;
    insiderNews: InsiderNews | null;
}

interface NightEvent {
    name: string;
    impact: number;
    probability: number;
}

/**
 * 新闻系统 v2
 * - 分阶段：gameDay<30 元年（上市快乐·俏皮）→ <150 成长（渐正式）→ 成熟（专业财经）
 * - 模板库：40+ 条，占位符 {company}/{code}/{industry}/{C}/{N} 动态填充
 * - 影响：宏观因子冲击 + 定向行业/个股价格冲击（真实嵌入）
 */
@Injectable()
export class NewsService {
    private readonly logger = new Logger(NewsService.name);

    private currentNews: NewsItem | null = null;

    // 全局去重：同一阶段内避免重复（池子耗尽才重置）
    private readonly usedKeys = new Set<string>();

    // stage: 0=元年(<30天) 1=成长(<150天) 2=成熟；type: bullish/bearish/neutral
    // 模板库：外部文件（约 190 条，分阶段）
    private readonly templates: NewsTemplate[] = NEWS_TEMPLATES;

    private readonly insiderTemplates: InsiderTemplate[] = [
        { title: '小道消息：{company}即将被举牌收购', description: '（非公开信息）据说有金主正在谈，具体金额不方便透露', impact: { '公司特质': 0.05 }, symbol: true, duration: 2 },
        { title: '内部人士透露：{company}财报大幅超预期', description: '（非公开信息）内部人士表示「数据好得离谱」', impact: { '公司特质': 0.045 }, symbol: true, duration: 1 },
    ];

    private readonly nightEvents: NightEvent[] = [
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

    constructor(
        private readonly marketData: MarketDataService,
        private readonly gateway: MarketGateway,
    ) {}

    // 填充占位符
    // Q9：{C} 按模板关键词分场景生成合理数值（降准/GDP/营收/派现/回购/订单/流动性等）
    fill(template: { title: string; desc?: string }) {
        const stock = this.marketData.getRandomStock();
        const company = stock?.name || '某公司';
        const code = stock?.code || '000000';
        const industry = stock?.industry || '某行业';
        const rnd = (n: number) => Math.floor(Math.random() * n);
        const t = template.title;
        const range = (min: number, max: number) => (min + Math.random() * (max - min)).toFixed(1);
        let C = range(1, 5);
        if (t.includes('降准'))
            C = [0.25, 0.5][rnd(2)].toFixed(2); // 降准 0.25/0.5 个百分点
        else if (t.includes('GDP'))
            C = range(3, 8); // GDP 同比 3~8%
        else if (t.includes('营收') || t.includes('业绩') || t.includes('净利') || t.includes('增长') || t.includes('评级') || t.includes('目标价'))
            C = range(5, 40); // 营收/增速 5~40%
        else if (t.includes('派现'))
            C = range(1, 10); // 每10股派现 1~10 元
        else if (t.includes('回购'))
            C = range(1, 50); // 回购金额 1~50 亿
        else if (t.includes('订单') || t.includes('合同') || t.includes('中标'))
            C = range(0.5, 20); // 订单金额 0.5~20 亿
        else if (t.includes('净流入') || t.includes('投放'))
            C = range(200, 1000); // 流动性投放 200~1000 亿
        const N = String(2 + rnd(9)); // 2~10
        const sub = (s: string) => s
            .replace(/\{company\}/g, company)
            .replace(/\{code\}/g, code)
            .replace(/\{industry\}/g, industry)
            .replace(/\{C\}/g, C)
            .replace(/\{N\}/g, N);
        return { title: sub(template.title), description: sub(template.desc || ''), stock };
    }

    generateDailyNews(marketRegime: string, gameDay = 0) {
        if (Math.random() > 0.72) {
            this.currentNews = null;
            return null;
        }
        const stage = gameDay < 30 ? 0 : gameDay < 150 ? 1 : 2;
        let pool = this.templates.filter((t) => t.stage.includes(stage));
        if (pool.length === 0)
            pool = this.templates;
        // 去重：优先未使用模板（100 天内不重复），池子耗尽才重置
        let unused = pool.filter((t) => !this.usedKeys.has(stage + '|' + t.title));
        if (unused.length === 0) {
            this.usedKeys.clear();
            unused = pool;
        }
        pool = unused;
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
        this.usedKeys.add(stage + '|' + template.title);
        const filled = this.fill(template);
        const duration = Math.max(1, template.duration + Math.floor(Math.random() * 2) - 1);
        const impact: Record<string, number> = {};
        for (const [factor, val] of Object.entries(template.impact || {})) {
            impact[factor] = val * (0.8 + Math.random() * 0.4);
        }
        const news: NewsItem = {
            title: filled.title,
            description: filled.description,
            type: template.type,
            impact,
            duration,
            stage,
            targetedSymbol: template.symbol ? filled.stock?.symbol : null,
            targetedIndustry: template.industry ? filled.stock?.industry : null,
            insiderNews: null,
        };
        this.currentNews = news;
        // P3 新闻因果链：因子冲击 + 定向个股/行业冲击 + 持久衰减档案（数日定价过程）由 applyNewsImpact 统一处理
        this.marketData.applyNewsImpact(news);
        // 内幕消息（低概率附加）——由 market.service 错峰播报（不再即时广播，避免开盘新闻扎堆）
        if (Math.random() < 0.02) {
            const insider = this.insiderTemplates[Math.floor(Math.random() * this.insiderTemplates.length)];
            const ins = this.fill(insider);
            const insiderNews: InsiderNews = {
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
            news.insiderNews = insiderNews;
            this.logger.warn('内幕消息: ' + insiderNews.title);
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
                    // 夜间事件新闻由 market.service 错峰播报
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
}
