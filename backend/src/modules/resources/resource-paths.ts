import * as path from 'node:path';

/**
 * 资源文件的 key 格式（与契约一致）：
 *   32 位小写 hex（crypto.randomBytes(16).toString('hex')），可选 1~10 位扩展名。
 * 下载接口与保存接口共用这一份正则，避免"写得进去、下不下来"。
 */
export const RESOURCE_KEY_RE = /^[a-f0-9]{32}(\.[A-Za-z0-9]{1,10})?$/;

/** 上传/下载共用的落盘目录：RESOURCE_DIR（容器里即 /app/data/resources） */
export function resourceDir(): string {
    return process.env.RESOURCE_DIR || path.join(process.cwd(), 'data', 'resources');
}

/**
 * 把 key 解析成绝对路径；key 非法或解析结果越出资源目录时返回 null。
 * 路径穿越防线：先卡 key 正则，再比对父目录 === 资源目录（双保险）。
 */
export function resolveResourcePath(key: string): string | null {
    if (!RESOURCE_KEY_RE.test(String(key || '')))
        return null;
    const dir = path.resolve(resourceDir());
    const abs = path.resolve(dir, key);
    if (path.dirname(abs) !== dir)
        return null;
    return abs;
}
