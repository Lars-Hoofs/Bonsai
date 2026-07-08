-- Per-tenant monthly answer quota (cost cap) and usage metering.
ALTER TABLE tenants
  ADD COLUMN monthly_answer_quota integer NOT NULL DEFAULT 1000;

CREATE TABLE usage_records (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period text NOT NULL,   -- 'YYYY-MM' (UTC)
  metric text NOT NULL,   -- e.g. 'answers'
  value bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, period, metric)
);
