import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';

import { CurrentUser, JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User } from '../../infrastructure/database/entities/user.entity';

import { SeasonService } from './season.service';

@Controller('season')
@UseGuards(JwtAuthGuard)
export class SeasonController {
    constructor(private readonly seasonService: SeasonService) {}

    @Post('enroll')
    enroll(@CurrentUser() user: User) {
        return this.seasonService.enroll(user.id);
    }

    @Get('current')
    current(@CurrentUser() user: User) {
        return this.seasonService.myStatus(user.id);
    }

    @Get('leaderboard')
    leaderboard(@Query('market') market: string = 'ALL', @Query('limit') limit: number) {
        return this.seasonService.leaderboard(null, market, limit);
    }

    @Get('history')
    history() {
        return this.seasonService.history();
    }

    // Phase E V2: 赛程日历 / 战绩档案 / 赛季积分榜
    @Get('schedule')
    schedule(@Query('count') count: number) {
        return this.seasonService.schedule(count);
    }

    @Get('archive/:seasonId')
    archive(@CurrentUser() user: User, @Param('seasonId') seasonId: string) {
        return this.seasonService.archive(seasonId, user.id);
    }

    @Get('points')
    points(@Query('limit') limit: number) {
        return this.seasonService.points(limit);
    }
}
