-- Conversation tags + saved filters + search (#36): lets agents organize and
-- find conversations. Three additive per-tenant tables plus a maintained
-- full-text search vector on conversations so the list/search endpoint can
-- filter by tag, free text (over message content), status, assignee and date.
--
-- Search design: rather than re-aggregating every conversation's messages at
-- query time, each conversation carries a `search_tsv` tsvector that is kept
-- current by a trigger whenever a visitor/agent/bot message is inserted (the
-- `simple` regconfig is used deliberately — conversations can be multilingual
-- and we want raw-token matching without stemming surprises across languages).

-- Free-form tags an agent can attach to conversations. Name is unique
-- (case-insensitively) per project.
CREATE TABLE conversation_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  name text NOT NULL,
  color text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversation_tags_project_id_idx ON conversation_tags (project_id);
CREATE UNIQUE INDEX conversation_tags_project_id_lower_name_idx
  ON conversation_tags (project_id, lower(name));

-- Many-to-many: which tags are on which conversation.
CREATE TABLE conversation_tag_assignments (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES conversation_tags(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, tag_id)
);
CREATE INDEX conversation_tag_assignments_tag_id_idx
  ON conversation_tag_assignments (tag_id);

-- Named filter presets, scoped to the agent who created them.
CREATE TABLE conversation_saved_filters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  name text NOT NULL,
  filter jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversation_saved_filters_project_owner_idx
  ON conversation_saved_filters (project_id, owner_user_id);
CREATE UNIQUE INDEX conversation_saved_filters_owner_lower_name_idx
  ON conversation_saved_filters (project_id, owner_user_id, lower(name));

-- Full-text search vector over a conversation's message content.
ALTER TABLE conversations ADD COLUMN search_tsv tsvector;
CREATE INDEX conversations_search_tsv_idx ON conversations USING gin (search_tsv);

-- Keep search_tsv current as messages arrive. Appends the new message's
-- content to the conversation's existing vector (cheap, no re-aggregation).
CREATE OR REPLACE FUNCTION conversations_append_search_tsv() RETURNS trigger AS $$
BEGIN
  UPDATE conversations
    SET search_tsv = coalesce(search_tsv, ''::tsvector)
        || to_tsvector('simple', coalesce(NEW.content, ''))
    WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER messages_maintain_conversation_search_tsv
  AFTER INSERT ON messages
  FOR EACH ROW
  EXECUTE FUNCTION conversations_append_search_tsv();

-- Backfill existing conversations from their current messages.
UPDATE conversations c
  SET search_tsv = sub.tsv
  FROM (
    SELECT conversation_id,
           to_tsvector('simple', string_agg(coalesce(content, ''), ' ')) AS tsv
    FROM messages
    GROUP BY conversation_id
  ) sub
  WHERE sub.conversation_id = c.id;
