const path = require('node:path');
const ts = require('typescript');
// Incremental strictness: real imports are resolved, while strict diagnostics are
// enforced for these pure modules. The normal build still checks the entire app.
const root = path.resolve(__dirname, '..');
const modules = ['matching-engine', 'finite-execution', 'order-flow', 'slippage'].map(name => path.join(root, 'src/core/trading-engine', name + '.ts'));
const contract = path.join(root, 'test/types/matching.ts');
const scope = new Set([...modules, contract].map(file => path.normalize(file).toLowerCase()));
const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
if (config.error)
    throw Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, undefined, path.join(root, 'tsconfig.json'));
const program = ts.createProgram([...modules, contract], { ...parsed.options, noEmit: true, strict: true, noImplicitAny: true, noImplicitThis: true, strictNullChecks: true, strictPropertyInitialization: true });
const diagnostics = ts.getPreEmitDiagnostics(program).filter(d => !d.file || scope.has(path.normalize(d.file.fileName).toLowerCase()));
for (const file of modules) {
    const source = program.getSourceFile(file);
    function inspect(node) {
        if (node.kind === ts.SyntaxKind.AnyKeyword)
            diagnostics.push({ file: source, start: node.getStart(), length: node.getWidth(), category: ts.DiagnosticCategory.Error, code: 9999, messageText: 'Explicit any is not allowed in the pure matching core' });
        ts.forEachChild(node, inspect);
    }
    inspect(source);
}
if (diagnostics.length) {
    process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: x => x, getCurrentDirectory: () => root, getNewLine: () => '\n' }));
    process.exitCode = 1;
}
else
    console.log('Strict matching-core types and negative type contracts passed');
