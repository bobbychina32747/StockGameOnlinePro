import { Injectable, Logger } from '@nestjs/common';

/**
 * 评论机器人审核（2026-09-29 站主要求："添加一个机器人审核评论，禁止 dddd 那些违规内容"）
 *
 * 设计前提（站主："不要让我自己审核，我懒"）：
 *   · **没有人工队列**——机器人必须当场给出唯一结论：放行 or 拒收。所以只有两档 verdict；
 *   · 可疑但不确定的（比如带 1~2 个链接）**放行**：评论一律用 textContent 渲染，链接不可点、
 *     也不参与 SEO，风险远小于"把正常读者的评论悄悄吞掉"；
 *   · 规则是**可解释**的：拒收时把理由同时给用户（400 文案）和日志，站长事后能复盘。
 *
 * 为什么是规则引擎而不是调大模型：评论是低价值高频输入，逐条调模型既费钱又引入外部依赖
 * （CF 抖动那套已经够烦）；这类中文小站的违规特征又高度集中（刷屏/灌水/广告/外链），正则足够。
 */
export type ModerationVerdict = 'pass' | 'block';

export interface ModerationResult {
    verdict: ModerationVerdict;
    /** 人类可读的拒收理由（进日志与 400 文案；不含用户数据） */
    reasons: string[];
}

/** 明确不欢迎的词（广告/灰产/色情/赌博）：命中即拒 */
const BANNED: RegExp[] = [
    /(加|➕|扫)\s*(微信|weixin|wx|v\s*信|qq|企鹅)/i,
    /(代刷|刷单|刷票|返利|博彩|赌场|下注|投注|开户|办证|发票|香烟|迷药|春药|开房记录)/,
    /(色情|约炮|包养|一夜情|裸聊|成人视频|福利姬|楼凤)/,
    /(免费|低价|高价).{0,8}(领取|回收|代充|代练|代购)/,
    /\b(viagra|casino|porn|xxx|sexcam|loan|betting|escort)\b/i,
    /(私信|扫码).{0,6}(进群|领取|咨询)/,
];

/** 纯灌水（整条只由这些字符组成）：dddd / 顶顶顶 / 1111 / 6666 / 哈哈哈哈 / 啊啊啊 / "。。。" */
const JUNK_ONLY = /^(?:d|D|顶|叮|帮顶|踩|1|6|9|哈|呵|嘿|啊|哦|额|嗯|草|艹|氵|水|。。。|\s|[，,。.、!！?？~～+\-_=*^])+$/u;

/** 同一字符连打 6 次以上（dddddd、啊啊啊啊啊啊） */
const REPEAT_CHAR = /(.)\1{5,}/u;

@Injectable()
export class BlogModerationService {
    private readonly logger = new Logger('BlogModeration');

    /** 只做审查，不碰库；block = 拒收（400），pass = 直接发布 */
    review(input: { body: string }): ModerationResult {
        const trimmed = String(input.body || '').trim();

        if (trimmed.length < 2)
            return this.no('内容太短');

        // ① 站主点名的这一类：整条就是 dddd / 顶顶顶 / 1111 / 哈哈哈哈
        if (JUNK_ONLY.test(trimmed))
            return this.no('纯灌水（重复字符、没有实际内容）');

        // ② 夹在正常文字里的超长重复（"支持ddddddddd"）
        if (REPEAT_CHAR.test(trimmed))
            return this.no('有超长重复字符');

        // ③ 字符多样性过低（长内容翻来覆去就那几个字）
        const dense = trimmed.replace(/\s/g, '');
        if (dense.length >= 8 && new Set([...dense]).size / dense.length < 0.25)
            return this.no('字符重复度太高');

        // ④ 广告 / 灰产词
        if (BANNED.some((re) => re.test(trimmed)))
            return this.no('命中违禁词（广告/灰产）');

        // ⑤ 全是符号或表情，没有实际文字
        const meaningful = dense.replace(/[\p{P}\p{S}\p{Emoji_Presentation}]/gu, '');
        if (dense.length >= 4 && meaningful.length === 0)
            return this.no('只有符号/表情，没有实际内容');

        // ⑥ 外链：3 条以上当垃圾；1~2 条放行（链接渲染成纯文本，点不了也没 SEO 收益）
        const links = trimmed.match(/https?:\/\/\S+/gi) || [];
        if (links.length >= 3)
            return this.no(`一次带了 ${links.length} 个外链`);

        // ⑦ 全大写英文长串（英文垃圾广告的典型形态）
        const letters = trimmed.replace(/[^A-Za-z]/g, '');
        if (letters.length >= 20 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.85)
            return this.no('全大写英文长串');

        return { verdict: 'pass', reasons: [] };
    }

    private no(reason: string): ModerationResult {
        this.logger.warn(`评论被机器人拦下：${reason}`);
        return { verdict: 'block', reasons: [reason] };
    }
}
