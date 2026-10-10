const {test}=require('node:test');const assert=require('node:assert/strict');
const catalog=require('../packages/domain/catalog.json').instruments;
const calibration=require('../packages/domain/sector-calibration.json');
const {generateHistory}=require('../dist/packages/engine/historical-model');
const {createWorld}=require('../dist/packages/engine/world');
const {cloneWorld}=require('../dist/packages/engine/matching');
const {applyNews,consumeNews,industryExposure}=require('../dist/packages/engine/news');
const {intradayActivity}=require('../dist/packages/engine/volatility');
const {snapshot}=require('../dist/apps/game-api/read-model');
const {openDay}=require('../dist/packages/engine/economy');
const {metrics,median}=require('../tooling/research-statistics.cjs');

test('23 sectors contain six distinct stocks, all markets and preserved original identities',()=>{
 assert.equal(catalog.length,138);assert.equal(new Set(catalog.map(stock=>stock.symbol)).size,138);
 const industries=[...new Set(catalog.map(stock=>stock.industry))];assert.equal(industries.length,23);
 for(const industry of industries){const stocks=catalog.filter(stock=>stock.industry===industry);assert.equal(stocks.length,6);assert.equal(new Set(stocks.map(stock=>stock.market)).size,3);assert(new Set(stocks.map(stock=>stock.volatility)).size>=3);}
 assert.equal(catalog.find(stock=>stock.symbol==='T1').name,'芯澜半导体');assert.equal(catalog.find(stock=>stock.symbol==='H1').name,'云顶网络');
 assert.equal(catalog.filter(stock=>/^NX/.test(stock.symbol)).length,70);
 assert.equal(calibration.trainingCutoffExclusive,'2025-10-01');
 assert(calibration.profiles['半导体'].CN.dailyVolatility>calibration.profiles['银行'].CN.dailyVolatility);
});

test('multiple seeds retain irregular returns, heavy tails and volatility clustering',()=>{
 const reference=catalog.find(stock=>stock.symbol==='U1');const rows=[];
 for(let seed=1;seed<=12;seed++){
  const bars=generateHistory({...reference,listedAt:'2021-10-11'},seed,'2026-10-10');rows.push(metrics(bars));
  for(const bar of bars){assert(bar.high>=Math.max(bar.open,bar.close));assert(bar.low<=Math.min(bar.open,bar.close));assert(bar.low>=1);assert(Number.isSafeInteger(bar.volume));}
 }
 const kurtosis=median(rows.map(row=>row.excessKurtosis)),clustering=median(rows.map(row=>row.absoluteReturnLag1));
 assert(kurtosis>.7,`fat tails missing: ${kurtosis}`);assert(clustering>.03,`volatility clustering missing: ${clustering}`);
 assert(median(rows.map(row=>row.dailyVolatility))>reference.volatility*.6);assert(median(rows.map(row=>row.medianGap))>.002);
});

test('CN daily limits and query ranges survive rounded OHLC prices',()=>{
 const stock=catalog.find(stock=>stock.symbol==='T1');const full=generateHistory(stock,73,'2026-10-10');
 const subset=generateHistory(stock,73,'2026-10-10','2024-01-01');assert.deepEqual(subset,full.filter(bar=>bar.time>=Date.parse('2024-01-01')));
 for(let i=1;i<full.length;i++){const previous=full[i-1].close;assert(full[i].high<=Math.ceil(previous*1.1)+1);assert(full[i].low>=Math.floor(previous*.9)-1);}
});

test('news starts after publication, persists safely, and uses industry exposures',()=>{
 const world=createWorld(123);const before=world.quotes.U1.price;
 applyNews(world,'US','earnings',1,{symbol:'U1',anticipated:.5,headline:'测试财报'});
 assert.equal(world.quotes.U1.price,before);assert(world.events.at(-1).time>0);
 const publicView=snapshot(world,'observer');assert.equal(publicView.quotes.U1.pendingNews,undefined);assert.equal(publicView.quotes.U1.volatilityState,undefined);
 const recovered=JSON.parse(JSON.stringify(world)),copy=cloneWorld(world);
 const shock=consumeNews(world.instruments.U1,copy);assert(shock.change>0);assert(shock.volatilityMultiplier>1);
 assert.notDeepEqual(copy.quotes.U1.pendingNews,world.quotes.U1.pendingNews);assert.deepEqual(consumeNews(recovered.instruments.U1,recovered),shock);
 const anticipated=createWorld(123);applyNews(anticipated,'US','earnings',1,{symbol:'U1',anticipated:.9});
 assert(consumeNews(anticipated.instruments.U1,anticipated).change<shock.change);
 assert(industryExposure('supply','能源与煤炭')>0);assert(industryExposure('supply','航空航运与物流')<0);
 assert(industryExposure('rates','地产与基建')>0);assert(industryExposure('rates','银行')<0);
});

test('intraday activity is normalized and opens more volatile than mid-session',()=>{
 for(const [market,length]of Object.entries({CN:240,HK:330,US:390})){
  const average=Array.from({length},(_,minute)=>intradayActivity(minute,length,market)).reduce((sum,n)=>sum+n,0)/length;
  assert(Math.abs(average-1)<.03);assert(intradayActivity(0,length,market)>intradayActivity(length/2,length,market));
 }
});

test('live next-day volatility retains the completed daily shock and downside asymmetry',()=>{
 const initial=createWorld(789),fall=cloneWorld(initial),rise=cloneWorld(initial),quiet=cloneWorld(initial);
 fall.quotes.U1.price=Math.round(fall.quotes.U1.previousClose*.9);rise.quotes.U1.price=Math.round(rise.quotes.U1.previousClose*1.1);
 openDay(fall,'US');openDay(rise,'US');openDay(quiet,'US');
 assert(fall.quotes.U1.volatilityState.variance>quiet.quotes.U1.volatilityState.variance);
 assert(fall.quotes.U1.volatilityState.variance>=rise.quotes.U1.volatilityState.variance);
});
