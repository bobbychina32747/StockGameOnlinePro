import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { User } from './entities/user.entity';
import { Account } from './entities/account.entity';
import { Position } from './entities/position.entity';
import { Order } from './entities/order.entity';
import { Transaction } from './entities/transaction.entity';
import { Kline } from './entities/kline.entity';
import { Stock } from './entities/stock.entity';
import { DailySnapshot } from './entities/daily-snapshot.entity';
import { FundHolding } from './entities/fund-holding.entity';

// Phase A: 分红事件/快照 + 重置审计（防套利与刷钱可追溯）
import { DividendEvent } from './entities/dividend-event.entity';
import { DividendSnapshot } from './entities/dividend-snapshot.entity';
import { ResetAuditLog } from './entities/reset-audit-log.entity';

// Phase C: 成就服务端化
import { Achievement } from './entities/achievement.entity';

// Phase C: 模拟大赛赛季
import { Season } from './entities/season.entity';
import { SeasonEntry } from './entities/season-entry.entity';

@Global()
@Module({
    imports: [
        TypeOrmModule.forFeature([
            User, Account, Position, Order,
            Transaction, Kline, Stock, DailySnapshot,
            FundHolding,
            DividendEvent, DividendSnapshot, ResetAuditLog,
            Achievement,
            Season, SeasonEntry,
        ]),
    ],
    exports: [TypeOrmModule],
})
export class DatabaseModule {}
