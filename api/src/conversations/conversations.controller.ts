import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser, Tenant } from '../auth/auth.types';
import type { AuthUser, TenantRef } from '../auth/auth.types';
import { RequireRole } from '../auth/roles.decorator';
import { RateLimitGuard } from '../usage/rate-limit.guard';
import { ConversationsService } from './conversations.service';
import {
  AgentMessageDto,
  EscalateDto,
  PostMessageDto,
  StartConversationDto,
} from './dto';

@Controller('tenants/:tenantId/projects/:projectId/conversations')
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Post()
  @RequireRole('viewer')
  start(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: StartConversationDto,
  ) {
    return this.conversations.start(tenant.schemaName, projectId, dto);
  }

  @Post(':conversationId/messages')
  @RequireRole('viewer')
  @UseGuards(RateLimitGuard)
  postMessage(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() dto: PostMessageDto,
  ) {
    return this.conversations.postVisitorMessage(
      tenant.id,
      tenant.schemaName,
      projectId,
      conversationId,
      dto.content,
    );
  }

  @Post(':conversationId/escalate')
  @RequireRole('viewer')
  async escalate(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() dto: EscalateDto,
  ): Promise<{ ok: true }> {
    await this.conversations.escalate(
      tenant.schemaName,
      projectId,
      conversationId,
      dto.reason ?? 'visitor_request',
    );
    return { ok: true };
  }

  @Get()
  @RequireRole('agent')
  inbox(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query('status') status = 'handover',
  ) {
    return this.conversations.listInbox(tenant.schemaName, projectId, status);
  }

  @Get(':conversationId')
  @RequireRole('agent')
  get(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
  ) {
    return this.conversations.getWithMessages(
      tenant.schemaName,
      projectId,
      conversationId,
    );
  }

  @Post(':conversationId/agent-messages')
  @RequireRole('agent')
  async agentMessage(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() dto: AgentMessageDto,
    @CurrentUser() user: AuthUser,
  ): Promise<{ ok: true }> {
    await this.conversations.agentMessage(
      tenant.schemaName,
      projectId,
      conversationId,
      user.id,
      dto.content,
    );
    return { ok: true };
  }

  @Post(':conversationId/return-to-bot')
  @RequireRole('agent')
  async returnToBot(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
  ): Promise<{ ok: true }> {
    await this.conversations.returnToBot(
      tenant.schemaName,
      projectId,
      conversationId,
    );
    return { ok: true };
  }
}
