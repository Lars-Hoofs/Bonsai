import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { ProjectSettingsController } from './project-settings.controller';
import { ProjectSettingsService } from './project-settings.service';

@Module({
  imports: [TenancyModule],
  controllers: [ProjectsController, ProjectSettingsController],
  providers: [ProjectsService, ProjectSettingsService],
})
export class ProjectsModule {}
