import { randomUUID } from "node:crypto";
import type pg from "pg";
import { getPool } from "./pool.js";

/** Version 1 relay metadata. Never add message text, files, blocks or raw payload fields here. */
export interface SlackMessageRelayMetadata {
  teamId: string;
  appId: string;
  eventId: string;
  channelId: string;
  ts: string;
  threadTs: string | null;
  userId: string | null;
  subtype: string | null;
}

export interface SlackMessageRelayDeadlines {
  /** Max wait for a pooled connection. */
  acquireMs: number;
  /** Server-side lock_timeout inside the transaction. */
  lockMs: number;
  /** Server-side statement_timeout inside the transaction. */
  statementMs: number;
  /** Hard wall-clock bound for the whole enqueue (acquire + transaction). */
  totalMs: number;
}

export const DEFAULT_ENQUEUE_DEADLINES: SlackMessageRelayDeadlines = {
  acquireMs: 500,
  lockMs: 500,
  statementMs: 1_000,
  totalMs: 2_000,
};

export type EnqueueResult = "inserted" | "duplicate";

export class SlackMessageRelayDeadlineError extends Error {
  constructor(stage: string) {
    super(`Slack message relay outbox deadline exceeded (${stage})`);
    this.name = "SlackMessageRelayDeadlineError";
  }
}

/** Bounds for any relay database work: acquisition, server-side lock/statement timeouts, and a hard wall-clock total. */
export type SlackMessageRelayDbBounds = SlackMessageRelayDeadlines;

/** Claim and outcome writes (drainer hot path). Total must stay well below the claim lease. */
export const DRAIN_DB_BOUNDS: SlackMessageRelayDbBounds = { acquireMs: 2_000, lockMs: 2_000, statementMs: 5_000, totalMs: 10_000 };
/** Retention, parked requeue and stats (background maintenance). */
export const MAINTENANCE_DB_BOUNDS: SlackMessageRelayDbBounds = { acquireMs: 2_000, lockMs: 2_000, statementMs: 15_000, totalMs: 20_000 };

function sleepReject(ms: number, stage: string): { promise: Promise<never>; cancel: () => void } {
  let timer: NodeJS.Timeout;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SlackMessageRelayDeadlineError(stage)), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

async function raceDeadline<T>(work: Promise<T>, ms: number, stage: string): Promise<T> {
  const deadline = sleepReject(Math.max(1, ms), stage);
  try {
    return await Promise.race([work, deadline.promise]);
  } finally {
    deadline.cancel();
  }
}

/**
 * Runs `work` in ONE short transaction with bounded connection acquisition, server-side lock/statement timeouts
 * and a hard total deadline. No network I/O may happen inside `work`. On ANY failure (including the deadline) the
 * connection is destroyed rather than returned to the pool, so the server rolls the transaction back and a late
 * completion can never leak into other work.
 */
async function withBoundedTransaction<T>(
  pool: pg.Pool,
  bounds: SlackMessageRelayDbBounds,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const remaining = (cap: number) => Math.min(cap, bounds.totalMs - (Date.now() - startedAt));
  const connecting = pool.connect();
  let client: pg.PoolClient;
  try {
    client = await raceDeadline(connecting, remaining(bounds.acquireMs), "acquire");
  } catch (error) {
    // A late-arriving connection must still be returned to the pool.
    connecting.then((late) => late.release(), () => undefined);
    throw error;
  }
  let failed = true;
  try {
    const running = (async () => {
      await client.query(
        `BEGIN; SET LOCAL lock_timeout = '${Math.trunc(bounds.lockMs)}ms'; SET LOCAL statement_timeout = '${Math.trunc(bounds.statementMs)}ms'`,
      );
      const value = await work(client);
      await client.query("COMMIT");
      return value;
    })();
    // If the deadline wins, the destroyed connection makes this reject later; that must not be unhandled.
    running.catch(() => undefined);
    const result = await raceDeadline(running, remaining(bounds.totalMs), "transaction");
    failed = false;
    return result;
  } finally {
    client.release(failed ? true : undefined);
  }
}

/**
 * Atomically persists one metadata row before Slack is acknowledged.
 * The caller must treat failure as "not persisted" and not acknowledge; a Slack retry de-duplicates through the
 * (team, app, event) unique key.
 */
export async function enqueueSlackMessageRelay(
  event: SlackMessageRelayMetadata,
  deadlines: SlackMessageRelayDeadlines = DEFAULT_ENQUEUE_DEADLINES,
  pool: pg.Pool = getPool(),
): Promise<EnqueueResult> {
  return withBoundedTransaction(pool, deadlines, async (client) => {
    const inserted = await client.query(
      `INSERT INTO slack_message_relay_outbox
         (team_id, app_id, event_id, channel_id, message_ts, thread_ts, user_id, subtype)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (team_id, app_id, event_id) DO NOTHING`,
      [event.teamId, event.appId, event.eventId, event.channelId, event.ts, event.threadTs, event.userId, event.subtype],
    );
    return inserted.rowCount === 1 ? ("inserted" as const) : ("duplicate" as const);
  });
}

export interface SlackMessageRelayRow extends SlackMessageRelayMetadata {
  id: string;
  attempts: number;
  claimToken: string;
  createdAt: Date;
}

interface ClaimRow {
  id: string;
  team_id: string;
  app_id: string;
  event_id: string;
  channel_id: string;
  message_ts: string;
  thread_ts: string | null;
  user_id: string | null;
  subtype: string | null;
  attempts: number;
  claim_token: string;
  created_at: Date;
}

/** Claims due rows (including rows whose previous claim crashed past its lease) without blocking other workers. */
export async function claimSlackMessageRelayBatch(
  limit: number,
  leaseMs: number,
  pool: pg.Pool = getPool(),
  bounds: SlackMessageRelayDbBounds = DRAIN_DB_BOUNDS,
): Promise<SlackMessageRelayRow[]> {
  const claimToken = randomUUID();
  const result = await withBoundedTransaction(pool, bounds, (client) => client.query<ClaimRow>(
    `WITH due AS (
       SELECT id FROM slack_message_relay_outbox
       WHERE (status = 'pending' AND next_attempt_at <= now())
          OR (status = 'delivering' AND lease_until <= now())
       ORDER BY next_attempt_at, id
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE slack_message_relay_outbox o
        SET status = 'delivering', attempts = o.attempts + 1, claim_token = $2,
            lease_until = now() + ($3 * interval '1 millisecond'), updated_at = now()
       FROM due
      WHERE o.id = due.id
      RETURNING o.id::text AS id, o.team_id, o.app_id, o.event_id, o.channel_id, o.message_ts,
                o.thread_ts, o.user_id, o.subtype, o.attempts, o.claim_token, o.created_at`,
    [limit, claimToken, leaseMs],
  ));
  return result.rows
    .map((row) => ({
      id: row.id,
      teamId: row.team_id,
      appId: row.app_id,
      eventId: row.event_id,
      channelId: row.channel_id,
      ts: row.message_ts,
      threadTs: row.thread_ts,
      userId: row.user_id,
      subtype: row.subtype,
      attempts: row.attempts,
      claimToken: row.claim_token,
      createdAt: row.created_at,
    }))
    .sort((a, b) => Number(BigInt(a.id) - BigInt(b.id)));
}

export interface SlackMessageRelayOutcomeDetail {
  statusCode?: number | null;
  /** Short metadata-only error code, never a response body or exception message with payload data. */
  error?: string | null;
}

/** Only the current claim holder can finish a row; stale workers update nothing. */
export async function markSlackMessageRelayDelivered(
  row: Pick<SlackMessageRelayRow, "id" | "claimToken">,
  detail: SlackMessageRelayOutcomeDetail = {},
  pool: pg.Pool = getPool(),
  bounds: SlackMessageRelayDbBounds = DRAIN_DB_BOUNDS,
): Promise<boolean> {
  const result = await withBoundedTransaction(pool, bounds, (client) => client.query(
    `UPDATE slack_message_relay_outbox
        SET status = 'delivered', delivered_at = now(), claim_token = NULL, lease_until = NULL,
            last_status_code = $3, last_error = NULL, updated_at = now()
      WHERE id = $1 AND claim_token = $2 AND status = 'delivering'`,
    [row.id, row.claimToken, detail.statusCode ?? null],
  ));
  return result.rowCount === 1;
}

/**
 * Returns a claimed row to pending at an absolute future time.
 * `countAttempt=false` refunds the attempt (429 and shutdown are not delivery failures).
 */
export async function deferSlackMessageRelay(
  row: Pick<SlackMessageRelayRow, "id" | "claimToken">,
  delayMs: number,
  detail: SlackMessageRelayOutcomeDetail & { countAttempt: boolean },
  pool: pg.Pool = getPool(),
  bounds: SlackMessageRelayDbBounds = DRAIN_DB_BOUNDS,
): Promise<boolean> {
  const result = await withBoundedTransaction(pool, bounds, (client) => client.query(
    `UPDATE slack_message_relay_outbox
        SET status = 'pending', claim_token = NULL, lease_until = NULL,
            attempts = GREATEST(attempts - $5, 0),
            next_attempt_at = now() + ($3 * interval '1 millisecond'),
            last_status_code = $4, last_error = $6, updated_at = now()
      WHERE id = $1 AND claim_token = $2 AND status = 'delivering'`,
    [row.id, row.claimToken, Math.max(0, Math.trunc(delayMs)), detail.statusCode ?? null, detail.countAttempt ? 0 : 1, detail.error ?? null],
  ));
  return result.rowCount === 1;
}

/** Terminal dead-letter ('failed') or configuration park ('parked'); metadata is retained. */
export async function finishSlackMessageRelayUndelivered(
  row: Pick<SlackMessageRelayRow, "id" | "claimToken">,
  status: "failed" | "parked",
  detail: SlackMessageRelayOutcomeDetail,
  pool: pg.Pool = getPool(),
  bounds: SlackMessageRelayDbBounds = DRAIN_DB_BOUNDS,
): Promise<boolean> {
  const result = await withBoundedTransaction(pool, bounds, (client) => client.query(
    `UPDATE slack_message_relay_outbox
        SET status = $3, claim_token = NULL, lease_until = NULL,
            last_status_code = $4, last_error = $5, updated_at = now()
      WHERE id = $1 AND claim_token = $2 AND status = 'delivering'`,
    [row.id, row.claimToken, status, detail.statusCode ?? null, detail.error ?? null],
  ));
  return result.rowCount === 1;
}

/**
 * Operator recovery after fixing URL/key: configuration-parked rows become due again on the next start.
 * Rows parked for an excessive Retry-After are NOT requeued automatically (that would retry earlier than Radar asked).
 */
export async function requeueParkedSlackMessageRelays(
  pool: pg.Pool = getPool(),
  bounds: SlackMessageRelayDbBounds = MAINTENANCE_DB_BOUNDS,
): Promise<number> {
  const result = await withBoundedTransaction(pool, bounds, (client) => client.query(
    `UPDATE slack_message_relay_outbox
        SET status = 'pending', attempts = 0, next_attempt_at = now(), updated_at = now()
      WHERE status = 'parked' AND last_error IS DISTINCT FROM 'retry_after_excessive'`,
  ));
  return result.rowCount ?? 0;
}

export interface SlackMessageRelayRetention {
  deliveredMs: number;
  failedMs: number;
  /**
   * A pending row whose later of (created, next attempt) is older than this becomes terminal 'failed' (expired).
   * Measured from the scheduled retry time so a long server-requested Retry-After is never cut short by expiry.
   */
  maxPendingAgeMs: number;
  batch: number;
}

export interface SlackMessageRelayPruneResult {
  expired: number;
  deleted: number;
}

export async function pruneSlackMessageRelays(
  retention: SlackMessageRelayRetention,
  pool: pg.Pool = getPool(),
  bounds: SlackMessageRelayDbBounds = MAINTENANCE_DB_BOUNDS,
): Promise<SlackMessageRelayPruneResult> {
  const expired = await withBoundedTransaction(pool, bounds, (client) => client.query(
    `UPDATE slack_message_relay_outbox
        SET status = 'failed', claim_token = NULL, lease_until = NULL, last_error = 'expired', updated_at = now()
      WHERE id IN (
        SELECT id FROM slack_message_relay_outbox
         WHERE status = 'pending' AND GREATEST(created_at, next_attempt_at) < now() - ($1 * interval '1 millisecond')
         LIMIT $2 FOR UPDATE SKIP LOCKED)`,
    [retention.maxPendingAgeMs, retention.batch],
  ));
  const deleted = await withBoundedTransaction(pool, bounds, (client) => client.query(
    `DELETE FROM slack_message_relay_outbox
      WHERE id IN (
        SELECT id FROM slack_message_relay_outbox
         WHERE (status = 'delivered' AND updated_at < now() - ($1 * interval '1 millisecond'))
            OR (status = 'failed' AND updated_at < now() - ($2 * interval '1 millisecond'))
         LIMIT $3 FOR UPDATE SKIP LOCKED)`,
    [retention.deliveredMs, retention.failedMs, retention.batch],
  ));
  return { expired: expired.rowCount ?? 0, deleted: deleted.rowCount ?? 0 };
}

export interface SlackMessageRelayStats {
  pending: number;
  delivering: number;
  delivered: number;
  failed: number;
  parked: number;
}

export async function getSlackMessageRelayStats(
  pool: pg.Pool = getPool(),
  bounds: SlackMessageRelayDbBounds = MAINTENANCE_DB_BOUNDS,
): Promise<SlackMessageRelayStats> {
  const result = await withBoundedTransaction(pool, bounds, (client) => client.query<{ status: keyof SlackMessageRelayStats; count: string }>(
    "SELECT status, count(*)::text AS count FROM slack_message_relay_outbox GROUP BY status",
  ));
  const stats: SlackMessageRelayStats = { pending: 0, delivering: 0, delivered: 0, failed: 0, parked: 0 };
  for (const row of result.rows) stats[row.status] = Number(row.count);
  return stats;
}
