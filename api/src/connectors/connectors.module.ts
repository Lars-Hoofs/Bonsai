import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { ConnectorsController } from './connectors.controller';
import { ConnectorsService } from './connectors.service';

@Module({
  imports: [TenancyModule, CommonModule],
  controllers: [ConnectorsController],
  providers: [ConnectorsService],
  exports: [ConnectorsService],
})
export class ConnectorsModule {}
