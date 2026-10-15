// Generate contract fixtures from the current TypeScript implementation, using synthetic accounts only.
require('../../remaster/tooling/runtime.cjs');
const {adaptLedger}=require('../../remaster/dist/apps/game-api/unified-ledger');
const {RoleSessions}=require('../../remaster/dist/apps/game-api/role-sessions');
const Database=require('better-sqlite3');
const {readFileSync,writeFileSync,mkdirSync}=require('node:fs');
const {resolve}=require('node:path');
const catalog=require('../../remaster/packages/domain/catalog.json');
const output=resolve(__dirname,'../internal/game/testdata');mkdirSync(output,{recursive:true});
const stocks=['CN','HK','US'].flatMap(market=>{
  const base=catalog.instruments.find(row=>row.market===market);
  return [{symbol:base.symbol,market,name:'Synthetic '+market,code:'test',industry:'半导体',listDate:'2024-01-01',description:'fixture',
    price:12.34,previousClose:12,changePct:2.83,dayOpen:12.01,dayHigh:13,dayLow:11,dayVolume:12345,dayAmount:150000,
    intrinsic:15,adjFactor:1.01,adjustmentSeries:[],volumeSource:'simulated-plus-matched',relativeVolume:1.2,modeledTurnoverPct:.03,
    priceLimits:market==='CN'?{up:13.2,down:10.8}:null,fundamentals:{consensusGrowth:.15}}];
});
stocks.push({...stocks[0],symbol:'NX999',code:'new',name:'Synthetic IPO'});
const state={gameDay:31,offHoursTrading:false,tickIntervalMs:60000,news:[
  {market:'CN',type:'bullish',publishedAt:'2026-10-15T06:00:00Z',title:'Synthetic news',description:'fixture'},
  {market:'US',type:'bearish',publishedAt:'2026-10-15T06:01:00Z',title:'Synthetic news',description:'fixture'}],
  markets:Object.fromEntries(['CN','HK','US'].map((market,index)=>[market,{gameDay:31+index,factors:{市场情绪:.01},industryCycles:{半导体:'peak'},hotTopics:[],
    clock:{date:'2026-10-15',now:'2026-10-15T07:00:00Z',minute:null,phase:'closed',status:'closed',nextOpen:'2026-10-16T01:30:00Z'}}]))};
const funds=[{id:'fund-1',nav:4.5},{id:'fund-2',nav:1.001}];
const cases=['CN','HK','US'].map((market,index)=>{
  const symbol=stocks.find(row=>row.market===market).symbol;
  const principal={owner:'game:fixture:'+market,name:'Synthetic',market,mode:'game'};
  const raw={ledgerVersion:123,account:{id:'synthetic-account-'+market,cash:12345.67,borrowed:2000.05,shortCollateral:100,
    leverage:2,initialEquity:100000,dayStartEquity:20000,seasonPoints:300,tier:'专家'},
    fxRates:{CN:1,HK:.93,US:7.2},positions:[{symbol,longQty:300,shortQty:index?20:0,longCost:10.01,shortCost:13,boughtDay:31,boughtToday:100}],
    funds:[{fundId:'fund-2',shares:500.1234,totalInvested:500,firstBuyDay:9}],
    orders:[{id:'synthetic-order',accountId:'synthetic-account-'+market,symbol,side:'buy',type:'limit',quantity:100,filledQty:20,
      status:'partial',price:11.99,avgFillPrice:12,createdAt:'2024-02-01T00:00:00Z'}],
    transactions:[],achievements:[{code:'first_trade'}],history:[{day:30,equity:20000}],
    reviews:[{title:'Synthetic review'},{title:'Other realm',market:market==='CN'?'US':'CN'}],metrics:{maxDrawdown:.12,sharpeRatio:.7,volatility:.2}};
  return {principal,raw,stocks,state,funds,expected:adaptLedger(raw,principal,stocks,state,funds)};
});
writeFileSync(resolve(output,'ledger.json'),JSON.stringify(cases,null,2)+'\n','utf8');
const db=new Database(':memory:');const key=Buffer.alloc(32,7);const keyPath=resolve(process.argv[2]??require('node:os').tmpdir(),'sgp-synthetic-key');
// Use a C-drive output directory when regenerating this fixture locally.
writeFileSync(keyPath,key,{mode:0o600});const roles=new RoleSessions(db,keyPath);
const entry={principal:{owner:'game:fixture:CN',name:'Synthetic',market:'CN',mode:'game',rememberMe:true},gameToken:'synthetic-upstream-token',expires:4102444800000};
roles.save('synthetic-role-token',entry,entry.expires);
writeFileSync(resolve(output,'node-session.json'),JSON.stringify({key:key.toString('base64'),token:'synthetic-role-token',entry,row:db.prepare('SELECT * FROM remembered_roles').get()},null,2)+'\n','utf8');
db.close();console.log('Generated synthetic TypeScript contract and encrypted-session fixtures');
