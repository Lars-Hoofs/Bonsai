import {
  Inject,
  Injectable,
  Logger,
  Module,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';
import { TenancyModule } from '../tenancy/tenancy.module';
import { GdprController } from './gdpr.controller';
import { GdprService } from './gdpr.service';

/**
 * In-process retention auto-purge reaper (#47). Mirrors the
 * ingestion-/conversation-reaper pattern: a plain `setInterval` timer (no
 * Redis dependency, so it runs in the base self-hosted deploy) that
 * periodically sweeps every active tenant/project and purges conversations
 * older than each project's configured retention window.
 *
 * The timer is `unref()`d so it never keeps the process alive on its own, and
 * disabled entirely under NODE_ENV=test so it can't fire mid-suite — tests
 * drive `GdprService.purgeExpired()` directly and deterministically.
 */
@Injectable()
export class RetentionReaper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionReaper.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly gdpr: GdprService,
    @Optional() @Inject(APP_CONFIG) private readonly cfg?: AppConfig,
  ) {}

  onModuleInit(): void {
    if (!this.cfg || this.cfg.nodeEnv === 'test') return;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.cfg.retentionPurgeIntervalMs);
    // Don't hold the event loop open for the purge timer alone.
    this.timer.unref();
  }

  /** One purge sweep; errors are swallowed (logged) so the timer survives. */
  async runOnce(): Promise<void> {
    try {
      const results = await this.gdpr.purgeExpired();
      const total = results.reduce((n, r) => n + r.conversationsDeleted, 0);
      if (total > 0) {
        this.logger.log(
          `Retention purge removed ${total} conversations across ${results.length} project(s)`,
        );
      }
    } catch (e) {
      this.logger.warn(`Retention purge sweep failed: ${(e as Error).message}`);
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

@Module({
  imports: [TenancyModule],
  controllers: [GdprController],
  providers: [GdprService, RetentionReaper],
  exports: [GdprService],
})
export class GdprModule {}
