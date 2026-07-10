-- Handover notification targets (#38): per-project fan-out destinations that
-- fire when a conversation is escalated/handed over to a human. Complements
-- the existing generic outbound `webhooks` table (which already delivers the
-- signed `conversation.escalated` event) by adding first-class Slack
-- incoming-webhook and email (SMTP) targets that render a human-readable
-- handover notification rather than a raw JSON event body.
CREATE TABLE handover_notification_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  -- 'slack' => `target` is a Slack incoming-webhook URL (posted as chat text);
  -- 'email' => `target` is a recipient email address (sent via MailService).
  kind text NOT NULL CHECK (kind IN ('slack', 'email')),
  target text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX handover_notification_targets_project_idx
  ON handover_notification_targets (project_id);
