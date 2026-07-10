-- Auto-close idle conversations + post-chat survey (#40).
--
-- Auto-close: a scheduled reaper (ConversationReaperService) closes
-- conversations that have been idle (no new message / update) beyond a
-- per-project configurable threshold. Closing sets status='closed', records
-- when (ended_at) and why (closed_reason). `closed_reason` is a plain nullable
-- text column so it can carry future close reasons too ('auto_idle' today,
-- 'agent' for a manual agent close); existing closed rows simply have NULL.
ALTER TABLE conversations
  ADD COLUMN closed_reason text;

-- Post-chat survey: when a conversation closes, the widget offers a short
-- end-of-chat survey (a 1-5 rating + optional free-text comment). One response
-- row per conversation, keyed by conversation_id, so a visitor re-submitting
-- (changes their mind before the widget unmounts) is a plain upsert rather
-- than an ever-growing history. This is deliberately SEPARATE from the CSAT
-- columns on `conversations` (#23): CSAT is an in-chat satisfaction rating a
-- visitor can leave at any time, whereas this is the end-of-chat survey shown
-- specifically once a conversation has closed.
CREATE TABLE post_chat_surveys (
  conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX post_chat_surveys_project_idx ON post_chat_surveys (project_id);
