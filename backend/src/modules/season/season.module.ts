import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Season } from '../../infrastructure/database/entities/season.entity';
import { SeasonEntry } from '../../infrastructure/database/entities/season-entry.entity';
import { Account } from '../../infrastructure/database/entities/account.entity';

import { SeasonService } from './season.service';
import { SeasonController } from './season.controller';
import { SeasonScheduler } from './season.scheduler';

@Module({
    imports: [TypeOrmModule.forFeature([Season, SeasonEntry, Account])],
    controllers: [SeasonController],
    providers: [SeasonService, SeasonScheduler],
    exports: [SeasonService],
})
export class SeasonModule {}
