import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentUser, Tenant } from '../auth/auth.types';
import type { AuthUser, TenantRef } from '../auth/auth.types';
import { RequireRole } from '../auth/roles.decorator';
import { ApiKeysService } from './apikeys.service';
import { CreateApiKeyDto } from './dto';

@Controller('tenants/:tenantId/api-keys')
@RequireRole('admin')
export class ApiKeysController {
  constructor(private readonly apiKeysService: ApiKeysService) {}

  @Post()
  issue(
    @Tenant() tenant: TenantRef,
    @Body() dto: CreateApiKeyDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.apiKeysService.issue(tenant.id, dto, user.id);
  }

  @Get()
  list(@Tenant() tenant: TenantRef) {
    return this.apiKeysService.list(tenant.id);
  }

  @Delete(':keyId')
  async revoke(
    @Tenant() tenant: TenantRef,
    @Param('keyId', ParseUUIDPipe) keyId: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.apiKeysService.revoke(tenant.id, keyId, user.id);
    return { ok: true };
  }
}
