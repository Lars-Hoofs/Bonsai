-- Agent presence + conversation assignment (#21): lets an escalated
-- conversation be auto-assigned to an available agent, and lets agents
-- claim/reassign conversations in the inbox. Nullable: existing/unassigned
-- conversations are unaffected (still show up in the inbox for anyone).
ALTER TABLE conversations ADD COLUMN assigned_agent_id uuid;
CREATE INDEX conversations_assigned_agent_idx ON conversations (project_id, assigned_agent_id);
