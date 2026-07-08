CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  schema_name text NOT NULL UNIQUE,
  plan text NOT NULL DEFAULT 'starter',
  data_region text NOT NULL DEFAULT 'eu',
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  oidc_subject text NOT NULL UNIQUE,
  email text NOT NULL,
  name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','admin','editor','agent','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  key_prefix text NOT NULL UNIQUE,
  key_hash text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('secret','public_widget')),
  scopes text[] NOT NULL DEFAULT '{}',
  allowed_origins text[] NOT NULL DEFAULT '{}',
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid,
  actor_user_id uuid,
  actor_api_key_id uuid,
  action text NOT NULL,
  resource text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
