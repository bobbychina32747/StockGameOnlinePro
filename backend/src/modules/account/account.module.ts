import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Account } from '../../infrastructure/database/entities/account.entity';
import { Position } from '../../infrastructure/database/entities/position.entity';
import { Transaction } from '../../infrastructure/database/entities/transaction.entity';

// Phase A: 重置防刷钱——基金持仓/未成交挂单一票否决 + 审计
import { FundHolding } from '../../infrastructure/database/entities/fund-holding.entity';
import { Order } from '../../infrastructure/database/entities/order.entity';
import { ResetAuditLog } from '../../infrastructure/database/entities/reset-audit-log.entity';

// Phase C: 成就服务端化
import { Achievement } from '../../infrastructure/database/entities/achievement.entity';

// Phase C: 赛季中禁重置/划转（AccountService 注入 SeasonService）
import { SeasonModule } from '../season/season.module';

import { AccountController } from './account.controller';
import { AccountService } from './account.service';

@Module({
    imports: [TypeOrmModule.forFeature([Account, Position, Transaction, FundHolding, Order, ResetAuditLog, Achievement]), SeasonModule],
    controllers: [AccountController],
    providers: [AccountService],
    exports: [AccountService],
})
export class AccountModule {}
