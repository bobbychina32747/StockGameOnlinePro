import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, ParseBoolPipe, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User, UserRole } from '../../infrastructure/database/entities/user.entity';
import { DebugModeService } from '../../common/debug-mode/debug-mode.service';
import { AdminService } from './admin.service';

@Controller('admin')
@UseGuards(JwtAuthGuard)
export class AdminController {
    constructor(
        private readonly adminService: AdminService,
        private readonly debugMode: DebugModeService,
    ) {}

    @Get('stats')
    async getStats(@CurrentUser() user: User) {
        if (user.role !== UserRole.ADMIN)
            throw new ForbiddenException('无权限');
        return this.adminService.getStats();
    }

    @Get('users')
    async getUsers(@CurrentUser() user: User, @Query('page') page: number, @Query('limit') limit: number) {
        if (user.role !== UserRole.ADMIN)
            throw new ForbiddenException('无权限');
        return this.adminService.getUsers(page, limit);
    }

    @Post('users/:id/toggle')
    async toggleUser(@CurrentUser() admin: User, @Param('id') userId: string, @Body('isActive', ParseBoolPipe) isActive: boolean) {
        if (admin.role !== UserRole.ADMIN)
            throw new ForbiddenException('无权限');
        // SECURITY(E): 禁止管理员禁用自己（避免失去管理入口）
        if (isActive === false && userId === admin.id)
            throw new BadRequestException('不能禁用当前登录的管理员账号');
        await this.adminService.setUserActive(userId, isActive);
        return { success: true };
    }

    // 调试模式：休市期间可生成行情/下单（管理员专用）
    @Post('debug')
    async setDebug(@CurrentUser() user: User, @Body('on') on: boolean) {
        if (user.role !== UserRole.ADMIN)
            throw new ForbiddenException('无权限');
        // SECURITY(D): 调试模式只对开启它的管理员生效（bypassUserIds 白名单），关闭时清空白名单并复位全局开关
        if (on === true) {
            this.debugMode.set(true);
            this.debugMode.addBypassUser(user.id);
        }
        else {
            this.debugMode.clearBypassUsers();
            this.debugMode.set(false);
            // P4 修复：关闭调试模式时同步复位全服休市交易（与注释承诺一致，避免遗留全局旁路）
            this.debugMode.setGlobalBypass(false);
        }
        return { success: true, debug: this.debugMode.get(), globalBypass: this.debugMode.getGlobalBypass() };
    }

    @Get('debug')
    async getDebug(@CurrentUser() user: User) {
        if (user.role !== UserRole.ADMIN)
            throw new ForbiddenException('无权限');
        return { debug: this.debugMode.get(), globalBypass: this.debugMode.getGlobalBypass() };
    }

    // P6 全服休市交易：开启后所有用户均可休市下单（行情全时生成）
    @Post('debug/global')
    async setDebugGlobal(@CurrentUser() user: User, @Body('on', ParseBoolPipe) on: boolean) {
        if (user.role !== UserRole.ADMIN)
            throw new ForbiddenException('无权限');
        this.debugMode.setGlobalBypass(on === true);
        if (on === true) {
            this.debugMode.set(true); // 全服休市交易依赖行情运行
        }
        return { success: true, debug: this.debugMode.get(), globalBypass: this.debugMode.getGlobalBypass() };
    }
}
