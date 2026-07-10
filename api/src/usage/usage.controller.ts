import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { RequireRole } from '../auth/roles.decorator';
import { UsageService } from './usage.service';

@Controller('tenants/:tenantId/usage')
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Get()
  @RequireRole('admin')
  current(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.usage.current(tenantId);
  }

  /**
   * Cost/usage analytics (#43): per-month answer counts + a rough cost
   * estimate for the current + last N months. Viewer-gated (read-only,
   * lower bar than the raw quota-check endpoint above).
   */
  @Get('summary')
  @RequireRole('viewer')
  summary(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Query('months') months?: string,
  ) {
    const parsed = months === undefined ? undefined : Number(months);
    const n =
      parsed !== undefined && Number.isInteger(parsed) && parsed > 0
        ? Math.min(parsed, 24)
        : undefined;
    return this.usage.summary(tenantId, n);
  }
}
