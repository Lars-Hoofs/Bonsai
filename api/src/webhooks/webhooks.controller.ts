import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Tenant } from '../auth/auth.types';
import type { TenantRef } from '../auth/auth.types';
import { RequireRole } from '../auth/roles.decorator';
import { RateLimitGuard } from '../usage/rate-limit.guard';
import { CreateWebhookDto } from './dto';
import { WebhooksService } from './webhooks.service';

@Controller('tenants/:tenantId/projects/:projectId/webhooks')
@RequireRole('admin')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post()
  @UseGuards(RateLimitGuard)
  create(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateWebhookDto,
  ) {
    return this.webhooks.register(tenant.schemaName, projectId, dto);
  }

  @Get()
  list(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.webhooks.list(tenant.schemaName, projectId);
  }

  @Delete(':webhookId')
  async remove(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('webhookId', ParseUUIDPipe) webhookId: string,
  ): Promise<{ ok: true }> {
    await this.webhooks.remove(tenant.schemaName, projectId, webhookId);
    return { ok: true };
  }
}
