import { getPool } from "./pool.js";

const MEETING_REMINDER_CLAIM_LEASE_MS = 5 * 60 * 1_000;

export interface MeetingReminderDeliveryState {
  claimed: boolean;
  delivered: boolean;
}

export async function claimMeetingReminder(occurrenceId: string, channelId: string): Promise<MeetingReminderDeliveryState> {
  const result = await getPool().query(
    `INSERT INTO meeting_reminder_deliveries (occurrence_id, channel_id)
     VALUES ($1, $2)
     ON CONFLICT (occurrence_id) DO UPDATE
       SET channel_id = EXCLUDED.channel_id, updated_at = now()
       WHERE meeting_reminder_deliveries.delivered_at IS NULL
         AND meeting_reminder_deliveries.updated_at < now() - ($3 * interval '1 millisecond')
     RETURNING occurrence_id`,
    [occurrenceId, channelId, MEETING_REMINDER_CLAIM_LEASE_MS],
  );
  if (result.rowCount === 1) return { claimed: true, delivered: false };
  const existing = await getPool().query<{ delivered_at: Date | null }>(
    "SELECT delivered_at FROM meeting_reminder_deliveries WHERE occurrence_id = $1",
    [occurrenceId],
  );
  return { claimed: false, delivered: existing.rows[0]?.delivered_at != null };
}

export async function releaseUndeliveredMeetingReminder(occurrenceId: string): Promise<void> {
  await getPool().query(
    "DELETE FROM meeting_reminder_deliveries WHERE occurrence_id = $1 AND delivered_at IS NULL",
    [occurrenceId],
  );
}

export async function markMeetingReminderDelivered(occurrenceId: string, messageTs: string): Promise<void> {
  await getPool().query(
    `UPDATE meeting_reminder_deliveries SET slack_message_ts = $2, delivered_at = now(), updated_at = now()
     WHERE occurrence_id = $1`, [occurrenceId, messageTs],
  );
}

export async function markMeetingReminderAcked(occurrenceId: string): Promise<void> {
  await getPool().query(
    `UPDATE meeting_reminder_deliveries SET acked_at = now(), updated_at = now()
     WHERE occurrence_id = $1 AND delivered_at IS NOT NULL`,
    [occurrenceId],
  );
}
