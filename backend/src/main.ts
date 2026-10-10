import core_1 = require("@nestjs/core");

import common_1 = require("@nestjs/common");

import config_1 = require("@nestjs/config");

import typeorm_1 = require("typeorm");

const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
import app_module_1 = require("./app.module");
import { formBodyMiddleware } from "./modules/identity/oauth-form";

// G-5: 进程级异常兜底（排障用）。
// 背景：之前既没有 unhandledRejection 也没有 uncaughtException 处理器——一旦某处 async 抛出而没人 await，
// Node 会**直接结束进程**，控制台里只剩半截日志（用户看到的就是"忽然没了/忽然不动了"，无从下手）。
// 现在统一记录：事件类型 + 原因 + 完整堆栈 + 常驻内存快照，并且**保持进程存活**
// （对游戏服务器来说，"少一个 tick" 远好于 "整场停摆"；看门狗会把卡住的 tick 捞回来）。
function logProcessFault(kind) {
    return (err) => {
        const logger = new common_1.Logger('ProcessFault');
        const reason = err && err.stack ? err.stack : (err && err.message ? err.message : String(err));
        const mem = process.memoryUsage();
        logger.error(`[${kind}] ${reason}\n`
            + `  heapUsed=${Math.round(mem.heapUsed / 1048576)}MB heapTotal=${Math.round(mem.heapTotal / 1048576)}MB`
            + ` rss=${Math.round(mem.rss / 1048576)}MB external=${Math.round(mem.external / 1048576)}MB`
            + ` uptime=${Math.round(process.uptime())}s node=${process.version}`);
    };
}
process.on('unhandledRejection', logProcessFault('未处理的 Promise 拒绝'));
process.on('uncaughtException', logProcessFault('未捕获异常'));
import stock_entity_1 = require("./infrastructure/database/entities/stock.entity");

import constants_1 = require("./common/constants");

import swagger_1 = require("@nestjs/swagger");

async function autoSeed(ds) {
    const logger = new common_1.Logger('Seed');
    const stockRepo = ds.getRepository(stock_entity_1.Stock);
    // SECURITY(C2): 管理员账号由 AuthService.onModuleInit 统一创建（密码从环境变量读取），此处不再硬编码
    for (const cfg of constants_1.STOCK_POOL) {
        if (!(await stockRepo.findOne({ where: { symbol: cfg.symbol } }))) {
            await stockRepo.save(stockRepo.create({ symbol: cfg.symbol, name: cfg.name, initialPrice: cfg.initialPrice, mu: cfg.mu, sigma: cfg.sigma, theta: cfg.theta }));
            logger.log(`股票已创建: ${cfg.symbol} ${cfg.name}`);
        }
    }
}
async function bootstrap() {
    // bodyParser: false —— 关掉 Nest 自带的 body 解析器，下面按「json → 表单体」自己装（顺序可控）。
    // 原因：OAuth 令牌端点必须收 application/x-www-form-urlencoded（RFC 6749 §4.1.3），
    // 而 Nest 默认那套在本应用里收不到表单体（流被消费、req.body 变空对象，端点表现成"参数全缺"）。
    // 关掉之后流的归属完全确定，不会再出现这种静默失败。JSON 解析器随后照旧装上，既有端点不受影响。
    const app = await core_1.NestFactory.create(app_module_1.AppModule, { bodyParser: false });
    const logger = new common_1.Logger('Bootstrap');
    const config = app.get(config_1.ConfigService);
    try {
        const ds = app.get(typeorm_1.DataSource);
        await autoSeed(ds);
    }
    catch (e) {
        logger.warn('种子数据初始化跳过（数据库可能未就绪）');
    }
    app.setGlobalPrefix('api');
    // 安全响应头。2026-10-08：默认 helmet() 会给每个响应加 `Cross-Origin-Resource-Policy: same-origin`
    // 与 `Content-Security-Policy: connect-src 'self'` —— 这两条会把**跨源的 API 调用**全部拦死：
    // 门户的 GitHub Pages 镜像、本机前后端分端口开发都靠跨源调 /api。被拦时浏览器只报
    // "TypeError: Failed to fetch"，看一眼像网络挂了，实际是响应头。
    // 所以这里保留其它安全头（nosniff / frameguard / referrer-policy / HSTS…），
    // 只放开"资源可被跨源读取"与"允许跨源 fetch"，并允许通过环境变量加白名单。
    const extraOrigins = String(process.env.CORS_ORIGIN || '')
        .split(',').map((s) => s.trim()).filter(Boolean);
    app.use(helmet({
        crossOriginResourcePolicy: { policy: 'cross-origin' },
        // HSTS 只在生产开：它会把浏览器对**这个主机**的 http 请求永久升级成 https，
        // 本机开发（http://127.0.0.1:8099）一旦收到这个头，之后浏览器直接报 ERR_SSL_PROTOCOL_ERROR，
        // 而且清不掉（浏览器记 31536000 秒）。线上由 nginx 也有 HSTS，这里保留生产开关。
        strictTransportSecurity: process.env.NODE_ENV === 'production'
            ? { maxAge: 31536000, includeSubDomains: true }
            : false,
        contentSecurityPolicy: {
            useDefaults: true,
            directives: {
                // 默认 null = 保留 helmet 的 default-src 'self'（本站页面自身的脚本/样式策略不变）
                'connect-src': process.env.CSP_CONNECT_SRC
                    ? ["'self'", ...String(process.env.CSP_CONNECT_SRC).split(',').map((s) => s.trim()).filter(Boolean)]
                    : null,
            },
        },
    }));
    // Central transport policy; keep saves' quota reachable without relaxing other routes.
    const { installJsonBodies } = require('./infrastructure/http/json-body');
    installJsonBodies(app);
    // 表单体（application/x-www-form-urlencoded）由自己的解析器收：见 oauth-form.ts 的注释。
    // json 在前、表单在后，两者类型互斥，顺序不影响既有端点。
    app.use(formBodyMiddleware);
    // 登录/注册频率限制：每 IP 每分钟最多 10 次
    // 2026-09-28 收窄：原来挂在 /api/auth 全前缀，会把 identity 模块的 verify（点邮件链接）与
    // GitHub 回调一起限住——用户在同一个 NAT 下点几下链接就 429。只限"确实要防爆破"的写入口。
    const authLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 10,
        message: { statusCode: 429, message: '请求过于频繁，请稍后再试' },
        standardHeaders: true,
        legacyHeaders: false,
    });
    app.use([
        '/api/auth/login',
        '/api/auth/register',
        '/api/auth/site-link',
        '/api/auth/site-session',
        '/api/auth/identity/login',
        '/api/auth/identity/register',
        '/api/auth/identity/password/reset-request',
        '/api/auth/identity/password/reset',
    ], authLimiter);
    // Phase D: /market/backtest 为无认证公共计算接口（逐根 K 线跑策略），单 IP 限流防滥用；
    // app.use 匹配原始请求路径（含 /api 前缀），与上方 authLimiter 同款先例
    const backtestLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 20,
        message: { statusCode: 429, message: '请求过于频繁，请稍后再试' },
        standardHeaders: true,
        legacyHeaders: false,
    });
    app.use('/api/market/backtest', backtestLimiter);
    app.useGlobalPipes(new common_1.ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
    }));
    const corsOrigin = config.get('CORS_ORIGIN');
    let corsOrigins = ['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:3000'];
    if (corsOrigin) {
        corsOrigins = corsOrigin.split(',').map((s) => s.trim());
    }
    // SECURITY(H): 信任代理层数（默认 0=直连；部署在反向代理后请设 TRUST_PROXY=1，否则限流/日志拿到的是代理 IP）
    app.getHttpAdapter().getInstance().set('trust proxy', Number(config.get('TRUST_PROXY', '0')) || 0);
    app.enableCors({
        origin: corsOrigins,
        credentials: true,
    });
    const port = config.get('PORT', 8000);
    // P5 工程化：Swagger API 文档（/api/docs）仅 development 环境挂载（生产不暴露接口清单与 schema）
    if (process.env.NODE_ENV === 'development') {
        try {
            const swaggerConfig = new swagger_1.DocumentBuilder()
                .setTitle('StockSim Pro API')
                .setDescription('模拟炒股平台接口文档：行情/交易/账户/量化接入（模拟数据仅供学习，不构成投资建议）')
                .setVersion('0.2.0')
                .addBearerAuth()
                .build();
            const document = swagger_1.SwaggerModule.createDocument(app, swaggerConfig);
            swagger_1.SwaggerModule.setup('api/docs', app, document);
        }
        catch (e) {
            logger.warn('Swagger 文档初始化失败: ' + (e && e.message ? e.message : e));
        }
    }
    await app.listen(port);
    logger.log(`应用已启动: http://localhost:${port}/api`);
    // ─── FIX(G): sql.js 持久化（autoSave 已关闭，改为定时全库导出 + 原子落盘）───
    const fs = require('fs');
    const path = require('path');
    const ds = app.get(typeorm_1.DataSource);
    const dbPath = config.get('SQLITE_PATH', './data/stockgame.db');
    // P0: better-sqlite3 启动时启用 WAL + busy_timeout（sqljs 内存库下该 PRAGMA 返回 memory，无害）
    try {
        await ds.query('PRAGMA journal_mode = WAL');
        await ds.query('PRAGMA busy_timeout = 5000');
        await ds.query('PRAGMA synchronous = NORMAL');
    }
    catch (e) {
        logger.warn('SQLite PRAGMA 初始化跳过: ' + (e && e.message ? e.message : e));
    }
    const persistDatabase = () => {
        try {
            const conn = ds && ds.driver ? (ds.driver as any).databaseConnection : null; // sqljs 专有字段（类型未声明），用 as any 访问
            if (!conn || typeof conn.export !== 'function')
                return; // 非 sqljs 数据源（如 postgres）无需此持久化
            const dir = path.dirname(dbPath);
            if (!fs.existsSync(dir))
                fs.mkdirSync(dir, { recursive: true });
            const data = Buffer.from(conn.export());
            // 先写同目录临时文件再 rename 原子替换，避免写一半损坏库文件
            const tmpPath = dbPath + '.tmp';
            fs.writeFileSync(tmpPath, data);
            fs.renameSync(tmpPath, dbPath);
        }
        catch (e) {
            logger.warn('数据库持久化失败: ' + (e && e.message ? e.message : e));
        }
    };
    setInterval(() => persistDatabase(), 60 * 1000);
    // 进程退出前同步写盘一次（beforeExit 只能使用同步 API）
    process.on('beforeExit', () => persistDatabase());
}
bootstrap();
