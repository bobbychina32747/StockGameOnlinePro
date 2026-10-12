const fs=require('node:fs'),path=require('node:path');
const S=require('../../remaster/tooling/microstructure-statistics.cjs');
const {calibratedVolume}=require('../dist/src/common/volume-model');
const calibration=require('../dist/src/common/unified-volume.json');
const folder=process.argv[2],destination=process.argv[3];
function rng(seed){return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return ((t^t>>>14)>>>0)/4294967296;};}
const records=fs.readFileSync(path.join(folder,'intraday-ohlcv.ndjson'),'utf8').trim().split('\n').map(JSON.parse),rows=[];
for(const record of records){const days=S.intradayFeatures(record),cut=Math.floor(days.length*2/3),test=days.slice(cut);if(test.length<5)continue;
 const length=record.market==='CN'?240:record.market==='HK'?330:390;
 const random=rng(record.symbol.split('').reduce((s,c)=>s+c.charCodeAt(0),0)),normal=()=>Math.sqrt(-2*Math.log(Math.max(random(),1e-9)))*Math.cos(2*Math.PI*random());
 const oldBuckets=Array.from({length:12},()=>[]),newBuckets=Array.from({length:12},()=>[]),realBuckets=Array.from({length:12},()=>[]);
 const stock={symbol:'VALIDATION',industry:record.sectors[0],baseVolume:10000,volatility:.02,lastReturn:0,minuteCounter:0};
 for(const day of test){for(const b of day.rows){const actualReturn=Math.log(b.row[4]/b.row[1]);
   stock.minuteCounter=b.minute;stock.lastReturn=actualReturn/Math.sqrt(5);
   const old=10000*Math.exp(normal()*.6),fresh=calibratedVolume(stock,record.market,length,normal);
   oldBuckets[b.bucket].push(old);newBuckets[b.bucket].push(fresh);realBuckets[b.bucket].push(b.relative);
 }}
 const normalize=buckets=>{const means=buckets.map(a=>S.mean(a)||1),m=S.mean(means);return means.map(v=>v/m);};
 const old=normalize(oldBuckets),fresh=normalize(newBuckets),real=normalize(realBuckets);
 const error=profile=>S.mean(profile.map((v,i)=>Math.abs(Math.log(v/real[i]))));
 rows.push({symbol:record.symbol,market:record.market,days:test.length,oldSeasonalityLogError:error(old),newSeasonalityLogError:error(fresh),real,old,simulated:fresh});
}
const summary={stocks:rows.length,method:'Chronological unseen days, observed price bars supplied to joint volume generator; seasonality validation, not full price-model validation or a predictive backtest.',
 oldMedianSeasonalityLogError:S.median(rows.map(r=>r.oldSeasonalityLogError)),newMedianSeasonalityLogError:S.median(rows.map(r=>r.newSeasonalityLogError)),improvedStocks:rows.filter(r=>r.newSeasonalityLogError<r.oldSeasonalityLogError).length};
fs.writeFileSync(destination,JSON.stringify({summary,rows},null,2));console.log(JSON.stringify(summary));
if(summary.stocks<60||summary.improvedStocks<summary.stocks*.7||summary.newMedianSeasonalityLogError>=summary.oldMedianSeasonalityLogError)throw Error('Volume holdout regression');
