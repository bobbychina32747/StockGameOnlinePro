import { Injectable, UnauthorizedException } from '@nestjs/common';
import { verify as cryptoVerify } from 'crypto';

import { KeysService, SIGNING_ALG } from './keys.service';

// EdDSA(Ed25519) JWT：手写 base64url + crypto.sign/verify。
// 为什么不用 jsonwebtoken/jose：格式只有三段、算法固定 EdDSA，手写不到百行，
// 且能精确控制 claims（iss/aud/sub/sid）与 TTL 上限，避免为一件事背一个依赖。
//
// 令牌语义（阶段一「一次登录、本地验签」）：
//   下游（game.bobbycn.cc、Cloudflare Worker）只验签 + 看 exp 即可放行，
//   需要"这个会话是否已被撤销"时再回调 /introspect（同库强一致）。
//   因此 TTL 必须短：撤销的生效延迟上限 = TTL。

/** 签发者：统一身份服务的规范地址 */
export const JWT_ISSUER = 'https://bobbycn.cc';
/** 受众：整站（主页/博客/游戏厅/游戏子域）共用一个受众值 */
export const JWT_AUDIENCE = 'bobbycn.cc';
/** 访问令牌 TTL = 600 秒（10 分钟，硬上限，不要再调大——撤销延迟与它成正比） */
export const JWT_TTL_SEC = 600;
/** 允许的时钟偏移：下游机器时间没对齐时不至于全量验签失败，同时不至于让过期令牌长命 */
const CLOCK_SKEW_SEC = 60;

export interface JwtClaims {
    iss: string;
    aud: string;
    /** identity.id */
    sub: string;
    /** sessions.id：撤销判定就靠它，必须带 */
    sid: string;
    iat: number;
    exp: number;
    /** 验签命中的 kid（来自 header；令牌轮换期用来判断该用哪把公钥） */
    kid: string;
    /** OAuth 授权：授权的客户端 id（站点内部令牌交换不带该字段） */
    client_id?: string;
    /** OAuth 授权：本张令牌被授到的 scopes（空格分隔，与 RFC 6749 一致） */
    scope?: string;
}

/** 授权码换来的令牌要带上的附加 claim（不传则与既有内部交换完全一致） */
export interface JwtExtraClaims {
    client_id?: string;
    scope?: string;
}

export interface IssuedToken {
    token: string;
    kid: string;
    /** 秒，供响应体 expiresIn 使用 */
    expiresIn: number;
}

type Json = Record<string, any>;

/** base64url 编码（JWT 段不允许 +/= 与填充） */
function b64url(buf: Buffer): string {
    return buf.toString('base64url');
}

function encodeSegment(value: Json): string {
    return b64url(Buffer.from(JSON.stringify(value), 'utf8'));
}

/** 严格解码：只接受 base64url 字符集，载荷被塞进非法字符时尽早判定为无效 */
function decodeSegment(part: string): Json {
    if (!part || !/^[A-Za-z0-9_-]+$/.test(part))
        throw new UnauthorizedException('令牌无效');
    try {
        return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    }
    catch {
        throw new UnauthorizedException('令牌无效');
    }
}

@Injectable()
export class IdentityJwtService {
    constructor(private readonly keys: KeysService) {}

    /**
     * 签发：header{alg:EdDSA,typ:JWT,kid} + payload{iss,aud,sub,sid,iat,exp[,client_id,scope]}。
     * extra 只允许追加 OAuth 授权字段（client_id/scope），不得改动核心语义——
     * 既有 /auth/identity/token 与 introspect 的契约因此一字不变。
     */
    issue(sub: string, sid: string, now = Date.now(), extra?: JwtExtraClaims): IssuedToken {
        const kid = this.keys.currentKid();
        if (!kid || !this.keys.isReady())
            throw new TokenSigningUnavailableError();
        if (!sub || !sid)
            throw new Error('签发身份令牌必须同时提供 sub(identityId) 与 sid(sessionId)');

        const iat = Math.floor(now / 1000);
        const exp = iat + JWT_TTL_SEC;
        const header = { alg: SIGNING_ALG, typ: 'JWT', kid };
        const payload: Record<string, any> = { iss: JWT_ISSUER, aud: JWT_AUDIENCE, sub: String(sub), sid: String(sid), iat, exp };
        if (extra && extra.client_id)
            payload.client_id = String(extra.client_id);
        if (extra && extra.scope)
            payload.scope = String(extra.scope);
        const signingInput = `${encodeSegment(header)}.${encodeSegment(payload)}`;
        const signature = b64url(this.keys.sign(Buffer.from(signingInput, 'utf8')));
        return { token: `${signingInput}.${signature}`, kid, expiresIn: JWT_TTL_SEC };
    }

    /**
     * 验签 + claims 校验（单测与 introspect 共用）。
     * 失败原因一律不外传（统一 UnauthorizedException）：调用方（introspect）只回 active:false，不给探测者任何信号。
     */
    verify(token: string, now = Date.now()): JwtClaims {
        const parts = String(token || '').split('.');
        if (parts.length !== 3)
            throw new UnauthorizedException('令牌无效');
        const [headPart, payloadPart, signaturePart] = parts;

        const header = decodeSegment(headPart);
        // 只认 EdDSA：挡住 alg:none 与任何"换成对称算法"的降级攻击
        if (header.alg !== SIGNING_ALG)
            throw new UnauthorizedException('令牌无效');
        const kid = String(header.kid || '');
        const publicKey = kid ? this.keys.publicKeyFor(kid) : null;
        if (!publicKey)
            throw new UnauthorizedException('令牌无效');

        const signature = Buffer.from(signaturePart, 'base64url');
        const ok = cryptoVerify(null, Buffer.from(`${headPart}.${payloadPart}`, 'utf8'), publicKey, signature);
        if (!ok)
            throw new UnauthorizedException('令牌无效');

        const payload = decodeSegment(payloadPart);
        const iat = Number(payload.iat);
        const exp = Number(payload.exp);
        const nowSec = Math.floor(now / 1000);
        const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];

        const bad =
            payload.iss !== JWT_ISSUER
            || !aud.includes(JWT_AUDIENCE)
            || typeof payload.sub !== 'string' || !payload.sub
            || typeof payload.sid !== 'string' || !payload.sid
            || !Number.isFinite(iat) || !Number.isFinite(exp)
            || exp <= nowSec                                            // 已过期
            || iat > nowSec + CLOCK_SKEW_SEC                            // 签发时间在未来（时钟/伪造）
            || exp - iat > JWT_TTL_SEC;                                 // 超过硬上限：即便签名有效也拒收
        if (bad)
            throw new UnauthorizedException('令牌无效');

        return {
            iss: payload.iss, aud: payload.aud, sub: payload.sub, sid: payload.sid,
            iat, exp, kid,
            ...(typeof payload.client_id === 'string' && payload.client_id ? { client_id: payload.client_id } : {}),
            ...(typeof payload.scope === 'string' && payload.scope ? { scope: payload.scope } : {}),
        };
    }

    /** 只解不验（排障/单测看 header）：生产判断一律走 verify */
    peek(token: string): { header: Json; payload: Json } {
        const parts = String(token || '').split('.');
        if (parts.length !== 3)
            throw new UnauthorizedException('令牌无效');
        return { header: decodeSegment(parts[0]), payload: decodeSegment(parts[1]) };
    }
}

/**
 * 私钥缺失专用错误：由 controller/exchange 层翻译成 503（而不是 500）。
 * 放在这里而不是 jwt.service 里 import @nestjs/common 的异常，是为了让「不可用」与「令牌无效」在类型上分得开。
 */
export class TokenSigningUnavailableError extends Error {
    constructor() {
        super('身份签名密钥不可用，暂时无法签发令牌');
        this.name = 'TokenSigningUnavailableError';
    }
}
