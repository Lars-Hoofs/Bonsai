import { Module } from '@nestjs/common';
import { AuditLogController } from './audit-log.controller';
import { AuditLogService } from './audit-log.service';

// Read-side companion to AuditModule (which owns writes via AuditService).
// Kept as a separate module/controller under `src/audit-log` so tenant
// admins can query & export `public.audit_log` without coupling the
// write-path AuditService to HTTP/query concerns.
@Module({
  controllers: [AuditLogController],
  providers: [AuditLogService],
})
export class AuditLogModule {}
