// Fits public five-minute bars using a chronological split; no player data.
const fs=require('node:fs'),path=require('node:path');
const S=require('../../remaster/tooling/microstructure-statistics.cjs');
const intraday=require('../src/common/unified-intraday.json');
const records=fs.readFileSync(path.join(process.argv[2],'intraday-ohlcv.ndjson'),'utf8').trim().split('\n').map(JSON.parse);
const profiles={},rows=[];
function activity(minute,length,market){const p=intraday.profiles[market],q=minute/length;return p.normalization*(1+p.openBoost*Math.exp(-q*14)+p.closeBoost*Math.exp(-(1-q)*14));}
function loss(values,g,start=1){let h=start,sum=0;for(const r of values){sum+=Math.log(h)+r*r/h;h=Math.max(.15,Math.min(25,g.omega+g.alpha*r*r+(r<0?g.gamma*r*r:0)+g.beta*h));}return {loss:sum/values.length,last:h};}
for(const record of records){
 const days=S.intradayFeatures(record),cut=Math.floor(days.length*2/3);if(cut<10||days.length-cut<5)continue;
 const length=record.market==='CN'?240:record.market==='HK'?330:390;
 const features=ds=>ds.flatMap(d=>d.rows.map(b=>({r:Math.log(b.row[4]/b.row[1])/activity(b.minute,length,record.market),wick:Math.max(0,(b.row[2]-Math.max(b.row[1],b.row[4])+Math.min(b.row[1],b.row[4])-b.row[3])/b.row[4])}))).filter(b=>Number.isFinite(b.r)&&Math.abs(b.r)<.15&&Number.isFinite(b.wick));
 const train=features(days.slice(0,cut)),test=features(days.slice(cut)),sigma=Math.sqrt(S.mean(train.map(b=>b.r*b.r)));
 if(!(sigma>0))continue;
 const normalize=a=>a.map(b=>Math.max(-8,Math.min(8,b.r/sigma))),x=normalize(train),y=normalize(test);let best;
 for(const alpha of [.03,.06,.1,.16])for(const beta of [.75,.84,.9,.94])for(const gamma of [0,.04,.08]){
  const persistence=alpha+beta+gamma/2;if(persistence>=.985)continue;
  const g={alpha,beta,gamma,omega:1-persistence},fit=loss(x,g);if(!best||fit.loss<best.loss)best={...g,...fit};
 }
 const held=loss(y,best,best.last),constant=S.mean(y.map(v=>v*v));
 const key=record.market+'|'+record.sectors[0],wickScale=Math.max(.05,Math.min(1.5,S.median(train.map(b=>b.wick))/sigma));
 profiles[key]={alpha:best.alpha,beta:best.beta,gamma:best.gamma,omega:best.omega,wickScale,trainBars:x.length,holdoutBars:y.length};
 rows.push({symbol:record.symbol,key,trainStart:days[0].date,trainEnd:days[cut-1].date,holdoutStart:days[cut].date,holdoutEnd:days.at(-1).date,constantLoss:constant,conditionalLoss:held.loss,improved:held.loss<constant});
}
const summary={profiles:Object.keys(profiles).length,improved:rows.filter(r=>r.improved).length,medianConstantLoss:S.median(rows.map(r=>r.constantLoss)),medianConditionalLoss:S.median(rows.map(r=>r.conditionalLoss))};
fs.writeFileSync(process.argv[3],JSON.stringify({version:1,method:'Earliest two thirds of complete five-minute sessions train; remaining sessions are holdout. Conditional variance coefficients fitted on deseasonalized open-close returns. One-minute conversion is a bounded persistence approximation, not an exact temporal aggregation.',profiles},null,2));
fs.writeFileSync(process.argv[4],JSON.stringify({summary,rows},null,2));console.log(JSON.stringify(summary));
if(summary.profiles<60)throw Error('Insufficient intraday coverage');
