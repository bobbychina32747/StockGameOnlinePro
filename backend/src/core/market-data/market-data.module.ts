import { Global, Module } from '@nestjs/common';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Stock } from '../../infrastructure/database/entities/stock.entity';
import { Kline } from '../../infrastructure/database/entities/kline.entity';
// Phase A: 分红事件落库
import { DividendEvent } from '../../infrastructure/database/entities/dividend-event.entity';

import { TradingEngineService } from '../trading-engine/trading-engine.service';

import { MarketDataService } from './market-data.service';

@Global()
@Module({
    imports: [TypeOrmModule.forFeature([Stock, Kline, DividendEvent])],
    providers: [
        MarketDataService,
        // 三服务器：HK/US 独立 MarketDataService 实例（CN 用默认）
        {
            provide: 'MarketDataHK',
            useFactory: (stockRepo: Repository<Stock>, klineRepo: Repository<Kline>, dividendEventRepo: Repository<DividendEvent>, engine: TradingEngineService) => new MarketDataService(stockRepo, klineRepo, dividendEventRepo, engine, 'HK'),
            inject: [
                getRepositoryToken(Stock),
                getRepositoryToken(Kline),
                getRepositoryToken(DividendEvent),
                TradingEngineService,
            ],
        },
        {
            provide: 'MarketDataUS',
            useFactory: (stockRepo: Repository<Stock>, klineRepo: Repository<Kline>, dividendEventRepo: Repository<DividendEvent>, engine: TradingEngineService) => new MarketDataService(stockRepo, klineRepo, dividendEventRepo, engine, 'US'),
            inject: [
                getRepositoryToken(Stock),
                getRepositoryToken(Kline),
                getRepositoryToken(DividendEvent),
                TradingEngineService,
            ],
        },
    ],
    exports: [MarketDataService, 'MarketDataHK', 'MarketDataUS'],
})
export class MarketDataModule {}
