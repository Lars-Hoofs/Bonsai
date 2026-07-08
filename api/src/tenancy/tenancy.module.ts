import { Module } from '@nestjs/common';
import { TenantProvisioningService } from './tenant-provisioning.service';
import { TenantDbService } from './tenant-db.service';

@Module({
  providers: [TenantProvisioningService, TenantDbService],
  exports: [TenantProvisioningService, TenantDbService],
})
export class TenancyModule {}
