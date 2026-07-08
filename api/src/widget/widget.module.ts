import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { WidgetController } from './widget.controller';
import { WidgetService } from './widget.service';

@Module({
  imports: [TenancyModule],
  controllers: [WidgetController],
  providers: [WidgetService],
})
export class WidgetModule {}
