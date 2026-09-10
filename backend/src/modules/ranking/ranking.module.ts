import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Account } from '../../infrastructure/database/entities/account.entity';
import { DailySnapshot } from '../../infrastructure/database/entities/daily-snapshot.entity';

import { RankingController } from './ranking.controller';
import { RankingService } from './ranking.service';
import { RankingScheduler } from './ranking.scheduler';

@Module({
    imports: [TypeOrmModule.forFeature([Account, DailySnapshot])],
    controllers: [RankingController],
    providers: [RankingService, RankingScheduler],
    exports: [RankingService],
})
export class RankingModule {}
