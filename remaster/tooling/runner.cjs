require('./runtime.cjs');
const path = require('node:path');
const fs = require('node:fs');
const {spawnSync} = require('node:child_process');
const remasterRoot = path.resolve(__dirname,'..');
const action = process.argv[2];
if (action === 'catalog') { require('./import-catalog.cjs'); }
else {
  const target = action === 'build-api' ? require.resolve('typescript/bin/tsc') : require.resolve('vite/bin/vite.js');
  const argumentsList = action === 'build-api' ? ['-p','tsconfig.json'] : [action === 'build-web' ? 'build' : '--host','--config','apps/web/vite.config.ts'];
  const result = spawnSync(process.execPath, ['--require',path.join(__dirname,'runtime.cjs'),target,...argumentsList],{cwd:remasterRoot,stdio:'inherit',windowsHide:true});
  if (result.error) { console.error(result.error.message); process.exit(1); }
  process.exit(result.status ?? 1);
}
