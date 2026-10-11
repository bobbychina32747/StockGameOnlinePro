import { BadRequestException, HttpException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuthBridge, Principal } from './auth';
import { MARKETS, MarketId } from '../../packages/domain/types';
import { Snapshot } from '../../packages/protocol/snapshot';
import catalog from '../../packages/domain/catalog.json';
import { commandKey, parseCommand } from '../../packages/protocol/commands';

export const cents=(value:unknown)=>Math.round((Number(value)||0)*100);
const num=(value:unknown)=>Number(value)||0;
const catalogBySymbol=new Map(catalog.instruments.map(row=>[row.symbol,row]));
interface CommandDatabase {exec(sql:string):unknown;prepare(sql:string):{get(...values:unknown[]):unknown;run(...values:unknown[]):unknown}}
export function mapOrder(row:any,day:number) {
  return {id:row.id,commandId:row.clientOrderId??row.id,accountId:row.accountId,symbol:row.symbol,
    side:row.side,type:row.type,quantity:row.quantity,remaining:Math.max(0,row.quantity-row.filledQty),
    filled:row.filledQty,averagePrice:cents(row.avgFillPrice),price:row.price==null?undefined:cents(row.price),
    triggerPrice:row.triggerPrice==null?undefined:cents(row.triggerPrice),displayQuantity:row.displayQty,
    visible:row.displayQty??Math.max(0,row.quantity-row.filledQty),sequence:Date.parse(row.createdAt)||0,
    createdDay:day,status:row.status==='open'?'pending':row.status,triggered:!!row.triggerLog,postClose:!!row.postClose,error:row.rejectReason};
}
export function adaptLedger(raw:any,principal:Principal,stocks:any[],state:any,fundDefs:any[]):Snapshot {
  const a=raw.account;const day=num(state.markets?.[principal.market]?.gameDay??state.gameDay);
  const instruments=stocks.filter(row=>row.market===principal.market).map(row=>({
    ...catalogBySymbol.get(row.symbol),symbol:row.symbol,code:row.code??row.symbol,name:row.name,market:principal.market,
    industry:row.industry,listedAt:row.listDate,description:row.description,
    initialPrice:catalogBySymbol.get(row.symbol)?.initialPrice??cents(row.price),volatility:catalogBySymbol.get(row.symbol)?.volatility??.02,
  }));
  const quotes=Object.fromEntries(stocks.filter(row=>row.market===principal.market).map(row=>{
    const price=cents(row.price),change=num(row.changePct)/100,previousClose=Math.round(price/(1+change));
    return [row.symbol,{symbol:row.symbol,price,previousClose,fairValue:cents(row.intrinsic)||price,open:cents(row.dayOpen)||price,
      high:cents(row.dayHigh)||price,low:cents(row.dayLow)||price,volume:num(row.dayVolume),turnover:0,
      momentum:0,bubble:0,earningsGrowth:num(row.fundamentals?.consensusGrowth),pe:0,dividendFactor:num(row.adjFactor)||1,change}];
  }));
  const positions=raw.positions.filter((p:any)=>p.longQty||p.shortQty).map((p:any)=>{
    const price=quotes[p.symbol]?.price??cents(p.longCost||p.shortCost),quantity=num(p.longQty);
    const locked=num(p.boughtToday);
    return {symbol:p.symbol,lots:[{quantity,cost:cents(p.longCost),boughtDay:p.boughtDay??0,debt:0}],
      quantity,shortQuantity:num(p.shortQty),shortProceeds:cents(p.shortCost)*num(p.shortQty),collateral:0,
      sellable:principal.market==='CN'?Math.max(0,quantity-locked):quantity,cost:cents(p.longCost),
      pnl:(price-cents(p.longCost))*quantity+(cents(p.shortCost)-price)*num(p.shortQty)};
  });
  const moneyFund=raw.funds.find((f:any)=>f.fundId==='fund-2');const etf=raw.funds.find((f:any)=>f.fundId==='fund-1');
  // Original fund shares/NAV are CNY; account balances are in their realm currency.
  const cnyPerUnit=(market:MarketId)=>market==='CN'?1:num(raw.fxRates?.[market])||1;
  const fundsValue=raw.funds.reduce((sum:number,f:any)=>sum+num(f.shares)*num(fundDefs.find(d=>d.id===f.fundId)?.nav),0)/cnyPerUnit(principal.market);
  const positionValue=raw.positionValue==null?positions.reduce((sum:number,p:any)=>sum+(p.quantity-p.shortQuantity)*(quotes[p.symbol]?.price??p.cost),0):cents(raw.positionValue);
  const equity=cents(a.cash)+positionValue+cents(a.shortCollateral)-cents(a.borrowed)+cents(fundsValue);
  const orders=raw.orders.map((row:any)=>mapOrder(row,day));
  // Legacy matching reserves cash at validation time, not by debiting every pending order.
  const reserved=orders.filter((o:any)=>['pending','partial'].includes(o.status)&&o.side==='buy').reduce((sum:number,o:any)=>sum+o.remaining*(o.price??quotes[o.symbol]?.price??0),0);
  const held={id:a.id,owner:principal.owner,name:principal.name,market:principal.market,actor:'player' as const,
    cash:cents(a.cash),debt:cents(a.borrowed),collateral:cents(a.shortCollateral),leverage:num(a.leverage)||1,
    initialEquity:cents(a.initialEquity),positions,funds:{money:num(moneyFund?.shares)*100,etf:num(etf?.shares)*100},
    achievements:(raw.achievements??[]).map((row:any)=>row.code),equityHistory:(raw.history??[]).map((row:any)=>({day:row.day,equity:cents(row.equity)})),
    seasonPoints:num(a.seasonPoints),adaptation:0,lastEquity:cents(a.dayStartEquity),available:cents(a.cash),reserved,equity,
    totalReturn:equity/Math.max(1,cents(a.initialEquity))-1,marginRatio:null,
    metrics:{maxDrawdown:num(raw.metrics?.maxDrawdown),sharpe:num(raw.metrics?.sharpeRatio),volatility:num(raw.metrics?.volatility),
      profitableDays:0,days:raw.history?.length??0,totalReturn:equity/Math.max(1,cents(a.initialEquity))-1}};
  const markets=Object.fromEntries(MARKETS.map(m=>{const src=state.markets?.[m]??state;return [m,{
    clock:{day:num(src.gameDay),date:new Date(Date.UTC(2024,0,1+num(src.gameDay))).toISOString().slice(0,10),minute:num(src.tickCount)%({CN:240,HK:330,US:390}[m]),
      phase:state.offHoursTrading||src.isTradingTime?'continuous':src.isPostCloseTrading?'post-close':'closed',settledDay:num(src.gameDay)-1,lastRealMinute:''},
    sentiment:num(src.factors?.['市场情绪']),rate:.025,inflation:0,growth:0,sectors:Object.fromEntries(Object.entries(src.industryCycles??{}).map(([industry,phase])=>[industry,{cycle:Math.max(0,['expansion','peak','contraction','trough'].indexOf(String(phase))),trend:0,heat:0}])),lastNavDay:day,
    fundNav:{money:Math.round(num(fundDefs.find(d=>d.id==='fund-2')?.nav)/cnyPerUnit(m)*10000),etf:Math.round(num(fundDefs.find(d=>d.id==='fund-1')?.nav)/cnyPerUnit(m)*10000),basket:0,dividend:0},
  }];})) as Snapshot['markets'];
  const events=(state.markets?.[principal.market]?.hotTopics??state.hotTopics??[]).map((item:any,index:number)=>({
    id:'topic:'+index+':'+day,sequence:index,market:principal.market,day,kind:'topic',title:typeof item==='string'?item:item.title??item.topic??item.industry+'行业热点',
    detail:typeof item==='string'?item:item.content??item.description??`热度 ${(num(item.strength)*100).toFixed(0)}% · 持续 ${num(item.duration)} 个交易日`,impact:num(item.impact),time:Date.now(),
  }));
  events.unshift(...(state.news??[]).filter((item:any)=>item.market===principal.market).slice(0,60).map((item:any,index:number)=>({id:'news:'+item.publishedAt+':'+index,sequence:index,market:principal.market,day,kind:item.type??'news',title:item.title,detail:item.description??'',impact:item.type==='bullish'?1:item.type==='bearish'?-1:0,time:Date.parse(item.publishedAt)||Date.now()})));
  const snapshot:Snapshot={protocolVersion:2,kind:'snapshot',worldVersion:raw.ledgerVersion,sequence:raw.ledgerVersion,mode:'real',
    simulatedAt:Object.fromEntries(MARKETS.map(m=>[m,markets[m].clock])) as Snapshot['simulatedAt'],
    instruments,quotes,markets,indices:[{market:principal.market,value:instruments.length?instruments.reduce((s,row)=>s+quotes[row.symbol].price/Math.max(1,row.initialPrice),0)/instruments.length*1000:1000,
      change:instruments.length?instruments.reduce((s,row)=>s+quotes[row.symbol].change,0)/instruments.length:0,advancing:instruments.filter(row=>quotes[row.symbol].change>0).length,count:instruments.length}],
    accounts:{CN:null,HK:null,US:null,[principal.market]:held},orders,trades:[],events,seasons:[],rankings:[]};
  return Object.assign(snapshot,{formal:{ledger:'legacy-authoritative',tier:a.tier,metrics:raw.metrics,reviews:raw.reviews,achievements:raw.achievements,
    fundHoldings:raw.funds,funds:fundDefs,tickIntervalMs:state.tickIntervalMs,offHoursTrading:state.offHoursTrading}});
}

export class UnifiedLedger {
  private cached?:{at:number;stocks:any[];state:any;funds:any[]};
  private fetching?:Promise<{at:number;stocks:any[];state:any;funds:any[]}>;
  constructor(readonly auth:AuthBridge,readonly db:CommandDatabase) {
    db.exec('CREATE TABLE IF NOT EXISTS formal_commands (owner TEXT NOT NULL, key TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL, result TEXT, PRIMARY KEY(owner,key))');
  }
  async publicData(token:string) {
    if(this.cached&&Date.now()-this.cached.at<1500)return this.cached;
    if(!this.fetching)this.fetching=Promise.all(['/api/market/stocks','/api/market/state','/api/fund'].map(path=>this.auth.forward(token,path)))
      .then(([stocks,state,funds])=>this.cached={at:Date.now(),stocks,state,funds}).finally(()=>this.fetching=undefined);
    return this.fetching;
  }
  async snapshot(token:string,principal:Principal) {
    const [data,raw]=await Promise.all([this.publicData(token),this.auth.forward(token,'/api/account/unified?mode='+principal.market)]);
    return adaptLedger(raw,principal,data.stocks,data.state,data.funds);
  }
  async symbol(token:string,principal:Principal,symbol:string) {
    if(typeof symbol!=='string'||!(await this.publicData(token)).stocks.some(row=>row.symbol===symbol&&row.market===principal.market))throw new BadRequestException('不能查看或交易其他区服标的');
  }
  async history(token:string,principal:Principal,symbol:string,interval:string,adjusted=false) {
    await this.symbol(token,principal,symbol);const timeframe=({ '1m':'1min','5m':'5min','60m':'60min',day:'daily',week:'weekly',month:'monthly'} as Record<string,string>)[interval];
    if(!timeframe)throw new BadRequestException('周期无效');
    const bars=await this.auth.forward(token,`/api/market/klines?symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}`);
    const stock=(await this.publicData(token)).stocks.find(row=>row.symbol===symbol);
    return bars.map((bar:any)=>{
      const time=Date.parse(bar.time),day=Math.floor((time-Date.UTC(2024,0,1))/86400000);
      const factor=adjusted?num(stock?.adjustmentSeries?.filter((row:any)=>row.day<=day).at(-1)?.factor)||1:1;
      return {time,day,open:Math.round(cents(bar.open)*factor),close:Math.round(cents(bar.close)*factor),high:Math.round(cents(bar.high)*factor),low:Math.round(cents(bar.low)*factor),volume:num(bar.volume)};
    });
  }
  async book(token:string,p:Principal,symbol:string) {
    await this.symbol(token,p,symbol);const book=await this.auth.forward(token,'/api/market/orderbook?symbol='+encodeURIComponent(symbol));
    return {bids:(book.bids??[]).map((r:any)=>({price:cents(r.price),quantity:r.quantity??r.qty??r.size??r.volume})),asks:(book.asks??[]).map((r:any)=>({price:cents(r.price),quantity:r.quantity??r.qty??r.size??r.volume})),worldVersion:Date.now()};
  }
  result(owner:string,key:string) {const row=this.db.prepare('SELECT * FROM formal_commands WHERE owner=? AND key=?').get(owner,key) as any;return row?.result?{found:true,result:JSON.parse(row.result)}:{found:false,pending:!!row};}
  async command(token:string,p:Principal,body:any,keyValue:unknown) {
    let key:string;try{key=commandKey(keyValue);}catch{throw new BadRequestException('需要有效的幂等键');}
    if(body?.market!==undefined&&body.market!==p.market)throw new BadRequestException('角色区服不可切换');
    if(!['order','cancel','leverage','reset','fund','season'].includes(body?.kind))throw new BadRequestException('正式版不支持该操作或跨区划转');
    const json=JSON.stringify(body);const previous=this.db.prepare('SELECT * FROM formal_commands WHERE owner=? AND key=?').get(p.owner,key) as any;
    if(previous&&previous.body!==json)throw new BadRequestException('幂等键已用于其他操作');
    if(previous?.result)return JSON.parse(previous.result);
    // An interrupted write is never blindly replayed, including funds and season enrollment.
    if(previous)throw new ServiceUnavailableException('原操作仍在处理或结果未知，请在资金流水核对；系统不会重复扣款');
    let path:string,method='POST',payload:any={};const mode='?mode='+p.market;
    if(body.kind==='order'){
      const i=this.orderInput(body,p);await this.symbol(token,p,i.symbol);
      path='/api/trading/order'+mode;payload={...i,displayQty:i.displayQuantity,displayQuantity:undefined,clientOrderId:createHash('sha256').update(key).digest('hex')};
    }else if(body.kind==='cancel'){
      if(typeof body.orderId!=='string'||body.orderId.length>100)throw new BadRequestException('订单无效');
      path='/api/trading/order/'+encodeURIComponent(body.orderId)+mode;method='DELETE';payload=undefined;
    }else if(body.kind==='leverage'){
      if(typeof body.leverage!=='number'||!Number.isFinite(body.leverage)||body.leverage<1||body.leverage>3)throw new BadRequestException('杠杆必须为1–3');
      path='/api/account/leverage'+mode;payload={leverage:body.leverage};
    }else if(body.kind==='reset'){path='/api/account/reset'+mode;payload={preset:'散户'};
    }else if(body.kind==='season'){path='/api/season/enroll';
    }else {
      if(!['money','etf'].includes(body.fund)||!['buy','sell'].includes(body.action)||!Number.isSafeInteger(body.amount)||body.amount<=0)throw new BadRequestException('基金交易参数无效');
      path=`/api/fund/${body.fund==='money'?'fund-2':'fund-1'}/${body.action==='buy'?'subscribe':'redeem'}${mode}&${body.action==='buy'?'amount':'shares'}=${body.amount/100}`;
    }
    const inserted=this.db.prepare('INSERT OR IGNORE INTO formal_commands(owner,key,body,state) VALUES(?,?,?,?)').run(p.owner,key,json,'pending') as {changes:number};
    if(!inserted.changes){const existing=this.db.prepare('SELECT * FROM formal_commands WHERE owner=? AND key=?').get(p.owner,key) as any;
      if(existing?.body!==json)throw new BadRequestException('幂等键已用于其他操作');
      if(existing.result)return JSON.parse(existing.result);throw new ServiceUnavailableException('原操作正在处理，请查询原结果');}
    try {
      const data=await this.auth.forward(token,path,method,payload);
      const result={success:data.success!==false,error:data.error,order:data.order?mapOrder(data.order,0):undefined,data,version:Date.now()};
      this.db.prepare('UPDATE formal_commands SET state=?,result=? WHERE owner=? AND key=?').run('complete',JSON.stringify(result),p.owner,key);return result;
    }catch(error){
      if(error instanceof HttpException&&error.getStatus()<500){const result={success:false,error:error.message,version:Date.now()};this.db.prepare('UPDATE formal_commands SET state=?,result=? WHERE owner=? AND key=?').run('complete',JSON.stringify(result),p.owner,key);return result;}throw error;
    }
  }
  orderInput(body:any,p:Principal) {
    let parsed:any;try{parsed=parseCommand({kind:'order',market:p.market,input:body.input},p.owner);}catch{throw new BadRequestException('委托参数无效');}
    const i=parsed.input;
    if(typeof i.symbol!=='string'||!['buy','sell','short','cover'].includes(i.side)||!['market','limit','stop','stop-limit','fok','ioc','iceberg'].includes(i.type)||!Number.isSafeInteger(i.quantity)||i.quantity<1||i.quantity>1000000)throw new BadRequestException('委托参数无效');
    for(const name of ['price','triggerPrice'])if(i[name]!==undefined&&(!Number.isSafeInteger(i[name])||i[name]<1||i[name]>100000000))throw new BadRequestException('价格必须是有效的分单位整数');
    if(i.displayQuantity!==undefined&&(!Number.isSafeInteger(i.displayQuantity)||i.displayQuantity<1||i.displayQuantity>=i.quantity))throw new BadRequestException('冰山显示数量无效');
    return {...i,price:i.price===undefined?undefined:i.price/100,triggerPrice:i.triggerPrice===undefined?undefined:i.triggerPrice/100};
  }
  async estimate(token:string,p:Principal,body:any){
    if(body.market!==p.market)throw new BadRequestException('角色区服不可切换');
    const i=this.orderInput(body,p);await this.symbol(token,p,i.symbol);
    const validation=await this.auth.forward(token,'/api/trading/estimate?mode='+p.market,'POST',{...i,displayQty:i.displayQuantity,displayQuantity:undefined});
    if(!validation.valid)return validation;
    const snapshot=await this.snapshot(token,p);const held=snapshot.accounts[p.market]!;
    const price=cents(validation.price)||snapshot.quotes[i.symbol].price;const fee=cents(validation.fees.totalFees);
    const availableSell=held.positions.find(row=>row.symbol===i.symbol)?.sellable??0;
    return {valid:true,price,quantity:i.quantity,filled:0,total:price*i.quantity,fee,cash:held.cash,availableSell,status:'pending',worldVersion:snapshot.worldVersion,estimated:true};
  }
}
