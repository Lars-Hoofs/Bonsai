import { createHash, timingSafeEqual } from 'node:crypto';
import { OnEvent } from '@nestjs/event-emitter';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { sql } from 'drizzle-orm';
import { Server, Socket } from 'socket.io';
import { ApiKeysService } from '../apikeys/apikeys.service';
import { TenantDbService } from '../tenancy/tenant-db.service';

export interface ChatMessageEvent {
  conversationId: string;
  role: string;
  content: string;
}

export const CHAT_MESSAGE_EVENT = 'chat.message';

interface JoinPayload {
  conversationId: string;
  visitorSecret: string;
  key: string;
}

type JoinResult = { ok: true } | { error: string };

// `@WebSocketGateway`'s cors option is a static decorator literal evaluated
// at class-definition time, before Nest's DI container exists — so it can't
// read `AppConfig` (which is only available via constructor injection). We
// read the allowlist directly from process.env here instead, matching the
// same `WIDGET_CORS_ORIGINS` env var `loadConfig` parses elsewhere. Per this
// task's design, this is only a coarse bound on which browser origins may
// open a socket at all; the REAL security boundary is the `join` handler
// below (widget key + per-conversation visitor secret), enforced regardless
// of which allowed origin the socket connected from.
const WIDGET_CORS_ORIGINS = (process.env.WIDGET_CORS_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

/**
 * Real-time delivery for live handover / streaming chat. Clients connect to
 * the `/chat` namespace and `join` a conversation room; every persisted
 * message (visitor, bot, agent, system) is broadcast to that room.
 *
 * Security: the `join` handler requires `{ conversationId, visitorSecret,
 * key }`. It resolves the client-supplied public_widget `key` (exactly like
 * the REST path, via `ApiKeysService.resolveWidgetKey`, origin-checked
 * against the handshake's Origin header) to get a server-resolved tenant
 * schema, then verifies the conversation's `visitor_secret` column matches
 * the supplied `visitorSecret` for that conversation, and ONLY THEN joins
 * the room. Any failure returns `{ error }` (a WS ack, not an HTTP
 * response/thrown exception) and never joins the socket to the room.
 */
@WebSocketGateway({ namespace: 'chat', cors: { origin: WIDGET_CORS_ORIGINS } })
export class ChatGateway {
  @WebSocketServer() server!: Server;

  constructor(
    private readonly apiKeys: ApiKeysService,
    private readonly tenantDb: TenantDbService,
  ) {}

  @SubscribeMessage('join')
  async join(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: JoinPayload,
  ): Promise<JoinResult> {
    if (!data?.conversationId || !data.visitorSecret || !data.key) {
      return { error: 'unauthorized' };
    }
    const origin = client.handshake.headers.origin;
    const resolved = await this.apiKeys.resolveWidgetKey(data.key, origin);
    if (!resolved) {
      return { error: 'unauthorized' };
    }
    const owned = await this.verifyOwnership(
      resolved.schemaName,
      resolved.projectId,
      data.conversationId,
      data.visitorSecret,
    );
    if (!owned) {
      return { error: 'unauthorized' };
    }
    await client.join(`conv:${data.conversationId}`);
    return { ok: true };
  }

  private async verifyOwnership(
    schemaName: string,
    projectId: string,
    conversationId: string,
    visitorSecret: string,
  ): Promise<boolean> {
    const row = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT visitor_secret FROM conversations WHERE id=${conversationId} AND project_id=${projectId}`,
      );
      return r.rows[0] as { visitor_secret: string } | undefined;
    });
    if (!row?.visitor_secret) return false;
    return secretsMatch(visitorSecret, row.visitor_secret);
  }

  @OnEvent(CHAT_MESSAGE_EVENT)
  broadcast(event: ChatMessageEvent): void {
    this.server?.to(`conv:${event.conversationId}`).emit('message', event);
  }
}

/**
 * Constant-time comparison of two secrets. Both sides are first hashed to a
 * fixed-length digest so `timingSafeEqual` never throws on a length
 * mismatch, and a plain `===` is never used for secret comparison. A local
 * re-implementation of the same helper in ConversationsService, to avoid
 * exporting a private cross-module dependency just for this.
 */
function secretsMatch(a: string, b: string): boolean {
  const ah = createHash('sha256').update(a).digest();
  const bh = createHash('sha256').update(b).digest();
  return timingSafeEqual(ah, bh);
}
