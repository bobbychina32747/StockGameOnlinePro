import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const { rules } = JSON.parse(readFileSync(new URL('../cloudflare-cache-rules.json', import.meta.url), 'utf8'));

// Interpret only the Rules Language subset used by this file. This does not
// replace Cloudflare's API validator or evaluate account-level rule precedence.
function matches(expression, request) {
  const lex = /\s+|"(?:\\.|[^"\\])*"|http\.request\.headers\["authorization"\]\[\*\]|[a-zA-Z_][\w.]*|[{}(),]/gy;
  const tokens = [];
  for (let offset = 0; offset < expression.length;) {
    lex.lastIndex = offset;
    const match = lex.exec(expression);
    assert.ok(match, `Unsupported expression at ${expression.slice(offset)}`);
    offset = lex.lastIndex;
    if (match[0].trim()) tokens.push(match[0]);
  }
  let index = 0;
  const take = () => tokens[index++];
  const expect = (token) => assert.equal(take(), token);
  const path = new URL(request.path, 'https://example.invalid').pathname;
  const basename = path.slice(path.lastIndexOf('/') + 1);
  const dot = basename.lastIndexOf('.');
  const values = {
    'http.host': request.host ?? 'bobbycn.cc',
    'http.cookie': request.cookie ?? '',
    'http.request.uri.path': path,
    'http.request.uri.path.extension': dot > 0 ? basename.slice(dot + 1).toLowerCase() : '',
    'http.request.headers["authorization"][*]': request.authorization ? [request.authorization] : [],
  };
  const functions = {
    lower: (value) => value.toLowerCase(),
    starts_with: (value, prefix) => value.startsWith(prefix),
    ends_with: (value, suffix) => value.endsWith(suffix),
    any: (value) => { assert.ok(Array.isArray(value)); return value.some(Boolean); },
  };
  function atom() {
    const token = take();
    if (token === '(') { const value = or(); expect(')'); return value; }
    if (token?.startsWith('"')) return JSON.parse(token);
    if (token === '{') {
      const values = [];
      while (tokens[index] !== '}') {
        assert.ok(index < tokens.length, 'Unclosed set');
        values.push(atom());
      }
      expect('}');
      return values;
    }
    if (Object.hasOwn(functions, token)) {
      expect('(');
      const args = [or()];
      while (tokens[index] === ',') { take(); args.push(or()); }
      expect(')');
      return functions[token](...args);
    }
    assert.ok(Object.hasOwn(values, token), `Unsupported field ${token}`);
    return values[token];
  }
  function comparison() {
    const left = atom();
    const op = tokens[index];
    if (!['eq', 'ne', 'in', 'contains'].includes(op)) return left;
    take();
    const right = atom();
    const compare = (value) => {
      if (op === 'eq') return value === right;
      if (op === 'ne') return value !== right;
      if (op === 'in') return right.includes(value);
      return value.includes(right);
    };
    return Array.isArray(left) ? left.map(compare) : compare(left);
  }
  function not() {
    if (tokens[index] === 'not') { take(); return !not(); }
    return comparison();
  }
  function and() {
    let value = not();
    while (tokens[index] === 'and') { take(); const right = not(); value = value && right; }
    return value;
  }
  function or() {
    let value = and();
    while (tokens[index] === 'or') { take(); const right = and(); value = value || right; }
    return value;
  }
  const result = or();
  assert.equal(index, tokens.length, 'Unconsumed expression');
  assert.equal(typeof result, 'boolean');
  return result;
}

function decision(request) {
  let result = null;
  for (const rule of rules) {
    if (rule.enabled && matches(rule.expression, request)) result = rule.action_parameters.cache;
  }
  return result;
}

test('three ordered, origin-respecting incremental rules', () => {
  assert.equal(rules.length, 3);
  assert.equal(new Set(rules.map((rule) => rule.ref)).size, 3);
  for (const rule of rules) {
    assert.equal(rule.action, 'set_cache_settings');
    assert.ok(rule.expression.length <= 4096);
    assert.equal(rule.enabled, true);
    assert.equal(Object.hasOwn(rule.action_parameters, 'cache_key'), false);
    if (rule.action_parameters.cache) {
      assert.deepEqual(rule.action_parameters.edge_ttl, { mode: 'bypass_by_default' });
      assert.deepEqual(rule.action_parameters.browser_ttl, { mode: 'respect_origin' });
    }
  }
  assert.equal(rules.at(-1).ref, 'portal_private_bypass_v1');
  assert.equal(rules.at(-1).action_parameters.cache, false);
});

test('public assets and known directory HTML are eligible', () => {
  for (const path of ['/', '/index.html', '/games/', '/games/alan/', '/games/alan/online/index.html', '/posts/example/', '/posts/example/index.html', '/resources/', '/sponsor/', '/hosted/shijing/', '/assets/site.css?v=next', '/games/account.js', '/i18n/zh-CN.js', '/media/photo.webp', '/favicon.ico', '/games/data.wasm']) {
    assert.equal(decision({ path }), true, path);
    assert.equal(decision({ path, host: 'www.bobbycn.cc' }), true, path);
  }
});

test('private paths win even when they look like static files', () => {
  for (const prefix of ['api', 'oauth', 'admin', 'account', 'login', 'register', 'reset-password', 'verify-email', 'chat', 'mail', 'secret', 'socket.io']) {
    for (const path of [`/${prefix}`, `/${prefix}/`, `/${prefix}/profile.css`, `/${prefix.toUpperCase()}/profile.js`]) {
      assert.equal(decision({ path }), false, path);
    }
  }
});

test('sessions always bypass previously eligible public URLs', () => {
  for (const path of ['/', '/posts/example/', '/assets/site.css', '/games/alan/']) {
    assert.equal(decision({ path, cookie: 'session=test' }), false, path);
    assert.equal(decision({ path, authorization: 'Bearer test' }), false, path);
  }
});

test('worker, manifest, callback and hidden paths bypass cache', () => {
  for (const path of ['/sw.js', '/games/service-worker.js', '/retire-remaster-sw.js', '/manifest.webmanifest', '/assets/site.js.map', '/games/oauth-callback.html', '/.hidden/file.css', '/games/.private/file.js']) {
    assert.equal(decision({ path }), false, path);
  }
});

test('unknown dynamic pages and other hosts receive no cache eligibility', () => {
  for (const path of ['/unlisted/', '/unlisted.html', '/games/custom.html', '/data.json', '/feed.xml', '/sitemap.xml']) {
    assert.equal(decision({ path }), null, path);
  }
  for (const host of ['game.bobbycn.cc', 'bobbycn.cc.example.org', 'bobbychina.github.io']) {
    assert.equal(decision({ host, path: '/assets/site.css' }), null, host);
  }
});
