import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ChatAttachment } from '../../infrastructure/database/entities/chat-attachment.entity';
import { ChatMessage } from '../../infrastructure/database/entities/chat-message.entity';
import { ChatThread } from '../../infrastructure/database/entities/chat-thread.entity';
import { Identity } from '../../infrastructure/database/entities/identity.entity';
import { IdentityModule } from '../identity/identity.module';

import { ChatController } from './chat.controller';
import { ChatEventsService } from './chat-events.service';
import { ChatService } from './chat.service';
import { ChatUploadInterceptor } from './chat-upload.interceptor';

/**
 * 站内私线（2026-10-27）：/api/chat/*
 *
 * 依赖 IdentityModule 提供的 IdentityService / SessionAuthGuard：
 *   · IdentityService.isOwnerIdentity 判「站主」
 *   · identity.role === subadmin 判「受邀朋友」
 * 三张表（threads / messages / attachments）由 autoLoadEntities + synchronize 自动建。
 */
@Module({
    imports: [
        TypeOrmModule.forFeature([ChatThread, ChatMessage, ChatAttachment, Identity]),
        IdentityModule,
    ],
    controllers: [ChatController],
    providers: [ChatService, ChatEventsService, ChatUploadInterceptor],
    exports: [ChatService, ChatEventsService],
})
export class ChatModule {}
