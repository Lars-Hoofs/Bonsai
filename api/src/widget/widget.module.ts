import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { ApiKeysModule } from '../apikeys/apikeys.module';
import { WidgetController } from './widget.controller';
import { WidgetPublicController } from './widget-public.controller';
import { WidgetService } from './widget.service';

@Module({
  imports: [TenancyModule, ApiKeysModule],
  controllers: [WidgetController, WidgetPublicController],
  providers: [WidgetService],
})
export class WidgetModule {}
