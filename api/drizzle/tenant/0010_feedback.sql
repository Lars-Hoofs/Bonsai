-- CSAT + per-answer feedback (#23): visitors rate a conversation
-- (satisfaction score + optional comment) and can thumbs-up/down individual
-- bot answers. Both are nullable/opt-in additions — existing conversations
-- and messages are unaffected until a visitor submits feedback.
ALTER TABLE conversations
  ADD COLUMN csat_score smallint,
  ADD COLUMN csat_comment text;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_csat_score_range
  CHECK (csat_score IS NULL OR (csat_score BETWEEN 1 AND 5));

-- One feedback row per message (thumbs-up/down), keyed by message_id so a
-- resubmission (visitor changes their mind) is a plain upsert rather than
-- an ever-growing history of ratings for the same answer.
CREATE TABLE message_feedback (
  message_id uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  rating text NOT NULL CHECK (rating IN ('up', 'down')),
  created_at timestamptz NOT NULL DEFAULT now()
);
