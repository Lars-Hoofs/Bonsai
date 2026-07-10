import type { AuditLogRow } from './audit-log.service';

const HEADER = [
  'id',
  'action',
  'resource',
  'actor_user_id',
  'actor_api_key_id',
  'metadata',
  'created_at',
];

// Escapes a single CSV field per RFC 4180: wraps in quotes and doubles any
// embedded quote whenever the value contains a quote, comma, or newline.
function escapeCsvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function auditLogRowsToCsv(rows: AuditLogRow[]): string {
  const lines = [HEADER.join(',')];
  for (const row of rows) {
    lines.push(
      [
        String(row.id),
        row.action,
        row.resource,
        row.actorUserId ?? '',
        row.actorApiKeyId ?? '',
        JSON.stringify(row.metadata ?? {}),
        row.createdAt.toISOString(),
      ]
        .map(escapeCsvField)
        .join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}
