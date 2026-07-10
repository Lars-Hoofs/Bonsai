import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { RagModule } from '../rag/rag.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { ApiKeysModule } from '../apikeys/apikeys.module';
import { PresenceModule } from '../presence/presence.module';
import { NotificationsModule } from '../notifications/notifications.module';
import {
  AgentPresenceController,
  ConversationsController,
} from './conversations.controller';
import { ConversationsPublicController } from './conversations-public.controller';
import { ConversationsService } from './conversations.service';
import { ChatGateway } from './chat.gateway';
import { PublicWidgetGuard } from './public-widget.guard';

@Module({
  imports: [
    TenancyModule,
    RagModule,
    WebhooksModule,
    ApiKeysModule,
    PresenceModule,
    NotificationsModule,
  ],
  controllers: [
    ConversationsController,
    ConversationsPublicController,
    AgentPresenceController,
  ],
  providers: [ConversationsService, ChatGateway, PublicWidgetGuard],
})
export class ConversationsModule {}
