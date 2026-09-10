import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Account } from '../../infrastructure/database/entities/account.entity';
import { Position } from '../../infrastructure/database/entities/position.entity';
import { DailySnapshot } from '../../infrastructure/database/entities/daily-snapshot.entity';
import { Transaction } from '../../infrastructure/database/entities/transaction.entity';

import { RiskManagerService } from './risk-manager.service';

@Global()
@Module({
    imports: [TypeOrmModule.forFeature([Account, Position, DailySnapshot, Transaction])],
    providers: [RiskManagerService],
    exports: [RiskManagerService],
})
export class RiskManagerModule {}
