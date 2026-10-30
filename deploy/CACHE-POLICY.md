# bobbycn.cc 门户缓存策略

状态：2026-10-29 本地配置已修改；尚未连接服务器、修改 Cloudflare 或发布。

## 公网检查结果

检查目标为主站 `bobbycn.cc`，不是 GitHub Pages 或 Cloudflare Pages 镜像。匿名请求未携带账号凭证，以下是本次实际响应：

| 请求 | Cache-Control | CF-Cache-Status |
| --- | --- | --- |
| `/` | `no-cache` | `DYNAMIC` |
| `/assets/site.css` | `public, max-age=604800` | `HIT` |
| `/games/alan/` | `no-cache` | `DYNAMIC` |
| `/games/account.js?v=20261014full1` | `max-age=14400` | `MISS` |
| `/i18n/i18n.js?v=20261027chat1` | `public, max-age=14400` | `EXPIRED` |
| `/easter-egg.js` | `max-age=14400` | `EXPIRED` |
| `/login/` | `no-cache` | `DYNAMIC` |

CSS 已经命中 CDN。一次 `MISS` 或 `EXPIRED` 不能证明资源从不缓存；也不能由这些抽样请求推导全站缓存命中率。截图中的 1.78% 缺少统计窗口、路径和状态分布，本次没有读取账号内的 Analytics，不能确认它的分母或根因。

公网部分脚本的头与本地模板不同。上线前必须读取当前生效配置并合并本次缓存改动，不能直接用本地 `portal.conf`、`blog.conf` 覆盖生产文件，否则可能丢失新接入的路由。

## 准备上线的行为

| 响应 | 浏览器 Cache-Control | Cloudflare 专用缓存策略 |
| --- | --- | --- |
| 匿名公开首页、游戏/文章/资源/赞助/托管目录首页 | `no-cache` | `public, max-age=60` |
| 公开 CSS、JS、图片、字体、WASM、音视频，无 `?v=` | `public, max-age=3600` | `public, max-age=86400` |
| 同类资源，带合法 `?v=` 发布版本 | `public, max-age=604800` | `public, max-age=604800` |
| 未列入的 HTML、JSON、未知类型 | `no-cache` | `no-store` |
| 身份、API、管理、账号、私线、邮件、OAuth、隐藏路径、Service Worker、manifest、source map | `private, no-store`（已有独立 location 的页面可为 `no-store`） | `no-store` |
| 非 GET/HEAD、错误响应、请求含 Authorization/Cookie、响应含上游 Set-Cookie、来自反代的响应 | `private, no-store` | `no-store` |

公开目录首页只匹配 `/`、`/index.html`，以及 `/games/`、`/posts/`、`/resources/`、`/sponsor/`、`/hosted/` 下的目录和 `index.html`。独立 OAuth 回调 HTML 不在该范围内。资源还需通过实际 Content-Type 检查，防止把返回 HTML 的路径当成 JS 长缓存；304 无 Content-Type 时使用原 URL 分类。

`no-cache` 允许保存响应，但复用前要验证。浏览器继续向 CDN 验证页面；CDN 可以在 60 秒内直接提供同一份公开静态 HTML。发布页面或文章后，公开访客可能最多等 60 秒才看到更新；需要立即更新时清除对应 URL 的 CDN 缓存。这里不启用 stale-while-revalidate，也不承诺源站离线时继续提供过期页面。

资源版本仍使用站点既有的 `?v=` 约定。改动资源时同步更新引用版本，CDN 缓存键保留查询参数。本次不对这些可变文件使用 `immutable`，也没有把查询参数忽略。未版本资源的浏览器缓存上限缩短为一小时；CDN 最多一天，更新同名文件后需清除对应 URL 或新增版本号。

RSS 与 sitemap 保留浏览器 `no-cache`，补上 Cloudflare `no-store`，本次不把订阅与索引文件纳入短缓存。

## 文件与验证

- `nginx/site-maps.conf`：按路径、类型、状态、方法与会话信息决定缓存头，不新增匹配路由的正则 location。
- `nginx/portal-cache.conf`：统一输出浏览器及 Cloudflare 专用缓存头。
- `nginx/portal.conf`、`nginx/blog.conf`：静态 location 使用公共片段；保留原路由、try_files 和 alias。
- `nginx/sgp-local-proxy.conf`、`nginx/chat.conf`：显式禁止缓存，清掉上游可能传来的公开缓存策略；保留 SSE 的 buffering off。
- `cloudflare-cache-rules.json`：三条增量规则，顺序为公开资源、公开 HTML、私有请求绕过。最后一条必须放在当前所有可匹配缓存规则之后。
- `tests/portal-cache.test.py`：标准库离线策略检查，读取实际 nginx map 并检查关键配置契约。
- `tests/cloudflare-cache.test.mjs`：读取实际 Cloudflare 表达式，检查本规则使用的语法子集、公开路径、私有路径与最终覆盖顺序。

本地检查命令：

```powershell
python deploy/tests/portal-cache.test.py
node --test deploy/tests/cloudflare-cache.test.mjs
```

本次实际运行结果：nginx 策略 16 项通过，Cloudflare 规则 6 项通过；`git diff --check` 通过。

这些离线检查不代替 nginx 自身的语法检查、Cloudflare 表达式验证或生产 HTTP 验收。本机没有可用 nginx，最终必须在目标服务器运行 `nginx -t`。

## 上线与回退

1. 经站主确认后，使用现有部署身份读取正在加载的 nginx 配置和 Cloudflare 缓存规则。只核对配置，不读取数据库、私线正文或密钥内容。
2. 备份实际将改动的文件和当前 Cloudflare 规则。将新 map 合并到 `/etc/nginx/conf.d/00-site-maps.conf`，把 `portal-cache.conf` 安装到 `/etc/nginx/snippets/portal-cache.conf`，按差异合并 portal/blog/local-proxy/chat 的缓存指令，保留生产新增路由。不要整文件替换生产模板。
3. 运行 `nginx -t`，失败就恢复文件并再次检查，成功才平滑 reload nginx。此步骤不重启应用、容器或数据库。
4. 按顺序新增或按 `ref` 更新三条 Cloudflare 规则。保留其它规则，不把 JSON 的 `rules` 整体 PUT 为现有规则集。检查旧 Page Rules、Cache Response Rules、Workers 和 Development Mode 是否覆盖本策略。公开规则的 Edge TTL 使用 `bypass_by_default`，Browser TTL 使用 `respect_origin`；不强制忽略源站的 no-store/Set-Cookie。
5. 核对源站响应，再从同一网络/节点连续请求公开 HTML 和静态资源，观察 `MISS → HIT`（已有缓存时可直接 HIT）。首页、文章和游戏仍要有浏览器 `no-cache`；登录、API、私线不得出现 HIT。检查不存在的 `.js` 返回 404/no-store，不能因静态扩展名缓存错误页。
6. 需要回退时先禁用新增的公开 HTML 缓存规则并清除对应公开 URL，恢复已备份的 nginx 文件、`nginx -t` 后 reload，再恢复或移除本次 Cloudflare 规则。先停止 HTML 缓存再恢复源站，可避免 CDN 沿用旧的 60 秒对象。

回退配置不会主动清掉访客浏览器已经存下的资源；紧急替换脚本或样式时使用新的 `?v=` URL。

Cloudflare 配置与 nginx 修改都属于线上配置变更。此文档和本地模板本身没有执行部署。实际命中率变化需要在相同统计窗口中比较请求数、字节命中率及 API/静态路径分布，不能提前给出提高后的百分比。

## 官方依据

- [Cloudflare 默认缓存行为](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/)：静态扩展名与 HTML 的默认缓存资格不同。
- [Cloudflare CDN-Cache-Control](https://developers.cloudflare.com/cache/concepts/cdn-cache-control/)：浏览器和 CDN 可以使用不同的缓存策略；Cloudflare 专用头不会传给浏览器。
- [Cloudflare Cache Rules 设置](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/)：源站策略、边缘 TTL 和浏览器 TTL 的控制方式。
- [nginx headers 模块](https://nginx.org/en/docs/http/ngx_http_headers_module.html)：add_header 的状态码、always 和继承行为。
