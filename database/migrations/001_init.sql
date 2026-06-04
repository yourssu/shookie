CREATE TABLE IF NOT EXISTS agent_calls (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT,
  tools_used TEXT[] DEFAULT '{}',
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_agent_calls_user_id ON agent_calls (user_id);
CREATE INDEX IF NOT EXISTS idx_agent_calls_created_at ON agent_calls (created_at DESC);
