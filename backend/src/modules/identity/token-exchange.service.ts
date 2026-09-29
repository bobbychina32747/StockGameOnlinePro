import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Identity, IdentityStatus } from '../../infrastructure/database/entities/identity.entity';
import { Session } from '../../infrastructure/database/entities/session.entity';

import { IdentityJwtService, TokenSigningUnavailableError } from './jwt.service';

/** introspect 的固定响应形状：不活跃时也回同一组字段（客户端不必分支判空） */
export interface IntrospectResult {
    active: boolean;
    sub: string | null;
    sid: string | null;
    /** 令牌自身的过期时间（秒）；active=false 时为 null */
    exp: number | null;
}

// 令牌交换 + 内省：把「不透明会话」换成「下游能自己验签的短时令牌」，并提供撤销状态的权威答案。
// 单独成服务（而不是塞进 IdentityService）的原因：IdentityService 面向账号全生命周期，
// 这里面向的是一次 HTTP 调用链（会话 → 令牌 / 令牌 → 状态），且它必须能在密钥缺失时只回 503 而不影响账号流程。
@Injectable()
export class TokenExchangeService {
    constructor(
        private readonly jwt: IdentityJwtService,
        @InjectRepository(Session) private readonly sessionRepo: Repository<Session>,
        @InjectRepository(Identity) private readonly identityRepo: Repository<Identity>,
    ) {}

    /**
     * 冻结的 exchange 端点载荷：会话（Cookie sid 或 Bearer）→ 短时 EdDSA 访问令牌。
     * 字段名与 OAuth2 token 响应对齐（token/tokenType/expiresIn），kid 便于下游按需预取公钥。
     */
    exchange(identityId: string, sessionId: string) {
        try {
            const issued = this.jwt.issue(String(identityId), String(sessionId));
            return { token: issued.token, tokenType: 'Bearer', expiresIn: issued.expiresIn, kid: issued.kid };
        }
        catch (e) {
            // 私钥缺失是可预期的降级状态（部署未就位），回 503 让下游重试/回退到 Cookie 校验，而不是 500 当作 bug
            if (e instanceof TokenSigningUnavailableError)
                throw new ServiceUnavailableException(e.message);
            throw e;
        }
    }

    /**
     * 公开内省：验签 → 同库查 sessions（强一致，不缓存、不跨服务）→ 只回 active/sub/sid/exp。
     * 令牌无效、已过期、会话已撤销、账号被停用一律 active:false 且**不区分原因**（不给出可探测的差异）。
     * @param token 待验的 EdDSA 令牌（明文会话令牌不在此接口受理）
     */
    async introspect(token: string): Promise<IntrospectResult> {
        const inactive: IntrospectResult = { active: false, sub: null, sid: null, exp: null };
        if (!token)
            return inactive;

        let claims;
        try {
            claims = this.jwt.verify(token);
        }
        catch {
            return inactive;
        }

        const session = await this.sessionRepo.findOne({ where: { id: claims.sid } });
        if (!session || session.revokedAt)
            return inactive;
        if (new Date(session.expiresAt).getTime() <= Date.now())
            return inactive;
        // 令牌自有其会话绑定：sid 与 sub 必须自洽，否则是一张"拼装"出来的令牌
        if (session.identityId !== claims.sub)
            return inactive;

        // 与 SessionAuthGuard.resolveSession 同一口径：账号被停用后，已发出的令牌立即失效
        const identity = await this.identityRepo.findOne({ where: { id: session.identityId } });
        if (!identity || identity.status !== IdentityStatus.ACTIVE)
            return inactive;

        return { active: true, sub: claims.sub, sid: claims.sid, exp: claims.exp };
    }
}
