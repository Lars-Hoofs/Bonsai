-- Transfer conversation between agents (#39): records each reassignment of an
-- assigned conversation from one agent to another, with an optional note. The
-- transfer *itself* also updates conversations.assigned_agent_id (reusing the
-- #21 assignment column); this table is the immutable history of who moved a
-- conversation to whom, and why. from_agent_user_id is nullable because a
-- conversation may have been assigned by auto-assignment and never explicitly
-- transferred before (or been unassigned) — we still record the transfer.
CREATE TABLE conversation_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  from_agent_user_id uuid,
  to_agent_user_id uuid NOT NULL,
  transferred_by_user_id uuid NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversation_transfers_conversation_idx
  ON conversation_transfers (conversation_id, created_at);
