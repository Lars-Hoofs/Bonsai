-- Per-source re-crawl schedule (roadmap #19). A source may opt into its own
-- recurring re-crawl interval; NULL means "no per-source schedule" — such a
-- source is left to the global scan cadence (website sources) or is never
-- auto-recrawled (non-website sources). Stored in milliseconds to match the
-- app-level RECRAWL_INTERVAL_MS / BullMQ `repeat.every` units.
ALTER TABLE knowledge_sources
  ADD COLUMN recrawl_interval_ms bigint
    CHECK (recrawl_interval_ms IS NULL OR recrawl_interval_ms > 0);

-- Partial index so the scheduled scan can cheaply find the sources that have
-- opted into a per-source schedule without walking every row.
CREATE INDEX knowledge_sources_recrawl_interval_idx
  ON knowledge_sources (recrawl_interval_ms)
  WHERE recrawl_interval_ms IS NOT NULL;
