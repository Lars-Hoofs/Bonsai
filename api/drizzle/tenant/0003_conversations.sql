CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  visitor_id text,
  channel text NOT NULL DEFAULT 'widget',
  status text NOT NULL DEFAULT 'bot' CHECK (status IN ('bot','handover','closed')),
  language text NOT NULL DEFAULT 'nl',
  resolution text,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_project_idx ON conversations (project_id);
CREATE INDEX conversations_status_idx ON conversations (project_id, status);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('visitor','bot','agent','system')),
  content text NOT NULL,
  confidence double precision,
  refused boolean NOT NULL DEFAULT false,
  agent_user_id uuid,
  model_used text,
  latency_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at);

CREATE TABLE message_citations (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  chunk_id uuid NOT NULL,
  document_id uuid NOT NULL,
  document_title text NOT NULL,
  source_id uuid NOT NULL,
  origin_url text,
  PRIMARY KEY (message_id, ordinal)
);

CREATE TABLE handovers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  agent_user_id uuid,
  reason text,
  started_at timestamptz NOT NULL DEFAULT now(),
  returned_at timestamptz
);
CREATE INDEX handovers_conversation_idx ON handovers (conversation_id);
