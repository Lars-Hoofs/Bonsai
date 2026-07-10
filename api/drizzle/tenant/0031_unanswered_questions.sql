-- "Did this answer your question?" inline feedback + unanswered-questions
-- capture (#32) and clustering -> KB gap suggestions (#41).
--
-- Every time the bot fails to answer a visitor's question we record the
-- question text here so editors can later see WHICH questions the KB can't
-- answer, cluster them, and turn the clusters into KB topics to add.
--
-- Two capture paths, both additive and non-blocking (a failure to record an
-- unanswered question never affects the answer returned to the visitor):
--   * 'refused'     — the bot answer was a low-confidence / refusal (the
--                     answer pipeline set refused = true). Captured
--                     automatically right after the bot answer is stored.
--   * 'visitor_no'  — the visitor explicitly told us "no, this didn't answer
--                     my question" via the inline yes/no signal on the answer.
--
-- Rows are keyed by the bot `message_id` (one unanswered record per bot
-- answer): the automatic 'refused' capture and a later explicit 'visitor_no'
-- for the same answer converge on the same row (upsert), so a single failed
-- answer is never double-counted. `question` is denormalized (copied from the
-- preceding visitor message) so clustering and the editor view never have to
-- walk the message history, and it survives even if the conversation is later
-- pruned.
CREATE TABLE unanswered_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  message_id uuid UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  question text NOT NULL,
  language text,
  confidence double precision,
  reason text NOT NULL CHECK (reason IN ('refused', 'visitor_no')),
  resolved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Editor views and clustering both scan unresolved questions for a project,
-- newest first; the partial-friendly composite index keeps that cheap.
CREATE INDEX unanswered_questions_project_idx
  ON unanswered_questions (project_id, resolved, created_at DESC);
