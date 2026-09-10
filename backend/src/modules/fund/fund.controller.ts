import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';

import { CurrentUser, JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User } from '../../infrastructure/database/entities/user.entity';

import { FundService } from './fund.service';

@Controller('fund')
export class FundController {
    constructor(private readonly fundService: FundService) {}

    @Get()
    getFunds() {
        return this.fundService.getFunds();
    }

    @Get(':id')
    getFund(@Param('id') id: string) {
        return this.fundService.getFund(id);
    }

    @Post(':id/subscribe')
    @UseGuards(JwtAuthGuard)
    subscribe(
        @CurrentUser() user: User,
        @Param('id') id: string,
        @Query('amount') amount: number,
        @Query('mode') mode: string,
    ) {
        return this.fundService.subscribe(user.id, mode, id, amount);
    }

    @Post(':id/redeem')
    @UseGuards(JwtAuthGuard)
    redeem(
        @CurrentUser() user: User,
        @Param('id') id: string,
        @Query('shares') shares: number,
        @Query('mode') mode: string,
    ) {
        return this.fundService.redeem(user.id, mode, id, shares);
    }
}
