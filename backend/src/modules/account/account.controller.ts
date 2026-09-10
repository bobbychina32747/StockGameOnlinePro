import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User } from '../../infrastructure/database/entities/user.entity';
import { AccountService } from './account.service';

@Controller('account')
@UseGuards(JwtAuthGuard)
export class AccountController {
    constructor(private readonly accountService: AccountService) {}

    @Get()
    async getAccount(@CurrentUser() user: User, @Query('mode') mode: string = 'US') {
        const account = await this.accountService.getAccount(user.id, mode);
        const positions = await this.accountService.getPositions(account.id);
        return { account, positions };
    }

    @Get('metrics')
    async getMetrics(@CurrentUser() user: User, @Query('mode') mode: string = 'US') {
        return this.accountService.getMetrics(user.id, mode);
    }

    @Get('history')
    getHistory(@CurrentUser() user: User, @Query('mode') mode: string = 'US') {
        return this.accountService.getHistory(user.id, mode);
    }

    @Get('transactions')
    getTransactions(@CurrentUser() user: User, @Query('mode') mode: string = 'US', @Query('limit') limit: string) {
        return this.accountService.getTransactions(user.id, mode, limit);
    }

    @Get('reviews')
    getReviews(@CurrentUser() user: User) {
        return this.accountService.getReviews(user.id);
    }

    @Post('leverage')
    async setLeverage(@CurrentUser() user: User, @Query('mode') mode: string, @Body('leverage') leverage: number) {
        return this.accountService.setLeverage(user.id, mode || 'US', leverage);
    }

    @Post('reset')
    async resetAccount(@CurrentUser() user: User, @Query('mode') mode: string, @Body('preset') preset: string) {
        return this.accountService.resetAccount(user.id, mode || 'US', preset);
    }

    @Post('transfer')
    async transfer(
        @CurrentUser() user: User,
        @Query('fromMode') fromMode: string,
        @Query('toMode') toMode: string,
        @Body('amount') amount: number,
    ) {
        return this.accountService.transferCash(user.id, fromMode, toMode, amount);
    }

    @Get('achievements')
    getAchievements(@CurrentUser() user: User) {
        return this.accountService.getAchievements(user.id);
    }

    @Post('achievements')
    unlockAchievement(@CurrentUser() user: User, @Body() body: any) {
        return this.accountService.unlockAchievement(user.id, body && body.code);
    }
}
