const fs=require('node:fs'),path=require('node:path');
const file=path.join(__dirname,'../packages/domain/catalog.json');const catalog=JSON.parse(fs.readFileSync(file,'utf8'));const calibration=require('../packages/domain/sector-calibration.json');
const industries=Object.keys(calibration.profiles);const english=['Semiconductor','AI Systems','Cloud Software','Interactive','Media','Electronics','Commerce','Energy Storage','Motors','Bank','Insurance','Financial','Biotech','Medical','Foods','Consumer','Energy','Materials','Industrial','Properties','Utilities','Telecom','Logistics'];
const hk=['晶片','智算','雲科','互娛','傳媒','電子','商貿','新能源','汽車','銀行','保險','金融','生物科技','醫療','食品','消費','能源','資源','工業','置業','公用','電訊','航運'];
const cn=['澄川','远岑','北辰','云衡','青屿','辰海'],hkBrands=['維港','獅峰','海怡','金鐘','港灣','天際'],us=['Aster','Redwood','Summit','Bluebridge','Cedar','Northstar'];
const instruments=catalog.instruments.filter(item=>!/^R(CN|HK|US)/.test(item.symbol));let serial=0;
for(const [sector,industry]of industries.entries())for(const market of ['CN','HK','US']){
 const items=instruments.filter(item=>item.industry===industry&&item.market===market);
 if(items.length>6)throw Error('Realm sector overflow');
 while(items.length<6){const slot=items.length,template=catalog.instruments.find(item=>item.industry===industry&&item.riskProfile?.business)||catalog.instruments.find(item=>item.industry===industry);const n=++serial;
 const item=JSON.parse(JSON.stringify(template));Object.assign(item,{symbol:`R${market}${String(sector+1).padStart(2,'0')}${slot+1}`,code:market==='CN'?String(690100+n):market==='HK'?String(8000+n).padStart(5,'0'):`RX${String(sector+1).padStart(2,'0')}${slot+1}`,market,listedAt:'2019-01-02',initialPrice:Math.round((market==='US'?7000:market==='HK'?3600:2400)*(1+slot*.4))});
 const templates=catalog.instruments.filter(i=>i.industry===industry);item.riskProfile.business=templates[slot%templates.length].riskProfile.business;
 instruments.push(item);items.push(item);
 }
 items.forEach((item,slot)=>{
  if(market==='US')item.name=us[slot]+' '+english[sector];
  else if(/^R/.test(item.symbol)||/^NX/.test(item.symbol))item.name=market==='HK'?hkBrands[slot]+hk[sector]+(industry==='银行'?'':'控股'):cn[slot]+(industry==='银行'?'银行':item.riskProfile.business);
  const profile=calibration.profiles[industry][market];item.volatility=Math.round(profile.dailyVolatility*[.85,1.12,.95,1.18,.9,1.05][slot]*1e6)/1e6;
  Object.assign(item.riskProfile,{marketWeight:profile.marketWeight,sectorWeight:profile.sectorWeight,gapScale:profile.gapScale,intradayFraction:profile.intradayFraction,wickScale:profile.wickScale,gjr:profile.gjr});
  item.description=`虚构${market==='CN'?'中国':market==='HK'?'香港':'美国'}区服企业，主营${item.riskProfile.business}。收入与成本受${item.riskProfile.newsKinds.join('、')}影响；本名称不对应真实上市公司。`;
 });
}
if(instruments.length!==414||new Set(instruments.map(i=>i.symbol)).size!==414)throw Error('Realm catalog invariant');
for(const market of ['CN','HK','US'])for(const industry of industries)if(instruments.filter(i=>i.market===market&&i.industry===industry).length!==6)throw Error('Sector size invariant');
fs.writeFileSync(file,JSON.stringify({...catalog,instruments,remaster:{...catalog.remaster,catalogVersion:3,sectors:23,perSectorPerRealm:6,perRealm:138,total:414}},null,2)+'\n');console.log('3 realms × 23 sectors × 6 stocks = 414');
