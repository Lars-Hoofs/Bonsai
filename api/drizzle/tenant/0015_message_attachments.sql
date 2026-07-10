-- Visitor file/image attachments (#14): a widget visitor can upload a
-- file/image within a conversation. The raw bytes live in object storage
-- (MinIO/S3) under `storage_key`; this table records the metadata and ties
-- each attachment to its conversation (and, when present, the visitor
-- `messages` row created for the upload), so agents viewing the conversation
-- can list and download what the visitor sent.
--
-- Additive/opt-in: existing conversations and messages are unaffected until a
-- visitor uploads something. `message_id` is nullable so an attachment can
-- exist independently of a text message; ON DELETE SET NULL keeps the
-- attachment metadata (and stored bytes) even if its message row is removed.
CREATE TABLE message_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  filename text NOT NULL,
  content_type text NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes >= 0),
  storage_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX message_attachments_conversation_idx
  ON message_attachments (conversation_id, created_at);
CREATE INDEX message_attachments_message_idx
  ON message_attachments (message_id);
