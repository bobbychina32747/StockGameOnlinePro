const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { AuthBridge } = require('../dist/apps/game-api/auth');
test('Node compatibility adapter keeps site identity and game ledger upstreams separate', async () => {
    const calls = { site: [], game: [] };
    const start = async (name, body) => {
        const server = http.createServer((req, res) => { calls[name].push(req.url); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        return { server, url: 'http://127.0.0.1:' + server.address().port };
    };
    const site = await start('site', { id: 'site-subject' });
    const game = await start('game', { subject: 'game:local-player', user: { id: 'local-player', username: 'Player', isActive: true } });
    const config = { sandbox: false, identityBaseUrl: game.url, siteIdentityBaseUrl: site.url, origin: 'https://game.bobbycn.cc', allowedOrigins: [] };
    try {
        const auth = new AuthBridge(config);
        await auth.request('/api/auth/identity/me');
        const role = await auth.createGameSession('synthetic-native-jwt', 'CN');
        await auth.forward(role.token, '/api/account');
        assert.deepEqual(calls.site, ['/api/auth/identity/me']);
        assert.deepEqual(calls.game, ['/api/auth/game-profile', '/api/account']);
        const unconfigured = new AuthBridge({ ...config, siteIdentityBaseUrl: undefined });
        await assert.rejects(() => unconfigured.request('/api/auth/identity/me'), error => error.getStatus() === 503);
        await assert.rejects(() => auth.request('/api/auth/identity/unsupported'), error => error.getStatus() === 503);
        assert.equal(calls.game.length, 2);
    }
    finally {
        for (const item of [site, game]) {
            item.server.closeAllConnections();
            await new Promise(resolve => item.server.close(resolve));
        }
    }
});
