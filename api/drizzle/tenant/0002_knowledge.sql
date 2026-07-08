-- Knowledge base per project. No schema qualifiers on tenant tables
-- (search_path selects the tenant schema); the pgvector type/opclass are
-- referenced via the `shared` schema, which is present in the migrator path.

CREATE TABLE knowledge_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('manual','upload','csv','website')),
  name text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','processed','failed','stale')),
  error_detail text,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_sources_project_idx ON knowledge_sources (project_id);

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  title text NOT NULL,
  origin_url text,
  content_hash text NOT NULL,
  language text NOT NULL DEFAULT 'nl',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','processed','failed','stale')),
  error_detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_source_idx ON documents (source_id);
CREATE INDEX documents_project_idx ON documents (project_id);

CREATE TABLE chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  ordinal integer NOT NULL,
  text text NOT NULL,
  token_count integer NOT NULL DEFAULT 0,
  section text,
  metadata jsonb NOT NULL DEFAULT '{}',
  embedding shared.vector(1024),
  tsv tsvector,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chunks_document_idx ON chunks (document_id);
CREATE INDEX chunks_project_idx ON chunks (project_id);
CREATE INDEX chunks_tsv_idx ON chunks USING gin (tsv);
CREATE INDEX chunks_embedding_idx ON chunks
  USING hnsw (embedding shared.vector_cosine_ops);
