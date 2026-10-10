# 行业扩展与市场真实性校准

日期：2026-10-10。交付位置：独立的 remaster/，以及本次静态概念页。旧版应用、真实玩家数据库与站点账号不在本轮修改范围。

## 已落实

- 基础股票池从 68 扩展到 **138**：**23 个行业，每行业 6 支**，三市场合计。中国 49、香港 45、美国 44；原来的股票标识、代码、名称保留。自动 IPO 属于运行期新增，不计入基础目录的六支配额。
- 同一行业的公司有不同波动幅度、主营业务、股息率、事件敏感度；各行业按三市场分别校准，非一组随机参数套所有股票。
- 历史价格使用共享市场/行业因子、标准化 Student-t 创新、GJR 条件波动、跳空、稀有冲击和 OHLC 上下影线。取消周期性价格曲线，并显著降低盘中强制回归。
- 盘中波动保留开盘活动结构；买卖价差、做市深度随压力变化。盘中成交量只统计实际撮合，历史模拟成交量另由随机模型生成，不宣称是实际交易。
- 新闻先公开，价格影响在后续撮合分钟释放；考虑预期差、提前计价、公司/行业溢出与衰减。未释放价格影响不出现在客户端快照。
- 删除概念页大标题和 Market Pulse，主导航移到页面底部，扩大图表。概念页也改用新模型生成的 K 线，股票目录与重制应用一致。

## 真实样本与质量检查

真实参考：138 支股票 + 3 个指数（上证综指、恒生指数、标普 500）。共 **173,066 条日线**，主要区间 2021-10-11 至 2026-10-09。另采集 **15,591 条五分钟线**，来自三市场的半导体/游戏、银行、医药和公用事业代表，共 12 支，最近一个月。

来源为 Yahoo Finance 公开 chart 数据，每个记录保留实际 URL、获取时间、交易所时区、复权说明。日线开高低收统一使用 adjclose/close 因子；成交量保留源数据单位。最初 EA 与 000300.SS 接口仅给出一条价格，未用于拟合，分别改用 RBLX 与 000001.SS。32 条源数据的高低区间未包含开盘/收盘，明确排除振幅拟合；没有伪造或修补高低价，其收盘收益仍保留。

[日线原始数据](C:/Users/lenovo/.codex/visualizations/2026/10/10/01a124f3-4a8d-7371-9df8-c4ac46738b31/real-market-research/market-samples.ndjson) · [五分钟原始数据](C:/Users/lenovo/.codex/visualizations/2026/10/10/01a124f3-4a8d-7371-9df8-c4ac46738b31/real-market-research/intraday-samples.ndjson) · [逐股票训练和留出统计](C:/Users/lenovo/.codex/visualizations/2026/10/10/01a124f3-4a8d-7371-9df8-c4ac46738b31/real-market-research/sector-statistics.json)。

## 校准方法与留出检验

训练严格截止于 **2025-10-01 之前**，后续数据不参与行业参数拟合。每行业每市场取两支参考股票，估计日收益波动、市场相关、跳空/波动比、振幅/波动比和日内收益比例。GJR 使用有界 Student-t(5) 似然网格；参数保持平稳性。每支游戏股票在行业参考上有独立倍率与事件暴露。

日内开盘/收盘活动只使用连续五分钟收益，排除隔夜、午休间隔。最近一个月的样本不代表多年稳定规律，开盘强度设置上限并归一化。日线参数转换成分钟持久性，不把每天的波动更新强度原样重复几百次。

69 组行业/市场、每组 5 个种子，对留出区间模拟检验：

| 指标 | 69 组的中位数 |
| --- | ---: |
| 模拟波动 / 训练参考波动 | 0.960 |
| 模拟波动 / 留出真实波动 | 1.079 |
| 模拟跳空 / 留出真实跳空 | 1.002 |
| 模拟收益超额峰度 | 1.563 |
| 模拟绝对收益一阶相关 | 0.068 |

以上是跨组中位数，不代表每支股票都达到同样误差。部分行业会因行情阶段变化而偏离训练期；未声称能复现未来走势或完全拟合真实市场。

[逐行业留出检验](C:/Users/lenovo/.codex/visualizations/2026/10/10/01a124f3-4a8d-7371-9df8-c4ac46738b31/real-market-research/realism-validation.json) · [日内活动统计](C:/Users/lenovo/.codex/visualizations/2026/10/10/01a124f3-4a8d-7371-9df8-c4ac46738b31/real-market-research/intraday-statistics.json)。

## 新闻时间线和股价反应

28 个事件产生 **354 个股票/交易日反应窗口**。公司、信用、供给案例覆盖 23 个行业；两项宏观事件另覆盖全股票池。只有 3 个事件核实到首次公开分钟，其他保留时段、日期或区间精度。

不把财报截止日、电话会、政策执行日、报道更新日替换成首次公告时间。盘后和周末匹配下一实际交易日；只有日期的记录保留两个可能窗口，并排除幅度拟合。美联储 14:00 美东的公告对美股和香港股票分别落在当日与次日交易。

市场模型的 alpha/beta 只用事件之前第 120 至第 21 个交易日，至少 60 个配对收益；估计期不含事件及其未来收益。报告当日收益、市场调整后的对数收益、2/6 日累计反应、事件前 5 日表现、同行相对表现、跳空与前 20 日成交量倍数。盘中事件的日线同时含发布前交易，无法隔离分钟因果。

财报与指引同时披露、就业/CPI/GDP数据、政策组合、提前计价均保留干扰说明。这是 **关联分析，不是因果识别**。利率、商品供给和信用的行业方向仍属于明确的经济暴露假设；没有把两次宏观公告包装成可靠的因果系数。财报幅度仅用 16 个时段明确的发行人窗口，做收缩和上限处理；事件频率、衰减与稀有跳跃概率是可调整的游戏设计参数。

[完整新闻原始来源和反应窗口](C:/Users/lenovo/.codex/visualizations/2026/10/10/01a124f3-4a8d-7371-9df8-c4ac46738b31/real-market-research/news-event-study.json)。

| 公告日期 | 事件 | 时间核对结果 | 来源 |
| --- | --- | --- | --- |
| 2024-05-22 | 英伟达季度财报与拆股公告 | 盘后；分钟未核实 | [原始公告](https://investor.nvidia.com/news/press-release-details/2024/NVIDIA-Announces-Financial-Results-for-First-Quarter-Fiscal-2025/) |
| 2024-05-29 | Salesforce季度财报与下一季度指引 | 盘后；分钟未核实 | [原始公告](https://investor.salesforce.com/news/news-details/2024/Salesforce-Announces-First-Quarter-Fiscal-2025-Results/default.aspx) |
| 2022-04-19 | Netflix季度财报与用户数量变化 | 盘后；分钟未核实 | [原始公告](https://ir.netflix.net/investor-news-and-events/financial-releases/press-release-details/2022/Netflix-Releases-First-Quarter-2022-Financial-Results/default.aspx) |
| 2024-05-02 | 苹果季度财报与回购计划 | 盘后；分钟未核实 | [原始公告](https://www.apple.com/sg/newsroom/2024/05/apple-reports-second-quarter-results/) |
| 2024-08-01 | 亚马逊季度财报与销售指引 | 盘后；分钟未核实 | [原始公告](https://ir.aboutamazon.com/news-release/news-release-details/2024/Amazon-com-Announces-Second-Quarter-Results/default.aspx) |
| 2024-05-09 | Roblox季度财报与全年指引 | 盘前；分钟未核实 | [原始公告](https://ir.roblox.com/news/news-details/2024/Roblox-Reports-First-Quarter-2024-Financial-Results/) |
| 2024-01-30 | 微软FY24第二季度财报 | 盘后；分钟未核实 | [原始公告](https://www.microsoft.com/en-us/investor/earnings/fy-2024-q2/press-release-webcast) |
| 2024-06-27 | 耐克FY24第四季度财报与指引 | 盘后；分钟未核实 | [原始公告](https://www.sec.gov/Archives/edgar/data/320187/000032018724000028/q4fy24exhibit991er.htm) |
| 2023-04-27 | 礼来SURMOUNT-2临床结果 | 2023-04-27T06:15:00-04:00 | [原始公告](https://investor.lilly.com/node/48776) |
| 2024-07-11 | 百事季度财报 | 盘前；分钟未核实 | [原始公告](https://www.sec.gov/Archives/edgar/data/77476/000007747624000043/q220248-kxexhibit991.htm) |
| 2024-07-11 | 达美航空季度财报与指引 | 2024-07-11T06:30:00-04:00 | [原始公告](https://ir.delta.com/news/news-details/2024/Delta-Air-Lines-Announces-June-Quarter-2024-Financial-Results/default.aspx) |
| 2024-09-18 | 美联储下调政策利率50基点 | 2024-09-18T14:00:00-04:00 | [原始公告](https://www.federalreserve.gov/newsevents/pressreleases/monetary20240918a.htm) |
| 2024-09-24 | 金融支持经济发展政策发布会 | 2024-09-24T09:00:00+08:00 ～ 2024-09-24T09:39:56+08:00 | [原始公告](https://www.csrc.gov.cn/csrc/c106311/c7508374/content.shtml) |
| 2023-04-02 | OPEC+成员公布自愿减产 | 周末；分钟未核实 | [原始公告](https://opec.org/pr-detail/63-03-apr-2023.html) |
| 2023-03-10 | 硅谷银行关闭及银行风险传导 | 盘中；分钟未核实 | [原始公告](https://www.fdic.gov/news/press-releases/2023/pr23016.html) |
| 2023-03-12 | 美国监管机构联合银行存款措施 | 周末；分钟未核实 | [原始公告](https://www.fdic.gov/news/press-releases/2023/pr23017.html) |
| 2024-04-25 | 卡特彼勒季度财报与销量变化 | 盘前；分钟未核实 | [原始公告](https://www.caterpillar.com/en/news/corporate-press-releases/h/1q24-results-caterpillar-inc.html) |
| 2024-04-23 | Freeport季度财报与铜矿运营结果 | 仅日期；双交易日窗口 | [原始公告](https://investors.fcx.com/investors/news-releases/news-release-details/2024/Freeport-McMoRan-Reports-First-Quarter-2024-Results/default.aspx) |
| 2023-07-26 | AT&T季度现金流与用户增长 | 盘前；分钟未核实 | [原始公告](https://about.att.com/story/2023/q2-earnings.html) |
| 2024-01-25 | NextEra全年财报与电力投资前景 | 盘前；分钟未核实 | [原始公告](https://www.investor.nexteraenergy.com/news-and-events/news-releases/2024/01-25-2024-123108652) |
| 2024-01-23 | D.R. Horton季度财报与住宅订单 | 盘前；分钟未核实 | [原始公告](https://investor.drhorton.com/news-and-events/press-releases/2024/01-23-2024-113041740) |
| 2024-01-24 | 雅培全年财报与器械销售预期 | 仅日期；双交易日窗口 | [原始公告](https://abbott.mediaroom.com/2024-01-24-Abbott-Reports-Fourth-Quarter-and-Full-Year-2023-Results-Issues-2024-Financial-Outlook) |
| 2024-02-27 | First Solar全年财报与订单指引 | 盘后；分钟未核实 | [原始公告](https://www.sec.gov/Archives/edgar/data/1274494/000127449424000003/ex991pressreleaseq4-2023fi.htm) |
| 2024-04-23 | 特斯拉季度财报与车型规划 | 盘后；分钟未核实 | [原始公告](https://ir.tesla.com/press-release/tesla-releases-first-quarter-2024-financial-results) |
| 2024-01-30 | Chubb全年财报与承保结果 | 仅日期；双交易日窗口 | [原始公告](https://investors.chubb.com/files/doc_financials/2023/q4/4th-Quarter-2023-Earnings-Press-Release.pdf) |
| 2024-03-20 | 腾讯全年财报与回购计划 | 仅日期；双交易日窗口 | [原始公告](https://static.www.tencent.com/uploads/2024/03/20/fe50310bf15caaab4b05dd9e8e49d316.pdf) |
| 2024-03-19 | 小米全年财报与业务展望 | 仅日期；双交易日窗口 | [原始公告](https://ir.mi.com/events/event-details/xiaomi-corporation-2023-annual-results-announcement) |
| 2024-03-22 | 美团全年财报与配送订单 | 仅日期；双交易日窗口 | [原始公告](https://www.meituan.com/news/NN240322064007784) |

## 各行业对应股票

游戏公司为虚构企业。以下真实股票只作为统计参考，分类是业务参考分组，不宣称是交易所或 GICS 的官方行业分类。

| 行业 | 六支游戏股票 | 六支真实参考股票 |
| --- | --- | --- |
| 半导体 | 芯澜半导体 (T1)、恒芯科技 (H13)、NovaChip (U1)、IntelCore (U19)、青屿芯片设备 (NX001)、辰海存储设计 (NX002) | NVDA、AMD、688981.SS、688012.SS、0981.HK、1347.HK |
| 人工智能 | 星语智能 (T2)、GalaxyNet (U2)、北辰视觉检测 (NX003)、云衡算力调度 (NX004)、青屿行业智能体 (NX005)、辰海机器人算法 Global (NX006) | MSFT、PLTR、002230.SZ、300033.SZ、0020.HK、6682.HK |
| 软件与云服务 | 帧光软件 (T3)、CloudPeak (U4)、北辰云安全 (NX007)、云衡财务软件 (NX008)、青屿开发工具 (NX009)、辰海云基础设施 Global (NX010) | CRM、ORCL、600588.SS、688111.SS、0268.HK、0909.HK |
| 游戏与互动娱乐 | 星界游戏 (G1)、云端电竞 (G3)、像素工坊 (G4)、霓虹引擎 (V1)、青屿引擎授权 (NX011)、辰海游戏渠道 Global (NX012) | RBLX、TTWO、002555.SZ、002602.SZ、0700.HK、9999.HK |
| 传媒与文娱 | 幻光互娱 (G2)、天籁音乐 (G5)、次元文创 (V2)、WaltRealm (U15)、StreamRealm (U18)、辰海广告分发 (NX013) | DIS、NFLX、300413.SZ、300251.SZ、0772.HK、1024.HK |
| 硬件与家电 | 蓝湾家电 (C3)、PixelSoft (U9)、北辰消费光学 (NX014)、云衡家电出口 (NX015)、青屿精密零件 (NX016)、辰海显示面板 Global (NX017) | AAPL、SONY、002475.SZ、000333.SZ、1810.HK、2018.HK |
| 互联网与电商 | 云顶网络 (H1)、云帆电商 (H3)、AlphaSearch (U10)、Amazonia (U13)、青屿商家服务 (NX018)、辰海数字配送 (NX019) | AMZN、BABA、002127.SZ、002315.SZ、3690.HK、9618.HK |
| 新能源与电池 | 日曜能源 (E1)、电芯动力 (E2)、北辰储能系统 (NX020)、云衡固态电池 Global (NX021)、青屿逆变器 (NX022)、辰海电池回收 Global (NX023) | FSLR、ALB、300750.SZ、601012.SS、1211.HK、3800.HK |
| 汽车与出行 | 追光汽车 (E3)、港汽集团 (H15)、VoltAuto (U3)、云衡商用车辆 (NX024)、青屿出行平台 (NX025)、辰海充电网络 Global (NX026) | TSLA、GM、600104.SS、601238.SS、9868.HK、2015.HK |
| 银行 | 江城银行 (F1)、华融银行 (H5)、RiverBank (U8)、云衡财富管理 (NX027)、青屿区域金融 (NX028)、辰海支付清算 Global (NX029) | JPM、BAC、000001.SZ、600036.SS、0939.HK、3988.HK |
| 保险 | 磐石保险 (F3)、裕丰保险 (H9)、北辰再保险 Global (NX030)、云衡健康保险 (NX031)、青屿农业保险 (NX032)、辰海保险资管 Global (NX033) | AIG、CB、601318.SS、601601.SS、1299.HK、2318.HK |
| 券商与金融科技 | 云帆证券 (F2)、港联交易所 (H18)、QuantumPay (U5)、CryptoPay (U14)、青屿量化软件 (NX034)、辰海投行业务 (NX035) | GS、SCHW、600030.SS、300059.SZ、0388.HK、6030.HK |
| 医药与生物 | 青囊医药 (M1)、澜生生物 (M3)、辉腾医药 (H7)、MedForge (U6)、PfizerLab (U16)、辰海细胞治疗 (NX036) | PFE、LLY、600276.SS、300122.SZ、1177.HK、2269.HK |
| 医疗器械与服务 | 白泽医疗 (M2)、康达医疗 (H16)、北辰医疗耗材 Global (NX037)、云衡检测服务 (NX038)、青屿医院运营 (NX039)、辰海康复设备 Global (NX040) | ABT、MDT、300760.SZ、300015.SZ、1099.HK、6618.HK |
| 食品饮料 | 杏花酿 (C1)、牧野食品 (C2)、维他食品 (H19)、GoldenFry (U11)、CocaRiver (U20)、辰海软饮料 (NX041) | KO、PEP、600519.SS、600887.SS、2319.HK、0322.HK |
| 零售与消费 | 美图生活 (H4)、皇冠珠宝 (H11)、百佳零售 (H14)、HomeCraft (U17)、青屿服装品牌 (NX042)、辰海美妆连锁 (NX043) | COST、NKE、002024.SZ、600612.SS、2020.HK、1929.HK |
| 能源与煤炭 | 墨石能源 (R2)、南海能源 (H20)、EverGreen Energy (U12)、云衡油田服务 (NX044)、青屿天然气储运 (NX045)、辰海能源贸易 Global (NX046) | XOM、CVX、601857.SS、601088.SS、0883.HK、1088.HK |
| 有色与材料 | 金川有色 (R1)、远岑黄金开采 (NX047)、北辰铝冶炼 Global (NX048)、云衡稀土材料 (NX049)、青屿特种化工 (NX050)、辰海锂资源 Global (NX051) | FCX、NEM、601899.SS、600309.SS、0358.HK、2600.HK |
| 工业与军工 | 长空防务 (D1)、湾区制造 (H12)、FalconAero (U7)、云衡工业自动化 (NX052)、青屿防务电子 (NX053)、辰海船舶制造 Global (NX054) | CAT、LMT、600031.SS、600893.SS、1766.HK、2357.HK |
| 地产与基建 | 广厦置业 (P1)、长桥地产 (H8)、北辰基础设施 Global (NX055)、云衡物业服务 (NX056)、青屿物流园区 (NX057)、辰海城市更新 Global (NX058) | DHI、PLD、000002.SZ、600048.SS、1109.HK、0016.HK |
| 公用事业 | 港能集团 (H6)、远岑燃气分销 (NX059)、北辰电网运营 Global (NX060)、云衡水务处理 (NX061)、青屿核电运营 (NX062)、辰海供热服务 Global (NX063) | NEE、DUK、600900.SS、600025.SS、0002.HK、0006.HK |
| 通信与网络 | 微波通信 (T4)、金港电信 (H2)、北辰卫星通信 Global (NX064)、云衡光纤设备 (NX065)、青屿网络安全 (NX066)、辰海通信铁塔 Global (NX067) | VZ、T、600050.SS、600941.SS、0941.HK、0728.HK |
| 航空航运与物流 | 速鹰物流 (V3)、环球航运 (H10)、国泰航空 (H17)、云衡快递网络 Global (NX068)、青屿港口服务 (NX069)、辰海供应链仓储 Global (NX070) | DAL、UPS、601111.SS、002352.SZ、0293.HK、1919.HK |

## 验证与限制

自动测试涵盖目录、日历、同种子确定性、成交守恒、T+1、FOK/IOC、空头保证金、命令幂等、事务各阶段回滚、提交后崩溃恢复、旧写者隔离、新闻先公开后变化、恢复后新闻一致、客户端不泄露潜在价格影响、时区与公告时间不确定性、波动厚尾及聚集。

API 与前端类型检查、生产构建、独立合成账号的 HTTP/WebSocket、桌面和手机布局均执行。浏览器证据及最终测试数以 [浏览器检查](C:/Users/lenovo/.codex/visualizations/2026/10/10/01a124f3-4a8d-7371-9df8-c4ac46738b31/chart-layout-checks.json) 与 [测试日志](C:/Users/lenovo/.codex/visualizations/2026/10/10/01a124f3-4a8d-7371-9df8-c4ac46738b31/remaster-tests.log) 为准。当前文档不代表完整重制验收矩阵的所有项目均完成，更不代表真实身份桥接或生产环境已验证。

理论参考：[Cont 关于收益统计性质的综述](https://onlinelibrary.wiley.com/doi/abs/10.1002/9780470061602.eqf19027)、[统计性质的现代复核研究](https://arxiv.org/abs/2311.07738)。
