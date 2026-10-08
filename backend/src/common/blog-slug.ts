/**
 * 博客 slug 契约（单一来源）
 *
 * 为什么单独一个文件：写作台（blog-admin）与对外接口（blog-public）**各自写了一份正则，而且不一致**——
 * 写作台那侧允许大写（controller 里是 `/^[a-zA-Z0-9][a-zA-Z0-9-]*$/`，service 里又写了 `/…$/i`），
 * 对外这份只允许小写（`/^[a-z0-9][a-z0-9-]{0,119}$/`）。
 * 后果（2026-10-08 线上实测）：站主用写作台发的《WeirdStuff2》在公开接口被判 400 ——
 *   · POST /api/blog/view      → 400，**这篇文章的浏览量永远记不上**（文章页永远显示「—」、列表页 data-pv 空白）
 *   · GET  /api/blog/comments  → 400，文章页评论区直接「评论加载失败。」
 *   · GET  /api/blog/views     → 该 slug 被静默过滤掉，连读都读不到
 * 现在两边共用这一份常量，长度上限（120）也对齐，避免再次漂移。
 *
 * 注意：slug 只参与数据库等值查询（TypeORM 参数化，无注入面）与静态页路径拼接，
 * 大小写敏感是**要保留**的语义 —— `WeirdStuff2` 与 `weirdstuff2` 是两篇文章。
 */
export const BLOG_SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/;

/** 与正则里的 {0,119} 对应：总长上限 120 */
export const BLOG_SLUG_MAX_LEN = 120;

/** 给用户看的错误文案（写作台 DTO 与公开接口共用同一句） */
export const BLOG_SLUG_HINT = 'slug 只能包含字母、数字与中划线（中文标题请自拟英文短链），长度不超过 120';
