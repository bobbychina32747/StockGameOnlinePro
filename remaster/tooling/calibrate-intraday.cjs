const fs=require('node:fs'),path=require('node:path');const {mean,median}=require('./research-statistics.cjs');
const out=process.argv[2];const records=fs.readFileSync(path.join(out,'intraday-samples.ndjson'),'utf8').trim().split('\n').map(JSON.parse);
const detail=[],profiles={};
for(const market of ['CN','HK','US']){
 const selected=records.filter(row=>market==='CN'?/\.(SS|SZ)$/.test(row.symbol):market==='HK'?row.symbol.endsWith('.HK'):!row.symbol.includes('.'));
 const stats=selected.map(row=>{const bins={open:[],middle:[],close:[]};const format=new Intl.DateTimeFormat('en-CA',{timeZone:row.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  for(let i=1;i<row.bars.length;i++){const bar=row.bars[i],previous=row.bars[i-1];if(bar.time-previous.time!==300000)continue;
   const parts=Object.fromEntries(format.formatToParts(new Date(bar.time)).map(item=>[item.type,item.value]));let minute=Number(parts.hour)*60+Number(parts.minute)-570;
   if(market==='CN'&&Number(parts.hour)>=13)minute-=90;if(market==='HK'&&Number(parts.hour)>=13)minute-=60;
   const length={CN:240,HK:330,US:390}[market];if(minute<0||minute>=length)continue;
   const group=minute<45?'open':minute>=length-45?'close':'middle';bins[group].push(Math.log(bar.close/previous.close)**2);
  }
  if(Object.values(bins).some(values=>values.length<20))throw new Error('Insufficient continuous intraday samples '+row.symbol);
  const middle=mean(bins.middle);const result={symbol:row.symbol,market,source:row.source,retrievedAt:row.retrievedAt,counts:Object.fromEntries(Object.entries(bins).map(([key,values])=>[key,values.length])),openVarianceRatio:mean(bins.open)/middle,closeVarianceRatio:mean(bins.close)/middle};detail.push(result);return result;
 });
 const length={CN:240,HK:330,US:390}[market],bucketMean=(1-Math.exp(-14*45/length))/(14*45/length);
 const openBoost=Math.max(0,Math.min(5,(median(stats.map(row=>row.openVarianceRatio))-1)/bucketMean));
 const closeBoost=Math.max(0,Math.min(5,(median(stats.map(row=>row.closeVarianceRatio))-1)/bucketMean));
 profiles[market]={openBoost,closeBoost,normalization:1/(1+(openBoost+closeBoost)*(1-Math.exp(-14))/14),stocks:stats.length};
}
const artifact={version:1,method:'One month of continuous five-minute returns; exclude overnight and lunch gaps. Opening/closing 45-minute variance relative to middle session; robust cross-stock medians. Recent samples do not establish long-run stability.',profiles};
fs.writeFileSync(path.join(__dirname,'../packages/domain/intraday-calibration.json'),JSON.stringify(artifact,null,2)+'\n');fs.writeFileSync(path.join(out,'intraday-statistics.json'),JSON.stringify(detail,null,2)+'\n');
console.log(JSON.stringify({bars:records.reduce((sum,row)=>sum+row.bars.length,0),profiles},null,2));
