const fs=require('node:fs'),path=require('node:path');const S=require('./microstructure-statistics.cjs');
const folder=process.argv[2],output=process.argv[3];if(!folder||!output)throw Error('Input and output directories required');fs.mkdirSync(output,{recursive:true});
const read=file=>fs.existsSync(path.join(folder,file))?fs.readFileSync(path.join(folder,file),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const daily=read('daily-ohlcv.ndjson'),intraday=read('intraday-ohlcv.ndjson'),turnover=read('cn-turnover.ndjson'),macro=read('macro.ndjson'),fundamentals=read('fundamentals.ndjson');
const cutoff='2025-01-01',sectors={},profiles={},instruments=[],features=new Map();let dailyBars=0,intradayBars=0,rejectedRanges=0;
for(const record of daily){dailyBars+=record.rows.length;if(record.sectors.includes('auxiliary'))continue;
 const rows=S.dailyFeatures(record);features.set(record.symbol,rows);const train=rows.filter(r=>r.date<cutoff),test=rows.filter(r=>r.date>=cutoff);
 if(train.length<100||test.length<60)continue;const a=S.fitVolume(train),b=S.fitVolume(test);rejectedRanges+=rows.filter(r=>r.range===null).length;
 instruments.push({symbol:record.symbol,market:record.market,sectors:record.sectors,train:a,holdout:b});
 for(const sector of record.sectors){const key=record.market+'|'+sector;(sectors[key]??=[]).push({symbol:record.symbol,train:a,test:b});}
}
for(const [key,rows]of Object.entries(sectors)){const trainBeta=S.median(rows.map(r=>r.train.beta)),testBeta=S.median(rows.map(r=>r.test.beta));
 profiles[key]={samples:rows.length,trainBars:rows.reduce((s,r)=>s+r.train.n,0),holdoutBars:rows.reduce((s,r)=>s+r.test.n,0),
  volumeReturnBeta:S.clamp(trainBeta,0,1.5),noiseSigma:S.clamp(S.median(rows.map(r=>r.train.residualSigma)),.15,1.2),
  persistence:S.clamp(S.median(rows.map(r=>r.train.residualPersistence)),0,.85),intercept:S.median(rows.map(r=>r.train.intercept)),
  trainVolumeAbsReturnCorrelation:S.median(rows.map(r=>r.train.volumeAbsoluteReturnCorrelation)),holdoutVolumeAbsReturnCorrelation:S.median(rows.map(r=>r.test.volumeAbsoluteReturnCorrelation)),
  trainSignedReturnCorrelation:S.median(rows.map(r=>r.train.volumeSignedReturnCorrelation)),holdoutSignedReturnCorrelation:S.median(rows.map(r=>r.test.volumeSignedReturnCorrelation))};
}
const seasonal={},intradayStudy=[],intradayFits={};
for(const record of intraday){intradayBars+=record.rows.length;const days=S.intradayFeatures(record),cut=Math.floor(days.length*2/3);
 if(cut<10||days.length-cut<5)continue;const train=days.slice(0,cut),test=days.slice(cut),weights=S.seasonality(train),heldout=S.seasonality(test);
 const extract=days=>days.flatMap(day=>day.rows.slice(1).filter((bar,i)=>bar.row[0]-day.rows[i].row[0]===300000).map(bar=>{
  const r=Math.log(bar.row[4]/bar.row[1]);return {r,abs:Math.abs(r),relative:bar.relative/weights[bar.bucket],logVolume:Math.log(bar.relative/weights[bar.bucket])};}));
 const trainRows=extract(train),scale=Math.sqrt(S.mean(trainRows.map(r=>r.r*r.r)))||.001;
 const normalized=rows=>rows.map(r=>({...r,x:Math.min(6,r.abs/scale)}));
 const fit=S.fitVolume(normalized(trainRows)),validation=S.fitVolume(normalized(extract(test)));
 const error=S.mean(weights.map((w,i)=>Math.abs(Math.log(w/heldout[i]))));intradayStudy.push({symbol:record.symbol,market:record.market,sectors:record.sectors,trainDays:train.length,holdoutDays:test.length,firstTrain:train[0].date,lastTrain:train.at(-1).date,firstHoldout:test[0].date,weights,heldout,logError:error,fit,validation});
 for(const sector of record.sectors){const key=record.market+'|'+sector;(intradayFits[key]??=[]).push(fit);}
 (seasonal[record.market]??=[]).push(weights);
}
const marketSeasonality={};for(const [market,rows]of Object.entries(seasonal)){const weights=Array.from({length:12},(_,i)=>S.median(rows.map(w=>w[i]))),normalization=S.mean(weights);marketSeasonality[market]=weights.map(w=>w/normalization);}
for(const [key,rows]of Object.entries(intradayFits)){if(!profiles[key])continue;
 profiles[key].minuteVolumeReturnBeta=S.clamp(S.median(rows.map(r=>r.beta)),0,1.2);
 profiles[key].minuteNoiseSigma=S.clamp(S.median(rows.map(r=>r.residualSigma)),.2,1.1);
 profiles[key].minutePersistence=S.clamp(S.median(rows.map(r=>r.residualPersistence)),0,.85);
 profiles[key].minuteReference='5-minute coefficients mapped conservatively to one minute; persistence^(1/5), noise scaled for stationary variance';
}
const turnoverStudy=[];let amountRows=0,badAmountRows=0;
for(const record of turnover){const valid=record.rows.filter(r=>r[5]>0&&r[6]>0&&r[10]>=0&&r[10]<=100);amountRows+=record.rows.length;
 const bad=valid.filter(r=>r[6]/(r[5]*100)<r[4]*.98||r[6]/(r[5]*100)>r[3]*1.02);badAmountRows+=bad.length;
 const rows=valid.filter(r=>!bad.includes(r));const train=rows.filter(r=>r[0]<cutoff),test=rows.filter(r=>r[0]>=cutoff);
 const metrics=a=>({n:a.length,medianTurnoverPct:S.median(a.map(r=>r[10])),medianAmountCny:S.median(a.map(r=>r[6]))});
 turnoverStudy.push({symbol:record.symbol,industry:record.industry,train:metrics(train),holdout:metrics(test),badAmountRows:bad.length});
}
for(const [key,profile]of Object.entries(profiles)){const industry=key.split('|')[1],rows=turnoverStudy.filter(r=>r.industry===industry);
 profile.referenceCnTurnoverPct=rows.length?S.median(rows.map(r=>r.train.medianTurnoverPct)):null;}
const macroStudy=[];for(const m of macro){const levels=new Map(m.rows.map((r,i)=>[r.date,i?{previousDate:m.rows[i-1].date,change:r.value-m.rows[i-1].value}:null]));
 for(const [key,group]of Object.entries(sectors)){const rows=group.flatMap(g=>(features.get(g.symbol)||[]).map(r=>({r,lag:levels.get(r.date)})).filter(x=>x.lag));
  // Descriptive same-date association only; revised FRED observations have no historical publication timestamp.
  const metric=a=>({n:a.length,correlation:S.corr(a.map(x=>x.r.r),a.map(x=>x.lag.change))});
  macroStudy.push({id:m.id,sector:key,train:metric(rows.filter(x=>x.r.date<cutoff)),holdout:metric(rows.filter(x=>x.r.date>=cutoff)),usedForDirectionalPrediction:false});
 }}
const summary={dailySymbols:daily.length,dailyBars,intradaySymbols:intraday.length,intradayBars,sectorMarketGroups:Object.keys(profiles).length,
  amountTurnoverSymbols:turnover.length,amountTurnoverRows:amountRows,badAmountRows,rejectedRanges,macroSeries:macro.length,macroRows:macro.reduce((s,m)=>s+m.rows.length,0),fundamentalIssuers:fundamentals.length,fundamentalFacts:fundamentals.reduce((s,r)=>s+r.facts.length,0),
  medianTrainVolumeAbsReturnCorrelation:S.median(Object.values(profiles).map(p=>p.trainVolumeAbsReturnCorrelation)),medianHoldoutVolumeAbsReturnCorrelation:S.median(Object.values(profiles).map(p=>p.holdoutVolumeAbsReturnCorrelation)),
  medianTrainSignedReturnCorrelation:S.median(Object.values(profiles).map(p=>p.trainSignedReturnCorrelation)),medianHoldoutSignedReturnCorrelation:S.median(Object.values(profiles).map(p=>p.holdoutSignedReturnCorrelation))};
const calibration={version:1,dailyTrainingEndExclusive:cutoff,dataCutoffExclusive:'2026-10-10',method:'Lagged rolling volume baselines; chronological holdout; contemporaneous volume-return association, not causal or directional prediction. FRED observations may be revised. No historical L2/bid-ask data.',profiles,marketSeasonality};
fs.writeFileSync(path.join(output,'volume-calibration.json'),JSON.stringify(calibration,null,2));
fs.writeFileSync(path.join(output,'microstructure-report.json'),JSON.stringify({summary,calibration,instruments,intradayStudy,turnoverStudy,macroStudy,missing:['historical level-2 book','historical quoted bid-ask spread','verified foreign-market float turnover']},null,2));
console.log(JSON.stringify(summary,null,2));
