import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

/**
 * 授权系统 · 客户端注册（2026-10-08）
 *
 * 把「账号系统」升级成「可复用的授权系统」的核心一张表：每个要接入站点身份的应用
 * （站内游戏、未来的独立游戏、第三方应用）在这里登记一行，之后走标准授权码流程
 * （`/oauth/authorize` → `/oauth/token` → `/oauth/userinfo`）。
 *
 * 与 GitHub / 微软的对应关系：
 *   · GitHub 的 OAuth App / Entra 的「应用注册」= 这里的 `clientId` + `redirectUris` + `scopes`；
 *   · `type=public`（浏览器/纯前端，无 client_secret，**强制 PKCE**）
 *     ↔ GitHub 的 public client / Entra 的 SPA 平台；
 *   · `type=confidential`（有后端、能保管密钥的服务端应用）存 `clientSecretHash`（只存 sha256，明文只在创建时出现一次），
 *     允许不带 PKCE（但带了就照验）。
 *
 * 第一方客户端（站内游戏）由 `OauthService.seedBuiltinClients()` 启动时幂等写入，
 * 所以"加一个站内游戏"= 在代码里加一条种子 + 前端引 SDK，不需要手工开表。
 */
export enum OAuthClientType {
    /** 公开客户端：浏览器里跑，没有 secret，必须 PKCE */
    PUBLIC = 'public',
    /** 机密客户端：有服务端（能保住 secret），可选 PKCE */
    CONFIDENTIAL = 'confidential',
}

@Entity('oauth_clients')
@Unique(['clientId'])
export class OAuthClient {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** 对外公开的客户端标识（会出现在 URL 与令牌的 client_id claim 里） */
    @Column({ type: 'varchar', length: 64 })
    clientId: string;

    /** 展示名（同意页上给用户看：「XX 想访问你的 bobbycn.cc 账号」） */
    @Column({ type: 'varchar', length: 120 })
    name: string;

    @Column({ type: 'simple-enum', enum: OAuthClientType, default: OAuthClientType.PUBLIC })
    type: OAuthClientType;

    /** confidential 客户端的密钥哈希（sha256 hex）；public 恒为 NULL */
    @Column({ type: 'varchar', length: 64, nullable: true })
    clientSecretHash: string | null;

    /**
     * 允许的回调地址（**精确匹配**，见 OauthService.resolveRedirectUri）。
     * 不搞通配：开放重定向是授权系统最致命的漏洞，宁可在加客户端时多写几行。
     */
    @Column({ type: 'simple-json' })
    redirectUris: string[];

    /** 本客户端**最多**能申请的 scope（申请超出即 invalid_scope，绝不静默降级） */
    @Column({ type: 'simple-json' })
    scopes: string[];

    /** 是否强制 PKCE（public 客户端一律强制，代码里再兜一层） */
    @Column({ default: true })
    requirePkce: boolean;

    /** 停用后所有端点一律 invalid_client（吊销一个应用不必删库） */
    @Column({ default: true })
    active: boolean;

    /** 是不是站点第一方应用（同意页文案用它区分「站内游戏」与「第三方应用」） */
    @Column({ default: false })
    firstParty: boolean;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
