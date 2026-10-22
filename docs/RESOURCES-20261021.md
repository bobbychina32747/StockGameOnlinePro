# 共享资源页（/resources/）+ 后台资源管理 · 2026-10-21

站主要求：在主站单开一个「共享资源」子页，放他喜欢的资源链接（第一条是 DSH 桌面版安装包），
并给写作台加一个「资源」面板，让他自己上传/维护条目（链接或文件）。

本文是**实现契约**，后端、公开页、写作台三方都按此实现，不改口径。

## 1. 数据与 API 契约

条目字段（数据库表 `resource_items`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| id | int 自增 | |
| title | string(120) | 必填 |
| description | text | 可空 |
| url | text | 链接地址；文件类条目 = `/api/resources/file/<key>` |
| tags | text(JSON 数组) | 例 `["桌面端","工具"]` |
| kind | `link` \| `file` | 有 fileKey 即 file |
| fileKey | string(64) 可空 | 服务器上的文件名（随机 32 hex + 扩展名） |
| fileName | string(200) 可空 | 下载时的原始文件名 |
| fileSize | int 可空 | 字节 |
| mimeType | string(120) 可空 | |
| published | boolean，默认 true | false 则公开接口不可见 |
| sortOrder | int，默认 0 | 大的在前，同值按 id 倒序 |
| createdAt / updatedAt | datetime | 自动 |

文件落盘目录：`RESOURCE_DIR`（默认 `<cwd>/data/resources`，容器里即 `/app/data/resources`，落在 sgp-data 卷）。

### 公开接口（无需登录）

`GET /api/resources`
```json
{ "items": [ {
  "id": 1, "title": "…", "description": "…", "url": "https://…",
  "tags": ["桌面端"], "kind": "link",
  "fileName": null, "fileSize": null, "updatedAt": "2026-10-21T10:00:00.000Z"
} ] }
```
只返回 `published=true`，按 `sortOrder desc, id desc` 排序。

`GET /api/resources/file/:key`
- `key` 必须是 `/^[a-f0-9]{32}(\.[A-Za-z0-9]{1,10})?$/`，否则 404。
- 只有所属条目 `published=true` 时才提供；返回文件流，`Content-Disposition: attachment; filename*=UTF-8''…`。
- 不做 Range（下载场景可接受）。

### 后台接口（`BlogAdminGuard` + `role===ADMIN`，与 `/api/admin/blog/*` 完全一致）

- `GET /api/admin/resources` → `{ items: [...] }`（全部条目，含隐藏；多出 published/sortOrder/fileKey 字段）
- `POST /api/admin/resources`（保存/更新）
  Body（`class-validator` 全字段装饰，`whitelist:true` 下漏装饰器会被 400）：
  `{ id?, title, description?, url?, tags?, published?, sortOrder?, fileKey?, fileName?, fileSize?, mimeType? }`
  返回 `{ item }`。
- `DELETE /api/admin/resources/:id` → `{ removed: true }`（同时删掉无引用的文件）
- `POST /api/admin/resources/upload`（multipart，字段名 `file`，上限 64MB）
  → `{ key, fileName, fileSize, mimeType }`；前端拿到后再调保存接口写入条目。
- 保存时如果带 `fileKey`，服务端校验文件存在；`kind` 由是否带 fileKey 推导。

种子：表为空时插入一条 DSH 桌面版条目（见 §3），只插入一次。

## 2. 公开页 `/resources/`（bobbychina-pages）

- 新文件：`resources/index.html`、`assets/resources.css`、`assets/resources.js`（或把 js 内联，二选一）。
- 页面结构照 `sponsor/index.html`：`<header class="top site-header">` 同款导航、`<footer>` 同款页脚。
- 导航在「文章」后加一项：`<a href="/resources/" data-i18n="nav.resources">资源</a>`；
  本页该项加 `class="on" aria-current="page"`。
- 渲染：`fetch('/api/resources')` → 卡片列表；失败或空时用页面内 `FALLBACK` 数组兜底（见 §3），
  并显示低调的「离线内容」提示。支持按标签筛选 + 搜索框（纯前端过滤）。
- 视觉：沿用 `site.css`/`palette.css` 的 CSS 变量（`--ink --soft --dim --line --paper2 --seal`…），
  **不要**整页居中、不要千篇一律卡片墙 + 默认阴影；做成带编号/分隔线的编辑式列表，桌面端一行一条、手机端堆叠。
- 零第三方依赖、零外链资源；`prefers-reduced-motion` 下不动画。

## 3. 初始内容（种子 + fallback 用同一份数据）

DSH 桌面版（社区 Tauri 打包，MIT；内核 0.2.1-rc.2，非 DeepSeek 官方发行）：

| 平台 | 链接 |
|---|---|
| Windows .exe（推荐） | https://github.com/dsh-tauri/deepseek-harness-desktop/releases/download/v0.24.5/Deepseek.Harness.Desktop_0.24.5_x64-setup.exe |
| Windows .msi（中文） | https://github.com/dsh-tauri/deepseek-harness-desktop/releases/download/v0.24.5/Deepseek.Harness.Desktop_0.24.5_x64_zh-CN.msi |
| macOS Apple Silicon | https://github.com/dsh-tauri/deepseek-harness-desktop/releases/download/v0.24.5/Deepseek.Harness.Desktop_0.24.5_aarch64.dmg |
| macOS Intel | https://github.com/dsh-tauri/deepseek-harness-desktop/releases/download/v0.24.5/Deepseek.Harness.Desktop_0.24.5_x64.dmg |
| Linux AppImage x64 | https://github.com/dsh-tauri/deepseek-harness-desktop/releases/download/v0.24.5/Deepseek.Harness.Desktop_0.24.5_amd64.AppImage |
| Linux .deb x64 | https://github.com/dsh-tauri/deepseek-harness-desktop/releases/download/v0.24.5/Deepseek.Harness.Desktop_0.24.5_amd64.deb |
| 全部版本 / 更新 | https://github.com/dsh-tauri/deepseek-harness-desktop/releases |
| 项目源码 | https://github.com/dsh-tauri/deepseek-harness-desktop |

说明文案要点（中文，可精简）：
- 免装 Node/pnpm，装完即用；首次启动可能要联网初始化（带 `_Bundle` 后缀的是离线捆绑包，体积大得多）。
- 这是社区用 Tauri 打包的桌面外壳，不是 DeepSeek 官方发布的安装包；内核跟官方 `@deepseek-ai/dsh` 同版本。
- 官方命令行路线：`npm i -g @deepseek-ai/dsh`，然后 `dsh web`。

种子 / fallback 只放**一条**精选条目（标题：`DeepSeek Harness 桌面版（Windows 安装包）`，
url 用 Windows .exe，描述里给 mac/Linux 与 releases 页链接），其余留给站主自己加。

## 4. i18n 键（三份词典 zh-CN / zh-TW / en 都要加，`node tools/i18n-check.mjs` 必须 0 退出）

导航 / 公开页：
```
nav.resources, resources.label, resources.title, resources.intro, resources.search,
resources.all, resources.empty, resources.error, resources.retry, resources.open,
resources.download, resources.size, resources.updated, resources.file, resources.link,
resources.fallbackNote, resources.note
```
写作台资源面板：
```
admin.resources.title, admin.resources.new, admin.resources.listEmpty, admin.resources.fieldTitle,
admin.resources.fieldUrl, admin.resources.fieldDesc, admin.resources.fieldTags,
admin.resources.fieldOrder, admin.resources.fieldFile, admin.resources.published,
admin.resources.hidden, admin.resources.save, admin.resources.delete, admin.resources.uploading,
admin.resources.uploaded, admin.resources.hint, admin.resources.fileSize, admin.resources.backToList
```

## 5. 验收

- 后端：`npm run build` 0 退出；本地起临时库（PORT=8123、SQLITE_PATH 指临时文件）：
  公开 GET 返回种子条目；登录后 POST/上传/下载/删除全通；未登录访问 admin 接口 401/403。
- 前端：`node tools/i18n-check.mjs` 0 退出；页面在 127.0.0.1 静态服务下无 JS 报错（API 失败时走 fallback）。
- 写作台：登录 → 资源面板能列出/新增/上传/删除，文章面板不受影响。
