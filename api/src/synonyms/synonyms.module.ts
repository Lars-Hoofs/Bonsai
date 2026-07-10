import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { SynonymsController } from './synonyms.controller';
import { SynonymsService } from './synonyms.service';

@Module({
  imports: [TenancyModule],
  controllers: [SynonymsController],
  providers: [SynonymsService],
  exports: [SynonymsService],
})
export class SynonymsModule {}
