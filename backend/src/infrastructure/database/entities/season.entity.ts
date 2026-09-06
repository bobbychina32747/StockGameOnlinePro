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

export enum SeasonStatus {
    ENROLLING = 'enrolling',
    RUNNING = 'running',
    SETTLED = 'settled',
}

// Phase C: 模拟大赛赛季（快照净值赛 MVP：10 游戏日滚动赛季，手动报名）
let Season = class Season {
    [key: string]: any;
};
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], Season.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)('int', { default: 0 }),
    __metadata("design:type", Number)
], Season.prototype, "seq", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: '赛季' }),
    __metadata("design:type", String)
], Season.prototype, "name", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'simple-enum', enum: SeasonStatus, default: SeasonStatus.ENROLLING }),
    __metadata("design:type", String)
], Season.prototype, "status", void 0);
// 开赛时各市场 gameDay（JSON：{CN,HK,US}），赛季结束判定 = 任一市场 gameDay ≥ anchor+duration
__decorate([
    (0, typeorm_1.Column)({ type: 'text', default: '{}' }),
    __metadata("design:type", String)
], Season.prototype, "anchorDay", void 0);
__decorate([
    (0, typeorm_1.Column)('int', { default: 10 }),
    __metadata("design:type", Number)
], Season.prototype, "durationDays", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)(),
    __metadata("design:type", Date)
], Season.prototype, "startedAt", void 0);
__decorate([
    (0, typeorm_1.Column)('datetime', { nullable: true }),
    __metadata("design:type", Date)
], Season.prototype, "endedAt", void 0);
__decorate([
    (0, typeorm_1.Column)('datetime', { nullable: true }),
    __metadata("design:type", Date)
], Season.prototype, "settledAt", void 0);

export { Season };

Season = __decorate(
    [
        (0, typeorm_1.Entity)('seasons'),
        (0, typeorm_1.Unique)(['seq'])
    ],
    Season
);
