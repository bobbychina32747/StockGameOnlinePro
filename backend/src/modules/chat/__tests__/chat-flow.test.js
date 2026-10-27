// 站内私线单测（2026-10-27）
// 风格与仓库既有单测一致：真实 DataSource（better-sqlite3 内存库）+ 手工装配服务，
// 不引 @nestjs/testing。被测对象是编译产物 dist/，所以先 npm run build 再 jest。
require('reflect-metadata');

const { DataSource } = require('typeorm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Identity, IdentityRole, IdentityStatus } = require('../../../../dist/src/infrastructure/database/entities/identity.entity');
const { ChatThread } = require('../../../../dist/src/infrastructure/database/entities/chat-thread.entity');
const { ChatMessage, ChatMessageKind } = require('../../../../dist/src/infrastructure/database/entities/chat-message.entity');
const { ChatAttachment } = require('../../../../dist/src/infrastructure/database/entities/chat-attachment.entity');
const { ChatService } = require('../../../../dist/src/modules/chat/chat.service');

async function createHarness() {
    const ds = new DataSource({
        type: 'better-sqlite3',
        database: ':memory:',
        entities: [Identity, ChatThread, ChatMessage, ChatAttachment],
        synchronize: true,
        logging: false,
    });
    await ds.initialize();

    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-test-'));
    process.env.CHAT_UPLOAD_DIR = uploadDir;

    const identityRepo = ds.getRepository(Identity);
    const threadRepo = ds.getRepository(ChatThread);
    const messageRepo = ds.getRepository(ChatMessage);
    const attachmentRepo = ds.getRepository(ChatAttachment);

    const owner = await identityRepo.save(identityRepo.create({
        email: 'owner@test.local', username: 'bobby', status: IdentityStatus.ACTIVE,
        emailVerifiedAt: new Date(), role: IdentityRole.USER,
    }));
    const peer = await identityRepo.save(identityRepo.create({
        email: 'tina@test.local', username: 'tina', status: IdentityStatus.ACTIVE,
        emailVerifiedAt: new Date(), role: IdentityRole.SUBADMIN,
    }));
    const stranger = await identityRepo.save(identityRepo.create({
        email: 'x@test.local', username: 'stranger', status: IdentityStatus.ACTIVE,
        emailVerifiedAt: new Date(), role: IdentityRole.USER,
    }));

    // 站主判据的替身：只认 owner（真实实现是 ADMIN_EMAILS / 最早注册身份，另有测试覆盖）
    const identityStub = {
        isOwnerIdentity: async (identity) => !!identity && identity.id === owner.id,
        findOldestActiveIdentityId: async () => owner.id,
    };

    const published = [];
    const events = {
        publish: (threadId, event, data) => published.push({ threadId, event, data }),
        peerOnline: () => false,
        broadcastPresence: () => undefined,
        subscribe: () => () => undefined,
    };

    const service = new ChatService(threadRepo, messageRepo, attachmentRepo, identityRepo, identityStub, events);

    return { ds, service, owner, peer, stranger, published, uploadDir, repos: { identityRepo, threadRepo, messageRepo, attachmentRepo } };
}

describe('站内私线 ChatService', () => {
    let h;

    beforeEach(async () => {
        h = await createHarness();
    });

    afterEach(async () => {
        await h.ds.destroy();
        try {
            fs.rmSync(h.uploadDir, { recursive: true, force: true });
        }
        catch (e) { /* 清理失败不影响结论 */ }
    });

    describe('访问控制', () => {
        it('站主可用，且对端是 subadmin', async () => {
            const access = await h.service.getAccess(h.owner);
            expect(access.allowed).toBe(true);
            expect(access.side).toBe('owner');
            expect(access.peer.username).toBe('tina');
            expect(access.threadId).toBeTruthy();
        });

        it('subadmin 可用，且对端是站主', async () => {
            const access = await h.service.getAccess(h.peer);
            expect(access.allowed).toBe(true);
            expect(access.side).toBe('peer');
            expect(access.peer.username).toBe('bobby');
        });

        it('普通账号被拒绝（403）', async () => {
            await expect(h.service.getAccess(h.stranger)).rejects.toMatchObject({ status: 403 });
        });

        it('站主与受邀方落到同一条 thread（不重复建）', async () => {
            const a1 = await h.service.getAccess(h.owner);
            const a2 = await h.service.getAccess(h.peer);
            expect(a1.threadId).toBe(a2.threadId);
            const count = await h.repos.threadRepo.count();
            expect(count).toBe(1);
        });

        it('没有 subadmin 时站主得到 409（部署后忘建 tina 会在这里显形）', async () => {
            await h.repos.identityRepo.update({ id: h.peer.id }, { role: IdentityRole.USER });
            await expect(h.service.getAccess(h.owner)).rejects.toMatchObject({ status: 409 });
        });
    });

    describe('发送与校验', () => {
        it('文本消息落库并广播', async () => {
            const dto = await h.service.send(h.owner, { kind: 'text', text: '  你好 tina  ' });
            expect(dto.kind).toBe('text');
            expect(dto.text).toBe('你好 tina');
            expect(dto.sender.username).toBe('bobby');
            expect(h.published.filter((p) => p.event === 'message')).toHaveLength(1);
        });

        it('空文本 / 超长文本被拒', async () => {
            await expect(h.service.send(h.owner, { kind: 'text', text: '   ' })).rejects.toMatchObject({ status: 400 });
            await expect(h.service.send(h.owner, { kind: 'text', text: 'x'.repeat(4001) })).rejects.toMatchObject({ status: 400 });
        });

        it('链接只接受 http/https 并做规范化', async () => {
            const dto = await h.service.send(h.peer, { kind: 'link', linkUrl: 'https://example.com/a?b=1', text: '看看' });
            expect(dto.linkUrl).toBe('https://example.com/a?b=1');
            await expect(h.service.send(h.peer, { kind: 'link', linkUrl: 'javascript:alert(1)' })).rejects.toMatchObject({ status: 400 });
            await expect(h.service.send(h.peer, { kind: 'link', linkUrl: 'not a url' })).rejects.toMatchObject({ status: 400 });
        });

        it('文本消息不接受 linkUrl / 附件字段', async () => {
            await expect(h.service.send(h.owner, { kind: 'text', text: 'x', linkUrl: 'https://a.b' })).rejects.toMatchObject({ status: 400 });
        });

        it('未知消息类型被拒', async () => {
            await expect(h.service.send(h.owner, { kind: 'video', text: 'x' })).rejects.toMatchObject({ status: 400 });
        });
    });

    describe('附件', () => {
        async function upload(name, content) {
            const incoming = path.join(h.uploadDir, 'incoming');
            fs.mkdirSync(incoming, { recursive: true });
            const diskName = 'a'.repeat(32) + path.extname(name);
            fs.writeFileSync(path.join(incoming, diskName), content);
            return h.service.registerUpload(h.owner, {
                originalname: name,
                mimetype: 'application/pdf',
                size: Buffer.byteLength(content),
                filename: diskName,
            });
        }

        it('上传后归档到会话目录，中文名按 UTF-8 还原', async () => {
            const res = await upload('私线测试.pdf', 'hello');
            expect(res.attachment.filename).toBe('私线测试.pdf');
            expect(res.attachment.size).toBe(5);
            const abs = path.join(h.uploadDir, (await h.repos.attachmentRepo.findOne({ where: { id: res.attachment.id } })).storageKey);
            expect(fs.existsSync(abs)).toBe(true);
        });

        it('文件消息必须绑定自己上传的附件，且不能重复发送', async () => {
            const res = await upload('a.pdf', 'x');
            const dto = await h.service.send(h.owner, { kind: 'file', attachmentId: res.attachment.id, text: '说明' });
            expect(dto.kind).toBe('file');
            expect(dto.attachment.filename).toBe('a.pdf');
            await expect(h.service.send(h.owner, { kind: 'file', attachmentId: res.attachment.id })).rejects.toMatchObject({ status: 400 });
            await expect(h.service.send(h.peer, { kind: 'file', attachmentId: res.attachment.id })).rejects.toMatchObject({ status: 403 });
        });

        it('取文件：参与者可读，非参与者被拒', async () => {
            const res = await upload('b.pdf', 'payload');
            const opened = await h.service.openFile(h.peer, res.attachment.id);
            expect(fs.readFileSync(opened.absPath, 'utf8')).toBe('payload');
            await expect(h.service.openFile(h.stranger, res.attachment.id)).rejects.toMatchObject({ status: 403 });
            await expect(h.service.openFile(h.owner, '00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ status: 404 });
        });

        it('孤儿附件（传了没发）会被定时清理', async () => {
            const res = await upload('c.pdf', 'x');
            const row = await h.repos.attachmentRepo.findOne({ where: { id: res.attachment.id } });
            // 把创建时间改到 48 小时以前，模拟长期没发送
            await h.repos.attachmentRepo.update({ id: row.id }, { createdAt: new Date(Date.now() - 49 * 3600 * 1000) });
            const out = await h.service.cleanupOrphans();
            expect(out.removedRows).toBe(1);
            expect(await h.repos.attachmentRepo.findOne({ where: { id: row.id } })).toBeNull();
        });
    });

    describe('历史与已读', () => {
        async function seed(n) {
            for (let i = 0; i < n; i += 1)
                await h.service.send(i % 2 ? h.peer : h.owner, { kind: 'text', text: 'm' + i });
        }

        it('按时间升序返回，倒序游标可翻页且不重不漏', async () => {
            await seed(6);
            const p1 = await h.service.listMessages(h.owner, { limit: 4 });
            expect(p1.messages.map((m) => m.text)).toEqual(['m2', 'm3', 'm4', 'm5']);
            expect(p1.hasMore).toBe(true);

            const p2 = await h.service.listMessages(h.owner, { limit: 4, before: p1.messages[0].id });
            expect(p2.messages.map((m) => m.text)).toEqual(['m0', 'm1']);
            expect(p2.hasMore).toBe(false);
            // 两页拼起来正好是全集，没有重复
            const all = p2.messages.concat(p1.messages).map((m) => m.text);
            expect(new Set(all).size).toBe(6);
        });

        it('同一毫秒内的多条消息顺序也稳定（seq 严格递增，不靠时间戳/uuid）', async () => {
            const ids = [];
            for (let i = 0; i < 3; i += 1) {
                const dto = await h.service.send(h.owner, { kind: 'text', text: 'same' + i });
                ids.push(dto.id);
            }
            const list = await h.service.listMessages(h.owner, { limit: 10 });
            expect(list.messages.map((m) => m.id)).toEqual(ids);
        });

        it('重启后续号：新消息仍排在旧消息之后（序号从库里 MAX(seq) 接上）', async () => {
            await h.service.send(h.owner, { kind: 'text', text: 'before-restart' });
            const first = await h.service.listMessages(h.owner, { limit: 10 });
            const seqMax = (await h.repos.messageRepo.createQueryBuilder('m').select('MAX(m.seq)', 'max').getRawOne()).max;
            // 模拟重启：新建一个 lastSeq=0 的服务实例（onModuleInit 会从库里续号）
            const { ChatService } = require('../../../../dist/src/modules/chat/chat.service');
            const events = { publish: () => undefined, peerOnline: () => false, broadcastPresence: () => undefined, subscribe: () => () => undefined };
            const identityStub = {
                isOwnerIdentity: async (identity) => !!identity && identity.id === h.owner.id,
                findOldestActiveIdentityId: async () => h.owner.id,
            };
            const reborn = new ChatService(h.repos.threadRepo, h.repos.messageRepo, h.repos.attachmentRepo, h.repos.identityRepo, identityStub, events);
            reborn.onModuleInit();
            // 等续号查询完成（setRaw 是异步的）
            await new Promise((r) => setTimeout(r, 30));
            await reborn.send(h.owner, { kind: 'text', text: 'after-restart' });
            const list = await h.service.listMessages(h.owner, { limit: 10 });
            expect(list.messages.map((m) => m.text)).toEqual(['before-restart', 'after-restart']);
            const after = (await h.repos.messageRepo.createQueryBuilder('m').select('MAX(m.seq)', 'max').getRawOne()).max;
            expect(Number(after)).toBeGreaterThan(Number(seqMax));
            reborn.onModuleDestroy();
        });

        it('非法游标被拒（400）', async () => {
            await expect(h.service.listMessages(h.owner, { before: 'nope' })).rejects.toMatchObject({ status: 400 });
        });

        it('已读回执只标记对端消息，且会广播', async () => {
            await h.service.send(h.owner, { kind: 'text', text: 'a' });
            await h.service.send(h.peer, { kind: 'text', text: 'b' });
            const before = await h.service.getAccess(h.peer);
            expect(before.unread).toBe(1);
            const out = await h.service.markRead(h.peer);
            expect(out.affected).toBe(1);
            const after = await h.service.getAccess(h.peer);
            expect(after.unread).toBe(0);
            expect(h.published.some((p) => p.event === 'read')).toBe(true);
        });
    });

    describe('DTO 边界', () => {
        it('消息 DTO 只暴露展示字段', async () => {
            const dto = await h.service.send(h.owner, { kind: 'text', text: 'x' });
            expect(Object.keys(dto).sort()).toEqual(['attachment', 'createdAt', 'id', 'kind', 'linkUrl', 'readAt', 'sender', 'text']);
        });

        it('输入中的事件带发送者的用户名，不含会话等内部字段', async () => {
            await h.service.typing(h.owner);
            const evt = h.published.find((p) => p.event === 'typing');
            expect(evt.data.username).toBe('bobby');
            expect(evt.data.by).toBe(h.owner.id);
        });
    });
});
