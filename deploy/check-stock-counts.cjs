const fs=require('fs');const rows=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const counts={};for(const market of ['CN','HK','US']){const stocks=rows.filter(row=>row.market===market);counts[market]=stocks.length;if(stocks.length<138)throw Error(market+' stock pool incomplete');}
if(new Set(rows.map(row=>row.symbol)).size!==rows.length)throw Error('Duplicate instrument IDs');console.log(JSON.stringify({stockCounts:counts}));
