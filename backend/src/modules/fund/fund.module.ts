import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Account } from '../../infrastructure/database/entities/account.entity';
import { FundHolding } from '../../infrastructure/database/entities/fund-holding.entity';

import { FundController } from './fund.controller';
import { FundService } from './fund.service';

// Phase C: 赛季中禁基金申购/赎回（FundService 注入 SeasonService）
import { SeasonModule } from '../season/season.module';

@Module({
    imports: [TypeOrmModule.forFeature([Account, FundHolding]), SeasonModule],
    controllers: [FundController],
    providers: [FundService],
    exports: [FundService],
})
export class FundModule {}
