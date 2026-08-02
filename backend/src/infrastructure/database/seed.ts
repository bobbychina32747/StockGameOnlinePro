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
    const existingAdmin = await userRepo.findOne({ where: { username: 'admin' } });
    if (!existingAdmin) {
        const hashed = await bcrypt.hash('admin123', 10);
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
        console.log('[Seed] 管理员账号已创建: admin / admin123');
    }
    else {
        console.log('[Seed] 管理员账号已存在');
    }
    const existingDemo = await userRepo.findOne({ where: { username: 'demo' } });
    if (!existingDemo) {
        const hashed = await bcrypt.hash('demo123', 10);
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
        console.log('[Seed] 演示用户已创建: demo / demo123');
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


