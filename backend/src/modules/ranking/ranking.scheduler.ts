import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

import { RankingService } from './ranking.service';

@Injectable()
export class RankingScheduler implements OnModuleDestroy {
    private readonly logger = new Logger(RankingScheduler.name);
    private handle: NodeJS.Timeout | null = null;
    private initialHandle: NodeJS.Timeout | null = null;

    constructor(private readonly rankingService: RankingService) {
        // FIX(F): 回调内 try/catch，避免 promise 拒绝产生未处理异常并中断后续计算
        this.handle = setInterval(async () => {
            try {
                await this.rankingService.calculateRankings();
                this.logger.log('排行榜已更新');
            }
            catch (e) {
                this.logger.error('排行榜计算失败: ' + (e && e.message ? e.message : e));
            }
        }, 30 * 1000);
        this.initialHandle = setTimeout(async () => {
            try {
                await this.rankingService.calculateRankings();
            }
            catch (e) {
                this.logger.error('排行榜初始化计算失败: ' + (e && e.message ? e.message : e));
            }
        }, 10000);
    }

    // FIX(F): 模块销毁时清理定时器，避免泄漏与重复计算
    onModuleDestroy() {
        if (this.handle) {
            clearInterval(this.handle);
            this.handle = null;
        }
        if (this.initialHandle) {
            clearTimeout(this.initialHandle);
            this.initialHandle = null;
        }
    }
}
