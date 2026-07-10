-- Profanity/abuse filter on visitor input (#31). Records every time the
-- self-hosted heuristic filter triggers on an inbound visitor message, along
-- with the policy action that was applied (warn/block/flag). Purely additive:
-- projects that never enable the filter (projects.settings.profanityFilter)
-- never produce rows here, so existing conversations are unaffected.
CREATE TABLE moderation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('warn','block','flag')),
  -- The (normalized) terms that matched, for auditing/tuning the wordlist.
  matched_terms text[] NOT NULL DEFAULT '{}',
  -- Snapshot of the offending message text at the time of detection. Stored
  -- so moderators can review context even if the message row is later
  -- removed; kept in the tenant schema like all other conversation data.
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX moderation_events_project_idx
  ON moderation_events (project_id, created_at DESC);
CREATE INDEX moderation_events_conversation_idx
  ON moderation_events (conversation_id);
