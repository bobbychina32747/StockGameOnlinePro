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

export enum EntryStatus {
    ACTIVE = 'active',
    SETTLED = 'settled',
}

// Phase C: 赛季报名（报名时快照账户净值，赛季收益=净值相对变化，收益率口径排序）
let SeasonEntry = class SeasonEntry {
    [key: string]: any;
};
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], SeasonEntry.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], SeasonEntry.prototype, "seasonId", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], SeasonEntry.prototype, "userId", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], SeasonEntry.prototype, "accountId", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: 'CN' }),
    __metadata("design:type", String)
], SeasonEntry.prototype, "marketMode", void 0);
__decorate([
    (0, typeorm_1.Column)('float', { default: 0 }),
    __metadata("design:type", Number)
], SeasonEntry.prototype, "startEquity", void 0);
__decorate([
    (0, typeorm_1.Column)('int', { default: 0 }),
    __metadata("design:type", Number)
], SeasonEntry.prototype, "startDay", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'simple-enum', enum: EntryStatus, default: EntryStatus.ACTIVE }),
    __metadata("design:type", String)
], SeasonEntry.prototype, "status", void 0);
__decorate([
    (0, typeorm_1.Column)('float', { nullable: true }),
    __metadata("design:type", Number)
], SeasonEntry.prototype, "finalEquity", void 0);
__decorate([
    (0, typeorm_1.Column)('float', { nullable: true }),
    __metadata("design:type", Number)
], SeasonEntry.prototype, "finalReturn", void 0);
__decorate([
    (0, typeorm_1.Column)('int', { nullable: true }),
    __metadata("design:type", Number)
], SeasonEntry.prototype, "finalRank", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)(),
    __metadata("design:type", Date)
], SeasonEntry.prototype, "enrolledAt", void 0);

export { SeasonEntry };

SeasonEntry = __decorate(
    [
        (0, typeorm_1.Entity)('season_entries'),
        (0, typeorm_1.Unique)(['seasonId', 'accountId'])
    ],
    SeasonEntry
);
