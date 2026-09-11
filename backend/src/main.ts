import core_1 = require("@nestjs/core");

import common_1 = require("@nestjs/common");

import config_1 = require("@nestjs/config");

import typeorm_1 = require("typeorm");

const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
import app_module_1 = require("./app.module");

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
    const app = await core_1.NestFactory.create(app_module_1.AppModule);
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
    app.use(helmet());
    const express = require('express');
    app.use(express.json({ limit: '1mb' }));
    app.use(express.urlencoded({ limit: '1mb', extended: true }));
    // 登录/注册频率限制：每 IP 每分钟最多 10 次
    const authLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 10,
        message: { statusCode: 429, message: '请求过于频繁，请稍后再试' },
        standardHeaders: true,
        legacyHeaders: false,
    });
    app.use('/api/auth', authLimiter);
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


