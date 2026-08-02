import { Global, Module } from '@nestjs/common';
import { DebugModeService } from './debug-mode.service';

/** 全局调试模式模块（market/order/admin 均可注入） */
@Global()
@Module({
  providers: [DebugModeService],
  exports: [DebugModeService],
})
export class DebugModeModule {}
