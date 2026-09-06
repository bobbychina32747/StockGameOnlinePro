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

// Phase A 分红登记日持仓快照：exDay-1 收盘拍全市场净持仓，exDay 盘后按快照发息（封堵"除权日买入白拿息"套利）
let DividendSnapshot = class DividendSnapshot {
    [key: string]: any;
};
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], DividendSnapshot.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], DividendSnapshot.prototype, "accountId", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], DividendSnapshot.prototype, "symbol", void 0);
__decorate([
    (0, typeorm_1.Column)('int', { default: 0 }),
    __metadata("design:type", Number)
], DividendSnapshot.prototype, "exDay", void 0);
__decorate([
    (0, typeorm_1.Column)('float', { default: 0 }),
    __metadata("design:type", Number)
], DividendSnapshot.prototype, "longQty", void 0);
__decorate([
    (0, typeorm_1.Column)('float', { default: 0 }),
    __metadata("design:type", Number)
], DividendSnapshot.prototype, "shortQty", void 0);
// Phase C: 快照时点的建仓日（红利税持有期近似：0=无记录按当日建仓）
__decorate([
    (0, typeorm_1.Column)('int', { default: 0 }),
    __metadata("design:type", Number)
], DividendSnapshot.prototype, "lockDay", void 0);
// 发息幂等标记：防止重复日终结算重复发息
__decorate([
    (0, typeorm_1.Column)({ default: false }),
    __metadata("design:type", Boolean)
], DividendSnapshot.prototype, "paid", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)(),
    __metadata("design:type", Date)
], DividendSnapshot.prototype, "createdAt", void 0);

export { DividendSnapshot };

DividendSnapshot = __decorate(
    [
        (0, typeorm_1.Entity)('dividend_snapshots'),
        (0, typeorm_1.Unique)(['accountId', 'symbol', 'exDay'])
    ],
    DividendSnapshot
);
