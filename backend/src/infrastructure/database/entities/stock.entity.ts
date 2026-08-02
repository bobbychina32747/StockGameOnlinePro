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

let Stock = class Stock {
    [key: string]: any;
};
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], Stock.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)({ unique: true, length: 10 }),
    __metadata("design:type", String)
], Stock.prototype, "symbol", void 0);
__decorate([
    (0, typeorm_1.Column)({ length: 100 }),
    __metadata("design:type", String)
], Stock.prototype, "name", void 0);
__decorate([
    (0, typeorm_1.Column)({ length: 5, default: 'CN' }),
    __metadata("design:type", String)
], Stock.prototype, "market", void 0);
__decorate([
    (0, typeorm_1.Column)({ length: 50, default: '综合' }),
    __metadata("design:type", String)
], Stock.prototype, "industry", void 0);
__decorate([
    (0, typeorm_1.Column)({ length: 10, default: '' }),
    __metadata("design:type", String)
], Stock.prototype, "code", void 0);
__decorate([
    (0, typeorm_1.Column)({ length: 20, default: '' }),
    __metadata("design:type", String)
], Stock.prototype, "listDate", void 0);
__decorate([
    (0, typeorm_1.Column)('text', { default: '' }),
    __metadata("design:type", String)
], Stock.prototype, "description", void 0);
__decorate([
    (0, typeorm_1.Column)('float'),
    __metadata("design:type", Number)
], Stock.prototype, "initialPrice", void 0);
__decorate([
    (0, typeorm_1.Column)('float'),
    __metadata("design:type", Number)
], Stock.prototype, "mu", void 0);
__decorate([
    (0, typeorm_1.Column)('float', { default: 0.015 }),
    __metadata("design:type", Number)
], Stock.prototype, "sigma", void 0);
__decorate([
    (0, typeorm_1.Column)('float', { default: 0.15 }),
    __metadata("design:type", Number)
], Stock.prototype, "theta", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: true }),
    __metadata("design:type", Boolean)
], Stock.prototype, "isActive", void 0);

export { Stock };

Stock = __decorate(
[
    (0, typeorm_1.Entity)('stocks')
],
Stock
);

