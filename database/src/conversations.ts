import { getPool } from "./pool.js";

export interface ConversationEvent {
  requestId: string;
  sessionId: string;
  channel: string;
  threadTs: string;
  userId: string;
  teamId?: string;
  eventId?: string;
}
export interface ConversationTurn {
  userContent: string;
  assistantContent: string;
}
export interface ConversationRepository {
  claim(event: ConversationEvent): Promise<boolean>;
  recent(sessionId: string, limit: number): Promise<ConversationTurn[]>;
  complete(event: ConversationEvent, turn: ConversationTurn): Promise<void>;
  fail(requestId: string): Promise<void>;
}

// No swallowed database errors: dialogue persistence is mandatory.
export const conversationRepository: ConversationRepository = {
  async claim(event) {
    const result = await getPool().query(
      `INSERT INTO conversation_events
       (request_id, session_id, channel_id, thread_ts, user_id, team_id, slack_event_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (request_id) DO NOTHING RETURNING request_id`,
      [event.requestId, event.sessionId, event.channel, event.threadTs, event.userId, event.teamId ?? null, event.eventId ?? null],
    );
    return result.rowCount === 1;
  },
  async recent(sessionId, limit) {
    const result = await getPool().query<{ user_content: string; assistant_content: string }>(
      `SELECT user_content, assistant_content FROM
       (SELECT id, user_content, assistant_content FROM conversation_turns
        WHERE session_id = $1 ORDER BY id DESC LIMIT $2) recent ORDER BY id`,
      [sessionId, limit],
    );
    return result.rows.map(row => ({ userContent: row.user_content, assistantContent: row.assistant_content }));
  },
  async complete(event, turn) {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE conversation_events SET status = 'completed', completed_at = now()
         WHERE request_id = $1 AND status = 'processing' RETURNING request_id`, [event.requestId],
      );
      if (result.rowCount !== 1) throw new Error("Conversation event is not processing");
      await client.query(
        `INSERT INTO conversation_turns (request_id, session_id, user_content, assistant_content)
         VALUES ($1,$2,$3,$4)`, [event.requestId, event.sessionId, turn.userContent, turn.assistantContent],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
  async fail(requestId) {
    await getPool().query(
      `UPDATE conversation_events SET status = 'failed', completed_at = now()
       WHERE request_id = $1 AND status = 'processing'`, [requestId],
    );
  },
};
