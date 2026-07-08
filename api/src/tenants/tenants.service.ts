import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { MembershipsService } from '../auth/memberships.service';
import { ROLE_RANK } from '../auth/roles.decorator';
import { DB } from '../db/db.module';
import type { Db } from '../db/db.module';
import { memberships, tenants, users } from '../db/schema';
import type { Role } from '../db/schema';
import { TenantProvisioningService } from '../tenancy/tenant-provisioning.service';

@Injectable()
export class TenantsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly provisioning: TenantProvisioningService,
    private readonly membershipsService: MembershipsService,
    private readonly audit: AuditService,
  ) {}

  async create(
    input: { name: string; slug: string },
    actorUserId: string,
  ): Promise<{ id: string; name: string; slug: string }> {
    const t = await this.provisioning.createTenant(input);
    await this.membershipsService.add(t.id, actorUserId, 'owner');
    await this.audit.record({
      tenantId: t.id,
      actorUserId,
      action: 'tenant.created',
      resource: `tenant:${t.id}`,
      metadata: { slug: t.slug },
    });
    return { id: t.id, name: input.name, slug: t.slug };
  }

  async listForUser(
    userId: string,
  ): Promise<Array<{ id: string; name: string; slug: string; role: Role }>> {
    return this.db
      .select({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        role: memberships.role,
      })
      .from(memberships)
      .innerJoin(tenants, eq(memberships.tenantId, tenants.id))
      .where(eq(memberships.userId, userId));
  }

  async addMemberByEmail(
    tenantId: string,
    email: string,
    role: Role,
    actorUserId: string,
  ): Promise<void> {
    // Privilege-escalation guard (defence-in-depth beyond the DTO): an actor
    // may never grant a role higher than their own. MembershipGuard has
    // already confirmed the actor is at least admin for this tenant.
    const actor = await this.membershipsService.find(tenantId, actorUserId);
    if (!actor || ROLE_RANK[role] > ROLE_RANK[actor.role])
      throw new ForbiddenException(
        'Cannot grant a role higher than your own',
      );
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email));
    if (!user)
      throw new NotFoundException(
        `No user with email ${email} — they must log in once first`,
      );
    await this.membershipsService.add(tenantId, user.id, role);
    await this.audit.record({
      tenantId,
      actorUserId,
      action: 'member.added',
      resource: `user:${user.id}`,
      metadata: { role },
    });
  }
}
