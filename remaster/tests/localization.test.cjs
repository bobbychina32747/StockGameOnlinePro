const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const filename=path.resolve(__dirname,'../apps/web/src/localization.ts');
const local=new Module(filename,module);local.filename=filename;local.require=id=>id==='./workspace'?{currentLanguage:()=> 'zh-CN'}:require(id);
local._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,filename);
const {translate,interfaceTranslations}=local.exports;
test('English covers formal panels, preferences, limits and dynamic numbers; traditional labels remain Chinese',()=>{
 for(const text of ['交易复盘记录','融资设置','界面语言','涨停价','AI 对手盘','订单流与融券','市场风险事件','游戏账号登录'])assert(!/[\u3400-\u9fff]/.test(translate(text,'en')));
 assert.equal(translate('当前债务 123.45','en'),'Current debt 123.45');
 assert.equal(translate('资产账本','zh-Hant'),'資產帳本');
 assert.equal(translate('暂停','zh-Hant'),'暫停');
 for(const [key,value] of Object.entries(interfaceTranslations)){assert(!/[\u3400-\u9fff]/.test(value),key);assert.equal(translate(key,'zh-CN'),key);}
});
