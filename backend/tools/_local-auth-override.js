/* 本机冒烟专用覆盖配置（tools/_oauth-browser-smoke.mjs 用 page.addInitScript 注入，
   不进任何部署产物）。把授权端点指向本机后端，其余沿用 auth-config.js。 */
window.DSH_AUTH_TEST_OVERRIDE = { siteRelay: 'http://127.0.0.1:8099' };
