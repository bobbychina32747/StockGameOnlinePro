import core_1 = require("@nestjs/core");

import common_1 = require("@nestjs/common");

import config_1 = require("@nestjs/config");

import typeorm_1 = require("typeorm");

import bcrypt = require("bcrypt");

const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
import app_module_1 = require("./app.module");

import user_entity_1 = require("./infrastructure/database/entities/user.entity");

import account_entity_1 = require("./infrastructure/database/entities/account.entity");

import stock_entity_1 = require("./infrastructure/database/entities/stock.entity");

import constants_1 = require("./common/constants");

async function autoSeed(ds) {
    const logger = new common_1.Logger('Seed');
    const userRepo = ds.getRepository(user_entity_1.User);
    const accountRepo = ds.getRepository(account_entity_1.Account);
    const stockRepo = ds.getRepository(stock_entity_1.Stock);
    if (!(await userRepo.findOne({ where: { username: 'Bobbychina' } }))) {
        const admin = userRepo.create({ username: 'Bobbychina', password: await bcrypt.hash('ThisIsTheBestProjectEver', 10), role: user_entity_1.UserRole.ADMIN });
        await userRepo.save(admin);
        for (const mode of ['US', 'CN']) {
            await accountRepo.save(accountRepo.create({ userId: admin.id, marketMode: mode, cash: constants_1.RISK.initialCash, totalEquity: constants_1.RISK.initialCash, peakEquity: constants_1.RISK.initialCash, initialEquity: constants_1.RISK.initialCash, dayStartEquity: constants_1.RISK.initialCash }));
        }
        logger.log('管理员已创建: Bobbychina / ThisIsTheBestProjectEver');
    }
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
    app.enableCors({
        origin: corsOrigins,
        credentials: true,
    });
    const port = config.get('PORT', 8000);
    await app.listen(port);
    logger.log(`应用已启动: http://localhost:${port}/api`);
}
bootstrap();


