const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { checkBoundaries } = require('../scripts/check-boundaries.cjs');
test('the game owns no site modules or identity database entities', () => {
    expect(checkBoundaries()).toEqual({ siteModules: 0, siteEntities: 0 });
});
test('the boundary gate rejects reintroducing a personal site module', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sgp-boundary-'));
    try {
        const module = path.join(directory, 'src/modules/blog-admin');
        fs.mkdirSync(module, { recursive: true });
        fs.writeFileSync(path.join(module, 'module.ts'), 'export {};');
        expect(() => checkBoundaries(directory)).toThrow('Site module: src/modules/blog-admin');
    }
    finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
