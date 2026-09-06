// Phase D 回归：API.md 与实现路由一致（静态抽查）——文档漂移防再腐烂
const fs = require('fs');
const path = require('path');

const apiMd = fs.readFileSync(path.resolve(__dirname, '../../docs/API.md'), 'utf8');

describe('API.md 与实现路由一致（静态抽查）', () => {
  const MUST_HAVE = [
    'POST /auth/register', 'POST /auth/login',
    'GET /user/profile', 'PUT /user/profile',
    'GET /account', 'GET /account/metrics', 'GET /account/history', 'GET /account/transactions',
    'GET /account/reviews', 'POST /account/leverage', 'POST /account/reset', 'POST /account/transfer',
    'GET /account/achievements', 'POST /account/achievements',
    'POST /trading/order', 'DELETE /trading/order/:id', 'GET /trading/orders/pending', 'GET /trading/history',
    'GET /market/prices', 'GET /market/stocks', 'GET /market/indices', 'GET /market/state',
    'GET /market/reports', 'GET /market/ai-opponents', 'GET /market/flow-signals',
    'GET /market/backtest', 'GET /market/klines', 'GET /market/orderbook',
    'GET /fund', 'POST /fund/:id/subscribe', 'POST /fund/:id/redeem',
    'POST /season/enroll', 'GET /season/current', 'GET /season/leaderboard', 'GET /season/history',
    'GET /ranking',
    'GET /admin/stats', 'GET /admin/users', 'POST /admin/users/:id/toggle',
    'POST /admin/debug', 'GET /admin/debug', 'POST /admin/debug/global',
  ];
  test.each(MUST_HAVE)('收录实现路由 %s', (route) => {
    expect(apiMd).toContain(route);
  });

  const MUST_HAVE_SEMANTIC = [
    'fok', 'ioc', 'iceberg', 'stop-limit',
    'isPostCloseTrading', 'counterFills', '维持担保比',
    '15:00-15:30', '20%', 'borrowed', 'cash × leverage', '+44%/-36%',
  ];
  test.each(MUST_HAVE_SEMANTIC)('收录关键语义 %s', (term) => {
    expect(apiMd).toContain(term);
  });

  const MUST_NOT = ['POST /trading/order/:id/cancel', 'GET /trading/orders/history'];
  test.each(MUST_NOT)('不残留漂移路由 %s', (bad) => {
    expect(apiMd).not.toContain(bad);
  });
});
