-- Per-project evaluation test sets + regression eval runs (A3). No schema
-- qualifiers on tenant tables (search_path selects the tenant schema).

CREATE TABLE eval_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  question text NOT NULL,
  expect_refusal boolean NOT NULL DEFAULT false,
  expected_source_ids uuid[] NOT NULL DEFAULT '{}',
  expected_substrings text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX eval_cases_project_idx ON eval_cases (project_id);

CREATE TABLE eval_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  total int NOT NULL,
  passed int NOT NULL,
  results jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX eval_runs_project_idx ON eval_runs (project_id);
