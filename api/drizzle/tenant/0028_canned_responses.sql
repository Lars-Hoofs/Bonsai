-- Per-project canned responses / macros for human agents (#35): a reusable
-- library of pre-written reply snippets an agent can insert when replying in
-- a conversation from the agent console. Each response has a short human
-- `title`, a free-text `body`, and an optional set of `variables` — named
-- placeholders (e.g. {{customer_name}}) that the agent fills in at insert
-- time. This is DISTINCT from bot answer-templates (#28): those drive the
-- automated bot answer per intent; these are authored/used by humans.
CREATE TABLE canned_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  -- Declared placeholder variable names, e.g. ['customer_name','order_id'].
  -- Advisory: used to prompt the agent for values; substitution renders any
  -- {{name}} token present in `body`.
  variables text[] NOT NULL DEFAULT '{}',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX canned_responses_project_id_idx ON canned_responses (project_id);

-- Case-insensitive uniqueness per project: the same title (regardless of
-- case) can't be registered twice for a project.
CREATE UNIQUE INDEX canned_responses_project_id_lower_title_idx
  ON canned_responses (project_id, lower(title));
