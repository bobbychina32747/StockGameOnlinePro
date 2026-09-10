import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

import { RankingService } from './ranking.service';

@Controller('ranking')
// SECURITY(F): 排行榜需登录后才能访问（防止未认证访问用户排行数据）
@UseGuards(JwtAuthGuard)
export class RankingController {
    constructor(private readonly rankingService: RankingService) {}

    @Get()
    getRankings(
        @Query('limit') limit: number,
        @Query('sort') sort: string,
        @Query('market') market: string,
    ) {
        return this.rankingService.getRankings(limit || 20, sort || 'totalReturn', market || 'ALL');
    }
}
