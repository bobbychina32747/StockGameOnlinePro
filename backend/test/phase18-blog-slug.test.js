// Phase 18 回归：博客 slug 契约必须是**单一来源**（写作台与对外接口共用一份）
//
// 线上事故（2026-10-08 实测 bobbycn.cc）：
//   写作台的 DTO 允许大写 slug，对外接口只认小写 → 站主发的《WeirdStuff2》变成"写得进去、读不出来"：
//     · POST /api/blog/view     → 400 `slug 不合法` ⇒ 该文章浏览量永远记不上（文章页永远「—」，列表页 data-pv 空白）
//     · GET  /api/blog/comments → 400               ⇒ 文章页评论区「评论加载失败。」
//     · GET  /api/blog/views    → 该 slug 被静默过滤，连批量读也读不到
//   修法：抽 common/blog-slug.ts 作为唯一来源，两侧都改成引用它（本文件同时做行为回归 + 防漂移门禁）。
const fs = require('fs');
const path = require('path');

const { BlogPublicService } = require('../dist/src/modules/blog-public/blog-public.service');
const { BLOG_SLUG_RE } = require('../dist/src/common/blog-slug');

const ROOT = path.join(__dirname, '..');

/** 用内存桩替掉三个 Repository：只实现被测路径用到的方法 */
function makeService() {
    const viewRows = new Map();
    const commentRows = [
        { id: 'c1', slug: 'WeirdStuff2', author: '甲', body: '写得好', status: 'published', createdAt: new Date('2026-10-08T00:00:00Z') },
        { id: 'c2', slug: 'weirdstuff2', author: '乙', body: '小写那篇', status: 'published', createdAt: new Date('2026-10-08T00:00:00Z') },
        { id: 'c3', slug: 'WeirdStuff2', author: '丙', body: '待审', status: 'pending', createdAt: new Date('2026-10-08T00:00:00Z') },
    ];
    const postRows = [
        { slug: 'WeirdStuff2', draft: false },
        { slug: 'weirdstuff2', draft: false },
        { slug: 'pure-test', draft: false },
        { slug: 'draft-only', draft: true },
    ];

    const views = {
        findOne: async ({ where }) => (viewRows.has(where.slug) ? { slug: where.slug, count: viewRows.get(where.slug) } : null),
        insert: async (row) => { viewRows.set(row.slug, row.count); },
        increment: async ({ slug }, _col, by) => { viewRows.set(slug, (viewRows.get(slug) || 0) + by); },
        // viewsFor 用的是 In(list)：TypeORM 的 FindOperator 把值放在 _value 上
        find: async ({ where }) => {
            const list = (where && where.slug && where.slug._value) || [];
            return list.filter((s) => viewRows.has(s)).map((s) => ({ slug: s, count: viewRows.get(s) }));
        },
    };
    const comments = {
        findAndCount: async ({ where }) => {
            const hit = commentRows.filter((c) => c.slug === where.slug && c.status === where.status);
            return [hit, hit.length];
        },
        count: async ({ where }) => commentRows.filter((c) => c.slug === where.slug && c.status === where.status).length,
    };
    const posts = { findOne: async ({ where }) => postRows.find((p) => p.slug === where.slug && p.draft === where.draft) || null };
    const moderation = { review: () => ({ verdict: 'pass', reasons: [] }) };

    const svc = new BlogPublicService(views, comments, posts, moderation);
    return { svc, viewRows };
}

describe('Phase 18 博客 slug 契约：写作台写得进去的，对外接口必须读得出来', () => {
    test('回归事例 WeirdStuff2（大写）：能计数、能读评论、能被批量读', async () => {
        const { svc } = makeService();

        // ① 浏览量计数不再 400
        await expect(svc.hit('WeirdStuff2', '1.1.1.1')).resolves.toBe(1);
        // ② 同一 IP 30 分钟冷却内只回读
        await expect(svc.hit('WeirdStuff2', '1.1.1.1')).resolves.toBe(1);
        // ③ 换 IP 才 +1
        await expect(svc.hit('WeirdStuff2', '2.2.2.2')).resolves.toBe(2);

        // ④ 评论列表不再 400（只给 published：WeirdStuff2 有 1 条 published、1 条 pending）
        const list = await svc.listComments('WeirdStuff2');
        expect(list.total).toBe(1);
        expect(list.comments[0].body).toBe('写得好');

        // ⑤ 列表页批量读不能被静默过滤掉
        const views = await svc.viewsFor(['WeirdStuff2', 'weirdstuff2', 'pure-test']);
        expect(views).toEqual({ WeirdStuff2: 2 });
    });

    test('大小写是两篇不同的文章，互不污染（不合并计数、不串评论）', async () => {
        const { svc } = makeService();
        await svc.hit('WeirdStuff2', '1.1.1.1');
        await svc.hit('weirdstuff2', '1.1.1.1');
        await svc.hit('weirdstuff2', '3.3.3.3');
        const views = await svc.viewsFor(['WeirdStuff2', 'weirdstuff2']);
        expect(views).toEqual({ WeirdStuff2: 1, weirdstuff2: 2 });

        expect((await svc.listComments('weirdstuff2')).comments.map((c) => c.body)).toEqual(['小写那篇']);
    });

    test('非法形状照旧一律拒绝（放宽大小写不等于放宽形状）', async () => {
        const { svc } = makeService();
        const bad = ['', '   ', '中文-slug', '-abc', 'a b', 'a/b', 'a_b', 'a.b', '.hidden', 'a'.repeat(121)];
        for (const s of bad) {
            await expect(svc.hit(s, '1.1.1.1')).rejects.toThrow();
        }
        await expect(svc.listComments('中文-slug')).rejects.toThrow();
        // 长度上限仍为 120：120 位合法、121 位不合法
        await expect(svc.hit('a'.repeat(120), '1.1.1.1')).resolves.toBe(1);
    });

    test('批量读混合输入：只丢掉非法项，合法项照常返回', async () => {
        const { svc } = makeService();
        await svc.hit('pure-test', '9.9.9.9');
        const views = await svc.viewsFor(['pure-test', '中文', '', 'a b']);
        expect(views).toEqual({ 'pure-test': 1 });
    });

    test('防漂移门禁：写作台与对外接口不再各写一份 slug 正则', () => {
        const files = [
            'src/common/blog-slug.ts',
            'src/modules/blog-public/blog-public.service.ts',
            'src/modules/blog-admin/blog-admin.controller.ts',
            'src/modules/blog-admin/blog-admin.service.ts',
        ];
        const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

        // ① 三处消费者都必须引用共用常量（而不是自己再写一份）
        for (const f of ['src/modules/blog-public/blog-public.service.ts', 'src/modules/blog-admin/blog-admin.controller.ts', 'src/modules/blog-admin/blog-admin.service.ts']) {
            expect(`${f} → ${/BLOG_SLUG_RE/.test(read(f))}`).toBe(`${f} → true`);
        }
        // ② 三个消费者里不得再出现自写的 slug 正则字面量（只允许小写的那份正是本次事故根因）；
        //    唯一可以写正则的地方就是 blog-slug.ts 自己，它的行为在 ③ 里断言
        const selfWritten = /\/\^\[a-z0-9\]\[a-z0-9-\]\{\d+,\d+\}\$\//;
        for (const f of files.slice(1)) {
            expect(`${f} 自写正则 → ${selfWritten.test(read(f))}`).toBe(`${f} 自写正则 → false`);
        }
        // ③ 共用常量本身的行为底稿
        expect(BLOG_SLUG_RE.test('WeirdStuff2')).toBe(true);
        expect(BLOG_SLUG_RE.test('self-hosted-in-tokyo')).toBe(true);
        expect(BLOG_SLUG_RE.test('中文')).toBe(false);
    });
});
