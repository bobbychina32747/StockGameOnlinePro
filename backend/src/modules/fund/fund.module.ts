import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Account } from '../../infrastructure/database/entities/account.entity';
import { FundHolding } from '../../infrastructure/database/entities/fund-holding.entity';

// Phase 14: 基金净值持久化（FundService 注入 FundNav repo 做启动回填 + 定时落库）
import { FundNav } from '../../infrastructure/database/entities/fund-nav.entity';

import { FundController } from './fund.controller';
import { FundService } from './fund.service';

// Phase C: 赛季中禁基金申购/赎回（FundService 注入 SeasonService）
import { SeasonModule } from '../season/season.module';

@Module({
    imports: [TypeOrmModule.forFeature([Account, FundHolding, FundNav]), SeasonModule],
    controllers: [FundController],
    providers: [FundService],
    exports: [FundService],
})
export class FundModule {}
