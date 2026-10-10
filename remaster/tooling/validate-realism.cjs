const fs=require('node:fs'),path=require('node:path');const assert=require('node:assert/strict');
require('./runtime.cjs');const {generateHistory}=require('../dist/packages/engine/historical-model');const {median,metrics}=require('./research-statistics.cjs');
const out=process.argv[2],calibration=require('../packages/domain/sector-calibration.json');
const records=fs.readFileSync(path.join(out,'market-samples.ndjson'),'utf8').trim().split('\n').map(JSON.parse);
assert.equal(records.length,141);const problems=[];
for(const stock of records){assert(stock.bars.length>250,stock.symbol+' has no usable history');for(const bar of stock.bars)if(bar.high<Math.max(bar.open,bar.close)-1e-5||bar.low>Math.min(bar.open,bar.close)+1e-5||bar.low<=0)problems.push({symbol:stock.symbol,date:bar.date});}
// These records are explicitly excluded from range fitting by metrics(); close-to-close returns remain usable.
assert(problems.length<records.reduce((sum,row)=>sum+row.bars.length,0)*.001,'Too many inconsistent vendor OHLC records');
const results=[];
for(const [industry,markets]of Object.entries(calibration.profiles))for(const [market,profile]of Object.entries(markets)){
 const synthetic=[];for(let seed=1;seed<=5;seed++){const stock={symbol:'VALIDATE:'+industry+':'+market,name:'Calibration validation',industry,market,code:'SIM',listedAt:'2025-10-01',initialPrice:10000,volatility:profile.dailyVolatility,
  riskProfile:{...profile,eventSensitivity:1,dividendYield:0,newsKinds:[],business:industry}};
  const bars=generateHistory(stock,seed,'2026-10-10');synthetic.push(metrics(bars));}
 const selected=records.filter(row=>profile.references.includes(row.symbol));const holdout=selected.map(row=>metrics(row.bars.filter(bar=>bar.date>='2025-10-01')));
 results.push({industry,market,references:profile.references,trainingDailyVolatility:profile.dailyVolatility,
  realHoldoutDailyVolatility:median(holdout.map(row=>row.dailyVolatility)),simulatedHoldoutDailyVolatility:median(synthetic.map(row=>row.dailyVolatility)),
  realHoldoutMedianGap:median(holdout.map(row=>row.medianGap)),simulatedHoldoutMedianGap:median(synthetic.map(row=>row.medianGap)),
  realHoldoutKurtosis:median(holdout.map(row=>row.excessKurtosis)),simulatedHoldoutKurtosis:median(synthetic.map(row=>row.excessKurtosis)),
  realHoldoutAbsoluteReturnLag1:median(holdout.map(row=>row.absoluteReturnLag1)),simulatedHoldoutAbsoluteReturnLag1:median(synthetic.map(row=>row.absoluteReturnLag1))});
}
const summary={symbols:records.length,dailyBars:records.reduce((sum,row)=>sum+row.bars.length,0),vendorRangesExcludedFromCalibration:problems.length,profiles:results.length,seedsPerProfile:5,
 medianSimulatedVolatilityVsTraining:median(results.map(row=>row.simulatedHoldoutDailyVolatility/row.trainingDailyVolatility)),
 medianSimulatedVolatilityVsHoldout:median(results.map(row=>row.simulatedHoldoutDailyVolatility/row.realHoldoutDailyVolatility)),
 medianSimulatedGapVsHoldout:median(results.map(row=>row.simulatedHoldoutMedianGap/row.realHoldoutMedianGap)),
 medianSimulatedKurtosis:median(results.map(row=>row.simulatedHoldoutKurtosis)),medianSimulatedAbsoluteReturnLag1:median(results.map(row=>row.simulatedHoldoutAbsoluteReturnLag1))};
fs.writeFileSync(path.join(out,'realism-validation.json'),JSON.stringify({summary,vendorRangeInconsistencies:problems,results,limitations:['Five-year daily training versus recent holdout can differ due to regimes.','Five-minute activity uses only one recent month and four references per market.','Selected news examples cannot identify causal effects or event frequencies.']},null,2)+'\n');console.log(JSON.stringify(summary,null,2));
