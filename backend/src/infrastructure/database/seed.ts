import typeorm_1 = require("typeorm");

import bcrypt = require("bcrypt");

import user_entity_1 = require("./entities/user.entity");

import account_entity_1 = require("./entities/account.entity");

import stock_entity_1 = require("./entities/stock.entity");

import position_entity_1 = require("./entities/position.entity");

import order_entity_1 = require("./entities/order.entity");

import transaction_entity_1 = require("./entities/transaction.entity");

import kline_entity_1 = require("./entities/kline.entity");

import constants_1 = require("../../common/constants");

async function seed() {
    const ds = new typeorm_1.DataSource({
        type: 'sqljs',
        location: './data/stockgame.db',
        entities: [user_entity_1.User, account_entity_1.Account, stock_entity_1.Stock, position_entity_1.Position, order_entity_1.Order, transaction_entity_1.Transaction, kline_entity_1.Kline],
        synchronize: true,
    });
    await ds.initialize();
    console.log('[Seed] 数据库已连接');
    const userRepo = ds.getRepository(user_entity_1.User);
    const accountRepo = ds.getRepository(account_entity_1.Account);
    const stockRepo = ds.getRepository(stock_entity_1.Stock);
    // SECURITY(C2): 仅 development 环境允许回退默认密码（与 auth.service 逻辑一致）
    const isDev = process.env.NODE_ENV === 'development';
    const existingAdmin = await userRepo.findOne({ where: { username: 'admin' } });
    if (!existingAdmin) {
        // SECURITY(C2): 管理员密码从环境变量读取；仅 development 环境允许回退默认密码，否则要求强 ADMIN_PASSWORD（>=8位）
        const adminPassword = process.env.ADMIN_PASSWORD;
        const isStrong = !!adminPassword && adminPassword.length >= 8;
        if (!isStrong && !isDev) {
            console.error('[Seed] 当前环境（' + (process.env.NODE_ENV || '未设置') + '）未设置强 ADMIN_PASSWORD（>=8位），已跳过创建默认管理员');
        }
        else {
            const passwordToUse = isStrong ? adminPassword : 'admin123';
            const hashed = await bcrypt.hash(passwordToUse, 10);
            const admin = userRepo.create({
                username: 'admin',
                password: hashed,
                role: user_entity_1.UserRole.ADMIN,
            });
            await userRepo.save(admin);
            const account = accountRepo.create({
                userId: admin.id,
                cash: constants_1.RISK.initialCash,
                totalEquity: constants_1.RISK.initialCash,
                peakEquity: constants_1.RISK.initialCash,
                initialEquity: constants_1.RISK.initialCash,
                dayStartEquity: constants_1.RISK.initialCash,
            });
            await accountRepo.save(account);
            console.log('[Seed] 管理员账号已创建: admin');
        }
    }
    else {
        console.log('[Seed] 管理员账号已存在');
    }
    // 注：已存在的 admin 若密码较弱，此处不强制重置（避免影响既有会话），请运维手动轮换密码
    const existingDemo = await userRepo.findOne({ where: { username: 'demo' } });
    if (!existingDemo) {
        // SECURITY(C2): 仅 development 环境允许回退默认 demo 密码，其他环境必须设置 DEMO_PASSWORD
        const demoPassword = process.env.DEMO_PASSWORD;
        if (!demoPassword && !isDev) {
            console.error('[Seed] 当前环境（' + (process.env.NODE_ENV || '未设置') + '）未设置 DEMO_PASSWORD，已跳过创建演示账号');
        }
        else {
            const passwordToUse = demoPassword || 'demo123';
            const hashed = await bcrypt.hash(passwordToUse, 10);
            const demo = userRepo.create({
                username: 'demo',
                password: hashed,
                role: user_entity_1.UserRole.USER,
            });
            await userRepo.save(demo);
            const account = accountRepo.create({
                userId: demo.id,
                cash: constants_1.RISK.initialCash,
                totalEquity: constants_1.RISK.initialCash,
                peakEquity: constants_1.RISK.initialCash,
                initialEquity: constants_1.RISK.initialCash,
                dayStartEquity: constants_1.RISK.initialCash,
            });
            await accountRepo.save(account);
            console.log('[Seed] 演示用户已创建: demo');
        }
    }
    for (const cfg of constants_1.STOCK_POOL) {
        const existing = await stockRepo.findOne({ where: { symbol: cfg.symbol } });
        if (!existing) {
            const stock = stockRepo.create({
                symbol: cfg.symbol,
                name: cfg.name,
                initialPrice: cfg.initialPrice,
                mu: cfg.mu,
                sigma: cfg.sigma,
                theta: cfg.theta,
            });
            await stockRepo.save(stock);
            console.log(`[Seed] 股票已创建: ${cfg.symbol} ${cfg.name}`);
        }
    }
    await ds.destroy();
    console.log('[Seed] 完成！');
}
seed().catch((err) => {
    console.error('[Seed] 失败:', err.message);
    process.exit(1);
});


