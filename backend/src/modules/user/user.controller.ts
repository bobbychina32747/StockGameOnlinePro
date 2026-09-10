import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User } from '../../infrastructure/database/entities/user.entity';
import { UserService } from './user.service';

@Controller('user')
@UseGuards(JwtAuthGuard)
export class UserController {
    constructor(private readonly userService: UserService) {}

    @Get('profile')
    getProfile(@CurrentUser() user: User) {
        return { id: user.id, username: user.username, role: user.role, createdAt: user.createdAt };
    }

    @Put('profile')
    updateProfile(@CurrentUser() user: User, @Body() data: any) {
        return this.userService.updateProfile(user.id, data);
    }
}
