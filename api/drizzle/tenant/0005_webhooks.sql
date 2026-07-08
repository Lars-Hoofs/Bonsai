CREATE TABLE webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  url text NOT NULL,
  events text[] NOT NULL DEFAULT '{}',
  secret text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhooks_project_idx ON webhooks (project_id);
