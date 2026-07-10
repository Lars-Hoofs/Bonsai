-- Per-document enable/disable (#21). An editor can toggle an individual
-- knowledge document off; disabled documents (and their chunks) are excluded
-- from retrieval without being deleted. Defaults to enabled so existing
-- documents keep their current (retrievable) behavior.
ALTER TABLE documents
  ADD COLUMN enabled boolean NOT NULL DEFAULT true;

-- Retrieval joins chunks -> documents and filters on this flag; a partial
-- index on the disabled rows keeps the common "enabled" scan cheap.
CREATE INDEX documents_enabled_idx ON documents (enabled) WHERE enabled = false;
