const fs = require('node:fs'), path = require('node:path');
const file = path.join(__dirname, '../packages/domain/catalog.json');
const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
const calibration = require('../packages/domain/sector-calibration.json');
const aliases = {
  软件服务:'软件与云服务', 软件:'软件与云服务', 游戏:'游戏与互动娱乐', 电竞:'游戏与互动娱乐', 云游戏:'游戏与互动娱乐', 游戏引擎:'游戏与互动娱乐',
  影视传媒:'传媒与文娱', 传媒:'传媒与文娱', 数字音乐:'传媒与文娱', 动漫IP:'传媒与文娱', 消费电子:'硬件与家电', 家电:'硬件与家电',
  互联网:'互联网与电商', 电商:'互联网与电商', 光伏:'新能源与电池', 锂电池:'新能源与电池', 新能源:'汽车与出行', 新能源车:'汽车与出行', 汽车:'汽车与出行',
  券商:'券商与金融科技', 金融:'券商与金融科技', 金融科技:'券商与金融科技', 创新药:'医药与生物', 生物疫苗:'医药与生物', 医药:'医药与生物',
  医疗器械:'医疗器械与服务', 医疗:'医疗器械与服务', 白酒:'食品饮料', 餐饮:'食品饮料', 消费:'零售与消费', 零售:'零售与消费',
  煤炭:'能源与煤炭', 能源:'能源与煤炭', 有色金属:'有色与材料', 军工:'工业与军工', 制造业:'工业与军工', 房地产:'地产与基建', 地产:'地产与基建',
  航空:'航空航运与物流', 航运:'航空航运与物流', 物流:'航空航运与物流', 通信:'通信与网络', 通信设备:'通信与网络'
};
// Each tuple describes a distinct business; six companies share a sector, not identical economics.
const businesses = {
  半导体:['晶圆代工','先进封装','模拟芯片','功率器件','芯片设备','存储设计'],
  人工智能:['企业模型订阅','智能语音','视觉检测','算力调度','行业智能体','机器人算法'],
  软件与云服务:['数据库订阅','企业协作','云安全','财务软件','开发工具','云基础设施'],
  游戏与互动娱乐:['主机发行','移动游戏','电竞赛事','创作者平台','引擎授权','游戏渠道'],
  传媒与文娱:['流媒体订阅','动画制作','数字音乐','院线发行','版权授权','广告分发'],
  硬件与家电:['智能手机','机器人家电','消费光学','家电出口','精密零件','显示面板'],
  互联网与电商:['本地服务','跨境电商','搜索广告','会员商城','商家服务','数字配送'],
  新能源与电池:['光伏组件','电池材料','储能系统','固态电池','逆变器','电池回收'],
  汽车与出行:['整车制造','汽车零件','智能座舱','商用车辆','出行平台','充电网络'],
  银行:['零售存贷','企业信贷','跨境金融','财富管理','区域金融','支付清算'],
  保险:['寿险与养老','财产险','再保险','健康保险','农业保险','保险资管'],
  券商与金融科技:['经纪交易','交易所服务','支付网络','资产管理','量化软件','投行业务'],
  医药与生物:['肿瘤新药','疫苗研发','代谢治疗','罕见病药','仿制药','细胞治疗'],
  医疗器械与服务:['手术机器人','影像设备','医疗耗材','检测服务','医院运营','康复设备'],
  食品饮料:['高端酒饮','乳品加工','健康零食','餐饮连锁','调味品','软饮料'],
  零售与消费:['会员零售','运动品牌','珠宝渠道','家居零售','服装品牌','美妆连锁'],
  能源与煤炭:['油气开采','煤炭长协','炼化加工','油田服务','天然气储运','能源贸易'],
  有色与材料:['铜矿开采','黄金开采','铝冶炼','稀土材料','特种化工','锂资源'],
  工业与军工:['航空设备','工程机械','轨道装备','工业自动化','防务电子','船舶制造'],
  地产与基建:['商业地产','住宅开发','基础设施','物业服务','物流园区','城市更新'],
  公用事业:['水力发电','燃气分销','电网运营','水务处理','核电运营','供热服务'],
  通信与网络:['移动运营','宽带网络','卫星通信','光纤设备','网络安全','通信铁塔'],
  航空航运与物流:['客运航空','货运航空','集装箱航运','快递网络','港口服务','供应链仓储']
};
const stems=['澄川','远岑','北辰','云衡','青屿','辰海'];
const newsKinds = {
  半导体:['出口限制','库存周期','研发突破'], 人工智能:['产品发布','算力成本','商业化进展'], 软件与云服务:['续费率','数据安全','业绩指引'],
  游戏与互动娱乐:['版号审批','新品延期','付费转化'], 传媒与文娱:['内容上线','版权纠纷','广告预算'], 硬件与家电:['供应链','新品发布','消费需求'],
  互联网与电商:['监管变化','流量成本','交易额'], 新能源与电池:['补贴政策','材料价格','产能过剩'], 汽车与出行:['交付量','价格战','召回'],
  银行:['利率变化','信用损失','存款流动'], 保险:['灾害赔付','投资收益','保费增长'], 券商与金融科技:['交易活跃','监管变化','资金流动'],
  医药与生物:['临床结果','药物审批','专利变化'], 医疗器械与服务:['产品认证','集采价格','设备召回'], 食品饮料:['原料价格','渠道库存','品牌需求'],
  零售与消费:['消费需求','折扣压力','同店销售'], 能源与煤炭:['供给变化','油煤价格','长协合同'], 有色与材料:['金属价格','矿山供给','工业需求'],
  工业与军工:['订单签约','资本开支','贸易限制'], 地产与基建:['融资政策','销售回款','项目开工'], 公用事业:['电价调整','燃料成本','来水变化'],
  通信与网络:['资费政策','网络投资','用户增长'], 航空航运与物流:['运价变化','燃油成本','航线中断']
};
const originals = catalog.instruments.filter(item => !/^NX\d+$/.test(item.symbol));
originals.forEach(item => { item.industry = aliases[item.industry] ?? item.industry; });
const instruments = [...originals]; let number = 0;
for (const industry of Object.keys(calibration.profiles)) {
  const existing = instruments.filter(item => item.industry === industry);
  if (existing.length > 6) throw new Error('Sector overflow: ' + industry);
  while (existing.length < 6) {
    const slot = existing.length; const counts = Object.fromEntries(['CN','HK','US'].map(market => [market,existing.filter(item => item.market === market).length]));
    const market = ['CN','HK','US'].sort((a,b) => counts[a] - counts[b])[0]; const id = ++number;
    const item = { symbol:'NX'+String(id).padStart(3,'0'), code:market==='CN'?String(689500+id):market==='HK'?String(9500+id).padStart(5,'0'):'SG'+String(id).padStart(3,'0'),
      name:stems[slot]+businesses[industry][slot].replace(/与.+$/,'')+(market==='US'?' Global':''), industry,market,listedAt:'2019-01-02',
      description:`虚构企业，主营${businesses[industry][slot]}；收入受${newsKinds[industry][slot%3]}影响，${slot%2?'扩张投入较高，短期利润承压':'成熟业务提供现金流，新增项目带来增长机会'}。`,
      initialPrice:Math.round((market==='US'?7000:market==='HK'?3600:2400)*(1+slot*.4)),volatility:.02 };
    instruments.push(item); existing.push(item);
  }
  existing.forEach((item, slot) => {
    const profile = calibration.profiles[industry][item.market]; const multiplier = [.85,1.12,.95,1.18,.9,1.05][slot];
    item.volatility = Math.round(profile.dailyVolatility * multiplier * 1e6) / 1e6;
    const {alpha,beta,gamma,omega} = profile.gjr;
    item.riskProfile = { marketWeight:profile.marketWeight,sectorWeight:profile.sectorWeight,gapScale:profile.gapScale,intradayFraction:profile.intradayFraction,wickScale:profile.wickScale,gjr:{alpha,beta,gamma,omega},
      eventSensitivity:[.85,1.2,1,.75,1.3,.95][slot], dividendYield:['银行','保险','公用事业','能源与煤炭','通信与网络'].includes(industry)?[.05,.03,.045,.02,.06,.035][slot]:[.005,0,.008,.01,0,.003][slot],
      newsKinds:newsKinds[industry], business:businesses[industry][slot] };
  });
}
if (instruments.length!==138||new Set(instruments.map(item=>item.symbol)).size!==138) throw new Error('Catalog invariant failed');
fs.writeFileSync(file, JSON.stringify({ ...catalog, instruments, remaster:{ sectors:23, perSector:6, calibrationVersion:calibration.version, fictional:true } }, null, 2)+'\n');
console.log(JSON.stringify({ preserved:originals.length, added:number, total:instruments.length, sectors:23,
  markets:Object.fromEntries(['CN','HK','US'].map(market=>[market,instruments.filter(item=>item.market===market).length])) }));
