import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { User } from '../../infrastructure/database/entities/user.entity';
import { Account } from '../../infrastructure/database/entities/account.entity';
import { Order } from '../../infrastructure/database/entities/order.entity';

import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
    imports: [TypeOrmModule.forFeature([User, Account, Order])],
    controllers: [AdminController],
    providers: [AdminService],
    exports: [AdminService],
})
export class AdminModule {}
