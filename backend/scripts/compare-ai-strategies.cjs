const fs=require('fs'),path=require('path'),Module=require('module');
const root=path.resolve(__dirname,'..');
const req=Module.createRequire(root+'/package.json');
const ts=req('typescript');
const legacyPath=root+'/dist/src/core/market-data/legacy-comparison.js';
const legacy=new Module(legacyPath,module);legacy.filename=legacyPath;legacy.paths=Module._nodeModulePaths(path.dirname(legacyPath));
legacy._compile(ts.transpileModule(fs.readFileSync(process.argv[2],'utf8').replace(/^\uFEFF/,''),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,experimentalDecorators:true,emitDecoratorMetadata:true}}).outputText,legacyPath);
const Current=req(root+'/dist/src/core/market-data/market-data.service').MarketDataService;
const Previous=legacy.exports.MarketDataService;
async function run(Service,scenario){
 const s=new Service(null,null,null,null,'HK');let orders=[],hook;
 s.applyUserFill=()=>{}; // Identical exogenous prices isolate decision quality from AI price impact.
 s.engine={setVirtualFillHook(fn){hook=fn;},pruneExpiredVirtualOrders(t){orders=orders.filter(o=>o.ttl>t);},getOrderBook(symbol){const p=s.stocks.get(symbol).price;return {bids:[{price:p*.9992,quantity:100000}],asks:[{price:p*1.0008,quantity:100000}]};},
 placeVirtualOrder(symbol,side,price,qty,ttl,opts){orders.push({symbol,side,price,qty,ttl,...opts});},
 executeVirtualMarketOrder(symbol,side,qty){return {filledQuantity:qty,avgPrice:s.stocks.get(symbol).price*(side==='buy'?1.0008:.9992),counterFills:[]};},async settleCounterFills(){return {ok:true}}};
 const prices=new Map();
 for(let i=0;i<40;i++){const symbol='H'+i,p=20+i;prices.set(symbol,p);s.stocks.set(symbol,{symbol,industry:'行业'+i%8,price:p,dayOpen:p,prevClose:p,volatility:.025,kline1min:[],dayVolume:0,baseVolume:10000});}
 const peaks=s.aiLedger.map(l=>l.initialCash),dd=peaks.map(()=>0);
 for(let day=1;day<=15;day++){
  s.gameDay=day;
  for(const st of s.stocks.values()){st.dayOpen=st.price;st.prevClose=st.price;}
  for(let tick=0;tick<240;tick++){
   s.tickCount=(day-1)*240+tick;
   let i=0;
   for(const st of s.stocks.values()){
    const drift=scenario==='bull'?.00012:scenario==='bear'?-.00012:0;
    const cyc=.0018*Math.sin((s.tickCount+i*13)*.23)+.0006*Math.cos((s.tickCount+i*7)*.047);
    const shock=scenario==='shock'&&day===8&&tick===60?-.08:0;
    st.price=Math.max(.1,st.price*(1+drift+cyc+shock));
    i++;
   }
   const remaining=[];
   for(const o of orders){const p=s.stocks.get(o.symbol).price*(o.side==='buy'?1.0008:.9992);if(o.ttl>s.tickCount&&((o.side==='buy'&&o.price>=p)||(o.side==='sell'&&o.price<=p)))hook?.({tag:o.tag,orderId:o.orderId,symbol:o.symbol,side:o.side,qty:o.qty,price:p});else if(o.ttl>s.tickCount)remaining.push(o);}
   orders=remaining;
   await s.applyAiTrading();
   for(const st of s.stocks.values()){st.kline1min.push({close:st.price});if(st.kline1min.length>1440)st.kline1min.shift();}
   s.aiLedger.forEach((l,i)=>{let eq=l.cash;for(const [sym,p]of l.positions)eq+=p.qty*s.stocks.get(sym).price;peaks[i]=Math.max(peaks[i],eq);dd[i]=Math.max(dd[i],(peaks[i]-eq)/peaks[i]);});
  }
  s.markAiEquityDaily();
 }
 const rows=s.getAiOpponents().map(r=>({name:r.name,returnPct:r.pnlPct,closedTrades:r.trades}));
 return {meanReturnPct:Number((rows.reduce((a,r)=>a+r.returnPct,0)/10).toFixed(2)),worstReturnPct:Math.min(...rows.map(r=>r.returnPct)),worstDrawdownPct:Number((Math.max(...dd)*100).toFixed(2)),positiveAgents:rows.filter(r=>r.returnPct>0).length,agents:rows};
}
(async()=>{const result={method:'15 days x 240 ticks, 40 symbols, identical deterministic public-price paths, simulated fills at 8bp half-spread, no fees, no AI price impact; not a production profitability guarantee',scenarios:{}};for(const scenario of ['bull','bear','sideways','shock'])result.scenarios[scenario]={before:await run(Previous,scenario),after:await run(Current,scenario)};fs.writeFileSync(process.argv[3],JSON.stringify(result,null,2));console.log(JSON.stringify(result));})().catch(e=>{console.error(e.stack);process.exitCode=1;});
