-- One widget configuration per project, with a separate draft and published
-- theme so editing in the builder never affects the live widget until publish.
CREATE TABLE widget_configs (
  project_id uuid PRIMARY KEY,
  draft jsonb NOT NULL DEFAULT '{}',
  published jsonb,
  published_version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
