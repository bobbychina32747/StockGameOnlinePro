require('./runtime.cjs');
const path = require('node:path');
const fs = require('node:fs');
const {spawnSync} = require('node:child_process');
const remasterRoot = path.resolve(__dirname,'..');
const action = process.argv[2];
if (action === 'catalog') { require('./import-catalog.cjs'); }
else {
  const target = ['build-api','typecheck-web'].includes(action) ? require.resolve('typescript/bin/tsc') : path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
  const argumentsList = action === 'build-api' ? ['-p','tsconfig.json'] : action === 'typecheck-web' ? ['-p','apps/web/tsconfig.json'] : [action === 'build-web' ? 'build' : '--host','--config','apps/web/vite.config.ts'];
  const result = spawnSync(process.execPath, ['--require',path.join(__dirname,'runtime.cjs'),target,...argumentsList],{cwd:remasterRoot,stdio:'inherit',windowsHide:true});
  if (result.error) { console.error(result.error.message); process.exit(1); }
  if (action==='build-web'&&result.status===0) require('./build-sw.cjs');
  process.exit(result.status ?? 1);
}
