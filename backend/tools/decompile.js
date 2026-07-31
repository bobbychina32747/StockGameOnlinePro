/**
 * 反编译脚本：将 dist/src 下的所有 .js（tsc 编译产物）恢复为 src 下的 .ts 可维护源码。
 *
 * 原理：tsc 产物是"JS 风格 TS"超集，只需做机械变换：
 *  1. 去掉 "use strict" 与 exports.__esModule 声明、var X_1 占位声明
 *  2. 顶层 const X = require("y") → import X = require("y")
 *  3. let A = A_1 = class A { ... } → class A { ... }（并把 A_1 引用替换为 A）
 *  4. exports 处理：
 *     exports.A = A;  → export { A };
 *     exports.A = A = A_1 = __decorate([...], A_1); → A = __decorate([...], A); export { A };
 *     exports.X = { ... };（多行字面量）→ export const X = { ... };
 *     exports.X = <单行值>; → export const X = <单行值>;
 *     exports.X = void 0;  → 删除
 * 保留 __decorate/__metadata/__param 辅助函数与显式装饰器元数据调用，
 * 使运行时 DI 行为与编译产物完全一致。
 *
 * 用法：node tools/decompile.js
 */
const fs = require('fs');
const path = require('path');

const SRC_DIST = path.join(__dirname, '..', 'dist', 'src');
const SRC_OUT = path.join(__dirname, '..', 'src');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** 处理一行顶层 require → import = require */
function convertTopRequire(line) {
  // helmet / express-rate-limit 无默认导出类型，保留 const require 形式（类型 any）
  const keepRaw = /^const\s+(\w+)\s*=\s*require\((["'])(helmet|express-rate-limit)\2\);\s*$/;
  const m = line.match(/^const\s+(\w+)\s*=\s*require\((["'])([^"']+)\2\);\s*$/);
  if (m && !keepRaw.test(line)) return `import ${m[1]} = require("${m[3]}");\n`;
  return line;
}

/** 将 tsc 输出的 IIFE 枚举（var X; (function(X){...})(X||(exports.X=X={}));）转为 TS enum */
/** 将 tsc 输出的 IIFE 枚举转为 TS enum（行级扫描，鲁棒） */
function convertEnums(body) {
  const lines = body.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^var (\w+);\s*$/);
    if (m && i + 1 < lines.length && /^\(function \(\w+\) \{/.test(lines[i + 1].trim())) {
      const name = m[1];
      const members = [];
      let j = i + 2;
      let endIdx = -1;
      while (j < lines.length) {
        const tm = lines[j].trim().match(new RegExp('^' + name + '\\["([^"]+)"\\] = "([^"]*)";$'));
        if (tm) members.push(`    ${tm[1]} = "${tm[2]}",`);
        const lt = lines[j].trim();
        if (m[1] === 'OrderType') console.log('  [loop]', j, JSON.stringify(lt.slice(0, 40)), 'end:', /^\}\)\(\w+ \|\| \(exports\./.test(lt));
        if (/^\}\)\(\w+ \|\| \(exports\./.test(lt)) { endIdx = j; break; }
        j++;
      }
      if (endIdx > 0) {
        out.push(`export enum ${name} {`);
        out.push(...members);
        out.push('}');
        i = endIdx + 1;
        continue;
      }
    }
    out.push(lines[i]);
    i++;
  }
  return out.join('\n');
}

/** 去掉代码中的字符串字面量（用于括号深度统计） */
function stripStrings(l) {
  return l.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '');
}

/** 反编译单个文件 */
function decompile(filePath) {
  const rel = path.relative(SRC_DIST, filePath).replace(/\\/g, '/').replace(/\.js$/, '.ts');
  const outFile = path.join(SRC_OUT, rel);
  const raw = fs.readFileSync(filePath, 'utf8');

  let lines = raw.split('\n');

  // 1. 删除 "use strict" / exports.__esModule / var X_1 占位声明 / sourcemap 注释
  lines = lines.filter((l) => {
    const t = l.trim();
    if (t === '"use strict";') return false;
    if (t.startsWith('Object.defineProperty(exports, "__esModule"')) return false;
    if (/^var\s+\w+_1;\s*$/.test(t)) return false;
    if (t.startsWith('//# sourceMappingURL=')) return false;
    return true;
  });

  // 2. require → import = require（仅在模块顶层）
  let inFunctionDepth = 0;
  lines = lines.map((l) => {
    if (inFunctionDepth === 0) {
      const conv = convertTopRequire(l);
      if (conv !== l) return conv;
    }
    inFunctionDepth += (stripStrings(l).match(/\{/g) || []).length - (stripStrings(l).match(/\}/g) || []).length;
    return l;
  });

  let body = lines.join('\n');

  // 2.5. 加固辅助函数（去掉顶层 this 检查，避免 TS2532；参数可选避免 TS2554）
  body = body.replace(/var __decorate = \(this && this\.__decorate\) \|\| function \(decorators, target, key, desc\) \{/,
    'var __decorate = function (decorators, target, key?, desc?) {');
  body = body.replace(/var __metadata = \(this && this\.__metadata\) \|\| function \(k, v\) \{/,
    'var __metadata = function (k, v) {');
  body = body.replace(/var __param = \(this && this\.__param\) \|\| function \(paramIndex, decorator\) \{/,
    'var __param = function (paramIndex, decorator) {');
  // 2.6. new Map() 推断为 unknown，统一加宽松泛型
  body = body.replace(/new Map\(\)/g, 'new Map<string, any>()');
  // 2.7. IIFE 枚举 → TS enum
  body = convertEnums(body);
  // 2.8. 若用到 __param 但未定义（原始产物缺失），注入定义
  if (/__param\(/.test(body) && !/var __param =/.test(body)) {
    body = 'var __param = function (paramIndex, decorator) {\n    return function (target, key) { decorator(target, key, paramIndex); }\n};\n' + body;
  }

  // 3. 类定义转换：let A = class A / let A = A_1 = class A（支持 extends）
  //    保留 let 形式（TS 中 class 声明不可重新赋值，__decorate 需要 let 变量）；
  //    插入索引签名，避免 constructor 属性赋值报 TS2339。
  const classHeader = body.match(/^let\s+(\w+)\s*=\s*(?:(\w+_1)\s*=\s*)?class\s+\1\b/m);
  if (classHeader) {
    const clsName = classHeader[1];
    const alias = classHeader[2];
    body = body.replace(
      new RegExp(`^let\\s+${clsName}\\s*=\\s*(?:${alias}\\s*=\\s*)?class\\s+${clsName}\\b([^\\n]*?)\\s*\\{`, 'm'),
      `let ${clsName} = class ${clsName}$1 {\n    [key: string]: any;`
    );
    if (alias) {
      body = body.split(alias).join(clsName);
    }
  }

  // 4. exports 处理（按行扫描，支持多行字面量与 __decorate 块）
  const exportBlocks = [];
  const rest = [];
  const exportedNames = new Set();
  const bodyLines = body.split('\n');
  let i = 0;
  while (i < bodyLines.length) {
    const line = bodyLines[i];
    const t = line.trim();

    // 4a. exports.X = X = X_1 = __decorate([ ... ], X_1);  多行块（支持多级赋值）
    const decStart = t.match(/^exports\.(\w+)\s*=\s*\1(?:\s*=\s*\1)*\s*=\s*__decorate\(\[$/);
    if (decStart) {
      const clsName = decStart[1];
      let depth = 1;
      const block = [line];
      i++;
      while (i < bodyLines.length && depth > 0) {
        const cur = bodyLines[i];
        block.push(cur);
        const stripped = stripStrings(cur);
        depth += (stripped.match(/\[/g) || []).length - (stripped.match(/\]/g) || []).length;
        i++;
      }
      // 按行处理首尾（多行 blockText 不能用 ^...$ 无 m 标志的正则）
      block[0] = block[0].replace(/^exports\.\w+(?:\s*=\s*\w+)*\s*=\s*__decorate\(\[$/, '[');
      const lastIdx = block.length - 1;
      block[lastIdx] = block[lastIdx].replace(/\]\s*,\s*\w+\);\s*$/, ']');
      const inner = block.join('\n');
      const exportLine = exportedNames.has(clsName) ? '' : `export { ${clsName} };\n`;
      exportedNames.add(clsName);
      exportBlocks.push(`${clsName} = __decorate(\n${inner},\n${clsName}\n);\n${exportLine}`);
      continue;
    }

    // 4b. exports.X = void 0;  或 链式 exports.A = exports.B = ... = void 0;  删除
    if (/^exports\.\w+(?:\s*=\s*exports\.\w+)*\s*=\s*void 0;\s*$/.test(t) ||
        /^exports\.\w+\s*=\s*void 0;\s*$/.test(t)) {
      i++;
      continue;
    }

    // 4c. exports.X = X;  →  export { X };（去重）
    const simpleExport = t.match(/^exports\.(\w+)\s*=\s*\1;\s*$/);
    if (simpleExport) {
      const name = simpleExport[1];
      if (!exportedNames.has(name)) {
        exportedNames.add(name);
        exportBlocks.push(`export { ${name} };\n`);
      }
      i++;
      continue;
    }

    // 4d. 多行字面量：exports.X = { / [   ...深度跟踪...   }; / ];
    const litStart = t.match(/^exports\.(\w+)\s*=\s*([\[{])\s*$/);
    if (litStart) {
      const name = litStart[1];
      const openCh = litStart[2];
      const closeCh = openCh === '{' ? '}' : ']';
      let depth = 1;
      const block = [line.replace(`exports.${name} =`, `export const ${name} =`)];
      i++;
      while (i < bodyLines.length && depth > 0) {
        const cur = bodyLines[i];
        const stripped = stripStrings(cur);
        const forCount = stripped.replace(/;?\s*$/, '');
        depth += (forCount.match(new RegExp(`\\${openCh}`, 'g')) || []).length
               - (forCount.match(new RegExp(`\\${closeCh}`, 'g')) || []).length;
        block.push(cur);
        i++;
      }
      exportBlocks.push(block.join('\n') + '\n');
      continue;
    }

    // 4e. exports.X = <多行表达式（函数/箭头等）>; → export const X = ...;
    const multiExpr = t.match(/^exports\.(\w+)\s*=\s*(?!void 0;)(?![\{\[]).+[^;]$/);
    if (multiExpr) {
      const name = multiExpr[1];
      let depth = 0;
      const block = [bodyLines[i].replace(`exports.${name} =`, `export const ${name} =`)];
      let stripped = stripStrings(bodyLines[i]).replace(/;\s*$/, '');
      depth += (stripped.match(/\(/g) || []).length - (stripped.match(/\)/g) || []).length;
      i++;
      while (i < bodyLines.length && depth > 0) {
        const cur = bodyLines[i];
        block.push(cur);
        stripped = stripStrings(cur).replace(/;\s*$/, '');
        depth += (stripped.match(/\(/g) || []).length - (stripped.match(/\)/g) || []).length;
        i++;
      }
      exportBlocks.push(block.join('\n') + '\n');
      continue;
    }

    // 4f. exports.X = <单行值>;  →  export const X = <单行值>;
    const constExport = t.match(/^exports\.(\w+)\s*=\s*(.+);\s*$/);
    if (constExport) {
      exportBlocks.push(`export const ${constExport[1]} = ${constExport[2]};\n`);
      i++;
      continue;
    }

    rest.push(line);
    i++;
  }

  let result = rest.join('\n');
  result = result.replace(/\n{3,}/g, '\n\n').trim();
  result += '\n\n' + exportBlocks.join('\n');
  result += '\n';

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, result, 'utf8');
  console.log(`[OK] ${rel}`);
}

function main() {
  // 清理旧产物，避免残留
  fs.rmSync(SRC_OUT, { recursive: true, force: true });
  const files = walk(SRC_DIST);
  for (const f of files) decompile(f);
  console.log(`\n共反编译 ${files.length} 个文件 → src/`);
}

main();
