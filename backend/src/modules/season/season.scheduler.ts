import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { SeasonService } from './season.service';

// Phase C: 赛季调度——30s 轮询游戏日推进，任一市场跑满时长即结算并自动开新赛季
@Injectable()
export class SeasonScheduler implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(SeasonScheduler.name);
    private timer: NodeJS.Timeout | null = null;

    constructor(private readonly seasonService: SeasonService) {}

    onModuleInit() {
        // 启动即确保存在报名中赛季
        this.seasonService.ensureSeason().catch((e) => this.logger.warn('赛季初始化失败: ' + (e && e.message ? e.message : e)));
        this.timer = setInterval(async () => {
            try {
                await this.seasonService.maybeSettleByClock();
            }
            catch (e) {
                this.logger.warn('赛季调度异常: ' + (e && e.message ? e.message : e));
            }
        }, 30000);
    }

    onModuleDestroy() {
        if (this.timer)
            clearInterval(this.timer);
    }
}
