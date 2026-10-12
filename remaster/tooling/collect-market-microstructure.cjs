const fs=require('node:fs'),path=require('node:path');
const universe=require('../packages/domain/research-universe.json');
const out=process.argv[2];if(!out)throw Error('Output directory required');fs.mkdirSync(out,{recursive:true});
const cutoff=Date.parse('2026-10-10T00:00:00Z')/1000,start=Date.parse('2016-10-01T00:00:00Z')/1000;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const labels=new Map();for(const [sector,symbols]of Object.entries(universe))for(const symbol of symbols)labels.set(symbol,[...(labels.get(symbol)||[]),sector]);
const market=s=>s.endsWith('.HK')||s==='^HSI'?'HK':/\.(SS|SZ)$/.test(s)?'CN':'US';
const intraday=[...new Set(Object.values(universe).flatMap(symbols=>['CN','HK','US'].map(m=>symbols.find(s=>market(s)===m))))];
const failures=[],counts={};
async function request(url,sec=false){for(let attempt=0;attempt<3;attempt++){
 try{const r=await fetch(url,{headers:{'User-Agent':sec?'StockGameOnlinePro research https://github.com/bobbychina32747/StockGameOnlinePro':'Mozilla/5.0'},signal:AbortSignal.timeout(20000)});
 if(r.status===429){await sleep(10000);throw Error('rate-limited');}if(!r.ok)throw Error('HTTP '+r.status);return await r.text();
 }catch(e){if(attempt===2)throw e;await sleep(1000*(attempt+1));}
}}
function append(file,record){const filename=path.join(out,file);fs.appendFileSync(filename,JSON.stringify(record)+'\n');if(fs.statSync(filename).size>90*1024*1024)throw Error('Dataset file exceeded 90 MB');}
async function charts(symbols,interval,file){
 const completed=new Set(fs.existsSync(path.join(out,file))?fs.readFileSync(path.join(out,file),'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l).symbol):[]);
 for(const symbol of symbols){if(completed.has(symbol))continue;
 // Provider retention is measured from request time, not our completed-day cutoff.
 const from=interval==='1d'?start:Math.max(cutoff-54*86400,Math.floor(Date.now()/1000)-58*86400);
 if(from>=cutoff)throw Error('Intraday cutoff is outside provider retention; choose a new research cutoff');
 const url=`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${from}&period2=${cutoff}&interval=${interval}&events=div%2Csplits`;
 try{const result=JSON.parse(await request(url)).chart?.result?.[0];if(!result?.timestamp)throw Error('No timestamps');
 const q=result.indicators.quote[0],adj=result.indicators.adjclose?.[0]?.adjclose;
 const rows=result.timestamp.map((t,i)=>[t*1000,q.open[i],q.high[i],q.low[i],q.close[i],adj?.[i]??q.close[i],q.volume[i]])
  .filter(row=>row[0]<cutoff*1000&&row.slice(1,6).every(v=>Number.isFinite(v)&&v>0)&&Number.isFinite(row[6])&&row[6]>=0);
 if(rows.length<(interval==='1d'?100:100))throw Error('Insufficient bars: '+rows.length);
 append(file,{symbol,sectors:labels.get(symbol)||['auxiliary'],market:market(symbol),source:url,retrievedAt:new Date().toISOString(),timezone:result.meta.exchangeTimezoneName,currency:result.meta.currency,
  interval,columns:['time','open','high','low','close','adjustedClose','volume'],volumeUnit:'provider-reported shares, unchanged',events:result.events||{},rows});
 completed.add(symbol);counts[file]={symbols:completed.size};console.log(`${file} ${completed.size}/${symbols.length} ${symbol} ${rows.length}`);
 }catch(e){failures.push({symbol,interval,error:e.message});console.log('FAILED '+symbol+' '+interval+' '+e.message);}
 fs.writeFileSync(path.join(out,'collection.json'),JSON.stringify({cutoff:'2026-10-10T00:00:00Z',counts,failures},null,2));await sleep(400);
 }
}
async function fundamentals(){
 try{const mapping=JSON.parse(await request('https://www.sec.gov/files/company_tickers.json',true));
 const entries=Object.values(mapping);for(const symbol of [...labels.keys()].filter(s=>market(s)==='US')){
  const issuer=entries.find(e=>e.ticker===symbol);if(!issuer){failures.push({symbol,source:'SEC',error:'No ticker-to-CIK mapping'});continue;}
  const cik=String(issuer.cik_str).padStart(10,'0'),url=`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
  try{const body=JSON.parse(await request(url,true));const tags=new Set(['EntityCommonStockSharesOutstanding','CommonStockSharesOutstanding','WeightedAverageNumberOfDilutedSharesOutstanding','Revenues','RevenueFromContractWithCustomerExcludingAssessedTax','NetIncomeLoss','Assets','StockholdersEquity','EarningsPerShareDiluted','PaymentsOfDividends']);
   const facts=[];for(const [namespace,group]of Object.entries(body.facts||{}))for(const [tag,definition]of Object.entries(group))if(tags.has(tag))for(const [unit,rows]of Object.entries(definition.units||{}))for(const row of rows){
    if(row.filed>='2016-10-01'&&row.filed<'2026-10-10')facts.push({namespace,tag,unit,...row});}
   append('fundamentals.ndjson',{symbol,cik,source:url,retrievedAt:new Date().toISOString(),facts});console.log('SEC '+symbol+' '+facts.length+' facts');
  }catch(e){failures.push({symbol,source:'SEC',error:e.message});}await sleep(500);
 }
 }catch(e){failures.push({source:'SEC mapping',error:e.message});console.log('SEC unavailable: '+e.message);}
}
async function macro(){for(const id of ['DGS10','DGS2','DFF','VIXCLS','DEXCHUS','DEXHKUS','DCOILWTICO','DCOILBRENTEU','T10Y2Y','BAMLH0A0HYM2']){
 if(fs.existsSync(path.join(out,'macro.ndjson'))&&fs.readFileSync(path.join(out,'macro.ndjson'),'utf8').split('\n').filter(Boolean).some(line=>JSON.parse(line).id===id))continue;
 const url=`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=2016-10-01&coed=2026-10-09`;
 try{const csv=await request(url);const rows=csv.trim().split(/\r?\n/).slice(1).map(l=>l.split(',')).filter(([date,value])=>/^\d{4}-\d{2}-\d{2}$/.test(date)&&value!=='.'&&value!==''&&Number.isFinite(Number(value))).map(([date,value])=>({date,value:Number(value)}));
 if(rows.length<100)throw Error('Not a complete CSV series');append('macro.ndjson',{id,source:url,retrievedAt:new Date().toISOString(),availability:'observation date only; exact publication minute not established',rows});console.log('FRED '+id+' '+rows.length);
 }catch(e){failures.push({source:'FRED',id,error:e.message});}await sleep(500);
}}
(async()=>{const phase=process.env.COLLECT_PHASE||'all';
 if(phase==='all'||phase==='daily')await charts([...labels.keys(),'^GSPC','^HSI','000001.SS','^VIX','^TNX','^IRX','GC=F','CL=F','HG=F','CNY=X','HKD=X'],'1d','daily-ohlcv.ndjson');
 if(phase==='all'||phase==='intraday')await charts(intraday,'5m','intraday-ohlcv.ndjson');
 if(phase==='all'||phase==='auxiliary'){await macro();await fundamentals();}
 fs.writeFileSync(path.join(out,`collection-${phase}.json`),JSON.stringify({cutoff:'2026-10-10T00:00:00Z',counts,failures,completedAt:new Date().toISOString()},null,2));
 console.log(JSON.stringify({phase,counts,failures}));
})().catch(e=>{console.error(e);process.exitCode=1;});
