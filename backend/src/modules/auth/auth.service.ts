import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User, UserRole } from '../../infrastructure/database/entities/user.entity';
import { Account } from '../../infrastructure/database/entities/account.entity';
import { RISK } from '../../common/constants';

// 登录失败记录：计数键（用户名|IP，见 loginFailKey）→ 失败计数 / 锁定截止时间戳
interface LoginFailRecord {
    failCount: number;
    lockedUntil: number;
}

@Injectable()
export class AuthService {
    // ─── Phase D: 账号级防爆破（纵深防御；IP 层 10次/分限流在 main.ts 挂载）───
    // 内存 Map：计数键 → { failCount, lockedUntil }，进程内单实例有效（本项目单进程部署）。
    // R5-④: 计数键由「用户名」改为「用户名|IP」——原实现只按用户名计数，攻击者从任意 IP 对
    // 已知用户名连错 5 次即可把真实用户锁 10 分钟（可被利用的账号锁定 DoS）；加入 IP 维度后
    // 攻击者无法再从任意 IP 锁死他人账号。残留风险：同一 NAT 出口（校园/公司/家宽）的用户
    // 共享 IP，极端情况下仍会互相影响失败计数；IP 层限流由 express-rate-limit（main.ts 挂载）兜底。
    // 不存在用户名同样计数锁定（防枚举：爆破方无法区分「用户名不存在」与「密码错误」）。
    // 常量做成实例字段便于 phase10 单测覆写（如 LOGIN_LOCK_MS=1 验证锁定期外恢复）。
    private loginFails = new Map<string, LoginFailRecord>();
    private LOGIN_MAX_FAILS = 5;
    private LOGIN_LOCK_MS = 10 * 60 * 1000; // 10 分钟
    private LOGIN_LOCK_MSG = '尝试次数过多，账号已锁定10分钟';

    constructor(
        @InjectRepository(User) private readonly userRepo: Repository<User>,
        @InjectRepository(Account) private readonly accountRepo: Repository<Account>,
        private readonly jwtService: JwtService,
    ) {}

    // 主应用启动自动确保管理员存在（防 DB 覆盖丢失）
    async onModuleInit() {
        try {
            const adminUsername = process.env.ADMIN_USERNAME || 'admin';
            const existing = await this.userRepo.findOne({ where: { username: adminUsername } });
            if (!existing) {
                const adminPassword = process.env.ADMIN_PASSWORD;
                const isStrong = !!adminPassword && adminPassword.length >= 8;
                const isDev = process.env.NODE_ENV === 'development';
                // SECURITY(C2): 仅 development 环境允许回退默认密码；production/staging/未设置等环境必须提供强 ADMIN_PASSWORD（>=8位），否则拒绝创建（避免默认后门）
                if (!isStrong && !isDev) {
                    console.error('[Seed] 当前环境（' + (process.env.NODE_ENV || '未设置') + '）未设置强 ADMIN_PASSWORD（>=8位），已拒绝创建默认管理员账号');
                    return;
                }
                const passwordToUse = isStrong ? adminPassword : 'admin123';
                if (!isStrong) {
                    console.warn('[Seed] 使用默认管理员密码 admin123（仅限 development 环境，其他环境请设置 ADMIN_PASSWORD 环境变量）');
                }
                const hashed = await bcrypt.hash(passwordToUse, 10);
                const admin = this.userRepo.create({
                    username: adminUsername,
                    password: hashed,
                    role: UserRole.ADMIN,
                });
                await this.userRepo.save(admin);
                for (const mode of ['CN', 'HK', 'US']) {
                    const account = this.accountRepo.create({
                        userId: admin.id,
                        marketMode: mode,
                        cash: RISK.initialCash,
                        totalEquity: RISK.initialCash,
                        peakEquity: RISK.initialCash,
                        initialEquity: RISK.initialCash,
                        dayStartEquity: RISK.initialCash,
                    });
                    await this.accountRepo.save(account);
                }
                console.log('[Seed] 管理员账号已创建: ' + adminUsername);
            }
            // 注：若 admin 用户已存在但密码较弱，此处不强制重置（避免影响既有登录会话），请运维手动轮换密码
        }
        catch (e) {
            console.error('[Seed] 管理员创建失败:', e.message);
        }
    }

    // SECURITY(H3): 序列化时排除密码哈希，避免泄露
    toSafeUser(user: User) {
        if (!user)
            return user;
        return {
            id: user.id,
            username: user.username,
            role: user.role,
            isActive: user.isActive,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
        };
    }

    async register(username: string, password: string) {
        const existing = await this.userRepo.findOne({ where: { username } });
        if (existing)
            // Phase E: 枚举面收口（teams 方案 B）——重名不再 409，统一 200+{success:false}，
            // 状态码不可区分"已存在/可注册"；文案不泄露存在性（与登录侧防枚举对称）
            return { success: false, error: '注册失败，请更换用户名' };
        const hashed = await bcrypt.hash(password, 10);
        const user = this.userRepo.create({ username, password: hashed });
        await this.userRepo.save(user);
        for (const mode of ['CN', 'HK', 'US']) { // B1 多市场：A股/港股/美股三账户
            const account = this.accountRepo.create({
                userId: user.id,
                marketMode: mode,
                cash: RISK.initialCash,
                totalEquity: RISK.initialCash,
                peakEquity: RISK.initialCash,
                initialEquity: RISK.initialCash,
                dayStartEquity: RISK.initialCash,
            });
            await this.accountRepo.save(account);
        }
        const token = this.jwtService.sign({ sub: user.id, username: user.username, role: user.role });
        return { user: this.toSafeUser(user), token };
    }

    // 用户名正常化：trim 规范化（与既有实现一致），查询库与计数键共用同一口径
    normalizeUsername(username: string) {
        // trim 规范化：拒绝 " admin " 与 "admin" 各记一次的分裂计数
        return String(username || '').trim();
    }

    // R5-④: 计数键 = 正常化用户名 + '|' + IP；ip 缺省 'local' 使既有调用（单测/无 IP 场景）
    // 退化为「用户名|local」——仍是按名共享计数，语义与旧实现等价，且不与任何真实 IP 键混用
    loginFailKey(username: string, ip?: string) {
        return `${this.normalizeUsername(username)}|${ip || 'local'}`;
    }

    purgeExpiredLoginFails() {
        if (this.loginFails.size < 5000)
            return; // 低于阈值不扫（R5-④ 后键变为「用户名×IP」，键数增长更快，容量阈值语义不变）
        const now = Date.now();
        for (const [k, v] of this.loginFails) { // Map 迭代中 delete 安全
            if (v.lockedUntil <= now)
                this.loginFails.delete(k);
        }
        if (this.loginFails.size > 10000)
            this.loginFails.clear(); // 极端兜底（正常不可能）
    }

    checkLoginLocked(key: string) {
        const rec = this.loginFails.get(key);
        if (!rec)
            return;
        const now = Date.now();
        if (rec.lockedUntil > now) {
            throw new UnauthorizedException(this.LOGIN_LOCK_MSG);
        }
        // lockedUntil=0 表示「仅有失败计数、尚未锁定」——保留计数记录；>0 且已过期才惰性清除
        if (rec.lockedUntil > 0)
            this.loginFails.delete(key);
    }

    recordLoginFail(key: string) {
        this.purgeExpiredLoginFails();
        const now = Date.now();
        const rec = this.loginFails.get(key) || { failCount: 0, lockedUntil: 0 };
        rec.failCount += 1;
        if (rec.failCount >= this.LOGIN_MAX_FAILS) {
            rec.lockedUntil = now + this.LOGIN_LOCK_MS; // 第 5 次失败即锁
            rec.failCount = 0; // 重置计数，避免锁内继续累加
        }
        this.loginFails.set(key, rec);
    }

    async login(username: string, password: string, ip?: string) {
        const name = this.normalizeUsername(username);
        const key = this.loginFailKey(name, ip);
        // 锁定检查先于一切 IO/bcrypt：锁定期内既不查库也不跑 bcrypt（省钱省 CPU，且不可被计时旁路）
        this.checkLoginLocked(key);
        // 注意：查库仍按正常化用户名（不带 IP 后缀），计数键只用于锁定维度
        const user = await this.userRepo.findOne({ where: { username: name } });
        if (!user) {
            // teams 定稿取舍：不存在的用户名同样计数 → 爆破方无法区分「用户名不存在」与「密码错误」；
            // 计数键是「不存在的名字|IP」这样的惰性键，到期由 purgeExpiredLoginFails 回收，不会锁住真实账号
            this.recordLoginFail(key);
            throw new UnauthorizedException('用户名或密码错误');
        }
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) {
            this.recordLoginFail(key);
            throw new UnauthorizedException('用户名或密码错误');
        }
        // R5-④: 成功登录只清「本键」（用户名|本次 IP），该用户在其他 IP 上的失败计数不受影响
        this.loginFails.delete(key);
        const token = this.jwtService.sign({ sub: user.id, username: user.username, role: user.role });
        return { user: this.toSafeUser(user), token };
    }
}
