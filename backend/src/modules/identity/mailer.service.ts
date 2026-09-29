import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface MailMessage {
    to: string;
    subject: string;
    html: string;
}

/** 邮件发送抽象：业务层只依赖本接口，具体通道由 module 里的工厂按环境变量挑选 */
export interface Mailer {
    send(message: MailMessage): Promise<void>;
}

/** DI 注入令牌（接口在运行时不存在，必须用字符串令牌） */
export const MAILER = 'IDENTITY_MAILER';

/** 规格指定发信人（不是密钥，可以进代码） */
export const DEFAULT_MAIL_FROM = 'no-reply@em.bobbycn.cc';

/** 默认实现：只写日志不真发（本机/测试环境用，避免误发真实邮件） */
@Injectable()
export class LogMailerService implements Mailer {
    private readonly logger = new Logger(LogMailerService.name);

    async send(message: MailMessage): Promise<void> {
        this.logger.log(`[LogMailer] to=${message.to} subject=${message.subject}`);
        // 正文含一次性链接，本地排查需要看到；这是开发日志通道，不落审计库
        this.logger.debug(`[LogMailer] body:\n${message.html}`);
    }
}

/** 真实发信：直接调 Resend HTTP API（不引入 SDK 依赖）。仅当 RESEND_API_KEY 存在时由工厂启用 */
@Injectable()
export class ResendMailerService implements Mailer {
    private readonly logger = new Logger(ResendMailerService.name);

    constructor(private readonly config: ConfigService) {}

    async send(message: MailMessage): Promise<void> {
        // 密钥只从环境变量读；代码里不得出现任何密钥常量
        const apiKey = this.config.get<string>('RESEND_API_KEY') || process.env.RESEND_API_KEY;
        if (!apiKey)
            throw new Error('RESEND_API_KEY 未配置，无法通过 Resend 发信');
        const from = this.config.get<string>('MAIL_FROM') || DEFAULT_MAIL_FROM;
        // Node 18+ 自带 fetch；tsconfig 未装 @types/node 的 undici 声明时按 any 调用，避免类型门槛
        const doFetch = (globalThis as any).fetch as (url: string, init: any) => Promise<any>;
        const res = await doFetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ from, to: [message.to], subject: message.subject, html: message.html }),
        });
        if (!res || !res.ok) {
            const status = res ? res.status : 'no-response';
            // 不回显响应体（可能含账号信息），只留状态码
            this.logger.error(`Resend 发信失败：HTTP ${status}`);
            throw new Error(`邮件发送失败（HTTP ${status}）`);
        }
        // 记下发信 id 与主题：投递有问题时能拿 id 去 Resend 侧查；日志里不出现密钥
        const body: any = await res.json().catch(() => null);
        this.logger.log(`[Resend] 已受理 id=${body && body.id ? body.id : '?'} to=${message.to} subject=${message.subject}`);
    }
}
