// Phase G-2 机器人玩家（算法盘假人）服务。
//
// 四条红线（违反任一即视为资金安全事故）：
// ① 机器人是**真实的 users 行 + 真实三市场账户**，下单只能经 OrderService.placeOrder（与真人同一条
//    代码路径）——本文件不写任何 Order/Position 实体、不直连撮合引擎、不绕过校验与费用；
// ② 开通口径与 AuthService.register() 严格一致（RISK.initialCash 等五项），否则机器人的净值/收益率
//    与真人不在同一基准上，排行榜与赛季结算全部失真；
// ③ 决策随机数全部来自 (gameDay, tick, botId, salt)（见 bot-strategies.ts），禁止 Math.random 参与决策；
// ④ 机器人是 tick 的**旁路**：任何异常（账户缺失/校验拒绝/DB 抖动）都必须在本层收敛，
//    绝不能因为一个机器人中断行情推进或影响其他机器人。
import { HttpException, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';

import { Account } from '../../infrastructure/database/entities/account.entity';
import { User, UserRole } from '../../infrastructure/database/entities/user.entity';
import { RISK } from '../../common/constants';

// 只引用类型/构造器元数据（Nest 按 design:paramtypes 解析注入），不在模块层反向 import 交易/赛季模块
import { OrderService } from '../trading/order.service';
import { SeasonService } from '../season/season.service';

import { BOT_MAX_COUNT, BotDef, BotPositionView, buildRosterDefs, planBotIntent } from './bot-strategies';

// 三市场账户：与 register() 同一循环口径（A股为主战场，其余两市场保留接口与净值口径）
const BOT_MARKETS = ['CN', 'HK', 'US'];

// 机器人所在市场（主战场）：ctx.market 只用 CN，其余市场目前只在名册层开好账户
const BOT_PRIMARY_MARKET = 'CN';

export interface BotTickContext {
    gameDay: number;
    tick: number;
    market?: string;
}

export interface BotCallbacks {
    getSymbols?: (market?: string) => string[];
    getPrice?: (symbol: string) => number | undefined;
    // 可选：日内基准价（stock.dayOpen）。未注入时退化为「当日首次观测价」，
    // 注入后与行情引擎的 dayOpen 完全对齐（推荐主 agent 注入）
    getDayOpen?: (symbol: string) => number | undefined;
    // 逃生舱：宿主未走 DI（或 token 不匹配）时可用 configure 直接装配依赖，避免"机器人在生产静默不交易"
    orderService?: any;
    seasonService?: any;
}

interface BotState {
    id: string;
    username: string;
    userId: string;
    strategy: string;
    market: string;
    day: number;            // 计数所属游戏日（跨日自动重置）
    submitted: number;      // 当日提交笔数（**尝试**数：被拒也占额度，否则拒单会变成无限刷单）
    accepted: number;       // 当日被接受的笔数（失败/被拒不计数）
    lastTick: number;       // 上次决策尝试的 tick（节流①）
    lastResult: string;     // accepted | rejected | error | skip | idle
    lastError: string | null;
}

interface BotEntry {
    def: BotDef;
    userId: string;
}

@Injectable()
export class BotPlayerService {
    private readonly logger = new Logger(BotPlayerService.name);

    // 名册与运行状态（内存 Map：游戏内可重建，不做持久化——机器人身份由 username 决定，重启后同名复用）
    private bots: BotEntry[] = [];
    private states = new Map<string, BotState>();
    private seasonDay = new Map<string, number>();   // userId → 上次赛季报名尝试的游戏日
    private dayAnchors = new Map<string, number>();  // `${day}|${symbol}` → 当日首次观测价
    private anchorDay = -1;
    // 名册开通结果（并发/重入合并用）；泛型与 ensureRoster 的返回一致——写成 Promise<void> 会让
    // 调用方拿到 void，编译期即报 TS2322（名册统计信息是冒烟断言要用的，不能丢）
    private rosterPromise: Promise<{ created: number; accounts: number; total: number }> | null = null;
    private rosterReady = false;
    private rosterSummary: { created: number; accounts: number; total: number } = { created: 0, accounts: 0, total: 0 };
    private rosterLogged = false;
    private rosterRetryTick = -1;
    private lastDecision: any = null;
    private warnedNoOrderService = false;

    constructor(
        // 全部 @Optional()：单测直接 new BotPlayerService(fakeUserRepo, fakeAccountRepo, fakeOrderService)；
        // OrderService/SeasonService 标 @Optional() 是为了避免 bots ↔ trading/season 的模块循环依赖
        // （与 market-data.service 的 @Optional() engine 同一手法），按类类型解析，宿主模块直接注入即可
        @Optional() @InjectRepository(User) private readonly userRepo?: Repository<User>,
        @Optional() @InjectRepository(Account) private readonly accountRepo?: Repository<Account>,
        @Optional() private readonly orderService?: OrderService,
        @Optional() private readonly seasonService?: SeasonService,
    ) {}

    // 回调注入：机器人只通过宿主给的 getSymbols/getPrice 观察行情，不读行情服务内部状态
    configure(opts: BotCallbacks) {
        const o = opts || {};
        this.getSymbols = typeof o.getSymbols === 'function' ? o.getSymbols : this.getSymbols;
        this.getPrice = typeof o.getPrice === 'function' ? o.getPrice : this.getPrice;
        this.getDayOpen = typeof o.getDayOpen === 'function' ? o.getDayOpen : this.getDayOpen;
        if (o.orderService)
            this.configuredOrderService = o.orderService;
        if (o.seasonService)
            this.configuredSeasonService = o.seasonService;
    }

    private configuredOrderService?: any;
    private configuredSeasonService?: any;

    private getSymbols?: (market?: string) => string[];
    private getPrice?: (symbol: string) => number | undefined;
    private getDayOpen?: (symbol: string) => number | undefined;

    // ─── 环境变量（每次调用现读：主 agent/单测可在运行期改 env，无需重启）───
    private settings() {
        return {
            // 与项目既有 DB_SYNCHRONIZE 口径一致：仅字符串严格等于 'false' 才关闭（'0'/'no'/'off' 均视为开启）
            enabled: String(process.env.BOT_PLAYERS_ENABLED) !== 'false',
            count: intEnv(process.env.BOT_PLAYERS_COUNT, 6, 0, BOT_MAX_COUNT),
            everyTicks: intEnv(process.env.BOT_PLAYERS_TRADE_EVERY_TICKS, 10, 1, 1000),
            maxPerDay: intEnv(process.env.BOT_PLAYERS_MAX_ORDERS_PER_DAY, 12, 0, 200),
        };
    }

    // ─── A. 名册幂等开通 ───────────────────────────────────────────────
    // 幂等：用户按 username 查存在性、账户按 (userId, marketMode) 逐个补齐——
    // 重启重复调用不新增，且"上次跑到一半失败"的残留（有用户缺账户）也能自愈。
    async ensureRoster(count?: number): Promise<{ created: number; accounts: number; total: number }> {
        const cfg = this.settings();
        if (!cfg.enabled)
            return { created: 0, accounts: 0, total: 0 };
        // 并发/重入合并：tick 与启动可能同时触发，重复插入会撞 unique(userId, marketMode)
        if (this.rosterPromise)
            return this.rosterPromise;
        // 已完成扫描的名册直接返回缓存：主 agent 若在 tick 内无条件调用 ensureRoster()，
        // 不应每 tick 都打 3×3 次库；显式传 count（或上次失败）仍会重新扫描并补齐缺失账户
        if (this.rosterReady && count === undefined)
            return this.rosterSummary;
        const target = Number.isFinite(Number(count)) ? Number(count) : cfg.count;
        this.rosterPromise = this.buildRoster(target)
            .then((res) => {
                // 显式调用过 ensureRoster（含主 agent 在 tick 内首次调用）即视为名册已就绪：
                // 后续 tick 的懒路径不再按环境变量重建名册（否则手工指定过 count 的场景会被 env 覆盖缩容）
                this.rosterReady = true;
                this.rosterRetryTick = -1;
                this.rosterSummary = res;
                return res;
            })
            .finally(() => { this.rosterPromise = null; });
        return this.rosterPromise;
    }

    private async buildRoster(count: number): Promise<{ created: number; accounts: number; total: number }> {
        const defs = buildRosterDefs(count);
        if (!this.userRepo || !this.accountRepo) {
            // 仓储缺失（模块未正确装配）不应让游戏起不来：降级为"无名册"，只告警一次
            this.logger.warn('机器人名册未开通：User/Account 仓储未注入（检查 BotModule 装配）');
            return { created: 0, accounts: 0, total: 0 };
        }
        let created = 0, accounts = 0;
        const entries: BotEntry[] = [];
        for (const def of defs) {
            let user = await this.userRepo.findOne({ where: { username: def.username } });
            if (!user) {
                // 密码 = 32 字节随机数的 bcrypt 哈希：机器人从不登录，随机口令让该账号无法被冒用登录；
                // 明文只存在于本函数栈内（不落库、不落日志、不进任何断言），与真人密码同等加密强度
                const hashed = await bcrypt.hash(randomBytes(32).toString('hex'), 10);
                user = await this.userRepo.save(this.userRepo.create({
                    username: def.username,
                    password: hashed,
                    role: UserRole.USER,
                    isActive: true,
                    isBot: true,
                }));
                created++;
            }
            else if (user.isBot !== true)
                // 与真人重名（极小概率）：绝不改写他人密码/标记，只复用并告警
                this.logger.warn(`机器人用户名 ${def.username} 已被非机器人账号占用，请改名册前缀`);
            const userId = user.id;
            for (const mode of BOT_MARKETS) {
                const existing = await this.accountRepo.findOne({ where: { userId, marketMode: mode } });
                if (existing)
                    continue;
                // 开户数值与 AuthService.register() 同口径（复用 RISK.initialCash），否则净值基准不可比
                await this.accountRepo.save(this.accountRepo.create({
                    userId,
                    marketMode: mode,
                    cash: RISK.initialCash,
                    totalEquity: RISK.initialCash,
                    peakEquity: RISK.initialCash,
                    initialEquity: RISK.initialCash,
                    dayStartEquity: RISK.initialCash,
                }));
                accounts++;
            }
            entries.push({ def, userId });
        }
        this.bots = entries;
        // 只在"首次开通/确实有变更"时打印：主 agent 若每 tick 调 ensureRoster()，不该把日志刷满
        if (created > 0 || accounts > 0 || !this.rosterLogged) {
            this.rosterLogged = true;
            this.logger.log(`机器人名册就绪：${entries.length} 个（新建用户 ${created}，补建账户 ${accounts}）`);
        }
        return { created, accounts, total: entries.length };
    }

    // 首次调用时才建名册（懒启动）：避免污染单测与启动冒烟
    private async ensureRosterIfNeeded(tick: number) {
        const cfg = this.settings();
        if (!cfg.enabled || this.rosterReady)
            return;
        // 失败退避：DB 抖动时不要每个 tick 重试（否则日志被刷爆、且每 tick 都打一次库）
        if (this.rosterRetryTick >= 0 && tick - this.rosterRetryTick < 100)
            return;
        try {
            await this.ensureRoster();
        }
        catch (e) {
            this.rosterRetryTick = tick;
            this.logger.warn(`机器人名册开通失败（100 tick 内不再重试，本 tick 跳过机器人）: ${errMsg(e)}`);
        }
    }

    // ─── B. 每 tick 交易（真实委托）─────────────────────────────────────
    async runTick(ctx: BotTickContext): Promise<{ processed: number; submitted: number }> {
        const cfg = this.settings();
        const idle = { processed: 0, submitted: 0 };
        if (!cfg.enabled)
            return idle;
        const day = Number(ctx && ctx.gameDay) || 0;
        const tick = Number(ctx && ctx.tick) || 0;
        // 主战场固定 A 股；其余市场仅在名册层开了账户，交易路径保留接口但不启用
        const market = String((ctx && ctx.market) || BOT_PRIMARY_MARKET).toUpperCase();
        if (market !== BOT_PRIMARY_MARKET)
            return idle;
        await this.ensureRosterIfNeeded(tick);
        if (this.bots.length === 0)
            return idle;
        // 跨游戏日：清空日内基准价缓存（内存 Map 跨日自动重置，不随游戏日无限增长）
        if (this.anchorDay !== day) {
            this.dayAnchors.clear();
            this.anchorDay = day;
        }
        const symbols = this.safeSymbols(market);
        if (symbols.length === 0)
            return idle;
        // 报价/日内基准每 tick 构建一次（所有机器人共用同一份视图 → 同一 tick 内决策依据一致）
        const view = this.marketView(symbols, day);
        // 全市场无有效报价（开市前/集体停牌/行情未就绪）：本 tick 没有任何决策依据，整轮跳过
        if (view.prices.size === 0)
            return idle;
        let processed = 0, submitted = 0;
        for (const entry of this.bots) {
            try {
                if (await this.runBotTick(entry, day, tick, market, symbols, view, cfg))
                    submitted++;
                processed++;
            }
            catch (e) {
                // 单机器人异常必须隔离：机器人在 tick 内是旁路，绝不能让一台假人拖停整个行情
                this.logger.warn(`机器人 ${entry.def.id} 本 tick 处理异常（已隔离，行情继续）: ${errMsg(e)}`);
            }
        }
        return { processed, submitted };
    }

    // 返回 true = 本 tick 真的向 OrderService 提交了一笔委托
    private async runBotTick(entry: BotEntry, day: number, tick: number, market: string, symbols: string[], view: { prices: Map<string, number>; dayOpens: Map<string, number> }, cfg: { everyTicks: number; maxPerDay: number }): Promise<boolean> {
        const { def, userId } = entry;
        const state = this.stateOf(def, userId);
        if (state.day !== day) {
            // 跨游戏日重置：日额度与节流窗口都必须清零，否则新的一天机器人会因"昨日额度用尽"而集体罢工
            state.day = day;
            state.submitted = 0;
            state.accepted = 0;
            state.lastTick = -Infinity;
        }
        // C. 赛季报名：每游戏日至多一次（放在节流之前——报名是低频运营动作，不受交易闸门影响）
        await this.ensureSeasonEnrollment(userId, day);
        // 节流①：每 N tick 至多一次决策尝试（快档下 N=1 时退化为每 tick 都能决策）
        if (Number.isFinite(state.lastTick) && tick - state.lastTick < cfg.everyTicks)
            return false;
        state.lastTick = tick;
        // 节流②：每游戏日提交上限。被拒的单也占额度——否则"必被拒的委托"会让机器人整日刷单
        if (cfg.maxPerDay <= 0 || state.submitted >= cfg.maxPerDay)
            return false;
        // DI 注入优先，configure() 逃生舱兜底（任一可用即可交易）
        const order = this.orderService || this.configuredOrderService;
        if (!order || typeof order.placeOrder !== 'function') {
            if (!this.warnedNoOrderService) {
                this.warnedNoOrderService = true;
                this.logger.warn('机器人无法交易：OrderService 未注入（BotPlayerService 需宿主模块注入 OrderService）');
            }
            return false;
        }
        if (!this.accountRepo)
            return false;
        // 账户读取失败（DB 抖动）由 runTick 统一兜住；这里只处理"账户不存在"的正常路径
        const account = await this.accountRepo.findOne({ where: { userId, marketMode: market }, relations: ['positions'] });
        if (!account) {
            state.lastResult = 'skip';
            state.lastError = '账户不存在';
            return false;
        }
        const intent = planBotIntent({
            def,
            gameDay: day,
            tick,
            symbols,
            prices: view.prices,
            dayOpens: view.dayOpens,
            cash: Number(account.cash) || 0,
            positions: positionMap(account),
        });
        if (!intent) {
            state.lastResult = 'skip';
            return false;
        }
        // 占额度先于下单：无论成交/被拒都算一次"提交"，保证日额度是硬上限
        state.submitted++;
        const snapshot = {
            gameDay: day, tick, botId: def.id, username: def.username, market,
            symbol: intent.symbol, side: intent.side, type: intent.type,
            quantity: intent.quantity, price: intent.price,
        };
        let res: any;
        try {
            // 与真人完全同一条路径：休市/涨跌停/购买力/T+1/费用全部由既有链路校验，本层不复制任何规则
            res = await order.placeOrder(userId, market, intent.symbol, intent.type, intent.side, intent.quantity, intent.price, 0, 0);
        }
        catch (e) {
            const business = isBusinessReject(e);
            state.lastResult = business ? 'rejected' : 'error';
            state.lastError = errMsg(e);
            this.lastDecision = { ...snapshot, outcome: state.lastResult, error: state.lastError };
            // 拒绝是机器人的正常遭遇（休市/涨跌停/资金不足），debug 即可；真正的异常才 warn
            if (business)
                this.logger.debug(`机器人 ${def.id} 委托被拒（正常现象，不重试）: ${state.lastError}`);
            else
                this.logger.warn(`机器人 ${def.id} 下单异常（已隔离）: ${state.lastError}`);
            return true; // 已提交：计入当日额度，但不算成功单
        }
        if (res && res.success === false) {
            state.lastResult = 'rejected';
            state.lastError = String(res.error || '委托被拒');
            this.lastDecision = { ...snapshot, outcome: 'rejected', error: state.lastError };
            this.logger.debug(`机器人 ${def.id} 委托被拒（正常现象，不重试）: ${state.lastError}`);
            return true;
        }
        // 市价单返回 settle（无 success 字段）也算受理：只有显式 success:false 才视作被拒
        state.accepted++;
        state.lastResult = 'accepted';
        state.lastError = null;
        this.lastDecision = { ...snapshot, outcome: 'accepted' };
        return true;
    }

    // ─── C. 赛季报名（每游戏日至多一次）──────────────────────────────────
    // 返回 true = 本游戏日确实尝试过报名。失败（赛季未开放/已开赛/接口异常）只 debug，不影响交易。
    //
    // ⚠️ 默认**关闭**（BOT_PLAYERS_SEASON_ENROLL 未设为 'true' 时不报名），原因是集成验证时实测到的副作用：
    //  SeasonService.enroll() 的**首个**报名者会把赛季从 ENROLLING 直接推进为 RUNNING 并定格 anchorDay
    //  （见 season.service.ts 的报名实现）——机器人抢先报名 = 替全体真人提前开赛、关掉真人报名窗口。
    //  冒烟日志实证：6 个机器人同时报名 → 第 1 个成功开赛，其余 5 个收到"当前赛季已开赛，报名已截止"。
    //  同台竞技不需要机器人来"起跑"：全服排行榜本来就是人机同榜；赛季要等"真人先报"的判定做好再打开。
    async ensureSeasonEnrollment(userId: string, gameDay?: number): Promise<boolean> {
        if (String(process.env.BOT_PLAYERS_SEASON_ENROLL) !== 'true')
            return false; // 默认关闭（见上方副作用说明）；比赛用车不抢发令枪
        const svc = this.seasonService || this.configuredSeasonService;
        if (!userId || !svc || typeof svc.enroll !== 'function')
            return false;
        const day = Number.isFinite(Number(gameDay)) ? Number(gameDay) : this.anchorDay;
        if (this.seasonDay.get(userId) === day)
            return false;
        // 先记日期再 await：失败也不在同一游戏日内重试，避免每 tick 打一次赛季接口
        this.seasonDay.set(userId, day);
        try {
            const res = await svc.enroll(userId);
            if (res && res.success === false)
                this.logger.debug(`机器人 ${userId} 赛季报名未成功（赛季未开放/已开赛）: ${res.error || ''}`);
        }
        catch (e) {
            this.logger.debug(`机器人 ${userId} 赛季报名异常（已忽略，不影响交易）: ${errMsg(e)}`);
        }
        return true;
    }

    // ─── 只读快照（供主 agent 冒烟断言）─────────────────────────────────
    getState() {
        const cfg = this.settings();
        return {
            enabled: cfg.enabled,
            rosterSize: this.bots.length,
            tradeEveryTicks: cfg.everyTicks,
            maxOrdersPerDay: cfg.maxPerDay,
            market: BOT_PRIMARY_MARKET,
            bots: this.bots.map(({ def, userId }) => {
                const s = this.stateOf(def, userId);
                return {
                    id: s.id, username: s.username, userId: s.userId, strategy: s.strategy, market: s.market,
                    day: s.day, submitted: s.submitted, accepted: s.accepted,
                    lastResult: s.lastResult, lastError: s.lastError,
                };
            }),
            lastDecision: this.lastDecision ? { ...this.lastDecision } : null,
        };
    }

    private stateOf(def: BotDef, userId: string): BotState {
        // 名册重建（重复 ensureRoster）不得丢掉当日计数：按 id 复用状态对象
        let s = this.states.get(def.id);
        if (!s) {
            s = {
                id: def.id, username: def.username, userId, strategy: def.strategy, market: def.market,
                day: -1, submitted: 0, accepted: 0, lastTick: -Infinity, lastResult: 'idle', lastError: null,
            };
            this.states.set(def.id, s);
        }
        s.userId = userId;
        return s;
    }

    private safeSymbols(market: string): string[] {
        try {
            const out = this.getSymbols ? this.getSymbols(market) : null;
            return Array.isArray(out) ? out.filter((s) => typeof s === 'string' && s.length > 0) : [];
        }
        catch (e) {
            this.logger.warn(`机器人取股票池失败（本 tick 跳过）: ${errMsg(e)}`);
            return [];
        }
    }

    private priceOf(symbol: string): number | undefined {
        try {
            const p = Number(this.getPrice ? this.getPrice(symbol) : NaN);
            return Number.isFinite(p) && p > 0 ? p : undefined;
        }
        catch (e) {
            return undefined;
        }
    }

    // 本 tick 的行情视图：报价 + 日内基准。基准优先取注入的 getDayOpen（= 行情引擎 dayOpen）；
    // 未注入时退化为「当日首次观测价」——同一 tick 序列必然得到同一基准（可复现，不依赖时钟）
    private marketView(symbols: string[], day: number) {
        const prices = new Map<string, number>();
        const dayOpens = new Map<string, number>();
        for (const s of symbols) {
            const p = this.priceOf(s);
            if (p === undefined)
                continue;
            prices.set(s, p);
            const key = `${day}|${s}`;
            const seen = this.dayAnchors.get(key);
            if (seen === undefined)
                this.dayAnchors.set(key, p);
            // 日内基准优先用注入的 getDayOpen；缺注入时退化为当日首次观测价（确定性，不依赖时钟）
            dayOpens.set(s, this.dayOpenOf(s) ?? seen ?? p);
        }
        return { prices, dayOpens };
    }

    private dayOpenOf(symbol: string): number | undefined {
        if (!this.getDayOpen)
            return undefined;
        try {
            const v = Number(this.getDayOpen(symbol));
            return Number.isFinite(v) && v > 0 ? v : undefined;
        }
        catch (e) {
            return undefined;
        }
    }
}

// 持仓视图：可卖量按 T+1 口径估算（持仓 − 当日买入）；最终裁定仍由 OrderService/引擎完成
function positionMap(account: any): Map<string, BotPositionView> {
    const out = new Map<string, BotPositionView>();
    const list = Array.isArray(account && account.positions) ? account.positions : [];
    for (const p of list) {
        if (!p || !p.symbol)
            continue;
        const qty = Math.max(0, Number(p.longQty) || 0);
        const sellable = Math.max(0, qty - Math.max(0, Number(p.boughtToday) || 0));
        out.set(String(p.symbol), { qty, sellable, cost: Number(p.longCost) || 0 });
    }
    return out;
}

// 业务性拒绝（4xx：休市/涨跌停/资金不足/T+1/账户不存在）与真正的故障区分开——
// 前者是机器人的日常，debug 级；后者要 warn 出来让人查
function isBusinessReject(e: any): boolean {
    const status = e instanceof HttpException ? e.getStatus() : Number((e && e.status) || 0);
    return status >= 400 && status < 500;
}

function errMsg(e: any): string {
    return e && e.message ? String(e.message) : String(e);
}

// 环境变量整数解析：未设置/空/非数字 → 默认值；'0' 是合法值（如 BOT_PLAYERS_COUNT=0 表示不建机器人），
// 不能用 `Number(x) || d` 这种写法把 0 吞掉
function intEnv(raw: any, dflt: number, lo: number, hi: number): number {
    const text = raw === undefined || raw === null ? '' : String(raw).trim();
    const n = text === '' ? NaN : Number(text);
    const v = Number.isFinite(n) ? Math.floor(n) : dflt;
    return Math.min(Math.max(v, lo), hi);
}
