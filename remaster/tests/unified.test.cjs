const {test}=require('node:test');const assert=require('node:assert/strict');const http=require('node:http');
const {generateKeyPairSync,sign}=require('node:crypto');const Database=require('better-sqlite3');
const {adaptLedger,UnifiedLedger}=require('../dist/apps/game-api/unified-ledger');
const {createUnifiedApplication}=require('../dist/apps/game-api/unified-main');
const {io}=require('socket.io-client');
const principal={owner:'game:old-player:CN',name:'老玩家',market:'CN',mode:'game'};
const stocks=[{symbol:'T1',market:'CN',name:'芯澜半导体',industry:'半导体',price:12.34,changePct:1,dayOpen:12,dayHigh:13,dayLow:11,dayVolume:1000},{symbol:'H1',market:'HK',name:'港股',price:20}];
const raw={ledgerVersion:123,account:{id:'original-account-uuid',cash:12345.67,borrowed:2000.05,shortCollateral:100,leverage:2,initialEquity:100000,dayStartEquity:20000,seasonPoints:300,tier:'专家'},
 positions:[{symbol:'T1',longQty:300,shortQty:0,longCost:10.01,boughtDay:31,boughtToday:100}],
 funds:[{fundId:'fund-2',shares:500.1234,totalInvested:500,firstBuyDay:9}],
 orders:[{id:'old-pending',accountId:'original-account-uuid',symbol:'T1',side:'buy',type:'limit',quantity:100,filledQty:20,status:'partial',price:11.99,avgFillPrice:12,createdAt:'2024-02-01T00:00:00Z'}],
 transactions:[{id:'old-trade',symbol:'T1',side:'buy',quantity:100,price:10.01,turnover:1001,totalFees:5}],
 achievements:[{code:'first_trade'}],history:[{day:30,equity:20000}],reviews:[{title:'旧复盘'}],metrics:{maxDrawdown:.12,sharpeRatio:.7}};
const state={gameDay:31,offHoursTrading:true,tickIntervalMs:1000,hotTopics:['行业库存回落'],markets:{CN:{gameDay:31},HK:{gameDay:20},US:{gameDay:21}}};
const funds=[{id:'fund-1',nav:4.5},{id:'fund-2',nav:1.001}];
test('unified view preserves original IDs, money, debt, fractional funds, T+1, orders and private realm',()=>{
 const input=JSON.stringify(raw);const s=adaptLedger(raw,principal,stocks,state,funds);const a=s.accounts.CN;
 assert.equal(a.id,raw.account.id);assert.equal(a.cash,1234567);assert.equal(a.debt,200005);assert.equal(a.collateral,10000);
 assert.equal(a.positions[0].quantity,300);assert.equal(a.positions[0].sellable,200);assert.equal(a.positions[0].cost,1001);
 assert.equal(a.equity,1234567+300*1234+10000-200005+Math.round(500.1234*1.001*100));
 assert.equal(s.orders[0].remaining,80);assert.equal(s.orders[0].price,1199);assert.equal(s.orders[0].id,'old-pending');
 assert.equal(s.formal.fundHoldings[0].shares,500.1234);assert.equal(s.accounts.HK,null);assert.equal(s.quotes.H1,undefined);
 assert.equal(JSON.stringify(raw),input);assert.equal(s.mode,'real');assert.equal(s.formal.ledger,'legacy-authoritative');
});
test('HK/US fund equity converts original CNY shares and NAV into realm currency without changing shares',()=>{
 for(const [market,fx] of [['HK',.93],['US',7.2]]){
  const input={...raw,account:{...raw.account,cash:99000,borrowed:0,shortCollateral:0},positions:[],orders:[],
   fxRates:{HK:.93,US:7.2},funds:[{fundId:'fund-2',shares:1000*fx,totalInvested:1000*fx}]};
  const before=JSON.stringify(input);const s=adaptLedger(input,{...principal,market},stocks,state,[{id:'fund-2',nav:1}]);
  assert.equal(s.accounts[market].equity,10000000);assert.equal(s.markets[market].fundNav.money,Math.round(10000/fx));
  assert.equal(s.formal.fundHoldings[0].shares,1000*fx);assert.equal(JSON.stringify(input),before);
 }
});
test('persistent command journal deduplicates funds and refuses to replay interrupted writes',async()=>{
 const db=new Database(':memory:');let calls=0;const auth={forward:async()=>{calls++;return {success:true};}};const ledger=new UnifiedLedger(auth,db);
 const body={kind:'fund',market:'CN',fund:'money',action:'buy',amount:10000};
 await ledger.command('opaque',principal,body,'fund-test-key');await ledger.command('opaque',principal,body,'fund-test-key');assert.equal(calls,1);
 await assert.rejects(()=>ledger.command('opaque',principal,{...body,amount:20000},'fund-test-key'),/幂等键/);
 auth.forward=async()=>{calls++;throw Error('connection lost after write');};
 await assert.rejects(()=>ledger.command('opaque',principal,body,'unknown-write-key'));const reopened=new UnifiedLedger(auth,db);
 await assert.rejects(()=>reopened.command('opaque',principal,body,'unknown-write-key'),/不会重复扣款/);assert.equal(calls,2);
 await assert.rejects(()=>ledger.command('opaque',principal,{...body,market:'US'},'realm-test-key'),/区服/);
 await assert.rejects(()=>ledger.command('opaque',principal,{kind:'transfer',from:'CN',to:'US',amount:100},'transfer-test-key'),/跨区/);db.close();
});
test('parallel order requests cannot duplicate settlement and long idempotency keys cannot collide by prefix',async()=>{
 const db=new Database(':memory:');const ids=[];const auth={forward:async(_token,path,_method,body)=>{
  if(path==='/api/market/stocks')return stocks;if(path==='/api/market/state')return state;if(path==='/api/fund')return funds;
  ids.push(body.clientOrderId);await new Promise(resolve=>setTimeout(resolve,15));return {success:true,order:raw.orders[0]};
 }};const ledger=new UnifiedLedger(auth,db);const body={kind:'order',market:'CN',input:{symbol:'T1',side:'buy',type:'limit',quantity:100,price:1199}};
 const parallel=await Promise.allSettled([ledger.command('opaque',principal,body,'parallel-order-key'),ledger.command('opaque',principal,body,'parallel-order-key')]);
 assert.equal(parallel.filter(row=>row.status==='fulfilled').length,1);assert.equal(ids.length,1);
 const prefix='x'.repeat(64);await ledger.command('opaque',principal,body,prefix+'A');await ledger.command('opaque',principal,body,prefix+'B');
 assert.notEqual(ids[1],ids[2]);assert.equal(ids[1].length,64);db.close();
});
test('formal HTTP + real websocket use the old ledger for both login methods and never create a test player',async()=>{
 const pair=generateKeyPairSync('ed25519');const now=Math.floor(Date.now()/1000);const header=Buffer.from(JSON.stringify({alg:'EdDSA',kid:'fixture'})).toString('base64url');
 const payload=Buffer.from(JSON.stringify({iss:'https://bobbycn.cc',aud:'bobbycn.cc',sub:'site-player',sid:'site-session',iat:now,exp:now+600})).toString('base64url');
 const siteToken=header+'.'+payload+'.'+sign(null,Buffer.from(header+'.'+payload),pair.privateKey).toString('base64url');
 const seen=[];let orderPayload,identityLimited=false;const fixture=http.createServer(async(req,res)=>{let input='';for await(const chunk of req)input+=chunk;seen.push(req.url);const body=input?JSON.parse(input):{};let result;
   if(req.url==='/api/auth/login'||req.url==='/api/auth/register')result={token:'native-backend-token'};
   else if(req.url==='/api/auth/game-profile')result={subject:'site:site-player',user:{id:'old-player',username:'老玩家',isActive:true}};
   else if(req.url==='/api/auth/site-session')result={token:siteToken,user:{id:'old-player',username:'老玩家'}};
   else if(req.url.includes('jwks.json'))result={keys:[{...pair.publicKey.export({format:'jwk'}),kid:'fixture',alg:'EdDSA'}]};
   else if(req.url.includes('introspect')){if(identityLimited){res.statusCode=429;result={message:'fixture rate limit'};}else result={active:true,sub:'site-player',sid:'site-session'};}
   else if(req.url==='/api/market/stocks')result=stocks;
   else if(req.url==='/api/market/state')result=state;
   else if(req.url==='/api/fund')result=funds;
   else if(req.url.startsWith('/api/account/unified'))result={...raw,ledgerVersion:Date.now()};
   else if(req.url.startsWith('/api/trading/order')){orderPayload=body;result={success:true,order:{...raw.orders[0],clientOrderId:body.clientOrderId}};}
   else if(req.url.startsWith('/api/market/klines'))result=[{time:'2024-02-01T02:00:00Z',open:12,high:13,low:11,close:12.34,volume:100}];
   else {res.statusCode=404;result={message:'unexpected fixture route'};}
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));});
 await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));const app=await createUnifiedApplication({port:0,database:':memory:',identityBaseUrl:'http://127.0.0.1:'+fixture.address().port});let socket;
 const call=async(path,body,token,extra={})=>{const res=await fetch(app.url+'/api/v2'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...extra},body:body?JSON.stringify(body):undefined});return {status:res.status,data:await res.json()};};
 try{
  const native=(await call('/auth/login',{username:'old-player',password:'fixture-password',market:'CN'})).data;
  const site=(await call('/auth/site-session',{market:'CN'})).data;assert.equal(native.owner,site.owner);assert.equal(native.owner,principal.owner);
  assert.notEqual(native.token,'native-backend-token');const snapshot=(await call('/state',undefined,native.token)).data;assert.equal(snapshot.accounts.CN.id,'original-account-uuid');assert.equal(snapshot.accounts.CN.cash,1234567);
  socket=io(app.url+'/v2',{auth:{token:native.token,market:'CN'},transports:['websocket'],reconnection:false});
  const live=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('websocket timeout')),4000);socket.once('snapshot',value=>{clearTimeout(timer);resolve(value);});socket.once('connect_error',reject);});assert.equal(live.accounts.CN.id,'original-account-uuid');
  const order={kind:'order',market:'CN',input:{symbol:'T1',side:'buy',type:'limit',quantity:100,price:1199}};
  const placed=await call('/commands',order,native.token,{'Idempotency-Key':'order-test-key'});assert.equal(placed.data.success,true);assert.equal(orderPayload.price,11.99);
  const other=await call('/history/H1?interval=day',undefined,native.token);assert.equal(other.status,400);
  const bars=(await call('/history/T1?interval=1m',undefined,native.token)).data;assert.equal(bars[0].open,1200);assert.equal(bars[0].close,1234);
  assert.equal(seen.some(path=>path.includes('create-player')),false);
  const repeated=await call('/commands',order,site.token,{'Idempotency-Key':'order-test-key'});assert.deepEqual(repeated.data,placed.data);
  identityLimited=true;assert.equal((await call('/state',undefined,site.token)).status,429);identityLimited=false;
  assert.equal((await call('/state',undefined,site.token)).status,200);
  await call('/auth/logout',{},native.token);assert.equal((await call('/state',undefined,native.token)).status,401);
 }finally{socket?.disconnect();await app.close();await new Promise(resolve=>fixture.close(resolve));}
});
