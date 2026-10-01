import { BadRequestException, Injectable, Logger } from '@nestjs/common';

/**
 * 站内发信（2026-09-30）
 *
 * 背景：站主想"以 contact@bobbycn.cc 回信"，但 Cloudflare Email Routing **只收不发**，而新版 QQ 邮箱
 * 把自定义域发信做成了付费会员功能（免费的「其他邮箱」入口已经没了）。所以干脆在站上做一个发信页：
 * 站主登录后填收件人/主题/正文 → 走 Resend API 以 contact@bobbycn.cc 发出。
 * 好处：手机也能用、不装任何客户端、不依赖第三方邮件服务，而且用的是自己的栈与已验证的主域 DKIM。
 *
 * 与 identity 模块的 ResendMailerService 的区别：那个是系统通知信（From = MAIL_FROM，如 no-reply@em.…），
 * 这里是**人写的信**（From = 可配的信箱地址，默认 contact@bobbycn.cc），两者语义不同所以单独一个 service。
 */
@Injectable()
export class WebmailService {
    private readonly logger = new Logger('Webmail');

    /** 发信地址：默认主域的 contact@（主域 DKIM 已验证，见 deploy/README §14.11） */
    fromAddress(): string {
        return String(process.env.WEBMAIL_FROM || 'contact@bobbycn.cc').trim();
    }

    fromHeader(): string {
        const name = String(process.env.WEBMAIL_FROM_NAME || 'Bobby · bobbycn.cc').trim();
        return `${name} <${this.fromAddress()}>`;
    }

    /** 收件人白名单为空 = 不限制；配了 WEBMAIL_TO_ALLOW 则只允许发往列出的地址（防手滑群发） */
    private allowedRecipients(): string[] {
        return String(process.env.WEBMAIL_TO_ALLOW || '')
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
    }

    private apiKey(): string {
        return String(process.env.RESEND_API_KEY || '').trim();
    }

    private assertEmail(addr: string): string {
        const s = String(addr || '').trim();
        // 只做形状校验，不追求 RFC 完备：真正的判定交给 Resend
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) || s.length > 254)
            throw new BadRequestException('收件人邮箱格式不对');
        const allow = this.allowedRecipients();
        if (allow.length && !allow.includes(s.toLowerCase()))
            throw new BadRequestException('这个收件人不在允许名单里（WEBMAIL_TO_ALLOW）');
        return s;
    }

    /** 发一封信；返回 Resend 的受理 id（日志里同样只记 id/主题/收件人，不记正文） */
    async send(input: { to: string; subject: string; text?: string; html?: string; replyTo?: string }): Promise<{ id: string; from: string; to: string }> {
        const key = this.apiKey();
        if (!key)
            throw new BadRequestException('服务器没配 RESEND_API_KEY，发不出去');

        const to = this.assertEmail(input.to);
        const subject = String(input.subject || '').trim().slice(0, 200) || '(无主题)';
        const text = String(input.text || '');
        if (!text.trim() && !input.html)
            throw new BadRequestException('正文是空的');
        if (text.length > 100_000)
            throw new BadRequestException('正文太长了');

        // 纯文本也能发：Resend 接受 html 字段传纯文本段落；这里把换行转成 <br>，
        // 同时在 text 里保留原文（收件人客户端优先用 text/plain 时看到的是原样）
        const html = input.html || '<div style="white-space:pre-wrap;font:14px/1.7 system-ui,sans-serif">'
            + text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
            + '</div>';

        const body: any = { from: this.fromHeader(), to: [to], subject, html, text };
        if (input.replyTo && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(input.replyTo).trim()))
            body.reply_to = String(input.replyTo).trim();

        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data: any = await res.json().catch(() => null);
        if (!res.ok) {
            this.logger.error(`发信失败：HTTP ${res.status}`);
            throw new BadRequestException(`发信失败（HTTP ${res.status}）${data && data.message ? '：' + String(data.message).slice(0, 160) : ''}`);
        }
        const id = (data && data.id) || '?';
        this.logger.log(`[Webmail] 已受理 id=${id} to=${to} subject=${subject}`);
        return { id, from: this.fromAddress(), to };
    }
}
