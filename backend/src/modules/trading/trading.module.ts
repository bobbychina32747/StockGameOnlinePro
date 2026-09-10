import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Account } from '../../infrastructure/database/entities/account.entity';
import { Position } from '../../infrastructure/database/entities/position.entity';
import { Order } from '../../infrastructure/database/entities/order.entity';
import { Transaction } from '../../infrastructure/database/entities/transaction.entity';

import { OrderController } from './order.controller';
import { OrderService } from './order.service';

@Module({
    imports: [TypeOrmModule.forFeature([Account, Position, Order, Transaction])],
    controllers: [OrderController],
    providers: [OrderService],
    exports: [OrderService],
})
export class TradingModule {}
