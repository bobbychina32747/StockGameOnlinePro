const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const S=require('../../remaster/tooling/microstructure-statistics.cjs');
const fresh=require('../dist/src/common/unified-market'),volume=require('../dist/src/common/volume-model');
const catalog=require('../src/common/unified-catalog.json').instruments,weights=require('../src/common/unified-volume.json').marketSeasonality;
function load(filename,name,dependency){const m=new Module(path.resolve(__dirname,'../src/common/'+name+'.cjs'),module);m.filename=path.resolve(__dirname,'../src/common/'+name+'.cjs');m.paths=module.paths;const req=m.require.bind(m);m.require=id=>id==='./unified-market'&&dependency?dependency:req(id);m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,m.filename);return m.exports;}
const old=load(process.argv[2],'baseline-risk'),oldVolume=load(process.argv[3],'baseline-volume',old);
function rng(seed){return()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return(seed+1)/4294967297;};}
function run(model,vmodel,instrument,seed){const random=rng(seed),normal=()=>Math.sqrt(-2*Math.log(random()))*Math.cos(2*Math.PI*random());
 const length=instrument.market==='CN'?240:instrument.market==='HK'?330:390,st={symbol:instrument.symbol,industry:instrument.industry,baseVolume:10000,volatility:instrument.volatility,lastReturn:0,minuteCounter:0};
 const r=[],v=[],signed=[];
 for(let i=0;i<length*30;i++){st.minuteCounter=i%length;const ret=model.calibratedShock(st,normal,length,instrument.market,normal(),normal());st.lastReturn=ret;
  const vol=vmodel.calibratedVolume(st,instrument.market,length,normal),a=model.activity(st.minuteCounter,length,instrument.market),season=weights[instrument.market][Math.min(11,Math.floor(st.minuteCounter/length*12))];
  if(i>=length*5){r.push(Math.abs(ret)/a);signed.push(ret/a);v.push(Math.log(Math.max(1,vol)/season));}
 }
 return {absoluteReturnAcf1:S.corr(r.slice(1),r.slice(0,-1)),volumeAbsoluteReturnCorrelation:S.corr(v,r),volumeSignedReturnCorrelation:S.corr(v,signed)};
}
const used=new Set(),rows=[];
for(const instrument of catalog){const key=instrument.market+'|'+instrument.industry;if(used.has(key))continue;used.add(key);rows.push({key,old:run(old,oldVolume,instrument,100+rows.length),updated:run(fresh,volume,instrument,100+rows.length)});}
const summary={groups:rows.length,old:{},updated:{}};
for(const metric of Object.keys(rows[0].old))for(const version of ['old','updated'])summary[version][metric]=S.median(rows.map(r=>r[version][metric]));
const report={method:'Thirty simulated sessions for each of 69 market/industry groups; first five sessions discarded; seasonal activity removed. Seeded pure price and volume generators without news, jumps, matching or player data. Mechanism comparison, not a real-market fit or a predictive backtest.',summary,rows};
fs.writeFileSync(process.argv[4],JSON.stringify(report,null,2));console.log(JSON.stringify(summary));
// This isolated test must preserve association, not manufacture a target
// correlation. A small sampling change is reported rather than hidden.
if(summary.updated.absoluteReturnAcf1<=summary.old.absoluteReturnAcf1
 ||summary.updated.volumeAbsoluteReturnCorrelation<summary.old.volumeAbsoluteReturnCorrelation-.05
 ||Math.abs(summary.updated.volumeSignedReturnCorrelation)>.1)throw Error('Joint activity mechanism regression');
