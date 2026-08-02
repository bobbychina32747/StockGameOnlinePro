const fs = require('fs');
const path = require('path');

// ═══ 1. app.module：注册 DebugModeModule ═══
let p = 'src/app.module.ts';
let s = fs.readFileSync(p, 'utf8');
// import
s = s.replace(
  "import market_module_1 = require(\"./modules/market/market.module\");",
  "import debug_mode_module_1 = require(\"./common/debug-mode/debug-mode.module\");\n\nimport market_module_1 = require(\"./modules/market/market.module\");"
);
// imports 数组（加在 MarketModule 前）
s = s.replace(
  "            market_module_1.MarketModule,",
  "            debug_mode_module_1.DebugModeModule,\n            market_module_1.MarketModule,"
);
fs.writeFileSync(p, s);
console.log('1. app.module 注册完成');

// ═══ 2. market.service：注入 debugMode，tick 检查跳过 ═══
p = 'src/modules/market/market.service.ts';
s = fs.readFileSync(p, 'utf8');
// import
s = s.replace(
  "import risk_manager_service_1 = require(\"../../core/risk-manager/risk-manager.service\");",
  "import debug_mode_service_1 = require(\"../../common/debug-mode/debug-mode.service\");\n\nimport risk_manager_service_1 = require(\"../../core/risk-manager/risk-manager.service\");"
);
// 构造器加 debugMode（第 8 参数）
s = s.replace(
  "    constructor(marketData, engine, gateway, newsService, riskManager, marketDataHK, marketDataUS) {",
  "    constructor(marketData, engine, gateway, newsService, riskManager, marketDataHK, marketDataUS, debugMode) {\n        this.debugMode = debugMode;"
);
// tick 检查：调试模式跳过
s = s.replace(
  "                if (!this.isTradingTime()) {\n                    return;\n                }",
  "                if (!this.debugMode.get() && !this.isTradingTime()) {\n                    return;\n                }"
);
// 装饰器：__param(7) 按类型注入（DebugModeService 是类 token，不需要 @Inject——但 design:paramtypes 要加）
s = s.replace(
  "        risk_manager_service_1.RiskManagerService,\n        market_data_service_1.MarketDataService,\n        market_data_service_1.MarketDataService])",
  "        risk_manager_service_1.RiskManagerService,\n        market_data_service_1.MarketDataService,\n        market_data_service_1.MarketDataService,\n        debug_mode_service_1.DebugModeService])"
);
fs.writeFileSync(p, s);
console.log('2. market.service 接入完成');

// ═══ 3. order.service：注入 debugMode，下单检查跳过 ═══
p = 'src/modules/trading/order.service.ts';
s = fs.readFileSync(p, 'utf8');
// import（看现有 import 结构）
if (!s.includes('debug-mode.service')) {
  s = s.replace(
    "import constants_1 = require(\"../../common/constants\");",
    "import debug_mode_service_1 = require(\"../../common/debug-mode/debug-mode.service\");\n\nimport constants_1 = require(\"../../common/constants\");"
  );
}
// 构造器加 debugMode（看构造器参数数量）
const m = s.match(/constructor\(([^)]*)\) \{/);
console.log('order.service 构造器:', m ? m[1].trim() : '未找到');
fs.writeFileSync(p, s);
