import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
    IsEnum,
    IsInt,
    IsNumber,
    IsOptional,
    IsString,
    Max,
    MaxLength,
    Min,
    MinLength,
} from 'class-validator';

import { CurrentUser, JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

import { User } from '../../infrastructure/database/entities/user.entity';

import { OrderService } from './order.service';

import { OrderSide, OrderType } from '../../infrastructure/database/entities/order.entity';

class PlaceOrderDto {
    @IsString()
    @MinLength(1)
    @MaxLength(20)
    symbol: string;

    @IsEnum(OrderType)
    type: OrderType;

    @IsEnum(OrderSide)
    side: OrderSide;

    @IsInt()
    @Min(1)
    @Max(1000000)
    quantity: number;

    @IsOptional()
    @IsNumber({ allowNaN: false, allowInfinity: false })
    @Min(0.01)
    price?: number;

    @IsOptional()
    @IsNumber({ allowNaN: false, allowInfinity: false })
    @Min(0.01)
    triggerPrice?: number;

    @IsOptional()
    @IsInt()
    @Min(1)
    displayQty?: number;
}

@Controller('trading')
@UseGuards(JwtAuthGuard)
export class OrderController {
    constructor(private readonly orderService: OrderService) {}

    @Post('order')
    placeOrder(
        @CurrentUser() user: User,
        @Body() dto: PlaceOrderDto,
        @Query('mode') mode: string,
    ) {
        return this.orderService.placeOrder(user.id, mode || 'US', dto.symbol, dto.type, dto.side, dto.quantity, dto.price, dto.triggerPrice, dto.displayQty);
    }

    @Delete('order/:id')
    cancelOrder(
        @CurrentUser() user: User,
        @Param('id') id: string,
        @Query('mode') mode: string,
    ) {
        return this.orderService.cancelOrder(user.id, id, mode || 'US');
    }

    @Get('orders/pending')
    getPending(
        @CurrentUser() user: User,
        @Query('mode') mode: string,
    ) {
        return this.orderService.getPendingOrders(user.id, mode || 'US');
    }

    @Get('history')
    getHistory(
        @CurrentUser() user: User,
        @Query('mode') mode: string,
    ) {
        return this.orderService.getHistory(user.id, mode || 'US');
    }
}
