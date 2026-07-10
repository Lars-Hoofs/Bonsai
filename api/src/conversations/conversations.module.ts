import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { RagModule } from '../rag/rag.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { ApiKeysModule } from '../apikeys/apikeys.module';
import { PresenceModule } from '../presence/presence.module';
import { ModerationModule } from '../moderation/moderation.module';
import { NotificationsModule } from '../notifications/notifications.module';
import {
  AgentPresenceController,
  ConversationsController,
} from './conversations.controller';
import { ConversationsPublicController } from './conversations-public.controller';
import { ConversationsService } from './conversations.service';
import { ConversationSearchController } from './conversation-search.controller';
import { ConversationSearchService } from './conversation-search.service';
import { ChatGateway } from './chat.gateway';
import { PublicWidgetGuard } from './public-widget.guard';

@Module({
  imports: [
    TenancyModule,
    RagModule,
    WebhooksModule,
    ApiKeysModule,
    PresenceModule,
    ModerationModule,
    NotificationsModule,
  ],
  // ConversationSearchController is registered before ConversationsController
  // so its static sub-routes (tags, saved-filters, search) win over the
  // latter's `:conversationId` param route under the same base path.
  controllers: [
    ConversationSearchController,
    ConversationsController,
    ConversationsPublicController,
    AgentPresenceController,
  ],
  providers: [
    ConversationsService,
    ConversationSearchService,
    ChatGateway,
    PublicWidgetGuard,
  ],
})
export class ConversationsModule {}
