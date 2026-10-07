import pg from "pg";

/**
 * Native pg-pool bound on establishing/checking out a connection. Without it a TCP peer that accepts but never answers
 * the PostgreSQL startup leaves a physical client "connecting" forever, holding pool capacity and preventing pool.end().
 * pg-pool destroys the socket when it elapses, so a connect attempt that a caller already gave up on (e.g. the 500ms
 * Slack-ACK-path enqueue acquire or the 2s drainer acquire) disappears within this budget. Healthy connects take
 * milliseconds; the same bound also caps waiting for a free client when all `max` clients are busy.
 */
export const DB_CONNECTION_TIMEOUT_MS = 5_000;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL environment variable is required");
    }
    pool = new pg.Pool({ connectionString: url, max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: DB_CONNECTION_TIMEOUT_MS });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
