var __decorate = function (decorators, target, key?, desc?) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import typeorm_1 = require("typeorm");

import user_entity_1 = require("./user.entity");

import position_entity_1 = require("./position.entity");

import order_entity_1 = require("./order.entity");

let Account = class Account {
    [key: string]: any;
};
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], Account.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], Account.prototype, "userId", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => user_entity_1.User, (user) => user.accounts),
    (0, typeorm_1.JoinColumn)({ name: 'userId' }),
    __metadata("design:type", user_entity_1.User)
], Account.prototype, "user", void 0);
__decorate([
    (0, typeorm_1.Column)('float', { default: 100000 }),
    __metadata("design:type", Number)
], Account.prototype, "cash", void 0);
__decorate([
    (0, typeorm_1.Column)('float', { default: 0 }),
    __metadata("design:type", Number)
], Account.prototype, "marginUsed", void 0);
__decorate([
    (0, typeorm_1.Column)('float', { default: 0 }),
    __metadata("design:type", Number)
], Account.prototype, "shortCollateral", void 0);
__decorate([
    (0, typeorm_1.Column)('float', { default: 100000 }),
    __metadata("design:type", Number)
], Account.prototype, "totalEquity", void 0);
__decorate([
    (0, typeorm_1.Column)('float', { default: 100000 }),
    __metadata("design:type", Number)
], Account.prototype, "peakEquity", void 0);
__decorate([
    (0, typeorm_1.Column)('float', { default: 100000 }),
    __metadata("design:type", Number)
], Account.prototype, "initialEquity", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: 'US' }),
    __metadata("design:type", String)
], Account.prototype, "marketMode", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: 1 }),
    __metadata("design:type", Number)
], Account.prototype, "leverage", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: 0 }),
    __metadata("design:type", Number)
], Account.prototype, "currentDay", void 0);
__decorate([
    (0, typeorm_1.Column)('float', { default: 100000 }),
    __metadata("design:type", Number)
], Account.prototype, "dayStartEquity", void 0);
__decorate([
    (0, typeorm_1.Column)('float', { default: 0 }),
    __metadata("design:type", Number)
], Account.prototype, "dailyPnl", void 0);
__decorate([
    (0, typeorm_1.Column)('float', { default: 0 }),
    __metadata("design:type", Number)
], Account.prototype, "totalPnl", void 0);
    // 段位系统：评分 + 段位 + 累计交易次数
    __decorate([(0, typeorm_1.Column)({ default: '青铜' }), __metadata("design:type", String)], Account.prototype, "tier", void 0);
    __decorate([(0, typeorm_1.Column)('float', { default: 0 }), __metadata("design:type", Number)], Account.prototype, "tierScore", void 0);
    __decorate([(0, typeorm_1.Column)({ default: 0 }), __metadata("design:type", Number)], Account.prototype, "totalTrades", void 0);

__decorate([
    (0, typeorm_1.OneToMany)(() => position_entity_1.Position, (pos) => pos.account),
    __metadata("design:type", Array)
], Account.prototype, "positions", void 0);
__decorate([
    (0, typeorm_1.OneToMany)(() => order_entity_1.Order, (order) => order.account),
    __metadata("design:type", Array)
], Account.prototype, "orders", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)(),
    __metadata("design:type", Date)
], Account.prototype, "createdAt", void 0);
__decorate([
    (0, typeorm_1.UpdateDateColumn)(),
    __metadata("design:type", Date)
], Account.prototype, "updatedAt", void 0);

export { Account };

Account = __decorate(
[
    (0, typeorm_1.Entity)('accounts'),
    (0, typeorm_1.Unique)(['userId', 'marketMode'])
],
Account
);

