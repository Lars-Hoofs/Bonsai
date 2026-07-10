import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../auth/auth.types';
import type { AuthUser } from '../auth/auth.types';
import { RequireRole } from '../auth/roles.decorator';
import { AcceptInvitationDto, CreateInvitationDto } from './dto';
import { InvitationsService } from './invitations.service';

@Controller('tenants/:tenantId/invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post()
  @RequireRole('admin')
  create(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() dto: CreateInvitationDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.invitations.create(tenantId, dto.email, dto.role, user.id);
  }

  @Get()
  @RequireRole('admin')
  list(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.invitations.list(tenantId);
  }

  @Delete(':invitationId')
  @RequireRole('admin')
  async remove(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('invitationId', ParseUUIDPipe) invitationId: string,
  ): Promise<{ ok: true }> {
    await this.invitations.revoke(tenantId, invitationId);
    return { ok: true };
  }
}

/**
 * Deliberately NOT tenant-scoped in its route (no :tenantId param): the
 * accepting user is authenticated (goes through the global AuthGuard) but is
 * not yet a member of the target tenant, so this route must bypass
 * MembershipGuard's per-tenant check — which it does simply by not
 * declaring a :tenantId param (see MembershipGuard).
 */
@Controller('invitations')
export class InvitationsAcceptController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post('accept')
  accept(@Body() dto: AcceptInvitationDto, @CurrentUser() user: AuthUser) {
    return this.invitations.accept(dto.token, user.id);
  }
}
