import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { ConversationNotesController } from './conversation-notes.controller';
import { ConversationNotesService } from './conversation-notes.service';

/**
 * Internal (agent-only) conversation notes (#34), kept as its own module
 * (rather than folded into `ConversationsModule`) so it can be registered as
 * the last import in `AppModule` with a single additive line.
 */
@Module({
  imports: [TenancyModule, AuthModule],
  controllers: [ConversationNotesController],
  providers: [ConversationNotesService],
})
export class ConversationNotesModule {}
