-- Status workflow (open/pending/resolved) + SLA timers (#37).
--
-- This is the agent-facing *workflow* lifecycle, distinct from the existing
-- `status` column (bot/handover/closed) which tracks who is driving the
-- conversation. `workflow_status` tracks where the ticket sits in an agent's
-- queue: `open` (needs work), `pending` (waiting on the visitor / a third
-- party), `resolved` (done). Defaults to `open` so existing conversations
-- slot straight into the queue.
ALTER TABLE conversations
  ADD COLUMN workflow_status text NOT NULL DEFAULT 'open'
    CHECK (workflow_status IN ('open', 'pending', 'resolved'));

-- SLA timers. Deadlines are stamped at conversation start from the project's
-- configured SLA policy (project settings jsonb); they are nullable so a
-- project with no SLA policy simply never has deadlines (and thus never
-- breaches). `first_responded_at` / `resolved_at` record when each milestone
-- was actually hit; breach is derived at read-time by comparing the relevant
-- deadline against the milestone time (or `now()` if not yet hit).
ALTER TABLE conversations
  ADD COLUMN first_response_due_at timestamptz,
  ADD COLUMN resolution_due_at timestamptz,
  ADD COLUMN first_responded_at timestamptz,
  ADD COLUMN resolved_at timestamptz;

-- Partition the inbox by workflow status (open/pending queues per project).
CREATE INDEX conversations_workflow_status_idx
  ON conversations (project_id, workflow_status);
