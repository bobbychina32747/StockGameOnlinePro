// Local complete-market exercise. Real price generation and virtual matching; no player DB.
const fs=require('node:fs');
const {Logger}=require('@nestjs/common');Logger.overrideLogger(false);
const {MarketDataService}=require('../dist/src/core/market-data/market-data.service');
const {TradingEngineService}=require('../dist/src/core/trading-engine/trading-engine.service');
const C=require('../dist/src/common/constants');
const {tradingMinutesFor}=require('../dist/src/common/data/trading-calendar');
const {dailyFactorDrift}=require('../dist/src/core/market-data/price-drift');
function rng(seed){return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
async function run(market,regime,premium,seed){
 Math.random=rng(seed);
 const engine=new TradingEngineService(null,null,null,null,null);
 const s=new MarketDataService(null,{create:r=>r,save:async()=>[]},null,engine,market);
 const pool=market==='CN'?C.STOCK_POOL:market==='HK'?C.HK_POOL:C.US_POOL;
 s.marketRegime=regime;s.updateMarketRegime=()=>{};s.gameDay=40;
 s.factors=Object.fromEntries(C.FACTOR_NAMES.map(n=>[n,.02]));
 s.industryCycles=new Map(pool.map(c=>[c.industry,'expansion']));
 s.hotTopics=[{industry:'半导体',strength:.5,day:40,duration:9}];
 s.ensureVirtualFillHook=()=>engine.setVirtualFillHook(f=>s.onVirtualFill(f));
 for(const cfg of pool){const price=cfg.initialPrice*premium;
  s.poolBySymbol.set(cfg.symbol,cfg);s.stocks.set(cfg.symbol,{symbol:cfg.symbol,name:cfg.name,market,industry:cfg.industry,
   price,intrinsic:cfg.mu,prevClose:price,dayOpen:price,dayHigh:price,dayLow:price,prevTickPrice:price,
   volatility:cfg.sigma*.5,lastReturn:0,lastVolume:10000,avgVolume:10000,baseVolume:10000,prevVolume:10000,
   dayVolume:0,minuteCounter:0,kline1min:[],kline5min:[],klineDaily:[],current1min:null,current5min:null,currentDaily:null,
   trendCounter:0,trendDirection:0,trendAccumulated:0,isTrending:false});
 }
 const days=[],length=tradingMinutesFor(market),peaks=s.aiLedger.map(l=>l.initialCash),drawdowns=peaks.map(()=>0);
 const auditDays=Math.max(6,Math.min(120,Number(process.env.AUDIT_DAYS)||6));
 for(let d=0;d<auditDays;d++){
  engine.setPrevCloses(s.getPrevCloses());engine.updatePrices(s.getPrices());engine.setDayOpen(s.getPrices());
  for(let tick=0;tick<length;tick++){
   await s.generateTick();engine.updatePrices(s.getPrices());engine.setVolatilities(s.getVolatilities());engine.refreshOrderBooks(s.getPrices());
   await s.postTickProcessing();
   s.aiLedger.forEach((l,i)=>{const eq=l.cash+[...l.positions].reduce((a,[sym,p])=>a+p.qty*s.stocks.get(sym).price,0);peaks[i]=Math.max(peaks[i],eq);drawdowns[i]=Math.max(drawdowns[i],(peaks[i]-eq)/peaks[i]);});
  }
  const rows=[...s.stocks.values()],rets=rows.map(st=>st.price/st.prevClose-1);
  const ups=rows.filter(st=>{const b=s.cnBandOf(st);return b&&st.price>=b.up-.005;}).length;
  const downs=rows.filter(st=>{const b=s.cnBandOf(st);return b&&st.price<=b.down+.005;}).length;
  days.push({day:d+1,meanReturnPct:+(rets.reduce((a,b)=>a+b,0)/rets.length*100).toFixed(2),upFraction:+(rets.filter(r=>r>0).length/rets.length).toFixed(3),limitUpFraction:+(ups/rows.length).toFixed(3),limitDownFraction:+(downs/rows.length).toFixed(3)});
  await s.endOfDay(true);s.marketRegime=regime;
 }
 const ai=s.getAiOpponents().map(r=>({id:r.id,pnlPct:r.pnlPct,fills:r.fills,closedTrades:r.trades,positions:r.positions}));
 return {market,regime,premium,seed,stocks:pool.length,days,ai,meanAiPnl:+(ai.reduce((a,r)=>a+r.pnlPct,0)/ai.length).toFixed(2),worstDrawdownPct:+(Math.max(...drawdowns)*100).toFixed(2),fills:ai.reduce((a,r)=>a+r.fills,0)};
}
(async()=>{
 const report={method:(Math.max(6,Math.min(120,Number(process.env.AUDIT_DAYS)||6)))+' complete game days, full stock pools, real generateTick/postTickProcessing/virtual matching; no real-player accounts, orders or network. Seeded randomness. Not a profitability guarantee.',drift:{hotSignal:.5,oldDailyDrift:.5*.9*5,newDailyDrift:dailyFactorDrift(.5*.9),oldGlobalEmotionDrift:.12*1.3*5,newGlobalEmotionDrift:dailyFactorDrift(.12*1.3)},scenarios:[]};
 for(const args of [['CN','bull',1,17],['CN','sideways',5,29],['HK','bear',1,31],['US','sideways',5,43]]){
  const row=await run(...args);report.scenarios.push(row);fs.writeFileSync(process.argv[2],JSON.stringify(report,null,2));console.log(JSON.stringify({market:row.market,regime:row.regime,premium:row.premium,days:row.days,fills:row.fills,meanAiPnl:row.meanAiPnl,worstDrawdownPct:row.worstDrawdownPct}));
  if(row.market==='CN'&&row.days.some(d=>d.limitUpFraction>.35||d.limitDownFraction>.35))throw Error('Broad daily sealing regression');
  if(row.fills===0)throw Error('No actual AI fills in scenario');
 }
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
