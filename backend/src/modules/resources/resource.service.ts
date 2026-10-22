import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { ResourceItem, ResourceKind } from '../../infrastructure/database/entities/resource-item.entity';
import { RESOURCE_KEY_RE, resolveResourcePath } from './resource-paths';
import { SaveResourceDto } from './dto/save-resource.dto';

/** 上传接口落盘后回给前端的描述（前端再调保存接口写条目） */
export interface UploadedFileInfo {
    key: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
}

/** 种子（契约 §3：只放一条 DSH 桌面版；其余留给站主自己加） */
const DSH_WINDOWS_EXE = 'https://github.com/dsh-tauri/deepseek-harness-desktop/releases/download/v0.24.5/Deepseek.Harness.Desktop_0.24.5_x64-setup.exe';
const SEED_ITEM = {
    title: 'DeepSeek Harness 桌面版（Windows 安装包）',
    description: [
        '社区用 Tauri 打包的桌面外壳（MIT，内核 0.2.1-rc.2），不是 DeepSeek 官方发布的安装包。',
        '免装 Node/pnpm，装完即用；首次启动可能要联网初始化（带 _Bundle 后缀的是离线捆绑包，体积大得多）。',
        'macOS / Linux 安装包与全部版本：https://github.com/dsh-tauri/deepseek-harness-desktop/releases',
        '项目源码：https://github.com/dsh-tauri/deepseek-harness-desktop',
        '官方命令行路线：npm i -g @deepseek-ai/dsh，然后 dsh web。',
    ].join('\n'),
    url: DSH_WINDOWS_EXE,
    tags: JSON.stringify(['桌面端', '工具']),
    kind: ResourceKind.LINK,
    published: true,
    sortOrder: 100,
};

/**
 * 共享资源（/api/resources/* 与 /api/admin/resources/*）。
 * 文件本体落 RESOURCE_DIR，库表只存元数据；删除条目时顺手清理"无任何条目引用"的文件。
 */
@Injectable()
export class ResourceService implements OnModuleInit {
    private readonly logger = new Logger(ResourceService.name);

    constructor(
        @InjectRepository(ResourceItem)
        private readonly repo: Repository<ResourceItem>,
    ) {}

    /** 表为空时插入种子；库未就绪时只告警不阻塞启动（与 main.ts 的 autoSeed 同口径） */
    async onModuleInit() {
        try {
            const count = await this.repo.count();
            if (count === 0) {
                await this.repo.save(this.repo.create(SEED_ITEM as Partial<ResourceItem>));
                this.logger.log('共享资源种子已写入（DSH 桌面版）');
            }
        }
        catch (e: any) {
            this.logger.warn(`共享资源种子初始化跳过（数据库可能未就绪）：${e?.message || e}`);
        }
    }

    /** 公开列表：只返回 published=true，sortOrder desc, id desc */
    async listPublished() {
        const rows = await this.repo.find({
            where: { published: true },
            order: { sortOrder: 'DESC', id: 'DESC' },
        });
        return rows.map((r) => this.toPublic(r));
    }

    /** 后台列表：全部条目（含隐藏），多出 published / sortOrder / fileKey 等字段 */
    async listAll() {
        const rows = await this.repo.find({ order: { sortOrder: 'DESC', id: 'DESC' } });
        return rows.map((r) => this.toAdmin(r));
    }

    /** 保存/更新；带 fileKey 时校验文件确实已上传，kind 由是否存在 fileKey 推导 */
    async save(dto: SaveResourceDto) {
        const title = String(dto.title || '').trim();
        if (!title)
            throw new Error('标题不能为空');

        let row: ResourceItem | null = null;
        if (dto.id) {
            row = await this.repo.findOne({ where: { id: Number(dto.id) } });
            if (!row)
                throw new Error('条目不存在');
        }
        if (!row)
            row = this.repo.create({ published: true, sortOrder: 0, tags: '[]' });

        row.title = title.slice(0, 120);
        if (dto.description !== undefined)
            row.description = String(dto.description || '').trim() || null;
        if (dto.url !== undefined)
            row.url = String(dto.url || '').trim() || null;
        if (dto.tags !== undefined)
            row.tags = JSON.stringify(this.sanitizeTags(dto.tags));
        if (dto.published !== undefined)
            row.published = dto.published !== false;
        if (dto.sortOrder !== undefined)
            row.sortOrder = Number(dto.sortOrder) || 0;

        // fileKey：undefined = 不改变；空串 = 清空文件信息，退回 link 条目
        if (dto.fileKey !== undefined) {
            const key = String(dto.fileKey || '').trim();
            if (!key) {
                row.fileKey = null;
                row.fileName = null;
                row.fileSize = null;
                row.mimeType = null;
            }
            else {
                if (!RESOURCE_KEY_RE.test(key))
                    throw new Error('fileKey 格式不正确（应为 32 位 hex，可带扩展名）');
                const abs = resolveResourcePath(key);
                if (!abs)
                    throw new Error('fileKey 非法');
                try {
                    const st = await fs.stat(abs);
                    if (!st.isFile())
                        throw new Error('not a file');
                }
                catch {
                    throw new Error('文件不存在，请先调用上传接口');
                }
                row.fileKey = key;
                row.fileName = dto.fileName !== undefined ? String(dto.fileName || '').slice(0, 200) || null : row.fileName;
                row.fileSize = dto.fileSize !== undefined ? (Number(dto.fileSize) || 0) : row.fileSize;
                row.mimeType = dto.mimeType !== undefined ? String(dto.mimeType || '').slice(0, 120) || null : row.mimeType;
                // 文件类条目的 url 由服务端固定，除非调用方显式给了别的
                if (!row.url && dto.url === undefined)
                    row.url = `/api/resources/file/${key}`;
            }
        }
        row.kind = row.fileKey ? ResourceKind.FILE : ResourceKind.LINK;

        const saved = await this.repo.save(row);
        return { item: this.toAdmin(saved) };
    }

    /** 删除条目，并清掉"没有任何条目再引用"的物理文件（失败只告警） */
    async remove(id: number) {
        const row = await this.repo.findOne({ where: { id: Number(id) } });
        if (!row)
            return { removed: false };
        const key = row.fileKey;
        await this.repo.remove(row);
        if (key) {
            const left = await this.repo.count({ where: { fileKey: key } });
            if (left === 0) {
                const abs = resolveResourcePath(key);
                if (abs) {
                    try {
                        await fs.unlink(abs);
                    }
                    catch (e: any) {
                        if (e?.code !== 'ENOENT')
                            this.logger.warn(`删除资源文件失败 ${key}：${e?.message || e}`);
                    }
                }
            }
        }
        return { removed: true };
    }

    /** 下载用：key 合法 + 条目存在 + published + 文件确实在盘上，缺一不可 */
    async findPublishedFile(key: string) {
        if (!RESOURCE_KEY_RE.test(String(key || '')))
            return null;
        const abs = resolveResourcePath(key);
        if (!abs)
            return null;
        const row = await this.repo.findOne({ where: { fileKey: key } });
        if (!row || !row.published)
            return null;
        try {
            const st = await fs.stat(abs);
            if (!st.isFile())
                return null;
        }
        catch {
            return null;
        }
        return { absolutePath: abs, fileName: row.fileName || path.basename(abs) };
    }

    /** 上传落盘完成后生成回执（multer 已把 key 写进 file.filename） */
    describeUploaded(file: any): UploadedFileInfo {
        return {
            key: String(file?.filename || ''),
            fileName: this.decodeOriginalName(file?.originalname),
            fileSize: Number(file?.size) || 0,
            mimeType: String(file?.mimetype || 'application/octet-stream'),
        };
    }

    /**
     * busboy 默认按 latin1 解码 multipart 文件名，中文名会乱码；能无损转回 UTF-8 就用转换结果。
     * （已是正常 UTF-8 的字符串转换后会带替换符，届时保留原值。）
     */
    private decodeOriginalName(raw: any): string {
        const name = path.basename(String(raw || '').replace(/\\/g, '/'));
        if (!name)
            return '';
        try {
            const utf8 = Buffer.from(name, 'latin1').toString('utf8');
            if (!utf8.includes('\uFFFD'))
                return utf8;
        }
        catch {
            // 保留原值
        }
        return name;
    }

    private sanitizeTags(tags: any): string[] {
        if (!Array.isArray(tags))
            return [];
        return tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20).map((t) => t.slice(0, 40));
    }

    private parseTags(raw: string): string[] {
        try {
            const v = JSON.parse(raw || '[]');
            return Array.isArray(v) ? v.map(String) : [];
        }
        catch {
            return [];
        }
    }

    /** 公开输出：不含 fileKey / published / sortOrder（契约 §1 的示例结构） */
    private toPublic(r: ResourceItem) {
        return {
            id: r.id,
            title: r.title,
            description: r.description || '',
            url: r.url || '',
            tags: this.parseTags(r.tags),
            kind: r.kind,
            fileName: r.fileName || null,
            fileSize: r.fileSize ?? null,
            updatedAt: r.updatedAt,
        };
    }

    /** 后台输出：公开字段 + 管理字段 */
    private toAdmin(r: ResourceItem) {
        return {
            ...this.toPublic(r),
            fileKey: r.fileKey || null,
            mimeType: r.mimeType || null,
            published: !!r.published,
            sortOrder: r.sortOrder,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
        };
    }
}
