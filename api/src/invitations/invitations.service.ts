import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { MembershipsService } from '../auth/memberships.service';
import { ROLE_RANK } from '../auth/roles.decorator';
import { DB } from '../db/db.module';
import type { Db } from '../db/db.module';
import { invitations } from '../db/schema';
import type { Role } from '../db/schema';
import { MailService } from '../mail/mail.service';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface InvitationView {
  id: string;
  tenantId: string;
  email: string;
  role: Exclude<Role, 'owner'>;
  acceptedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

export interface CreatedInvitation extends InvitationView {
  token: string;
}

@Injectable()
export class InvitationsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly membershipsService: MembershipsService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  async create(
    tenantId: string,
    email: string,
    role: Exclude<Role, 'owner'>,
    actorUserId: string,
  ): Promise<CreatedInvitation> {
    // Privilege-escalation guard (defence-in-depth beyond the DTO): an actor
    // may never invite someone at a role higher than their own.
    // MembershipGuard has already confirmed the actor is at least admin.
    const actor = await this.membershipsService.find(tenantId, actorUserId);
    if (!actor || ROLE_RANK[role] > ROLE_RANK[actor.role])
      throw new ForbiddenException('Cannot invite a role higher than your own');

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

    const row = await this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(invitations)
        .values({ tenantId, email, role, token, expiresAt })
        .returning();
      await this.audit.record(
        {
          tenantId,
          actorUserId,
          action: 'invitation.created',
          resource: `invitation:${inserted.id}`,
          metadata: { email, role },
        },
        tx,
      );
      return inserted;
    });

    const acceptUrl = `\${BASE_URL}/invite/accept?token=${token}`;
    await this.mail.send({
      to: email,
      subject: "You've been invited to join a Bonsai workspace",
      text: `You've been invited to join a workspace as ${role}. Accept your invitation: ${acceptUrl}`,
      html: `<p>You've been invited to join a workspace as <strong>${role}</strong>.</p><p><a href="${acceptUrl}">Accept your invitation</a></p>`,
    });

    return {
      id: row.id,
      tenantId: row.tenantId,
      email: row.email,
      role: row.role,
      acceptedAt: row.acceptedAt,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      token,
    };
  }

  async list(tenantId: string): Promise<InvitationView[]> {
    const rows = await this.db
      .select({
        id: invitations.id,
        tenantId: invitations.tenantId,
        email: invitations.email,
        role: invitations.role,
        acceptedAt: invitations.acceptedAt,
        expiresAt: invitations.expiresAt,
        createdAt: invitations.createdAt,
      })
      .from(invitations)
      .where(
        and(eq(invitations.tenantId, tenantId), isNull(invitations.acceptedAt)),
      );
    return rows.map((r) => ({ ...r, role: r.role }));
  }

  async revoke(tenantId: string, invitationId: string): Promise<void> {
    const [row] = await this.db
      .select({ id: invitations.id })
      .from(invitations)
      .where(
        and(
          eq(invitations.id, invitationId),
          eq(invitations.tenantId, tenantId),
        ),
      );
    if (!row) throw new NotFoundException('Invitation not found');
    await this.db.delete(invitations).where(eq(invitations.id, invitationId));
  }

  async accept(
    token: string,
    userId: string,
  ): Promise<{ tenantId: string; role: Exclude<Role, 'owner'> }> {
    const [invite] = await this.db
      .select()
      .from(invitations)
      .where(eq(invitations.token, token));
    if (!invite) throw new NotFoundException('Invalid invitation token');
    if (invite.acceptedAt)
      throw new BadRequestException('Invitation already accepted');
    if (invite.expiresAt.getTime() < Date.now())
      throw new BadRequestException('Invitation has expired');

    const role = invite.role;
    await this.db.transaction(async (tx) => {
      await this.membershipsService.add(invite.tenantId, userId, role, tx);
      await tx
        .update(invitations)
        .set({ acceptedAt: new Date() })
        .where(eq(invitations.id, invite.id));
      await this.audit.record(
        {
          tenantId: invite.tenantId,
          actorUserId: userId,
          action: 'invitation.accepted',
          resource: `invitation:${invite.id}`,
          metadata: { role },
        },
        tx,
      );
    });

    return { tenantId: invite.tenantId, role };
  }
}
