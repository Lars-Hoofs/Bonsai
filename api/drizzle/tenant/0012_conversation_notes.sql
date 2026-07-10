-- Internal (agent-only) conversation notes (#34): private annotations agents
-- and admins can leave on a conversation for each other, never surfaced to
-- the visitor/widget. Deliberately its own table (not on `conversations` or
-- `messages`) so there is no shared code path with the visitor-facing
-- message list/history endpoints to accidentally leak a note through.
CREATE TABLE conversation_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  author_user_id uuid NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX conversation_notes_conversation_idx ON conversation_notes (conversation_id);
