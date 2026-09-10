import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Account } from '../../infrastructure/database/entities/account.entity';
import { User } from '../../infrastructure/database/entities/user.entity';
import { SeasonModule } from '../season/season.module';
import { TradingModule } from '../trading/trading.module';

import { BotPlayerService } from './bot-player.service';

// Phase G-2 机器人玩家子模块。
// 装配要点（为什么这样切）：
// ① BotPlayerService 依赖 OrderService（真实下单）与 SeasonService（赛季报名）：**依赖必须在声明它的模块
//    自己的 imports 里可见**——Nest 的 provider 依赖解析只看"声明模块 + 其 imports + 全局模块"，
//    宿主（MarketModule）import 了本模块并不会把自己的 provider 借给本模块的 provider。
//    所以这里直接 imports TradingModule / SeasonModule（二者都不反向依赖 MarketModule，无环）。
// ② 依赖方向：MarketModule → BotModule → TradingModule/SeasonModule；机器人不认识行情服务，
//    行情侧通过 configure({getSymbols,getPrice}) 回调喂数据，避免 bots ↔ market 循环。
// ③ 本模块不含 onModuleInit：名册由宿主在行情 tick 内首次调用 ensureRoster() 懒开通，
//    避免污染单测与启动冒烟（见 bot-player.service.ts 的 ensureRosterIfNeeded）。
@Module({
    imports: [TypeOrmModule.forFeature([User, Account]), TradingModule, SeasonModule],
    providers: [BotPlayerService],
    exports: [BotPlayerService],
})
export class BotModule {}
