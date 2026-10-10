const fs=require('node:fs'),path=require('node:path');
const out=process.argv[2];
const symbols=['NVDA','JPM','LLY','NEE','0700.HK','0939.HK','1177.HK','0002.HK','688981.SS','600036.SS','600276.SS','600900.SS'];
async function run(){const results=[];for(const symbol of symbols){const url=`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1mo&interval=5m`;
  const response=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('HTTP '+response.status+' '+symbol);
  const result=(await response.json()).chart.result[0],quote=result.indicators.quote[0];
  const bars=result.timestamp.map((time,i)=>({time:time*1000,open:quote.open[i],high:quote.high[i],low:quote.low[i],close:quote.close[i],volume:quote.volume[i]})).filter(bar=>bar.close>0&&bar.open>0&&bar.volume>=0);
  if(bars.length<100)throw new Error('Insufficient intraday history '+symbol);
  results.push({symbol,source:url,retrievedAt:new Date().toISOString(),timezone:result.meta.exchangeTimezoneName,bars});
  console.log(symbol+' '+bars.length+' five-minute bars');await new Promise(resolve=>setTimeout(resolve,350));
}fs.writeFileSync(path.join(out,'intraday-samples.ndjson'),results.map(JSON.stringify).join('\n')+'\n');console.log(JSON.stringify({symbols:results.length,bars:results.reduce((sum,r)=>sum+r.bars.length,0)}));}
run().catch(error=>{console.error(error);process.exitCode=1;});
