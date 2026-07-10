import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { MembershipsService } from '../auth/memberships.service';
import { TenantDbService } from '../tenancy/tenant-db.service';

export interface ConversationNote {
  id: string;
  conversationId: string;
  authorUserId: string;
  body: string;
  createdAt: string;
}

function mapRow(r: Record<string, unknown>): ConversationNote {
  return {
    id: r.id as string,
    conversationId: r.conversation_id as string,
    authorUserId: r.author_user_id as string,
    body: r.body as string,
    createdAt: String(r.created_at),
  };
}

/**
 * Internal (agent/admin-only) notes on a conversation (#34): private
 * annotations for the back-office side, never returned by any
 * visitor/widget-facing endpoint (`ConversationsPublicController` and
 * `ConversationsService`'s visitor-facing methods have no knowledge of this
 * table at all — isolation by omission, not by filtering).
 */
@Injectable()
export class ConversationNotesService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly audit: AuditService,
    private readonly memberships: MembershipsService,
  ) {}

  /**
   * Confirms `conversationId` actually belongs to `projectId` in this tenant
   * schema before any read/write, so a note can never be added to, listed
   * for, or deleted from a conversation outside the caller's project scope.
   */
  private async requireConversation(
    schemaName: string,
    projectId: string,
    conversationId: string,
  ): Promise<void> {
    const rows = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT id FROM conversations WHERE id = ${conversationId} AND project_id = ${projectId}`,
      );
      return r.rows;
    });
    if (!rows[0]) throw new NotFoundException('Conversation not found');
  }

  async add(
    tenantId: string,
    schemaName: string,
    projectId: string,
    conversationId: string,
    body: string,
    authorUserId: string,
  ): Promise<ConversationNote> {
    await this.requireConversation(schemaName, projectId, conversationId);
    const row = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(sql`
        INSERT INTO conversation_notes (conversation_id, author_user_id, body)
        VALUES (${conversationId}, ${authorUserId}, ${body})
        RETURNING *`);
      const inserted = r.rows[0];
      await this.audit.record(
        {
          tenantId,
          actorUserId: authorUserId,
          action: 'conversation.note_added',
          resource: `conversation:${conversationId}`,
          metadata: { noteId: (inserted as { id: string }).id },
        },
        db,
      );
      return inserted;
    });
    return mapRow(row);
  }

  async list(
    schemaName: string,
    projectId: string,
    conversationId: string,
  ): Promise<ConversationNote[]> {
    await this.requireConversation(schemaName, projectId, conversationId);
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT * FROM conversation_notes
            WHERE conversation_id = ${conversationId}
            ORDER BY created_at DESC`,
      );
      return r.rows.map(mapRow);
    });
  }

  /**
   * Deletes a note. Allowed for its author, or for any tenant admin+
   * (owner/admin) — anyone else (including another, non-admin agent) is
   * rejected with 403.
   */
  async remove(
    tenantId: string,
    schemaName: string,
    projectId: string,
    conversationId: string,
    noteId: string,
    actorUserId: string,
  ): Promise<void> {
    await this.requireConversation(schemaName, projectId, conversationId);
    const note = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT * FROM conversation_notes
            WHERE id = ${noteId} AND conversation_id = ${conversationId}`,
      );
      return r.rows[0];
    });
    if (!note) throw new NotFoundException('Note not found');
    const authorUserId = (note as { author_user_id: string }).author_user_id;

    if (authorUserId !== actorUserId) {
      const membership = await this.memberships.find(tenantId, actorUserId);
      const isAdmin =
        membership !== null &&
        (membership.role === 'admin' || membership.role === 'owner');
      if (!isAdmin) {
        throw new ForbiddenException(
          'Only the note author or an admin can delete this note',
        );
      }
    }

    await this.tenantDb.withTenant(schemaName, async (db) => {
      await db.execute(
        sql`DELETE FROM conversation_notes WHERE id = ${noteId}`,
      );
      await this.audit.record(
        {
          tenantId,
          actorUserId,
          action: 'conversation.note_deleted',
          resource: `conversation:${conversationId}`,
          metadata: { noteId },
        },
        db,
      );
    });
  }
}
