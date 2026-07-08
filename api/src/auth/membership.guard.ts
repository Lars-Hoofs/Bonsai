import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '../db/schema';
import { AuthUser } from './auth.types';
import { MembershipsService } from './memberships.service';
import { REQUIRED_ROLE, ROLE_RANK } from './roles.decorator';

@Injectable()
export class MembershipGuard implements CanActivate {
  constructor(
    private readonly membershipsService: MembershipsService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{
      params: Record<string, string | undefined>;
      user: AuthUser;
      membership?: { role: Role };
      tenant?: { id: string; schemaName: string };
    }>();
    const tenantId = req.params.tenantId;
    if (!tenantId) return true;
    const membership = await this.membershipsService.find(
      tenantId,
      req.user.id,
    );
    if (!membership)
      throw new ForbiddenException('Not a member of this tenant');
    const required =
      this.reflector.getAllAndOverride<Role | undefined>(REQUIRED_ROLE, [
        ctx.getHandler(),
        ctx.getClass(),
      ]) ?? 'viewer';
    if (ROLE_RANK[membership.role] < ROLE_RANK[required]) {
      throw new ForbiddenException(`Requires role ${required}`);
    }
    req.membership = { role: membership.role };
    req.tenant = membership.tenant;
    return true;
  }
}
