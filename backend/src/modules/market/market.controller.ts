import { BadRequestException, Body, Controller, Get, Post, Query, ServiceUnavailableException } from '@nestjs/common';
import { resolve } from 'node:path';

import { MarketService } from './market.service';

@Controller('market')
export class MarketController {
    constructor(private readonly marketService: MarketService) {}

    @Get('prices')
    getPrices() {
        return this.marketService.getPrices();
    }

    @Get('stocks')
    getStocks() {
        return this.marketService.getStocks();
    }

    @Get('indices')
    getIndices() {
        return this.marketService.getIndices();
    }

    @Get('state')
    getState() {
        return this.marketService.getState();
    }

    @Get('reports')
    getReports(@Query('symbol') symbol: string) {
        return this.marketService.getReports(symbol);
    }

    @Get('ai-opponents')
    getAiOpponents() {
        return this.marketService.getAiOpponents();
    }

    @Get('flow-signals')
    getFlowSignals(@Query('symbol') symbol: string) {
        return this.marketService.getFlowSignals(symbol);
    }

    @Get('backtest')
    backtest(
        @Query('symbol') symbol: string,
        @Query('fast') fast: string,
        @Query('slow') slow: string,
        @Query('timeframe') timeframe: string,
        @Query('strategy') strategy: string,
        @Query('slippageBps') slippageBps: string,
        @Query('period') period: string,
        @Query('momentumN') momentumN: string,
    ) {
        return this.marketService.backtest(symbol, fast, slow, timeframe, strategy, slippageBps, period, momentumN);
    }

    @Get('klines')
    getKlines(@Query('symbol') symbol: string, @Query('timeframe') timeframe: string) {
        return this.marketService.getKlines(symbol || 'A', timeframe || '1min');
    }

    @Get('orderbook')
    getOrderBook(@Query('symbol') symbol: string) {
        return this.marketService.getOrderBook(symbol || 'A');
    }

    @Post('backtest-v2')
    async backtestV2(@Body() body: any) {
        if (typeof body?.symbol !== 'string' || body.symbol.length > 100 || !['ma', 'rsi', 'momentum'].includes(body?.strategy)) {
            throw new BadRequestException('回测参数无效');
        }
        // The Go API retains the exact existing pure engine for numerical compatibility.
        // Load only a deployment-owned module path, never a request-controlled path.
        const modulePath = process.env.V2_BACKTEST_MODULE || resolve(process.cwd(), '../remaster/dist/packages/engine/backtest.js');
        let backtest: any;
        try { ({ backtest } = require(modulePath)); }
        catch { throw new ServiceUnavailableException('兼容回测模块未安装'); }
        const raw = await this.marketService.getKlines(body.symbol, 'daily');
        const bars = raw.map(bar => {
            const time = new Date(bar.time).getTime();
            const cents = value => Math.round((Number(value) || 0) * 100);
            return { time, day: Math.floor((time - Date.UTC(2024, 0, 1)) / 86400000),
                open: cents(bar.open), close: cents(bar.close), high: cents(bar.high), low: cents(bar.low), volume: Number(bar.volume) || 0 };
        });
        try { return backtest(body.symbol, bars.slice(0, -1), body.strategy, 20261010); }
        catch (error) {
            if (typeof error?.code === 'string') throw new BadRequestException(error.message);
            throw error;
        }
    }
}
