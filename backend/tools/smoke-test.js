/* 冒烟测试：验证 F1（挂单成交记账）、F3（做空结算）、基础交易 */
const http = require('http');

const BASE = 'http://localhost:8000/api';
const TOKEN = null; // 运行时填充

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(BASE + path);
    const opts = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (token) opts.headers.Authorization = 'Bearer ' + token;
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const r = http.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { resolve({ raw: d }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function main() {
  // 1. 登录
  const login = await req('POST', '/auth/login', { username: 'Bobbychina', password: 'ThisIsTheBestProjectEver' });
  if (!login.token) { console.log('❌ 登录失败', JSON.stringify(login)); return; }
  const token = login.token;
  console.log('✅ 登录成功');

  // 2. 账户初始状态
  let acct = await req('GET', '/account?mode=US', null, token);
  const cash0 = acct.account.cash;
  console.log(`✅ 初始现金: ${cash0}`);

  // 3. 市价买入 200 股（A 股价格约 100）
  const buy = await req('POST', '/trading/order?mode=US', { symbol: 'A', type: 'market', side: 'buy', quantity: 200 }, token);
  if (!buy.success) { console.log('❌ 市价买入失败', JSON.stringify(buy)); return; }
  acct = await req('GET', '/account?mode=US', null, token);
  const posA = acct.positions.find((p) => p.symbol === 'A');
  const expectedCash = cash0 - buy.fill.totalCost - buy.fill.fees.totalFees;
  const cashOk = Math.abs(acct.account.cash - expectedCash) < 0.01;
  const posOk = posA && posA.longQty === 200;
  console.log(`${cashOk && posOk ? '✅' : '❌'} 市价买入记账: 现金 ${acct.account.cash} (期望 ~${expectedCash.toFixed(2)}), 持仓 ${posA ? posA.longQty : 0}股`);

  // 4. F1 验证：挂限价买单（当前价下方，保证立即触发），成交后现金/持仓应更新
  const klines = await req('GET', '/market/klines?symbol=A&timeframe=1min', null, null);
  const last = klines[klines.length - 1];
  const limitPrice = Math.round((last.close * 1.002) * 100) / 100; // 高于现价，立即触发
  const cashBeforeLimit = acct.account.cash;
  const posBeforeLimit = posA ? posA.longQty : 0;
  const limit = await req('POST', '/trading/order?mode=US', { symbol: 'A', type: 'limit', side: 'buy', quantity: 100, price: limitPrice }, token);
  if (!limit.success) { console.log('❌ 挂限价单失败', JSON.stringify(limit)); return; }
  console.log(`✅ 挂限价买单 ${limitPrice} x 100，等待成交...`);
  // 等最多 10 秒（tick 每秒检查挂单）
  let filled = false;
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const pending = await req('GET', '/trading/orders/pending?mode=US', null, token);
    if (!Array.isArray(pending) || pending.length === 0) { filled = true; break; }
  }
  acct = await req('GET', '/account?mode=US', null, token);
  const posAAfter = acct.positions.find((p) => p.symbol === 'A');
  const newQty = posAAfter ? posAAfter.longQty : 0;
  const filledOk = filled && newQty === posBeforeLimit + 100 && acct.account.cash < cashBeforeLimit;
  console.log(`${filledOk ? '✅' : '❌'} F1 挂单成交记账: 成交=${filled}, 持仓 ${posBeforeLimit}→${newQty}, 现金 ${cashBeforeLimit}→${acct.account.cash.toFixed(2)}`);

  // 5. F3 验证：做空 100 股，再平空，现金应回正
  const acctUS = await req('GET', '/account?mode=US', null, token);
  const cashBeforeShort = acctUS.account.cash;
  const short = await req('POST', '/trading/order?mode=US', { symbol: 'B', type: 'market', side: 'short', quantity: 100 }, token);
  if (!short.success) { console.log('❌ 做空失败', JSON.stringify(short)); return; }
  acct = await req('GET', '/account?mode=US', null, token);
  const posB = acct.positions.find((p) => p.symbol === 'B');
  const collateralAfterShort = acct.account.shortCollateral || 0;
  console.log(`✅ 做空: 现金 ${cashBeforeShort}→${acct.account.cash.toFixed(2)}, 空仓 ${posB ? posB.shortQty : 0}股, 冻结 ${collateralAfterShort.toFixed(2)}`);
  const cover = await req('POST', '/trading/order?mode=US', { symbol: 'B', type: 'market', side: 'cover', quantity: 100 }, token);
  if (!cover.success) { console.log('❌ 平空失败', JSON.stringify(cover)); return; }
  acct = await req('GET', '/account?mode=US', null, token);
  const posBAfter = acct.positions.find((p) => p.symbol === 'B');
  const shortRoundTripOk = (posBAfter ? posBAfter.shortQty : 0) === 0 && (acct.account.shortCollateral || 0) === 0;
  const pnl = acct.account.cash - cashBeforeShort;
  console.log(`${shortRoundTripOk ? '✅' : '❌'} F3 做空平仓闭环: 空仓归零=${shortRoundTripOk}, 冻结释放=${(acct.account.shortCollateral || 0) === 0}, 做空盈亏=${pnl.toFixed(2)}`);

  console.log('\n冒烟测试完成');
  process.exit(0);
}

main().catch((e) => { console.error('❌ 异常:', e.message); process.exit(1); });
