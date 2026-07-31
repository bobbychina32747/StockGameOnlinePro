var __decorate = function (decorators, target, key?, desc?) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import common_1 = require("@nestjs/common");

import typeorm_1 = require("@nestjs/typeorm");

import user_entity_1 = require("../../infrastructure/database/entities/user.entity");

import user_controller_1 = require("./user.controller");

import user_service_1 = require("./user.service");

let UserModule = class UserModule {
    [key: string]: any;
};

export { UserModule };

UserModule = __decorate(
[
    (0, common_1.Module)({
        imports: [typeorm_1.TypeOrmModule.forFeature([user_entity_1.User])],
        controllers: [user_controller_1.UserController],
        providers: [user_service_1.UserService],
        exports: [user_service_1.UserService],
    })
],
UserModule
);

