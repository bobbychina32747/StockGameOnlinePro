const fs=require('node:fs'),path=require('node:path');const S=require('./microstructure-statistics.cjs');
const {publicationBounds,firstAffected}=require('./news-time.cjs');
const folder=process.argv[2],output=process.argv[3];
const events=[...require('../packages/domain/news-timeline.json').events,...require('../packages/domain/news-timeline-extra.json').events];
const records=fs.readFileSync(path.join(folder,'daily-ohlcv.ndjson'),'utf8').trim().split('\n').map(JSON.parse).map(r=>({...r,bars:r.rows.map(row=>({time:row[0],date:S.localParts(row[0],r.timezone).date,close:row[5],open:row[1]*row[5]/row[4],volume:row[6]}))}));
const lookup=new Map(records.map(r=>[r.symbol,r])),windows=[];
for(const event of events){const symbols=event.scope==='all'?records.filter(r=>!r.sectors.includes('auxiliary')).map(r=>r.symbol):event.symbols;
 for(const symbol of symbols){const stock=lookup.get(symbol);if(!stock)continue;
  const anchors=[...new Set(publicationBounds(event).map(t=>firstAffected(stock,t)))];
  for(const index of anchors){if(index<120||index+5>=stock.bars.length)continue;
   const bar=stock.bars[index],previous=stock.bars[index-1],baseline=S.median(stock.bars.slice(index-20,index).map(b=>b.volume));
   const ret=Math.log(bar.close/previous.close),pre=stock.bars.slice(index-120,index-20).map((b,i,a)=>i?Math.log(b.close/a[i-1].close):0);
   windows.push({eventId:event.id,symbol,market:stock.market,industry:stock.sectors[0],anchorDate:bar.date,anchorAmbiguous:anchors.length>1,publicationPrecision:event.timestampPrecision,
    volumeRatio:baseline>0?bar.volume/baseline:null,absoluteReturn:Math.abs(ret),return:Math.expm1(ret),gap:bar.open/previous.close-1,
    preEventVolatility:Math.sqrt(S.variance(pre)),postVolumeRatios:stock.bars.slice(index,index+6).map(b=>baseline>0?b.volume/baseline:null),
    limitation:'Selected observational event; simultaneous disclosures and market moves are confounded. No causal attribution.'});
  }
 }
}
const company=windows.filter(w=>!w.anchorAmbiguous&&events.find(e=>e.id===w.eventId).kind==='earnings'&&events.find(e=>e.id===w.eventId).symbols[0]===w.symbol);
const summary={events:events.length,windows:windows.length,unambiguousCompanyExamples:company.length,medianCompanyVolumeRatio:S.median(company.map(w=>w.volumeRatio)),medianAbsoluteCompanyReturn:S.median(company.map(w=>w.absoluteReturn)),preciseMinuteEvents:events.filter(e=>e.firstPublicMinuteVerified).length};
fs.writeFileSync(path.join(output,'news-volume-study.json'),JSON.stringify({summary,events,windows},null,2));console.log(JSON.stringify(summary));
