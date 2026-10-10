const fs=require('node:fs'),path=require('node:path');
const {mean,variance,covariance,median}=require('./research-statistics.cjs');
const timeline=require('../packages/domain/news-timeline.json');
const out=process.argv[2];
const records=fs.readFileSync(path.join(out,'market-samples.ndjson'),'utf8').trim().split('\n').map(JSON.parse);
const bySymbol=new Map(records.map(row=>[row.symbol,row]));
const returns=row=>new Map(row.bars.slice(1).map((bar,i)=>[bar.date,Math.log(bar.close/row.bars[i].close)]));
const benchmarkReturns=Object.fromEntries(['CN','HK','US'].map(market=>[market,returns(bySymbol.get({CN:'000001.SS',HK:'^HSI',US:'^GSPC'}[market]))]));
const {publicationBounds,firstAffected}=require('./news-time.cjs');
const results=[];
for(const event of timeline.events){
  const symbols=event.scope==='all'?records.filter(row=>row.sectors[0]!=='benchmark').map(row=>row.symbol):event.symbols;
  for(const symbol of symbols){const stock=bySymbol.get(symbol);if(!stock){results.push({eventId:event.id,symbol,excluded:'Missing usable price history'});continue;}
    const bounds=publicationBounds(event);const anchors=[...new Set(bounds.map(value=>firstAffected(stock,value)))];
    if(anchors.some(index=>index<121||index+5>=stock.bars.length)){results.push({eventId:event.id,symbol,excluded:'Insufficient pre-event or post-event observations'});continue;}
    for(const index of anchors){const bar=stock.bars[index],market=benchmarkReturns[stock.market];
      const train=[];for(let i=index-120;i<=index-21;i++){const x=market.get(stock.bars[i].date);if(Number.isFinite(x))train.push([x,Math.log(stock.bars[i].close/stock.bars[i-1].close)]);}
      if(train.length<60)continue;const xs=train.map(row=>row[0]),ys=train.map(row=>row[1]);const beta=covariance(xs,ys)/variance(xs),alpha=mean(ys)-beta*mean(xs);
      const residualSigma=Math.sqrt(variance(ys.map((r,i)=>r-alpha-beta*xs[i])));
      const abnormal=i=>Math.log(stock.bars[i].close/stock.bars[i-1].close)-alpha-beta*(market.get(stock.bars[i].date)??NaN);
      const car=end=>Array.from({length:end+1},(_,offset)=>abnormal(index+offset)).reduce((sum,r)=>sum+r,0);
      const sectorPeers=records.filter(row=>row.market===stock.market&&row.symbol!==symbol&&row.sectors.some(sector=>stock.sectors.includes(sector)));
      const peerReturns=sectorPeers.map(row=>returns(row).get(bar.date)).filter(Number.isFinite);
      const rawReturn=Math.log(bar.close/stock.bars[index-1].close);
      results.push({eventId:event.id,symbol,industry:stock.sectors[0],market:stock.market,anchorDate:bar.date,
        anchorAmbiguous:anchors.length>1,precision:event.timestampPrecision,trainingFrom:stock.bars[index-120].date,trainingTo:stock.bars[index-21].date,
        trainingObservations:train.length,alpha,beta,rawReturn:Math.expm1(rawReturn),abnormalLogReturn:car(0),car2:car(1),car6:car(5),
        preEventCar5:Array.from({length:5},(_,offset)=>abnormal(index-5+offset)).reduce((sum,r)=>sum+r,0),
        sectorRelativeLogReturn:peerReturns.length?rawReturn-mean(peerReturns):null,sectorPeerCount:peerReturns.length,
        gap:bar.open/stock.bars[index-1].close-1,volumeRatio:bar.volume/mean(stock.bars.slice(index-20,index).map(bar=>bar.volume)),
        residualSigma,descriptiveZ:car(0)/residualSigma,confounders:event.confounders,
        limitation:event.session==='during-session'?'Daily bar includes trading before publication; intraday causal isolation is unavailable':'Market-adjusted association; contemporaneous information remains confounded'});
    }
  }
}
const companyEvents=results.filter(row=>{const event=timeline.events.find(event=>event.id===row.eventId);return !row.excluded&&!row.anchorAmbiguous&&event.kind==='earnings'&&event.symbols[0]===row.symbol;});
const magnitude=median(companyEvents.map(row=>Math.abs(row.abnormalLogReturn)));
const response={version:1,method:'Descriptive, selected event examples; no causal interpretation and no claim of representative frequency. Amplitudes are shrunk and bounded for simulation.',
  earnings:{sampleSize:companyEvents.length,medianAbsoluteAbnormalLogReturn:magnitude,simulationScale:Math.max(.01,Math.min(.05,magnitude*.5))},
  // The remaining effects are economic exposure assumptions; two macro observations cannot identify reliable causal coefficients.
  exposureAssumptions:{rateSensitive:['地产与基建','公用事业','新能源与电池','人工智能','软件与云服务'],commodityProducers:['能源与煤炭','有色与材料'],fuelConsumers:['航空航运与物流','汽车与出行'],creditSensitive:['银行','保险','券商与金融科技','地产与基建']}};
fs.writeFileSync(path.join(out,'news-event-study.json'),JSON.stringify({version:1,events:timeline.events,results,model:response},null,2)+'\n');
fs.writeFileSync(path.join(__dirname,'../packages/domain/news-calibration.json'),JSON.stringify(response,null,2)+'\n');
console.log(JSON.stringify({events:timeline.events.length,eventStockWindows:results.length,excluded:results.filter(row=>row.excluded).length,earningsExamples:companyEvents.length,simulationEarningsScale:response.earnings.simulationScale}));
module.exports={publicationBounds,firstAffected};
