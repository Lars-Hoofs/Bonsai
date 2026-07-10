-- Tenant-owned API connectors: management/storage layer for "live
-- tool-calling" (the bot calling tenant-owned APIs). This migration only
-- adds storage + encrypted credentials; the actual outbound calling logic
-- (part 2) is a separate, later change. No schema qualifiers on tenant
-- tables (search_path selects the tenant schema).

CREATE TABLE api_connectors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  base_url text NOT NULL,
  method text NOT NULL DEFAULT 'GET',
  -- Encrypted credentials blob (AES-256-GCM via EncryptionService), e.g. a
  -- JSON-stringified { type: 'bearer', token } or { type: 'header', name,
  -- value }. NULL when the connector needs no auth. Never returned by any
  -- API response — see ConnectorsService.
  auth_encrypted text,
  request_schema jsonb NOT NULL DEFAULT '{}',
  response_template text,
  usage_hint text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_connectors_project_idx ON api_connectors (project_id);
