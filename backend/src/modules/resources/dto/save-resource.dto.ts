import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    IsArray,
    IsBoolean,
    IsInt,
    IsNotEmpty,
    IsOptional,
    IsString,
    Matches,
    MaxLength,
    Min,
} from 'class-validator';
import { RESOURCE_KEY_RE } from '../resource-paths';

/**
 * 后台保存入参（POST /api/admin/resources）。
 *
 * ⚠️ 每个字段都必须带 class-validator 装饰器：全局 ValidationPipe 开了 `whitelist: true` +
 *    `forbidNonWhitelisted: true`，没装饰器的属性会被当成未声明字段直接 400（与 blog-admin 的 SavePostDto 同一约定）。
 */
export class SaveResourceDto {
    /** 有 id = 更新，没有 = 新建 */
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    id?: number;

    @IsString()
    @IsNotEmpty()
    @MaxLength(120)
    title: string;

    @IsOptional()
    @IsString()
    @MaxLength(20000)
    description?: string;

    @IsOptional()
    @IsString()
    @MaxLength(2000)
    url?: string;

    /** 标签数组；库里按 JSON 文本存 */
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(20)
    @IsString({ each: true })
    @MaxLength(40, { each: true })
    tags?: string[];

    @IsOptional()
    @IsBoolean()
    published?: boolean;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    sortOrder?: number;

    /** 上传接口返回的 key；空串表示"清空文件、退回链接条目" */
    @IsOptional()
    @IsString()
    @MaxLength(64)
    @Matches(RESOURCE_KEY_RE, { message: 'fileKey 格式不正确（应为 32 位 hex，可带扩展名）' })
    fileKey?: string;

    @IsOptional()
    @IsString()
    @MaxLength(200)
    fileName?: string;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    fileSize?: number;

    @IsOptional()
    @IsString()
    @MaxLength(120)
    mimeType?: string;
}
