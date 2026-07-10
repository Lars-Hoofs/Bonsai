-- A/B testing of prompts/thresholds via the eval runner (feature #30). A
-- project defines an experiment with 2+ variants (each a candidate system
-- prompt and/or retrieval confidence threshold), then runs the project's
-- existing eval_cases against every variant to produce comparative scores.
-- No schema qualifiers on tenant tables (search_path selects the tenant
-- schema).

CREATE TABLE eval_experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX eval_experiments_project_idx ON eval_experiments (project_id);

CREATE TABLE eval_experiment_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL
    REFERENCES eval_experiments (id) ON DELETE CASCADE,
  name text NOT NULL,
  -- NULL = use the built-in answering system prompt (behaves like /answer).
  system_prompt text,
  -- NULL = use the project's configured confidenceThreshold. Otherwise a
  -- value in [0, 1] overriding the retrieval gate for this variant only.
  confidence_threshold double precision,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT eval_experiment_variants_threshold_range
    CHECK (confidence_threshold IS NULL
           OR (confidence_threshold >= 0 AND confidence_threshold <= 1))
);
CREATE INDEX eval_experiment_variants_experiment_idx
  ON eval_experiment_variants (experiment_id);

-- One row per experiment run (a single execution of the eval set against
-- every variant). `results` holds the per-variant comparative scores as a
-- JSON array so the best variant can be chosen; `total` is the shared case
-- count, `best_variant_id` the highest-scoring variant at run time.
CREATE TABLE eval_experiment_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL
    REFERENCES eval_experiments (id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  total int NOT NULL,
  best_variant_id uuid,
  results jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX eval_experiment_runs_experiment_idx
  ON eval_experiment_runs (experiment_id);
