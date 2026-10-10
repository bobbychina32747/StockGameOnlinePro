const fs=require('node:fs'),path=require('node:path');
const out=process.argv[2];const root=path.join(__dirname,'..');
const catalog=require('../packages/domain/catalog.json').instruments;
const universe=require('../packages/domain/research-universe.json');
const timeline=require('../packages/domain/news-timeline.json');
const study=JSON.parse(fs.readFileSync(path.join(out,'news-event-study.json'),'utf8'));
const validation=JSON.parse(fs.readFileSync(path.join(out,'realism-validation.json'),'utf8'));
const stat=validation.summary;
const sourceLink=(label,filename)=>`[${label}](${path.join(out,filename).replaceAll('\\','/')})`;
const companyCoverage=new Set(study.results.filter(row=>!row.excluded&&study.events.find(event=>event.id===row.eventId).scope!=='all').map(row=>row.industry));
const table=Object.keys(universe).map(industry=>`| ${industry} | ${catalog.filter(stock=>stock.industry===industry).map(stock=>stock.name+' ('+stock.symbol+')').join('、')} | ${universe[industry].join('、')} |`).join('\n');
const events=timeline.events.map(event=>`| ${event.date} | ${event.title} | ${event.publishedAt??(event.publicationWindow?event.publicationWindow.join(' ～ '):({'after-close':'盘后；分钟未核实','before-open':'盘前；分钟未核实','during-session':'盘中；分钟未核实',weekend:'周末；分钟未核实',unknown:'仅日期；双交易日窗口'})[event.session])} | [原始公告](${event.sources[0]}) |`).join('\n');
const report=`# 行业扩展与市场真实性校准

日期：2026-10-10。交付位置：独立的 remaster/，以及本次静态概念页。旧版应用、真实玩家数据库与站点账号不在本轮修改范围。

## 已落实

- 基础股票池从 68 扩展到 **138**：**23 个行业，每行业 6 支**，三市场合计。中国 49、香港 45、美国 44；原来的股票标识、代码、名称保留。自动 IPO 属于运行期新增，不计入基础目录的六支配额。
- 同一行业的公司有不同波动幅度、主营业务、股息率、事件敏感度；各行业按三市场分别校准，非一组随机参数套所有股票。
- 历史价格使用共享市场/行业因子、标准化 Student-t 创新、GJR 条件波动、跳空、稀有冲击和 OHLC 上下影线。取消周期性价格曲线，并显著降低盘中强制回归。
- 盘中波动保留开盘活动结构；买卖价差、做市深度随压力变化。盘中成交量只统计实际撮合，历史模拟成交量另由随机模型生成，不宣称是实际交易。
- 新闻先公开，价格影响在后续撮合分钟释放；考虑预期差、提前计价、公司/行业溢出与衰减。未释放价格影响不出现在客户端快照。
- 删除概念页大标题和 Market Pulse，主导航移到页面底部，扩大图表。概念页也改用新模型生成的 K 线，股票目录与重制应用一致。

## 真实样本与质量检查

真实参考：138 支股票 + 3 个指数（上证综指、恒生指数、标普 500）。共 **${stat.dailyBars.toLocaleString('en-US')} 条日线**，主要区间 2021-10-11 至 2026-10-09。另采集 **15,591 条五分钟线**，来自三市场的半导体/游戏、银行、医药和公用事业代表，共 12 支，最近一个月。

来源为 Yahoo Finance 公开 chart 数据，每个记录保留实际 URL、获取时间、交易所时区、复权说明。日线开高低收统一使用 adjclose/close 因子；成交量保留源数据单位。最初 EA 与 000300.SS 接口仅给出一条价格，未用于拟合，分别改用 RBLX 与 000001.SS。${stat.vendorRangesExcludedFromCalibration} 条源数据的高低区间未包含开盘/收盘，明确排除振幅拟合；没有伪造或修补高低价，其收盘收益仍保留。

${sourceLink('日线原始数据','market-samples.ndjson')} · ${sourceLink('五分钟原始数据','intraday-samples.ndjson')} · ${sourceLink('逐股票训练和留出统计','sector-statistics.json')}。

## 校准方法与留出检验

训练严格截止于 **2025-10-01 之前**，后续数据不参与行业参数拟合。每行业每市场取两支参考股票，估计日收益波动、市场相关、跳空/波动比、振幅/波动比和日内收益比例。GJR 使用有界 Student-t(5) 似然网格；参数保持平稳性。每支游戏股票在行业参考上有独立倍率与事件暴露。

日内开盘/收盘活动只使用连续五分钟收益，排除隔夜、午休间隔。最近一个月的样本不代表多年稳定规律，开盘强度设置上限并归一化。日线参数转换成分钟持久性，不把每天的波动更新强度原样重复几百次。

69 组行业/市场、每组 5 个种子，对留出区间模拟检验：

| 指标 | 69 组的中位数 |
| --- | ---: |
| 模拟波动 / 训练参考波动 | ${stat.medianSimulatedVolatilityVsTraining.toFixed(3)} |
| 模拟波动 / 留出真实波动 | ${stat.medianSimulatedVolatilityVsHoldout.toFixed(3)} |
| 模拟跳空 / 留出真实跳空 | ${stat.medianSimulatedGapVsHoldout.toFixed(3)} |
| 模拟收益超额峰度 | ${stat.medianSimulatedKurtosis.toFixed(3)} |
| 模拟绝对收益一阶相关 | ${stat.medianSimulatedAbsoluteReturnLag1.toFixed(3)} |

以上是跨组中位数，不代表每支股票都达到同样误差。部分行业会因行情阶段变化而偏离训练期；未声称能复现未来走势或完全拟合真实市场。

${sourceLink('逐行业留出检验','realism-validation.json')} · ${sourceLink('日内活动统计','intraday-statistics.json')}。

## 新闻时间线和股价反应

28 个事件产生 **${study.results.length} 个股票/交易日反应窗口**。公司、信用、供给案例覆盖 ${companyCoverage.size} 个行业；两项宏观事件另覆盖全股票池。只有 ${timeline.events.filter(event=>event.publishedAt).length} 个事件核实到首次公开分钟，其他保留时段、日期或区间精度。

不把财报截止日、电话会、政策执行日、报道更新日替换成首次公告时间。盘后和周末匹配下一实际交易日；只有日期的记录保留两个可能窗口，并排除幅度拟合。美联储 14:00 美东的公告对美股和香港股票分别落在当日与次日交易。

市场模型的 alpha/beta 只用事件之前第 120 至第 21 个交易日，至少 60 个配对收益；估计期不含事件及其未来收益。报告当日收益、市场调整后的对数收益、2/6 日累计反应、事件前 5 日表现、同行相对表现、跳空与前 20 日成交量倍数。盘中事件的日线同时含发布前交易，无法隔离分钟因果。

财报与指引同时披露、就业/CPI/GDP数据、政策组合、提前计价均保留干扰说明。这是 **关联分析，不是因果识别**。利率、商品供给和信用的行业方向仍属于明确的经济暴露假设；没有把两次宏观公告包装成可靠的因果系数。财报幅度仅用 ${study.model.earnings.sampleSize} 个时段明确的发行人窗口，做收缩和上限处理；事件频率、衰减与稀有跳跃概率是可调整的游戏设计参数。

${sourceLink('完整新闻原始来源和反应窗口','news-event-study.json')}。

| 公告日期 | 事件 | 时间核对结果 | 来源 |
| --- | --- | --- | --- |
${events}

## 各行业对应股票

游戏公司为虚构企业。以下真实股票只作为统计参考，分类是业务参考分组，不宣称是交易所或 GICS 的官方行业分类。

| 行业 | 六支游戏股票 | 六支真实参考股票 |
| --- | --- | --- |
${table}

## 验证与限制

自动测试涵盖目录、日历、同种子确定性、成交守恒、T+1、FOK/IOC、空头保证金、命令幂等、事务各阶段回滚、提交后崩溃恢复、旧写者隔离、新闻先公开后变化、恢复后新闻一致、客户端不泄露潜在价格影响、时区与公告时间不确定性、波动厚尾及聚集。

API 与前端类型检查、生产构建、独立合成账号的 HTTP/WebSocket、桌面和手机布局均执行。浏览器证据及最终测试数以 ${sourceLink('浏览器检查','../chart-layout-checks.json')} 与 ${sourceLink('测试日志','../remaster-tests.log')} 为准。当前文档不代表完整重制验收矩阵的所有项目均完成，更不代表真实身份桥接或生产环境已验证。

理论参考：[Cont 关于收益统计性质的综述](https://onlinelibrary.wiley.com/doi/abs/10.1002/9780470061602.eqf19027)、[统计性质的现代复核研究](https://arxiv.org/abs/2311.07738)。
`;
fs.writeFileSync(path.join(root,'../docs/MARKET-REALISM-20261010.md'),report,'utf8');
console.log(JSON.stringify({companyIndustryCoverage:companyCoverage.size,newsEvents:timeline.events.length,windows:study.results.length,report:'docs/MARKET-REALISM-20261010.md'}));
