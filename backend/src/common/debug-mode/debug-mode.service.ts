import { Injectable } from '@nestjs/common';

/** 全局调试模式：管理员开启后，休市期间也可生成行情/下单（用于 debug） */
@Injectable()
export class DebugModeService {
  private debug = false;

  set(on: boolean) {
    this.debug = !!on;
  }

  get() {
    return this.debug;
  }
}
