-- Durable, metadata-only outbox for relaying public Slack message events to Radar.
-- No message text, files, blocks, attachments, tokens or raw payloads are stored here.
CREATE TABLE IF NOT EXISTS slack_message_relay_outbox (
  id BIGSERIAL PRIMARY KEY,
  team_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_ts TEXT NOT NULL,
  thread_ts TEXT,
  user_id TEXT,
  subtype TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivering', 'delivered', 'failed', 'parked')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claim_token TEXT,
  lease_until TIMESTAMPTZ,
  last_status_code INTEGER,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  CONSTRAINT slack_message_relay_outbox_event_key UNIQUE (team_id, app_id, event_id)
);

CREATE INDEX IF NOT EXISTS slack_message_relay_outbox_due_idx
  ON slack_message_relay_outbox (next_attempt_at, id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS slack_message_relay_outbox_lease_idx
  ON slack_message_relay_outbox (lease_until)
  WHERE status = 'delivering';

CREATE INDEX IF NOT EXISTS slack_message_relay_outbox_message_idx
  ON slack_message_relay_outbox (team_id, app_id, channel_id, message_ts);

CREATE INDEX IF NOT EXISTS slack_message_relay_outbox_retention_idx
  ON slack_message_relay_outbox (updated_at)
  WHERE status IN ('delivered', 'failed');
