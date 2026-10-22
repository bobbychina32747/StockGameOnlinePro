import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    ForbiddenException,
    Get,
    NotFoundException,
    Param,
    ParseIntPipe,
    Post,
    UploadedFile,
    UseGuards,
    UseInterceptors,
} from '@nestjs/common';
import { CurrentUser } from '../../common/guards/jwt-auth.guard';
import { User, UserRole } from '../../infrastructure/database/entities/user.entity';
import { BlogAdminGuard } from '../blog-admin/blog-admin.guard';
import { SaveResourceDto } from './dto/save-resource.dto';
import { ResourceUploadInterceptor } from './resource-upload.interceptor';
import { ResourceService } from './resource.service';

/**
 * 后台资源管理（/api/admin/resources/*），鉴权与 /api/admin/blog/* 完全一致：
 * BlogAdminGuard（站点身份优先 + 旧管理员 JWT 兜底）+ assertAdmin(role===ADMIN)。
 */
@Controller('admin/resources')
@UseGuards(BlogAdminGuard)
export class ResourceAdminController {
    constructor(private readonly resources: ResourceService) {}

    private assertAdmin(user: User) {
        if (!user || user.role !== UserRole.ADMIN)
            throw new ForbiddenException('无权限');
    }

    @Get()
    async list(@CurrentUser() user: User) {
        this.assertAdmin(user);
        return { items: await this.resources.listAll() };
    }

    @Post()
    async save(@CurrentUser() user: User, @Body() dto: SaveResourceDto) {
        this.assertAdmin(user);
        try {
            return await this.resources.save(dto);
        }
        catch (e: any) {
            throw new BadRequestException(String(e?.message || e));
        }
    }

    @Delete(':id')
    async remove(@CurrentUser() user: User, @Param('id', ParseIntPipe) id: number) {
        this.assertAdmin(user);
        const r = await this.resources.remove(id);
        if (!r.removed)
            throw new NotFoundException('条目不存在');
        return r;
    }

    /** multipart 上传，字段名 file，上限 64MB；返回 key 等元数据，前端再调保存接口写条目 */
    @Post('upload')
    @UseInterceptors(ResourceUploadInterceptor)
    async upload(@CurrentUser() user: User, @UploadedFile() file: any) {
        this.assertAdmin(user);
        if (!file || !file.filename)
            throw new BadRequestException('未收到文件（字段名应为 file）');
        return this.resources.describeUploaded(file);
    }
}
