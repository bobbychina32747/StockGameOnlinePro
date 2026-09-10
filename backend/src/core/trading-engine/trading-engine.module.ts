import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Order } from '../../infrastructure/database/entities/order.entity';
import { Account } from '../../infrastructure/database/entities/account.entity';
import { Position } from '../../infrastructure/database/entities/position.entity';
import { Transaction } from '../../infrastructure/database/entities/transaction.entity';

// Phase A: 分红登记日持仓快照
import { DividendSnapshot } from '../../infrastructure/database/entities/dividend-snapshot.entity';

import { TradingEngineService } from './trading-engine.service';

@Global()
@Module({
    imports: [TypeOrmModule.forFeature([Order, Account, Position, Transaction, DividendSnapshot])],
    providers: [TradingEngineService],
    exports: [TradingEngineService],
})
export class TradingEngineModule {}
