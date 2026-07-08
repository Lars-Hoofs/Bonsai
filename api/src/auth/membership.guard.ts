import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '../db/schema';
import { AuthUser } from './auth.types';
import { MembershipsService } from './memberships.service';
import { IS_PUBLIC } from './public.decorator';
import { REQUIRED_ROLE, ROLE_RANK } from './roles.decorator';

@Injectable()
export class MembershipGuard implements CanActivate {
  constructor(
    private readonly membershipsService: MembershipsService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
        ctx.getHandler(),
        ctx.getClass(),
      ])
    )
      return true;
    const req = ctx.switchToHttp().getRequest<{
      params: Record<string, string | undefined>;
      user: AuthUser | undefined;
      membership?: { role: Role };
      tenant?: { id: string; schemaName: string };
    }>();
    const requiredRole = this.reflector.getAllAndOverride<Role | undefined>(
      REQUIRED_ROLE,
      [ctx.getHandler(), ctx.getClass()],
    );
    const tenantId = req.params.tenantId;
    if (!tenantId) {
      // Fail closed: a route that declares @RequireRole is tenant-scoped by
      // definition, so a missing :tenantId param is a misconfiguration, not a
      // free pass. Routes without @RequireRole (e.g. user-scoped /tenants) pass.
      if (requiredRole !== undefined) {
        throw new ForbiddenException(
          'Tenant-scoped route is missing a tenantId parameter',
        );
      }
      return true;
    }
    const user = req.user;
    if (!user) throw new UnauthorizedException('Missing authenticated user');
    const membership = await this.membershipsService.find(tenantId, user.id);
    if (!membership)
      throw new ForbiddenException('Not a member of this tenant');
    const required = requiredRole ?? 'viewer';
    if (ROLE_RANK[membership.role] < ROLE_RANK[required]) {
      throw new ForbiddenException(`Requires role ${required}`);
    }
    req.membership = { role: membership.role };
    req.tenant = membership.tenant;
    return true;
  }
}
