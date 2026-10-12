const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const median=a=>{if(!a.length)return 0;const s=[...a].sort((a,b)=>a-b),i=Math.floor(s.length/2);return s.length%2?s[i]:(s[i-1]+s[i])/2;};
const variance=a=>{const m=mean(a);return mean(a.map(v=>(v-m)**2));};
const covariance=(a,b)=>{const am=mean(a),bm=mean(b);return mean(a.map((v,i)=>(v-am)*(b[i]-bm)));};
const corr=(a,b)=>a.length>=20&&variance(a)>1e-12&&variance(b)>1e-12?covariance(a,b)/Math.sqrt(variance(a)*variance(b)):0;
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const dateFormat=new Map();
function localParts(time,timezone){if(!dateFormat.has(timezone))dateFormat.set(timezone,new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}));
 const p=Object.fromEntries(dateFormat.get(timezone).formatToParts(new Date(time)).map(x=>[x.type,x.value]));return {date:`${p.year}-${p.month}-${p.day}`,minute:Number(p.hour)*60+Number(p.minute)};}
function sessionMinute(market,minute){const sessions=market==='CN'?[[570,690],[780,900]]:market==='HK'?[[570,720],[780,960]]:[[570,960]];let offset=0;
 for(const [a,b]of sessions){if(minute>=a&&minute<b)return offset+minute-a;offset+=b-a;}
 if(minute===sessions.at(-1)[1])return offset-1;return null;
}
function dailyFeatures(record){const rows=record.rows.slice().sort((a,b)=>a[0]-b[0]),ret=[],volume=[];const result=[];
 const splitDates=new Set(Object.values(record.events?.splits||{}).map(s=>localParts(s.date*1000,record.timezone).date));
 for(let i=1;i<rows.length;i++){const row=rows[i],r=Math.log(row[5]/rows[i-1][5]);const date=localParts(row[0],record.timezone).date;
  const previousVolume=volume.slice(-20),previousReturns=ret.slice(-20),baseline=median(previousVolume);
  const sigma=Math.max(.003,Math.sqrt(mean(previousReturns.map(v=>v*v))));
  if(previousVolume.length===20&&row[6]>0&&baseline>0&&!splitDates.has(date)&&Math.abs(r)<.4){
   const relative=row[6]/baseline,range=Math.log(row[2]/row[3]),validRange=row[2]>=Math.max(row[1],row[4])&&row[3]<=Math.min(row[1],row[4]);
   result.push({date,r,abs:Math.abs(r),relative,logVolume:clamp(Math.log(relative),-4,4),x:Math.min(6,Math.abs(r)/sigma),volume:row[6],dollarVolumeProxy:row[4]*row[6],range:validRange?range:null,gap:Math.log(row[1]/rows[i-1][4])});
  }
  volume.push(row[6]);ret.push(r);
 }return result;
}
function fitVolume(rows){const x=rows.map(r=>r.x),y=rows.map(r=>r.logVolume);
 const beta=variance(x)>1e-10?covariance(x,y)/variance(x):0,intercept=mean(y)-beta*mean(x),residual=y.map((v,i)=>v-intercept-beta*x[i]);
 return {n:rows.length,volumeAbsoluteReturnCorrelation:corr(y,rows.map(r=>r.abs)),volumeSignedReturnCorrelation:corr(y,rows.map(r=>r.r)),
  beta,intercept,residualSigma:Math.sqrt(variance(residual)),residualPersistence:corr(residual.slice(1),residual.slice(0,-1)),relativeVolumeP50:median(rows.map(r=>r.relative)),
  amihudProxyMedian:median(rows.filter(r=>r.dollarVolumeProxy>0).map(r=>r.abs/r.dollarVolumeProxy)),meanAbsoluteReturn:mean(rows.map(r=>r.abs))};
}
function intradayFeatures(record){const groups=new Map(),length=record.market==='CN'?240:record.market==='HK'?330:390;
 for(const row of record.rows){const {date,minute}=localParts(row[0],record.timezone),m=sessionMinute(record.market,minute);
  if(m===null||row[6]<=0)continue;const list=groups.get(date)||[];list.push({row,minute:m,bucket:Math.min(11,Math.floor(m/length*12))});groups.set(date,list);}
 const valid=[...groups.entries()].filter(([_,g])=>g.length>=length/5*.7).sort((a,b)=>a[0].localeCompare(b[0]));
 return valid.map(([date,rows])=>{const total=rows.reduce((s,r)=>s+r.row[6],0);return {date,rows:rows.map(r=>({...r,share:r.row[6]/total,relative:r.row[6]/(total/rows.length)}))};});
}
function seasonality(days){const sums=Array(12).fill(0),counts=Array(12).fill(0);for(const day of days)for(const bar of day.rows){sums[bar.bucket]+=bar.relative;counts[bar.bucket]++;}
 const weights=sums.map((sum,i)=>counts[i]?sum/counts[i]:1),normalization=mean(weights);return weights.map(w=>w/normalization);}
module.exports={mean,median,variance,covariance,corr,clamp,localParts,sessionMinute,dailyFeatures,fitVolume,intradayFeatures,seasonality};
