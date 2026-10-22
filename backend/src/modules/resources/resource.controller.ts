import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import { ResourceService } from './resource.service';

/**
 * 公开资源接口（无需登录）
 *   GET /api/resources             → { items }（仅 published=true）
 *   GET /api/resources/file/:key   → 附件下载（仅所属条目 published=true）
 * 契约见 docs/RESOURCES-20261021.md §1。
 */
@Controller('resources')
export class ResourceController {
    constructor(private readonly resources: ResourceService) {}

    @Get()
    async list() {
        return { items: await this.resources.listPublished() };
    }

    @Get('file/:key')
    async download(@Param('key') key: string, @Res() res: any) {
        // key 格式由 service 再校验一遍（双重防线），非法 / 不存在 / 未发布 一律 404，不泄露条目是否存在
        const found = await this.resources.findPublishedFile(key);
        if (!found)
            throw new NotFoundException('文件不存在');
        res.download(found.absolutePath, found.fileName, (err: any) => {
            // 头已发出时不能再改状态码（客户端中断等场景），静默即可
            if (err && !res.headersSent)
                res.status(404).end();
        });
    }
}
