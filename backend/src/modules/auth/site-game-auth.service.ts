import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import * as bcrypt from 'bcrypt';
import { User, UserRole } from '../../infrastructure/database/entities/user.entity';
import { Account } from '../../infrastructure/database/entities/account.entity';
import { Session } from '../../infrastructure/database/entities/session.entity';
import { IdentityStatus } from '../../infrastructure/database/entities/identity.entity';
import { IdentityJwtService } from '../identity/jwt.service';
import { TokenExchangeService } from '../identity/token-exchange.service';
import { AuthService } from './auth.service';
import { RISK } from '../../common/constants';

export function isSiteToken(token: string): boolean {
    try {
        if (typeof token !== 'string' || token.length > 8192) return false;
        return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString()).alg === 'EdDSA';
    } catch { return false; }
}

@Injectable()
export class SiteGameAuthService {
    private mutationQueue: Promise<unknown> = Promise.resolve();
    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        @InjectRepository(User) private readonly users: Repository<User>,
        private readonly jwt: IdentityJwtService,
        private readonly exchange: TokenExchangeService,
        private readonly legacy: AuthService,
    ) {}

    async authenticate(token: string): Promise<User> {
        const claims = this.jwt.verify(token);
        // Third-party grants must not acquire access to the player's trading account.
        if (claims.client_id) throw new UnauthorizedException('请使用站点登录');
        const active = await this.exchange.introspect(token);
        if (!active.active) throw new UnauthorizedException('站点会话已失效');
        const user = await this.users.findOne({ where: { identityId: claims.sub } });
        if (!user || !user.isActive || user.isBot) throw new UnauthorizedException('游戏账号不可用');
        return user;
    }

    async session(session: Session, create = false) {
        this.assertSession(session);
        let user = await this.users.findOne({ where: { identityId: session.identityId } });
        if (!user && !create) {
            return { needsAccountSetup: true, identity: { username: session.identity.username || '站点玩家' } };
        }
        if (!user) {
            const password = await bcrypt.hash(randomUUID() + randomUUID(), 10);
            try {
                user = await this.mutate(() => this.dataSource.transaction(async manager => {
                    const users = manager.getRepository(User);
                    const existing = await users.findOne({ where: { identityId: session.identityId } });
                    if (existing) return existing;
                    let username = (session.identity.username || '站点玩家').slice(0, 50);
                    if (await users.findOne({ where: { username } })) {
                        username = username.slice(0, 37) + '_' + randomUUID().slice(0, 12);
                    }
                    const saved = await users.save(users.create({ username, password, identityId: session.identityId, role: UserRole.USER }));
                    const accounts = manager.getRepository(Account);
                    await accounts.save(['CN', 'HK', 'US'].map(marketMode => accounts.create({
                        userId: saved.id, marketMode, cash: RISK.initialCash,
                        totalEquity: RISK.initialCash, peakEquity: RISK.initialCash,
                        initialEquity: RISK.initialCash, dayStartEquity: RISK.initialCash,
                    })));
                    return saved;
                }));
            } catch (error) {
                user = await this.users.findOne({ where: { identityId: session.identityId } });
                if (!user) throw error;
            }
        }
        return this.result(session, user);
    }

    async link(session: Session, username: string, password: string, ip?: string) {
        this.assertSession(session);
        // Reuse the old account's password verification and brute-force limits.
        const verified = await this.legacy.login(username, password, ip, true);
        const user = await this.mutate(() => this.dataSource.transaction(async manager => {
            const users = manager.getRepository(User);
            const target = await users.findOne({ where: { id: verified.user.id } });
            if (!target || !target.isActive || target.isBot) throw new UnauthorizedException('游戏账号不可用');
            const current = await users.findOne({ where: { identityId: session.identityId } });
            if ((current && current.id !== target.id) || (target.identityId && target.identityId !== session.identityId)) {
                throw new ConflictException('账号已绑定，不能覆盖现有绑定');
            }
            if (target.identityId === session.identityId) return target;
            const updated = await users.createQueryBuilder().update(User).set({ identityId: session.identityId })
                .where('id = :id AND identityId IS NULL', { id: target.id }).execute();
            if (updated.affected !== 1) throw new ConflictException('账号绑定已变化，请重试');
            target.identityId = session.identityId;
            return target;
        }));
        return this.result(session, user);
    }

    private assertSession(session: Session) {
        if (!session?.identity || session.identity.status !== IdentityStatus.ACTIVE || session.identity.id !== session.identityId
            || session.revokedAt || !(new Date(session.expiresAt).getTime() > Date.now())) {
            throw new UnauthorizedException('站点会话已失效');
        }
    }

    private mutate<T>(action: () => Promise<T>): Promise<T> {
        const result = this.mutationQueue.then(action);
        this.mutationQueue = result.catch(() => undefined);
        return result;
    }

    private result(session: Session, user: User) {
        if (!user.isActive || user.isBot) throw new UnauthorizedException('游戏账号不可用');
        return { ...this.exchange.exchange(session.identityId, session.id), user: this.legacy.toSafeUser(user) };
    }
}
