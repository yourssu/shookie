import {
  claimSlackMessageRelayBatch,
  deferSlackMessageRelay,
  finishSlackMessageRelayUndelivered,
  getSlackMessageRelayStats,
  markSlackMessageRelayDelivered,
  pruneSlackMessageRelays,
  requeueParkedSlackMessageRelays,
  type SlackMessageRelayRow,
  type SlackMessageRelayStats,
} from "database";
import { logger } from "../../logger.js";

export interface RelayStore {
  claim(limit: number, leaseMs: number): Promise<SlackMessageRelayRow[]>;
  delivered(row: SlackMessageRelayRow, detail: { statusCode: number }): Promise<boolean>;
  defer(row: SlackMessageRelayRow, delayMs: number, detail: { statusCode?: number; error: string; countAttempt: boolean }): Promise<boolean>;
  finish(row: SlackMessageRelayRow, status: "failed" | "parked", detail: { statusCode?: number; error: string }): Promise<boolean>;
  requeueParked(): Promise<number>;
  prune(): Promise<{ expired: number; deleted: number }>;
  stats(): Promise<SlackMessageRelayStats>;
}

export const RELAY_RETENTION = {
  deliveredMs: 3 * 24 * 60 * 60 * 1_000,
  failedMs: 30 * 24 * 60 * 60 * 1_000,
  // Measured from the later of creation and the scheduled retry, so a long Retry-After is never cut short.
  maxPendingAgeMs: 3 * 24 * 60 * 60 * 1_000,
  batch: 500,
} as const;

export const databaseRelayStore: RelayStore = {
  claim: (limit, leaseMs) => claimSlackMessageRelayBatch(limit, leaseMs),
  delivered: (row, detail) => markSlackMessageRelayDelivered(row, detail),
  defer: (row, delayMs, detail) => deferSlackMessageRelay(row, delayMs, detail),
  finish: (row, status, detail) => finishSlackMessageRelayUndelivered(row, status, detail),
  requeueParked: () => requeueParkedSlackMessageRelays(),
  prune: () => pruneSlackMessageRelays(RELAY_RETENTION),
  stats: () => getSlackMessageRelayStats(),
};

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export interface RelayDrainerOptions {
  apiUrl: string;
  apiKey: string;
  store?: RelayStore;
  fetcher?: Fetcher;
  now?: () => number;
  random?: () => number;
  /** Max rows claimed per tick (memory bound). */
  batchSize?: number;
  /** Max concurrent HTTP requests. */
  concurrency?: number;
  requestTimeoutMs?: number;
  idlePollMs?: number;
  /** Delay between ticks after a database error. */
  errorPollMs?: number;
  maintenanceEveryMs?: number;
  /** Claim lease; a crashed worker's rows become due again after this. Must exceed requestTimeoutMs. */
  leaseMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Delivery attempts (excluding 429) before a row becomes terminally failed. */
  maxAttempts?: number;
  /**
   * Longest server-supplied Retry-After that is honoured. Anything longer is NEVER shortened and retried early:
   * the row is parked visibly (error log, 'parked') for an operator instead.
   */
  maxRetryAfterMs?: number;
  /** Upper bound for stop() to wait for in-flight work; database work is itself bounded by its own deadlines. */
  stopTimeoutMs?: number;
}

const RETRY_AFTER_DEFAULT_MS = 60_000;

/** Retry-After as delta-seconds or HTTP-date; returns null when absent/invalid. Not clamped to a short value. */
export function parseRetryAfter(header: string | null, nowMs: number): number | null {
  if (header === null) return null;
  const value = header.trim();
  if (/^\d{1,9}$/u.test(value)) return Number(value) * 1_000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - nowMs);
}

/**
 * Bounded, separate outbox drain: never on the Slack ACK path. Runs in the existing Node process and
 * database; no extra broker, process or Slack connection.
 */
export class RelayDrainer {
  private readonly store: RelayStore;
  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly batchSize: number;
  private readonly concurrency: number;
  private readonly requestTimeoutMs: number;
  private readonly idlePollMs: number;
  private readonly errorPollMs: number;
  private readonly maintenanceEveryMs: number;
  private readonly leaseMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxAttempts: number;
  private readonly maxRetryAfterMs: number;
  private readonly stopTimeoutMs: number;
  private hardStopped = false;

  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopping = false;
  private halted: { statusCode: number; since: number; lastLog: number } | null = null;
  private lastMaintenance = -Infinity;
  private readonly aborts = new Set<AbortController>();

  constructor(private readonly options: RelayDrainerOptions) {
    this.store = this.guard(options.store ?? databaseRelayStore);
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.batchSize = options.batchSize ?? 20;
    this.concurrency = Math.max(1, Math.min(options.concurrency ?? 3, this.batchSize));
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    this.idlePollMs = options.idlePollMs ?? 2_000;
    this.errorPollMs = options.errorPollMs ?? 10_000;
    this.maintenanceEveryMs = options.maintenanceEveryMs ?? 5 * 60_000;
    // Must exceed a whole batch's worth of requests plus bounded outcome writes; a crashed worker recovers after it.
    this.leaseMs = options.leaseMs ?? Math.max(120_000, this.requestTimeoutMs * 8 + 20_000);
    this.baseBackoffMs = options.baseBackoffMs ?? 5_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 15 * 60_000;
    this.maxAttempts = options.maxAttempts ?? 15;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? 7 * 24 * 60 * 60_000;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 30_000;
  }

  /** After a hard stop no further database call is started (rows stay recoverable through their lease). */
  private guard(store: RelayStore): RelayStore {
    const skip = <T>(fallback: T, call: () => Promise<T>) => (this.hardStopped ? Promise.resolve(fallback) : call());
    return {
      claim: (l, m) => skip([], () => store.claim(l, m)),
      delivered: (r, d) => skip(false, () => store.delivered(r, d)),
      defer: (r, ms, d) => skip(false, () => store.defer(r, ms, d)),
      finish: (r, st, d) => skip(false, () => store.finish(r, st, d)),
      requeueParked: () => skip(0, () => store.requeueParked()),
      prune: () => skip({ expired: 0, deleted: 0 }, () => store.prune()),
      stats: () => skip({ pending: 0, delivering: 0, delivered: 0, failed: 0, parked: 0 }, () => store.stats()),
    };
  }

  /** Re-queues rows parked by a previous configuration error (operator fixed URL/key and restarted), then starts polling. */
  async start(): Promise<void> {
    this.stopping = false;
    this.hardStopped = false;
    try {
      const requeued = await this.store.requeueParked();
      if (requeued > 0) logger.warn("Slack 메시지 릴레이 parked 행을 재시도 대기열로 복구", { requeued });
    } catch (error) {
      logger.error("Slack 메시지 릴레이 parked 행 복구 실패", { errorName: errorName(error) });
    }
    this.schedule(0);
  }

  /** Stops polling, aborts in-flight HTTP and waits until no database write can occur afterwards. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const controller of this.aborts) controller.abort();
    const running = this.running;
    if (!running) return;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      running.then(() => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), this.stopTimeoutMs); }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut) {
      // Every database call has its own deadline and destroys its connection, so this is a last-resort bound:
      // forbid new calls and let the caller continue shutdown instead of waiting forever.
      this.hardStopped = true;
      logger.error("Slack 메시지 릴레이 drain 종료 대기 초과 — 이후 DB 호출 중단(행은 lease 만료로 복구)");
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.running = this.tick().finally(() => {
        this.running = null;
      });
    }, delayMs);
    this.timer.unref?.();
  }

  /** One drain cycle; exposed for tests. Always reschedules unless stopping. */
  async tick(): Promise<void> {
    let next = this.idlePollMs;
    try {
      await this.maintain();
      if (this.halted) {
        this.reportHalted();
        next = this.idlePollMs * 5;
      } else {
        const rows = await this.store.claim(this.batchSize, this.leaseMs);
        if (rows.length > 0) await this.deliverAll(rows);
        if (rows.length >= this.batchSize) next = 0;
      }
    } catch (error) {
      logger.error("Slack 메시지 릴레이 drain 실패", { errorName: errorName(error) });
      next = this.errorPollMs;
    }
    this.schedule(next);
  }

  private async maintain(): Promise<void> {
    if (this.now() - this.lastMaintenance < this.maintenanceEveryMs) return;
    this.lastMaintenance = this.now();
    const pruned = await this.store.prune();
    const stats = await this.store.stats();
    const level = stats.failed > 0 || stats.parked > 0 ? "warn" : "info";
    logger[level]("Slack 메시지 릴레이 outbox 상태", { ...stats, expired: pruned.expired, pruned: pruned.deleted });
  }

  private reportHalted(): void {
    const halted = this.halted!;
    if (this.now() - halted.lastLog < 10 * 60_000) return;
    halted.lastLog = this.now();
    logger.error("Slack 메시지 릴레이가 설정 오류로 중지됨 — URL/키 확인 후 재시작 필요", {
      statusCode: halted.statusCode,
      haltedForMs: this.now() - halted.since,
    });
  }

  private async deliverAll(rows: SlackMessageRelayRow[]): Promise<void> {
    const queue = [...rows];
    const worker = async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        if (this.stopping || this.halted) {
          await this.release(row);
          continue;
        }
        await this.deliver(row);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, rows.length) }, worker));
  }

  /** Give an unsent claimed row back without spending an attempt. */
  private async release(row: SlackMessageRelayRow): Promise<void> {
    try {
      await this.store.defer(row, 0, { error: this.stopping ? "shutdown" : "halted", countAttempt: false });
    } catch (error) {
      logger.error("Slack 메시지 릴레이 claim 해제 실패", { errorName: errorName(error) });
    }
  }

  private async deliver(row: SlackMessageRelayRow): Promise<void> {
    const controller = new AbortController();
    this.aborts.add(controller);
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response: Response | null = null;
    let failure: string | null = null;
    try {
      response = await this.fetcher(this.options.apiUrl, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", "X-Radar-Internal-Key": this.options.apiKey },
        body: JSON.stringify({
          version: 1,
          teamId: row.teamId,
          appId: row.appId,
          eventId: row.eventId,
          channelId: row.channelId,
          ts: row.ts,
          threadTs: row.threadTs,
          userId: row.userId,
          subtype: row.subtype,
        }),
      });
    } catch (error) {
      failure = this.stopping ? "shutdown" : controller.signal.aborted ? "timeout" : `network:${errorName(error)}`;
    } finally {
      clearTimeout(timeout);
      this.aborts.delete(controller);
    }

    try {
      if (response === null) {
        if (failure === "shutdown") await this.release(row);
        else await this.retryOrFail(row, undefined, failure ?? "network");
        return;
      }
      const status = response.status;
      const retryAfter = response.headers.get("retry-after");
      // Free the socket without reading (or logging) the response body.
      await response.body?.cancel().catch(() => undefined);

      if (status >= 200 && status < 300) {
        // Radar returns 2xx only after its durable commit; anything else keeps the row for a same-eventId retry.
        await this.store.delivered(row, { statusCode: status });
      } else if (status === 429) {
        const requested = parseRetryAfter(retryAfter, this.now()) ?? RETRY_AFTER_DEFAULT_MS;
        if (requested > this.maxRetryAfterMs) {
          // Never retry earlier than Radar asked: park visibly; an operator (or restart) decides.
          await this.store.finish(row, "parked", { statusCode: status, error: "retry_after_excessive" });
          logger.error("Slack 메시지 릴레이 Retry-After가 허용 한도 초과 — 조기 재시도 없이 park함", {
            eventId: row.eventId, retryAfterMs: requested, maxMs: this.maxRetryAfterMs,
          });
        } else {
          await this.store.defer(row, requested, { statusCode: status, error: "rate_limited", countAttempt: false });
          logger.warn("Slack 메시지 릴레이 429 — Retry-After 전체를 durable 지연", { eventId: row.eventId, delayMs: requested });
        }
      } else if ([401, 403, 404, 405].includes(status) || (status >= 300 && status < 400)) {
        // Authentication / route / redirect problems are configuration errors: park the row and stop hammering Radar.
        await this.store.finish(row, "parked", { statusCode: status, error: "config" });
        if (!this.halted) this.halted = { statusCode: status, since: this.now(), lastLog: -Infinity };
        logger.error("Slack 메시지 릴레이 설정 오류로 행을 park함", { eventId: row.eventId, statusCode: status });
      } else if (status === 408 || status === 425 || status >= 500) {
        await this.retryOrFail(row, status, `http_${status}`);
      } else {
        await this.store.finish(row, "failed", { statusCode: status, error: `http_${status}` });
        logger.error("Slack 메시지 릴레이 비재시도 응답 — 실패 보관", { eventId: row.eventId, statusCode: status });
      }
    } catch (error) {
      // The row stays 'delivering'; its lease expiry makes it due again and Radar de-duplicates by eventId.
      logger.error("Slack 메시지 릴레이 결과 기록 실패", { eventId: row.eventId, errorName: errorName(error) });
    }
  }

  private async retryOrFail(row: SlackMessageRelayRow, statusCode: number | undefined, error: string): Promise<void> {
    if (row.attempts >= this.maxAttempts) {
      await this.store.finish(row, "failed", { ...(statusCode !== undefined ? { statusCode } : {}), error });
      logger.error("Slack 메시지 릴레이 최대 재시도 초과 — 실패 보관", { eventId: row.eventId, attempts: row.attempts, error });
      return;
    }
    const ceiling = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** Math.max(0, row.attempts - 1));
    // Equal jitter: half deterministic, half random, so a Radar recovery is not hit by a synchronized herd.
    const delay = Math.round(ceiling / 2 + this.random() * (ceiling / 2));
    await this.store.defer(row, delay, { ...(statusCode !== undefined ? { statusCode } : {}), error, countAttempt: true });
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
