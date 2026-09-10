import { Controller, Get, Query } from '@nestjs/common';

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
}
