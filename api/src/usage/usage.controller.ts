import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
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
}
