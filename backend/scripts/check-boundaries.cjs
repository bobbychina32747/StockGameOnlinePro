const fs = require('node:fs');
const path = require('node:path');
/** StockGame consumes site identity through HTTP; it does not host the site. */
function checkBoundaries(root = path.resolve(__dirname, '..')) {
    const siteModules = ['identity', 'blog-admin', 'blog-public', 'arcade', 'webmail', 'resources', 'chat', 'game-saves'];
    const siteEntities = ['identity', 'credential', 'session', 'identity-token', 'oauth-client', 'oauth-code', 'oauth-grant', 'oauth-refresh-token',
        'blog-post', 'blog-comment', 'blog-view', 'app-secret', 'arcade-link', 'resource-item', 'chat-message', 'chat-attachment', 'chat-thread', 'game-save', 'identity-secret'];
    const problems = [];
    for (const name of ['_local-auth-override.js', '_local-site.mjs', '_oauth-browser-check.mjs', '_oauth-live-browser.mjs', '_oauth-smoke.mjs', '_oauth-staging-check.mjs', '_seed-local-user.mjs']) {
        if (fs.existsSync(path.join(root, 'tools', name))) problems.push('Site development tool: tools/' + name);
    }
    const hasFiles = directory => fs.readdirSync(directory, { withFileTypes: true }).some(entry => entry.isFile() || entry.isSymbolicLink() || (entry.isDirectory() && hasFiles(path.join(directory, entry.name))));
    for (const name of siteModules) {
        const directory = path.join(root, 'src/modules', name);
        if (fs.existsSync(directory) && hasFiles(directory))
            problems.push('Site module: src/modules/' + name);
    }
    for (const name of siteEntities) {
        const file = 'src/infrastructure/database/entities/' + name + '.entity.ts';
        if (fs.existsSync(path.join(root, file)))
            problems.push('Site entity: ' + file);
    }
    function inspect(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory())
                inspect(file);
            else if (entry.name.endsWith('.ts')) {
                const source = fs.readFileSync(file, 'utf8');
                if (/(?:from|require\s*\()\s*['"][^'"]*(?:\/modules\/(?:identity|blog-admin|blog-public|arcade|webmail|resources|chat|game-saves)\/|\.\.\/identity\/)/.test(source)) {
                    problems.push('Site implementation import: ' + path.relative(root, file));
                }
            }
        }
    }
    inspect(path.join(root, 'src'));
    if (problems.length)
        throw new Error('StockGame/site boundary violation:\n' + problems.join('\n'));
    const tables = require(path.join(root, 'src/common/game-tables.json'));
    const entities = fs.readdirSync(path.join(root, 'src/infrastructure/database/entities')).filter(name => name.endsWith('.entity.ts')).map(name => { const text = fs.readFileSync(path.join(root, 'src/infrastructure/database/entities', name), 'utf8'); const match = text.match(/@Entity\(['"]([^'"]+)['"]\)/); if (!match) throw Error('Entity table name must be explicit: ' + name); return match[1]; });
    const expected = [...entities, 'market_runtime_state'].sort();
    if (JSON.stringify(tables) !== JSON.stringify(expected)) throw Error('Game table allowlist must match its entity and runtime tables');
    return { siteModules: 0, siteEntities: 0 };
}
module.exports = { checkBoundaries };
if (require.main === module) {
    checkBoundaries();
    console.log('StockGame boundary check passed');
}
