import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../auth/public.decorator';
import { RateLimitGuard, rateLimitGuard } from '../usage/rate-limit.guard';
import { ResolvedWidgetKey } from '../apikeys/apikeys.service';
import { ConversationsService } from './conversations.service';
import { PublicWidgetGuard } from './public-widget.guard';
import { EscalateDto, PostMessageDto, StartConversationDto } from './dto';

interface WidgetKeyedRequest extends Request {
  widgetKey?: ResolvedWidgetKey;
}

// Per-project+IP: unbounded `start` calls create a conversation row (and, on
// the first message, LLM spend) each time, so this needs its own tighter cap
// independent of the general per-tenant/per-route limit used elsewhere.
const START_CONVERSATION_LIMIT_PER_MINUTE = 20;

function requireWidgetKey(req: WidgetKeyedRequest): ResolvedWidgetKey {
  // Invariant guard: PublicWidgetGuard always runs first and always sets
  // this, or throws. This is just to satisfy strict typing without `!`.
  if (!req.widgetKey) {
    throw new UnauthorizedException('Missing resolved widget key');
  }
  return req.widgetKey;
}

/**
 * Anonymous visitor-facing chat endpoints for the embedded widget. Gated by
 * `PublicWidgetGuard` (public_widget API key, origin-checked) instead of
 * OIDC + tenant membership, since anonymous website visitors have no OIDC
 * identity. The project (and tenant schema) come exclusively from the
 * resolved widget key — never from a client-supplied path/body param — and
 * per-conversation ownership is enforced by a per-conversation visitor
 * secret, issued once by `start` and required (header `x-bonsai-visitor-secret`)
 * on every subsequent call for that conversation.
 */
@Controller('widget/conversations')
@Public()
@UseGuards(PublicWidgetGuard)
export class ConversationsPublicController {
  constructor(private readonly conversations: ConversationsService) {}

  @Post()
  @UseGuards(rateLimitGuard(START_CONVERSATION_LIMIT_PER_MINUTE))
  async start(
    @Req() req: WidgetKeyedRequest,
    @Body() dto: StartConversationDto,
  ) {
    const { schemaName, projectId } = requireWidgetKey(req);
    return this.conversations.start(schemaName, projectId, dto);
  }

  @Post(':conversationId/messages')
  @UseGuards(RateLimitGuard)
  postMessage(
    @Req() req: WidgetKeyedRequest,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() dto: PostMessageDto,
    @Headers('x-bonsai-visitor-secret') visitorSecret: string | undefined,
  ) {
    const { tenantId, schemaName, projectId } = requireWidgetKey(req);
    if (!visitorSecret) {
      throw new UnauthorizedException('Missing visitor secret');
    }
    return this.conversations.postVisitorMessage(
      tenantId,
      schemaName,
      projectId,
      conversationId,
      dto.content,
      visitorSecret,
    );
  }

  @Post(':conversationId/escalate')
  async escalate(
    @Req() req: WidgetKeyedRequest,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() dto: EscalateDto,
    @Headers('x-bonsai-visitor-secret') visitorSecret: string | undefined,
  ): Promise<{ ok: true }> {
    const { schemaName, projectId } = requireWidgetKey(req);
    if (!visitorSecret) {
      throw new UnauthorizedException('Missing visitor secret');
    }
    await this.conversations.escalate(
      schemaName,
      projectId,
      conversationId,
      dto.reason ?? 'visitor_request',
      visitorSecret,
    );
    return { ok: true };
  }

  @Get(':conversationId')
  get(
    @Req() req: WidgetKeyedRequest,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Headers('x-bonsai-visitor-secret') visitorSecret: string | undefined,
  ) {
    const { schemaName, projectId } = requireWidgetKey(req);
    if (!visitorSecret) {
      throw new UnauthorizedException('Missing visitor secret');
    }
    return this.conversations.getWithMessagesForVisitor(
      schemaName,
      projectId,
      conversationId,
      visitorSecret,
    );
  }
}
