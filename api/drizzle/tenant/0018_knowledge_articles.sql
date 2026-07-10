-- Manual Q&A / article editor (roadmap #17). Adds the `article` knowledge
-- source type and denormalised taxonomy columns (categories/tags) on
-- knowledge_sources so authored articles can be listed and filtered without
-- unpacking the jsonb config on every read. The article body itself lives in
-- `config` (rendered Markdown) and flows through the existing chunking +
-- embedding pipeline like any other source.

-- Extend the source-type CHECK to allow 'article'. The original constraint from
-- 0002 was declared inline, so Postgres named it knowledge_sources_type_check.
ALTER TABLE knowledge_sources
  DROP CONSTRAINT IF EXISTS knowledge_sources_type_check;
ALTER TABLE knowledge_sources
  ADD CONSTRAINT knowledge_sources_type_check
  CHECK (type IN ('manual','upload','csv','website','article'));

-- Denormalised taxonomy for fast listing/filtering of articles. Kept in sync
-- from config by ArticlesService on create/update; empty for non-article rows.
ALTER TABLE knowledge_sources
  ADD COLUMN IF NOT EXISTS categories text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS knowledge_sources_categories_idx
  ON knowledge_sources USING gin (categories);
CREATE INDEX IF NOT EXISTS knowledge_sources_tags_idx
  ON knowledge_sources USING gin (tags);
