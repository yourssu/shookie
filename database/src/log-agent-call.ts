import { getPool } from "./pool.js";

export interface AgentCallRecord {
  userId: string;
  channel: string;
  threadTs: string;
  question: string;
  answer: string;
  toolsUsed: string[];
  inputTokens: number;
  outputTokens: number;
}

export async function logAgentCall(record: AgentCallRecord): Promise<void> {
  const pool = getPool();
  try {
    await pool.query(
      `INSERT INTO agent_calls (user_id, channel, thread_ts, question, answer, tools_used, input_tokens, output_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        record.userId,
        record.channel,
        record.threadTs,
        record.question,
        record.answer,
        record.toolsUsed,
        record.inputTokens,
        record.outputTokens,
      ],
    );
  } catch (err) {
    // DB 로깅 실패가 봇 동작에 영향을 주지 않도록 에러만 로깅
    console.error("Failed to log agent call:", err);
  }
}
