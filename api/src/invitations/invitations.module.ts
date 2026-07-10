import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import {
  InvitationsAcceptController,
  InvitationsController,
} from './invitations.controller';
import { InvitationsService } from './invitations.service';

@Module({
  imports: [AuthModule],
  controllers: [InvitationsController, InvitationsAcceptController],
  providers: [InvitationsService],
})
export class InvitationsModule {}
