-- Per-project synonyms/alias dictionary (#23): boosts LEXICAL (FTS) retrieval
-- recall by mapping a term to one or more aliases, e.g. 'retour' ->
-- ['terugsturen', 'retourneren'], so a query containing the term also
-- matches documents that only contain an alias. Vector retrieval is
-- unaffected — only the FTS query text is expanded, at query time, in
-- RetrievalService.
CREATE TABLE synonyms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  term text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX synonyms_project_id_idx ON synonyms (project_id);

-- Case-insensitive uniqueness per project: the same term (regardless of
-- case) can't be registered twice for a project.
CREATE UNIQUE INDEX synonyms_project_id_lower_term_idx
  ON synonyms (project_id, lower(term));
