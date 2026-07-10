-- Agent presence (#21): control-plane table (not tenant-scoped) recording
-- each agent's self-reported presence per tenant, used to auto-assign newly
-- escalated conversations to a currently-available agent.
CREATE TABLE agent_presence (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'away' CHECK (status IN ('available', 'away')),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
