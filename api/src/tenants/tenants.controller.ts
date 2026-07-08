import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../auth/auth.types';
import type { AuthUser } from '../auth/auth.types';
import { RequireRole } from '../auth/roles.decorator';
import { AddMemberDto, CreateTenantDto } from './dto';
import { TenantsService } from './tenants.service';

@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Post()
  create(@Body() dto: CreateTenantDto, @CurrentUser() user: AuthUser) {
    return this.tenantsService.create(dto, user.id);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.tenantsService.listForUser(user.id);
  }

  @Post(':tenantId/members')
  @RequireRole('admin')
  async addMember(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() dto: AddMemberDto,
    @CurrentUser() user: AuthUser,
  ): Promise<{ ok: true }> {
    await this.tenantsService.addMemberByEmail(
      tenantId,
      dto.email,
      dto.role,
      user.id,
    );
    return { ok: true };
  }
}
