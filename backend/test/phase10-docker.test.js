// Phase D 回归：Docker 产物静态断言（lockfile/CMD/compose/nginx 关键配置）
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');            // 仓库根
const backendDocker = path.join(__dirname, '..', 'docker'); // backend/docker
const read = (p) => fs.readFileSync(p, 'utf8');

describe('Phase D Dockerfile 修复与 compose（静态断言）', () => {
  test('Dockerfile.backend：两阶段 npm ci 均带 package-lock.json', () => {
    const f = read(path.join(backendDocker, 'Dockerfile.backend'));
    expect(f).toMatch(/COPY package\.json package-lock\.json tsconfig\.json/); // builder
    expect(f).toMatch(/COPY package\.json package-lock\.json \.\//);           // runner
  });

  test('Dockerfile.backend：CMD 指向真实产物 dist/src/main.js', () => {
    const f = read(path.join(backendDocker, 'Dockerfile.backend'));
    expect(f).toContain('dist/src/main.js');
    expect(f).not.toMatch(/dist\/main\b/); // 旧的 dist/main 路径不得残留
  });

  test('docker-compose.yml：env_file/卷/端口/健康检查齐全', () => {
    const c = read(path.join(backendDocker, 'docker-compose.yml'));
    expect(c).toContain('"8000:8000"');
    expect(c).toContain('"3000:80"');
    expect(c).toContain('env_file');
    expect(c).toContain('sgp-data:/app/data');
    expect(c).toContain('healthcheck');
    // teams 定稿：健康检查走公开端点 /api/market/prices（Swagger 仅 dev 挂载，不可依赖）
    expect(c).toContain('/api/market/prices');
    expect(c).not.toContain('/api/docs');
  });

  test('frontend/Dockerfile 存在且为 node 构建 + nginx 托管', () => {
    const p = path.join(ROOT, 'frontend', 'Dockerfile');
    expect(fs.existsSync(p)).toBe(true);
    const f = read(p);
    expect(f).toMatch(/nginx/);
    expect(f).toMatch(/npm run build/);
  });

  test('frontend/nginx.conf：SPA fallback + /api 与 /socket.io 反代（含 Upgrade 头）', () => {
    const f = read(path.join(ROOT, 'frontend', 'nginx.conf'));
    expect(f).toContain('try_files');
    expect(f).toContain('proxy_pass http://backend:8000');
    expect(f).toContain('Upgrade $http_upgrade');
    expect(f).toContain('/socket.io/');
    expect(f).toContain('/api/');
  });

  test('.dockerignore 存在且排除 node_modules/dist/.env', () => {
    const b = read(path.join(ROOT, 'backend', '.dockerignore'));
    expect(b).toMatch(/^node_modules$/m);
    expect(b).toMatch(/^dist$/m);
    expect(b).toMatch(/^\.env$/m);
    const f = read(path.join(ROOT, 'frontend', '.dockerignore'));
    expect(f).toMatch(/^node_modules$/m);
    expect(f).toMatch(/^dist$/m);
  });
});
