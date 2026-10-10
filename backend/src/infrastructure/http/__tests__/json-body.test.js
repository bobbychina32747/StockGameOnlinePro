const express = require('express');
const { installJsonBodies } = require('../../../../dist/src/infrastructure/http/json-body');

describe('JSON request limits', () => {
  let server, base;
  beforeAll(async () => {
    const app = express();
    installJsonBodies(app);
    app.put('/api/auth/identity/saves', (req, res) => res.json({ bytes: req.body.data.length }));
    app.put('/api/other', (req, res) => res.json({ ok: true }));
    app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.type }));
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  const put = (route, length) => fetch(base + route, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: 'A'.repeat(length) }) });
  test('2 MiB saves pass the transport parser', async () => {
    const res = await put('/api/auth/identity/saves', 2 * 1024 * 1024);
    expect(res.status).toBe(200);
    expect((await res.json()).bytes).toBe(2 * 1024 * 1024);
  });
  test('other routes retain their 1 MiB limit', async () => {
    expect((await put('/api/other', 1250000)).status).toBe(413);
  });
  test('saves still have a bounded request body', async () => {
    expect((await put('/api/auth/identity/saves', 4 * 1024 * 1024)).status).toBe(413);
  });
});
