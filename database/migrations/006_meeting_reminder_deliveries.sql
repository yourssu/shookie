CREATE TABLE IF NOT EXISTS meeting_reminder_deliveries (
  occurrence_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  slack_message_ts TEXT,
  delivered_at TIMESTAMPTZ,
  acked_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS meeting_reminder_deliveries_pending_ack_idx
  ON meeting_reminder_deliveries (updated_at)
  WHERE delivered_at IS NOT NULL AND acked_at IS NULL;
