CREATE TABLE conversation_events (
  request_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  user_id TEXT NOT NULL,
  team_id TEXT,
  slack_event_id TEXT,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE conversation_turns (
  id BIGSERIAL PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES conversation_events(request_id),
  session_id TEXT NOT NULL,
  user_content TEXT NOT NULL,
  assistant_content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX conversation_turns_recent ON conversation_turns (session_id, id DESC);
