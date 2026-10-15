// Local synthetic backend for manual or CLI browser smoke checks. Never uses production data.
const fs=require('node:fs');const path=require('node:path');const http=require('node:http');const {spawn}=require('node:child_process');
const [binary,output]=process.argv.slice(2);if(!binary||!output)throw Error('Usage: node tooling/ui-fixture.cjs <Go binary> <C-drive evidence directory>');
fs.mkdirSync(output,{recursive:true});const root=path.resolve(__dirname,'../..');
const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'../internal/game/testdata/ledger.json'),'utf8'))[0];
let tick=0,pause=false,child,closing=false;const calls={},commands=[];
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://fixture');res.setHeader('Content-Type','application/json');calls[url.pathname]=(calls[url.pathname]??0)+1;
  if(url.pathname==='/_control'){pause=url.searchParams.get('pause')==='true';res.end(JSON.stringify({pause}));return;}
  if(url.pathname==='/_stats'){res.end(JSON.stringify({calls,commands,pause}));return;}
  let text='';for await(const chunk of req){text+=chunk;if(text.length>65536){res.writeHead(413);res.end('{}');return;}}const body=text?JSON.parse(text):{};
  let result;
  if(['/api/auth/login','/api/auth/register'].includes(url.pathname))result={token:'synthetic-upstream-token'};
  else if(url.pathname==='/api/auth/game-profile')result={subject:'game:fixture',user:{id:'fixture',username:'Synthetic',isActive:true}};
  else if(url.pathname==='/api/market/state'){
    result=structuredClone(fixture.state);for(const market of ['CN','HK','US'])Object.assign(result.markets[market].clock,{phase:'continuous',status:'continuous',now:new Date().toISOString(),timeZone:market==='US'?'America/New_York':'Asia/Shanghai'});
  }else if(url.pathname==='/api/market/stocks'){tick++;result=structuredClone(fixture.stocks);for(const stock of result){stock.price+=tick*.01;stock.dayHigh=Math.max(stock.price,stock.dayHigh);stock.changePct=(stock.price/stock.previousClose-1)*100;}}
  else if(url.pathname==='/api/fund')result=fixture.funds;
  else if(url.pathname==='/api/account/unified'){
    if(pause){res.writeHead(503);res.end(JSON.stringify({message:'Synthetic outage'}));return;}
    result=structuredClone(fixture.raw);result.ledgerVersion=Date.now();result.account.cash-=commands.length*1200;
  }else if(url.pathname==='/api/market/klines')result=Array.from({length:100},(_,index)=>({time:new Date(Date.UTC(2026,5,1+index)).toISOString(),open:12+index*.002,close:12.1+index*.002,high:12.2+index*.002,low:11.9+index*.002,volume:100+index}));
  else if(url.pathname==='/api/market/orderbook')result={bids:[{price:12.3,qty:500}],asks:[{price:12.4,qty:500}]};
  else if(url.pathname==='/api/trading/estimate')result={valid:true,price:12,fees:{totalFees:5}};
  else if(url.pathname==='/api/trading/order'){commands.push(body);result={success:true,order:{...fixture.raw.orders[0],status:'filled',filledQty:100}};}
  else if(url.pathname.startsWith('/api/market/reports'))result=[];
  else if(url.pathname.startsWith('/api/market/flow-signals'))result={};
  else {res.statusCode=404;result={message:'Unknown synthetic route'};}
  res.end(JSON.stringify(result));
});
server.listen(0,'127.0.0.1',async()=>{
  const port=await new Promise((resolve,reject)=>{const probe=require('node:net').createServer();probe.once('error',reject);probe.listen(0,'127.0.0.1',()=>{const port=probe.address().port;probe.close(()=>resolve(port));});});
  const backendURL='http://127.0.0.1:'+server.address().port;const log=path.join(output,'go-ui-server.log');fs.writeFileSync(log,'','utf8');const logfd=fs.openSync(log,'a');
  child=spawn(binary,[],{cwd:root,windowsHide:true,stdio:['ignore',logfd,logfd],env:{...process.env,GOMEMLIMIT:'64MiB',GOMAXPROCS:'2',REMASTER_PORT:String(port),REMASTER_HOST:'127.0.0.1',REMASTER_IDENTITY_URL:backendURL,REMASTER_ALLOWED_ORIGINS:'http://127.0.0.1:'+port,REMASTER_COOKIE_SECURE:'false',SGP_CATALOG:path.join(root,'remaster/packages/domain/catalog.json'),SGP_WEB_ROOT:path.join(root,'remaster/apps/web/dist'),UNIFIED_COMMAND_DB:path.join(output,'ui-commands.sqlite')}});
  const data={url:'http://127.0.0.1:'+port,backendURL,nodePid:process.pid,goPid:child.pid};fs.writeFileSync(path.join(output,'ui-ready.json'),JSON.stringify(data,null,2),'utf8');console.log(JSON.stringify(data));
  child.on('error',error=>{console.error(error.message);stop();});child.on('exit',code=>{console.log('Go fixture exited '+code);stop();});
});
function stop(){if(closing)return;closing=true;server.close();if(child&&!child.killed)child.kill();}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
