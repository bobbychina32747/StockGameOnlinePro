// Phase G-2 机器人玩家（算法盘假人）——策略层：纯函数、无 IO、无状态。
//
// 为什么复用 core/market-data/ai-opponents.ts 而不自己写一套：
// ① 随机数必须由 (gameDay, tick, botId, salt) 派生（agentRng）——否则同一 tick 重放会产出
//    不同决策序列，回放排查与冒烟断言全部失效（禁止 Math.random 参与决策）；
// ② 特征（aiFeatures）+ 策略信号 + 本地随机森林（decideDirection）是既有对手盘已调好的口径，
//    重写会让"机器人"与"AI 对手盘"在同一市场里出现两套打分标尺；
// ③ 但**不共用虚拟账本**：虚拟 AI 对手盘不落订单、不进排行榜，而机器人是真 users 行，
//    委托必须走 OrderService.placeOrder（见 bot-player.service.ts）。
import { agentRng, aiFeatures, clamp, decideDirection } from '../../core/market-data/ai-opponents';
import { OrderSide, OrderType } from '../../infrastructure/database/entities/order.entity';

// 名册名池：固定 20 个纯 ASCII 短名（`bot_<name>`），避免非 ASCII 用户名在日志/URL/终端里乱码。
export const BOT_NAME_POOL = [
    'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa',
    'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho', 'sigma', 'tau', 'upsilon',
];

// 名册上限：与环境变量 BOT_PLAYERS_COUNT 的钳制上界一致（超出部分按序号拼后缀，保证 username 唯一）
export const BOT_MAX_COUNT = 20;

// 策略轮换表：与 ai-opponents 的本地规则策略同名（trend/meanrev/momentum/herd/reversal/noise），
// 但姿态不同——机器人不追热点行业（hotFlag 恒 false），只按日内涨幅与自身持仓做决策。
const BOT_STRATEGY_POOL = ['trend', 'meanrev', 'momentum', 'herd', 'reversal', 'noise'];

export interface BotDef {
    id: string;
    username: string;
    name: string;
    strategy: string;
    market: string;         // 主战场市场：机器人固定用 A 股账户主战，其余市场仅保留接口
    activity: number;       // 决策响应率：闸门放行后仍以该概率观望（越小越懒）
    sizeCap: number;        // 单笔股数上限（防单笔巨额冲击）
    cashFraction: number;   // 单笔买入占可用现金比例（硬上限 0.5，见 planBotIntent）
    useStops: boolean;      // 是否启用止盈/止损（长线策略不设，避免被日内噪声反复打脸）
    takeProfit: number;
    stopLoss: number;
    gain: number;           // 策略信号增益（喂给 decideDirection）
}

export interface BotPositionView {
    qty: number;        // 持仓总量
    sellable: number;   // 可卖量（已扣当日买入，即 T+1 口径）
    cost: number;       // 持仓成本价
}

export interface BotPlanInput {
    def: BotDef;
    gameDay: number;
    tick: number;
    symbols: string[];
    prices: Map<string, number>;      // symbol → 最新价（由宿主注入的 getPrice 提供）
    dayOpens: Map<string, number>;    // symbol → 日内基准价（判断日内涨跌，喂 aiFeatures）
    cash: number;                     // 该市场账户可用现金
    positions: Map<string, BotPositionView>;
}

export interface BotIntent {
    symbol: string;
    side: OrderSide;      // 用订单实体枚举而不是裸字符串：与 OrderService.placeOrder 的契约逐一对应
    type: OrderType;
    quantity: number;
    price: number;
}

// 名册第 index 个机器人的人设（确定性：同一 index 恒等 → 名册重建不改变任何机器人性格）
export function botDefAt(index: number): BotDef {
    const i = Math.max(0, Math.floor(Number(index) || 0));
    const name = BOT_NAME_POOL[i % BOT_NAME_POOL.length];
    const round = Math.floor(i / BOT_NAME_POOL.length) + 1;
    const strategy = BOT_STRATEGY_POOL[i % BOT_STRATEGY_POOL.length];
    return {
        id: `bot${i + 1}`,
        username: i < BOT_NAME_POOL.length ? `bot_${name}` : `bot_${name}_${round}`,
        name,
        strategy,
        market: 'CN',
        // 人设差异：响应率/规模/仓位比例错开，让名册在同一市场里呈现不同活跃度（不是 6 个同样的假人）
        activity: clamp(0.22 + (i % 5) * 0.07, 0.05, 0.6),
        sizeCap: 200 + (i % 4) * 300,
        cashFraction: clamp(0.15 + (i % 4) * 0.1, 0.05, 0.5),
        useStops: strategy === 'momentum' || strategy === 'herd' || strategy === 'noise' || strategy === 'reversal',
        takeProfit: 0.05,
        stopLoss: -0.03,
        gain: 1 + ((i % 3) - 1) * 0.1,
    };
}

export function buildRosterDefs(count: number): BotDef[] {
    const total = Math.min(Math.max(Math.floor(Number(count) || 0), 0), BOT_MAX_COUNT);
    const defs: BotDef[] = [];
    for (let i = 0; i < total; i++)
        defs.push(botDefAt(i));
    return defs;
}

// 单 tick 决策：返回 null = 本 tick 观望（不产生任何委托）。
// 纯函数：输入相同 → 输出必相同（随机数全部来自 agentRng，无任何隐式状态/时钟/环境变量）。
export function planBotIntent(input: BotPlanInput): BotIntent | null {
    const def = input.def;
    const day = Number(input.gameDay) || 0;
    const tick = Number(input.tick) || 0;
    const symbols = Array.isArray(input.symbols) ? input.symbols : [];
    if (symbols.length === 0)
        return null;
    // ① 响应闸门：独立 salt（'act'）→ 后续任何分支新增/删减随机数都不会位移本闸门的序列
    if (agentRng(day, tick, def.id, 'act')() > def.activity)
        return null;
    // ② 选标的：先随机落点再确定性向后扫描，取第一个「有有效报价」的标的
    // （跳过停牌/无行情标的，而不是把无效价交给下游；扫描保持确定性，不引入新随机数）
    const start = Math.floor(agentRng(day, tick, def.id, 'pick')() * symbols.length) % symbols.length;
    let symbol = '';
    let price = 0;
    for (let k = 0; k < symbols.length; k++) {
        const s = symbols[(start + k) % symbols.length];
        const p = Number(input.prices.get(s));
        if (s && Number.isFinite(p) && p > 0) {
            symbol = s;
            price = p;
            break;
        }
    }
    if (!symbol)
        return null;
    // ③ 方向：日内涨幅 + 波动率喂给与虚拟对手盘同一套特征 → 策略信号 70% + 随机森林 30%
    // 缺日内基准时退化为当前价（ret=0 → 中性观望），绝不凭空造出方向
    const raw = Number(input.dayOpens.get(symbol));
    const dayOpen = Number.isFinite(raw) && raw > 0 ? raw : price;
    const feats = aiFeatures({ price, dayOpen }, 0, 'expansion', 0);
    let dir = decideDirection(def.strategy, feats, false, agentRng(day, tick, def.id, 'dir'), { gain: def.gain });
    // ④ 持仓止盈/止损 + 反向信号：判断基准是持仓成本价，与虚拟对手盘的行为树同口径
    const pos = input.positions.get(symbol) || null;
    const heldQty = pos ? Math.max(0, Number(pos.qty) || 0) : 0;
    const heldCost = pos ? Number(pos.cost) || 0 : 0;
    if (def.useStops && heldQty > 0 && heldCost > 0) {
        const pnl = (price - heldCost) / heldCost;
        if (pnl >= def.takeProfit || pnl <= def.stopLoss)
            dir = -1;
    }
    if (dir === 0)
        return null;
    if (dir > 0) {
        // 买入：单笔不超过可用现金的 50%（与人肉玩家的购买力校验同向，但更保守——
        // 机器人不参与融资，避免机器人替全体玩家加杠杆推高强平风险）
        const fraction = clamp(Number(def.cashFraction) || 0, 0, 0.5);
        const budget = Math.max(0, Number(input.cash) || 0) * fraction;
        const qty = Math.min(def.sizeCap, Math.floor(budget / price));
        if (qty <= 0)
            return null; // 现金不足一手价 → 观望（不制造必然被拒的委托）
        return buildIntent(def, day, tick, symbol, OrderSide.BUY, qty, price);
    }
    // 卖出：只卖可卖量（持仓 − 当日买入），最终仍由 OrderService/引擎做 T+1 与持仓校验
    const sellable = pos ? Math.max(0, Math.floor(Number(pos.sellable) || 0)) : 0;
    const qty = Math.min(def.sizeCap, sellable);
    if (qty <= 0)
        return null; // 无可卖持仓（含 T+1 锁定）→ 观望
    return buildIntent(def, day, tick, symbol, OrderSide.SELL, qty, price);
}

// 委托方式与报价：限价为主（进盘口排队，不立刻吃掉别人的流动性），偶尔市价（保证能成交）。
// 报价偏移 0.1%~0.6%：买单上浮/卖单下压以提高成交概率；**不做涨跌停带推算**——
// 越界的委托交给 OrderService/引擎按既有规则拒绝，避免本层与引擎的涨跌停口径分叉。
function buildIntent(def: BotDef, day: number, tick: number, symbol: string, side: OrderSide, quantity: number, refPrice: number): BotIntent {
    const type = agentRng(day, tick, def.id, 'route')() < 0.78 ? OrderType.LIMIT : OrderType.MARKET;
    const offset = clamp(0.001 + agentRng(day, tick, def.id, 'offset')() * 0.005, 0.001, 0.006);
    const raw = side === OrderSide.BUY ? refPrice * (1 + offset) : refPrice * (1 - offset);
    return {
        symbol,
        side,
        type,
        quantity: Math.max(1, Math.floor(quantity)),
        price: Math.max(0.01, Math.round(raw * 100) / 100),
    };
}
