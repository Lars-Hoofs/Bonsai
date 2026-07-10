-- Team invitations (#46): control-plane table (not tenant-scoped) recording
-- pending/accepted invites to join a tenant with a given role. A random,
-- unique `token` is emailed to the invitee (see MailService); accepting adds
-- a membership row and stamps `accepted_at`.
CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'editor', 'agent', 'viewer')),
  token text NOT NULL UNIQUE,
  accepted_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
