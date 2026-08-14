import { Injectable } from '@nestjs/common';

/**
 * 全局调试模式：管理员开启后，休市期间也可生成行情/下单（用于 debug）。
 * D 修复：行情生成仍由全局布尔（get()）控制（market.service 继续使用）；
 * 休市下单绕过仅对开启该模式的管理员生效（bypassUserIds 白名单），避免全员滥用。
 */
@Injectable()
export class DebugModeService {
  private debug = false;
  /** 允许休市期下单的管理员白名单（开启调试模式的管理员 id） */
  private bypassUserIds = new Set<string>();

  set(on: boolean) {
    this.debug = !!on;
  }

  get() {
    return this.debug;
  }

  addBypassUser(userId: string) {
    if (userId) this.bypassUserIds.add(userId);
  }

  clearBypassUsers() {
    this.bypassUserIds.clear();
  }

  /** 仅当全局调试开启且该用户在白名单中时才允许绕过休市时段检查 */
  canBypassHours(userId?: string): boolean {
    return this.debug && !!userId && this.bypassUserIds.has(userId);
  }
}
