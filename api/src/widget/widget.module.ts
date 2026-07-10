import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { ApiKeysModule } from '../apikeys/apikeys.module';
import { WidgetController } from './widget.controller';
import { WidgetCopyController } from './widget-copy.controller';
import { WidgetPublicController } from './widget-public.controller';
import { WidgetService } from './widget.service';
import { WidgetCopyService } from './widget-copy.service';

@Module({
  imports: [TenancyModule, ApiKeysModule],
  controllers: [WidgetController, WidgetCopyController, WidgetPublicController],
  providers: [WidgetService, WidgetCopyService],
})
export class WidgetModule {}
