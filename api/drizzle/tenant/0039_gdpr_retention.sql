-- GDPR data-retention window (#47). Per-project retention in days: any
-- conversation (and its cascaded messages / citations / handovers /
-- feedback) whose activity is older than this many days becomes eligible
-- for the retention auto-purge. NULL (the default) means "keep forever" —
-- existing projects are unaffected and never purged until an admin sets a
-- window, so this is a purely additive, opt-in change.
ALTER TABLE projects
  ADD COLUMN retention_days integer;
ALTER TABLE projects
  ADD CONSTRAINT projects_retention_days_positive
  CHECK (retention_days IS NULL OR retention_days > 0);

-- The purge scan selects conversations by (project_id, last-activity) and
-- deletes the stale ones; this partial-free composite index keeps that scan
-- from a full table scan on large conversation tables. `updated_at` is
-- bumped on every message/status change, so it is the conversation's
-- last-activity timestamp.
CREATE INDEX IF NOT EXISTS conversations_project_updated_idx
  ON conversations (project_id, updated_at);
