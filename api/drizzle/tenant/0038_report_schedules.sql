-- Scheduled report generation (#45): per-project config for automatically
-- generating an analytics/usage report on a cadence (weekly, etc.) and
-- delivering it by email (via the self-hosted MailModule) and/or storing it
-- via StorageModule/MinIO. On-demand export (CSV/JSON) needs no table — it is
-- computed and streamed per request. This table only backs the *scheduled*
-- side: the in-process runner (ReportsRunnerService) walks active tenants,
-- finds schedules whose next_run_at is due, generates the report and delivers
-- it, then advances next_run_at by the cadence.
CREATE TABLE report_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  -- 'daily' | 'weekly' | 'monthly' — see report-schedule.ts (single source of
  -- truth for the cadence set and the next-run arithmetic).
  cadence text NOT NULL,
  -- 'csv' | 'json' — serialization format of the generated report.
  format text NOT NULL,
  -- Delivery channels. At least one must be true (enforced at the API layer,
  -- the DB just stores the flags). Email uses MailModule; storage uses
  -- StorageModule/MinIO. Either can be a no-op if unconfigured for the deploy.
  deliver_email boolean NOT NULL DEFAULT false,
  deliver_storage boolean NOT NULL DEFAULT false,
  -- Email recipients (only meaningful when deliver_email is true).
  recipients text[] NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  -- When the runner last successfully generated+delivered this schedule.
  last_run_at timestamptz,
  -- When the schedule is next due. Seeded at creation to now() so the first
  -- run happens on the next runner tick, then advanced by the cadence.
  next_run_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX report_schedules_project_id_idx ON report_schedules (project_id);

-- The runner scans for due, enabled schedules across a tenant; index the
-- predicate columns so that scan stays cheap as schedules accumulate.
CREATE INDEX report_schedules_due_idx
  ON report_schedules (enabled, next_run_at);
