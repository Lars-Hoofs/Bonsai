-- Answer templates / canned answers per intent (#28): editors define canned
-- answers keyed to a trigger — either a KEYWORD (matched as a whole word,
-- case-insensitively, against the incoming question) or an INTENT phrase
-- (matched when every whitespace-separated token of the trigger appears as a
-- whole word in the question). When an incoming question matches an active
-- template, the answer pipeline can short-circuit retrieval and return the
-- canned answer with proper attribution (see AnswerTemplatesService /
-- AnswerService). Entirely additive and config-gated (ANSWER_TEMPLATES_ENABLED):
-- when disabled, or when a project has no matching active template, the answer
-- pipeline behaves exactly as before.
CREATE TABLE answer_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  -- 'keyword': trigger is a single term matched as a whole word.
  -- 'intent':  trigger is a short phrase; matches when ALL of its tokens
  --            appear as whole words in the question (order-independent).
  trigger_type text NOT NULL DEFAULT 'keyword'
    CHECK (trigger_type IN ('keyword', 'intent')),
  trigger text NOT NULL,
  answer text NOT NULL,
  -- Optional human-readable attribution shown alongside the canned answer
  -- (e.g. 'Klantenservice FAQ'); surfaced as the citation's document title.
  attribution text,
  -- When true (default), a match SHORT-CIRCUITS retrieval entirely and the
  -- canned answer is returned as-is. When false, the template is inert for
  -- now (reserved for a future "seed retrieval" behavior) and never
  -- short-circuits — so retrieval runs normally.
  short_circuit boolean NOT NULL DEFAULT true,
  -- Inactive templates are never matched.
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX answer_templates_project_id_idx ON answer_templates (project_id);

-- Case-insensitive uniqueness per project+trigger_type: the same trigger
-- (regardless of case) can't be registered twice with the same type for a
-- project.
CREATE UNIQUE INDEX answer_templates_project_trigger_idx
  ON answer_templates (project_id, trigger_type, lower(trigger));
