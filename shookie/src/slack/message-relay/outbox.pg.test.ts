/**
 * Real-PostgreSQL + real-HTTP integration tests for the metadata outbox and its drainer.
 * Opt-in: set SHOOKIE_TEST_PG_ADMIN_URL to an admin URL of a THROWAWAY server, e.g.
 *   docker run -d --rm -e POSTGRES_PASSWORD=itpass -p 127.0.0.1:55432:5432 postgres:16-alpine
 *   SHOOKIE_TEST_PG_ADMIN_URL=postgres://postgres:itpass@127.0.0.1:55432/postgres yarn workspace shookie test outbox.pg
 * Each run creates and drops its own database; it never touches DATABASE_URL or existing databases.
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import {
  claimSlackMessageRelayBatch, closePool, deferSlackMessageRelay, enqueueSlackMessageRelay, finishSlackMessageRelayUndelivered, getPool,
  getSlackMessageRelayStats, markSlackMessageRelayDelivered, pruneSlackMessageRelays, requeueParkedSlackMessageRelays, runMigrations,
  type SlackMessageRelayMetadata,
} from "database";
import { databaseRelayStore, RelayDrainer, type RelayStore } from "./drain.js";

const TINY = { acquireMs: 300, lockMs: 120, statementMs: 200, totalMs: 500 };
const adminUrl = process.env.SHOOKIE_TEST_PG_ADMIN_URL;
const dbName = `shookie_relay_it_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

const meta = (n: number, overrides: Partial<SlackMessageRelayMetadata> = {}): SlackMessageRelayMetadata => ({
  teamId: "T2SRCGYPQ", appId: "A0ATZCLF99A", eventId: `Ev0SYNTH${String(n).padStart(4, "0")}`, channelId: "C0SYNTH01",
  ts: `1700000000.${String(n).padStart(6, "0")}`, threadTs: null, userId: "U0HUMAN01", subtype: null, ...overrides,
});
const rows = async () => (await getPool().query("SELECT * FROM slack_message_relay_outbox ORDER BY id")).rows;

/** Radar stub: commits (de-duplicating by eventId) and answers according to a script. */
function radarStub() {
  const committed = new Map<string, unknown>();
  const requests: { key: string | undefined; body: Record<string, unknown> }[] = [];
  const script: Array<"ok" | "503" | "429-long" | "429-172800" | "429-absurd" | "401" | "commit-then-drop" | "drop-before-commit"> = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push({ key: req.headers["x-radar-internal-key"] as string | undefined, body });
      const step = script.shift() ?? "ok";
      if (req.url !== "/internal/v1/slack/message-events" || req.method !== "POST") { res.writeHead(404).end(); return; }
      if (step === "503") { res.writeHead(503).end(); return; }
      if (step === "429-long") { res.writeHead(429, { "Retry-After": "7200" }).end(); return; }
      if (step === "429-172800") { res.writeHead(429, { "Retry-After": "172800" }).end(); return; }
      if (step === "429-absurd") { res.writeHead(429, { "Retry-After": String(90 * 86_400) }).end(); return; }
      if (step === "401") { res.writeHead(401).end(); return; }
      if (step === "drop-before-commit") { req.socket.destroy(); return; }
      committed.set(String(body.eventId), body);
      if (step === "commit-then-drop") { req.socket.destroy(); return; }
      res.writeHead(202).end();
    });
  });
  return {
    committed, requests, script,
    listen: () => new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/v1/slack/message-events`))),
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
const drainer = (apiUrl: string, extra: Record<string, unknown> = {}, store: RelayStore = databaseRelayStore) =>
  new RelayDrainer({ apiUrl, apiKey: "shared-key-0123456789", store, idlePollMs: 20, errorPollMs: 20, baseBackoffMs: 40, maxBackoffMs: 80, requestTimeoutMs: 1_000, leaseMs: 300, ...extra });
const until = (fn: () => Promise<boolean>, ms = 8_000) => vi.waitFor(async () => { expect(await fn()).toBe(true); }, { timeout: ms, interval: 25 });

describe.skipIf(!adminUrl)("PostgreSQL outbox + HTTP drain (real PostgreSQL)", () => {
  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const url = new URL(adminUrl!);
    url.pathname = `/${dbName}`;
    process.env.DATABASE_URL = url.toString();
    await runMigrations();
  });
  afterAll(async () => {
    await closePool();
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });
  beforeEach(async () => { vi.clearAllMocks(); await getPool().query("TRUNCATE slack_message_relay_outbox RESTART IDENTITY"); });

  it("migration is immutable/idempotent and the table stores metadata columns only", async () => {
    expect(await runMigrations()).toEqual([]);
    const applied = await getPool().query("SELECT filename FROM schema_migrations WHERE filename LIKE '008%'");
    expect(applied.rows).toEqual([{ filename: "008_slack_message_relay_outbox.sql" }]);
    const columns = (await getPool().query("SELECT column_name FROM information_schema.columns WHERE table_name = 'slack_message_relay_outbox'")).rows.map((r) => r.column_name);
    expect(columns.sort()).toEqual(["app_id", "attempts", "channel_id", "claim_token", "created_at", "delivered_at", "event_id", "id", "last_error", "last_status_code", "lease_until", "message_ts", "next_attempt_at", "status", "subtype", "team_id", "thread_ts", "updated_at", "user_id"]);
  });

  it("enqueue is atomic and de-duplicates by team/app/event, including concurrent Slack retries", async () => {
    expect(await enqueueSlackMessageRelay(meta(1))).toBe("inserted");
    expect(await enqueueSlackMessageRelay(meta(1))).toBe("duplicate");
    const results = await Promise.all(Array.from({ length: 15 }, () => enqueueSlackMessageRelay(meta(2))));
    expect(results.filter((r) => r === "inserted")).toHaveLength(1);
    // Same event id under a different app is a different identity.
    expect(await enqueueSlackMessageRelay(meta(1, { appId: "A0OTHER0001" }))).toBe("inserted");
    const all = await rows();
    expect(all).toHaveLength(3);
    expect(all[0]).toMatchObject({ team_id: "T2SRCGYPQ", app_id: "A0ATZCLF99A", event_id: "Ev0SYNTH0001", channel_id: "C0SYNTH01", message_ts: "1700000000.000001", thread_ts: null, status: "pending", attempts: 0 });
  });

  it("out-of-order arrival is stored in claim order of arrival and delivered by id", async () => {
    await enqueueSlackMessageRelay(meta(5));
    await enqueueSlackMessageRelay(meta(3));
    const claimed = await claimSlackMessageRelayBatch(10, 1_000);
    expect(claimed.map((r) => r.eventId)).toEqual(["Ev0SYNTH0005", "Ev0SYNTH0003"]);
  });

  it("a conflicting in-flight transaction hits the lock deadline and nothing is persisted twice", async () => {
    const holder = await getPool().connect();
    await holder.query("BEGIN");
    await holder.query("INSERT INTO slack_message_relay_outbox (team_id, app_id, event_id, channel_id, message_ts) VALUES ('T2SRCGYPQ','A0ATZCLF99A','Ev0SYNTH0009','C0SYNTH01','1700000000.000009')");
    const started = Date.now();
    await expect(enqueueSlackMessageRelay(meta(9), { acquireMs: 500, lockMs: 150, statementMs: 300, totalMs: 600 })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1_200);
    await holder.query("ROLLBACK");
    holder.release();
    expect(await rows()).toHaveLength(0);
    expect(await enqueueSlackMessageRelay(meta(9))).toBe("inserted"); // Slack retry succeeds
  });

  it("a database outage makes enqueue fail within its bound (connection refused)", async () => {
    const dead = new pg.Pool({ connectionString: "postgres://postgres:x@127.0.0.1:1/none", max: 1 });
    const started = Date.now();
    await expect(enqueueSlackMessageRelay(meta(1), undefined, dead)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_500);
    await dead.end();
  });

  it("concurrent claimers never receive the same row, and stale claim holders cannot finish a row", async () => {
    for (let n = 1; n <= 12; n++) await enqueueSlackMessageRelay(meta(n));
    const [a, b, c] = await Promise.all([claimSlackMessageRelayBatch(5, 60_000), claimSlackMessageRelayBatch(5, 60_000), claimSlackMessageRelayBatch(5, 60_000)]);
    const ids = [...a, ...b, ...c].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(12);
    const stale = { ...a[0]!, claimToken: "stale-token" };
    expect(await markSlackMessageRelayDelivered(stale)).toBe(false);
    expect(await markSlackMessageRelayDelivered(a[0]!)).toBe(true);
    expect(await markSlackMessageRelayDelivered(a[0]!)).toBe(false);
  });

  it("pending rows survive a pool restart; a crashed claim becomes due again after its lease", async () => {
    await enqueueSlackMessageRelay(meta(1));
    const [claimed] = await claimSlackMessageRelayBatch(1, 200);
    expect(claimed!.attempts).toBe(1);
    await closePool(); // "crash": claim never finished
    expect(await claimSlackMessageRelayBatch(1, 200)).toHaveLength(0); // lease still held (new pool, same DB)
    await new Promise((r) => setTimeout(r, 300));
    const [again] = await claimSlackMessageRelayBatch(1, 200);
    expect(again).toMatchObject({ eventId: "Ev0SYNTH0001", attempts: 2 });
    expect(again!.claimToken).not.toBe(claimed!.claimToken);
    expect(await markSlackMessageRelayDelivered(claimed!)).toBe(false); // the crashed owner is fenced out
    expect(await markSlackMessageRelayDelivered(again!)).toBe(true);
  });

  it("defer refunds attempts only when asked and keeps the absolute future time", async () => {
    await enqueueSlackMessageRelay(meta(1));
    const [r1] = await claimSlackMessageRelayBatch(1, 5_000);
    await deferSlackMessageRelay(r1!, 3_600_000, { statusCode: 429, error: "rate_limited", countAttempt: false });
    const [row] = await rows();
    expect(row).toMatchObject({ status: "pending", attempts: 0, last_status_code: 429 });
    expect(new Date(row.next_attempt_at).getTime() - Date.now()).toBeGreaterThan(3_500_000);
    expect(await claimSlackMessageRelayBatch(1, 5_000)).toHaveLength(0);
  });

  it("retention: delivered rows expire, failed rows are retained longer, stale pending rows dead-letter", async () => {
    for (let n = 1; n <= 4; n++) await enqueueSlackMessageRelay(meta(n));
    await getPool().query(`UPDATE slack_message_relay_outbox SET status='delivered', updated_at = now() - interval '4 days' WHERE event_id = 'Ev0SYNTH0001'`);
    await getPool().query(`UPDATE slack_message_relay_outbox SET status='delivered', updated_at = now() - interval '1 hour' WHERE event_id = 'Ev0SYNTH0002'`);
    await getPool().query(`UPDATE slack_message_relay_outbox SET status='failed', updated_at = now() - interval '4 days' WHERE event_id = 'Ev0SYNTH0003'`);
    await getPool().query(`UPDATE slack_message_relay_outbox SET created_at = now() - interval '4 days', next_attempt_at = now() - interval '4 days' WHERE event_id = 'Ev0SYNTH0004'`);
    const result = await pruneSlackMessageRelays({ deliveredMs: 3 * 86_400_000, failedMs: 30 * 86_400_000, maxPendingAgeMs: 3 * 86_400_000, batch: 100 });
    expect(result).toEqual({ expired: 1, deleted: 1 });
    expect((await rows()).map((r) => [r.event_id, r.status, r.last_error])).toEqual([
      ["Ev0SYNTH0002", "delivered", null], ["Ev0SYNTH0003", "failed", null], ["Ev0SYNTH0004", "failed", "expired"],
    ]);
    expect(await getSlackMessageRelayStats()).toEqual({ pending: 0, delivering: 0, delivered: 1, failed: 2, parked: 0 });
  });

  it("retention measures pending age from the scheduled retry, so a long Retry-After is never expired early", async () => {
    await enqueueSlackMessageRelay(meta(1));
    await getPool().query(`UPDATE slack_message_relay_outbox SET created_at = now() - interval '4 days', next_attempt_at = now() + interval '2 days'`);
    expect(await pruneSlackMessageRelays({ deliveredMs: 1, failedMs: 1, maxPendingAgeMs: 3 * 86_400_000, batch: 10 })).toEqual({ expired: 0, deleted: 0 });
    expect((await rows())[0]).toMatchObject({ status: "pending" });
  });

  describe("every drainer database call is bounded under a held lock (real PostgreSQL)", () => {
    const hold = async () => {
      const holder = await getPool().connect();
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE slack_message_relay_outbox IN ACCESS EXCLUSIVE MODE");
      return { release: async () => { await holder.query("ROLLBACK"); holder.release(); } };
    };

    it("claim, outcomes, requeue, prune and stats all fail within their total deadline instead of waiting on the lock", async () => {
      await enqueueSlackMessageRelay(meta(1));
      const [claimed] = await claimSlackMessageRelayBatch(1, 60_000);
      const lock = await hold();
      const retention = { deliveredMs: 1, failedMs: 1, maxPendingAgeMs: 1, batch: 10 };
      const calls: Array<[string, () => Promise<unknown>]> = [
        ["claim", () => claimSlackMessageRelayBatch(5, 1_000, undefined, TINY)],
        ["delivered", () => markSlackMessageRelayDelivered(claimed!, {}, undefined, TINY)],
        ["defer", () => deferSlackMessageRelay(claimed!, 1, { countAttempt: true }, undefined, TINY)],
        ["finish", () => finishSlackMessageRelayUndelivered(claimed!, "failed", { error: "x" }, undefined, TINY)],
        ["requeue", () => requeueParkedSlackMessageRelays(undefined, TINY)],
        ["prune", () => pruneSlackMessageRelays(retention, undefined, TINY)],
        ["stats", () => getSlackMessageRelayStats(undefined, TINY)],
      ];
      try {
        for (const [name, call] of calls) {
          const started = Date.now();
          await expect(call(), name).rejects.toThrow();
          expect(Date.now() - started, name).toBeLessThan(TINY.totalMs + 400);
        }
      } finally { await lock.release(); }
      // Nothing was changed and no connection leaked: the same claim can still finish once the lock is gone.
      expect(await markSlackMessageRelayDelivered(claimed!)).toBe(true);
      expect(getPool().waitingCount).toBe(0);
    });

    it("a row whose outcome write timed out stays 'delivering' and is recoverable after its lease", async () => {
      await enqueueSlackMessageRelay(meta(1));
      const [claimed] = await claimSlackMessageRelayBatch(1, 250);
      const lock = await hold();
      await expect(markSlackMessageRelayDelivered(claimed!, {}, undefined, TINY)).rejects.toThrow();
      await lock.release();
      expect((await rows())[0]).toMatchObject({ status: "delivering" });
      await new Promise((r) => setTimeout(r, 300));
      const [again] = await claimSlackMessageRelayBatch(1, 1_000);
      expect(again).toMatchObject({ eventId: "Ev0SYNTH0001", attempts: 2 });
    });

    it("shutdown during a blocked outcome write and blocked maintenance terminates within bounds, then the pool closes cleanly", async () => {
      const radar = radarStub(); const url = await radar.listen();
      await enqueueSlackMessageRelay(meta(1));
      const bounded: RelayStore = {
        ...databaseRelayStore,
        claim: (l, m) => claimSlackMessageRelayBatch(l, m, undefined, TINY),
        delivered: (r, d) => markSlackMessageRelayDelivered(r, d, undefined, TINY),
        defer: (r, ms, d) => deferSlackMessageRelay(r, ms, d, undefined, TINY),
        finish: (r, st, d) => finishSlackMessageRelayUndelivered(r, st, d, undefined, TINY),
        prune: () => pruneSlackMessageRelays({ deliveredMs: 1, failedMs: 1, maxPendingAgeMs: 1e12, batch: 10 }, undefined, TINY),
        stats: () => getSlackMessageRelayStats(undefined, TINY),
      };
      // Let one claim happen, then lock the table before the outcome write; maintenance is also blocked.
      const gate: { lock?: { release(): Promise<void> } } = {};
      const claimed: RelayStore = { ...bounded, claim: async (l, m) => { const r = await bounded.claim(l, m); gate.lock = await hold(); return r; } };
      const d = drainer(url, { stopTimeoutMs: 2_000 }, claimed);
      await d.start();
      await until(async () => radar.committed.size === 1);
      const started = Date.now();
      await d.stop();
      expect(Date.now() - started).toBeLessThan(2_500);
      await gate.lock!.release();
      await radar.close();
      const before = (await rows())[0];
      await closePool(); // would hang or throw if a writer were still holding a connection
      expect(before).toMatchObject({ status: "delivering", event_id: "Ev0SYNTH0001" });
      // The unfinished row recovers after its lease through a fresh pool (duplicate-safe, same eventId).
      await new Promise((r) => setTimeout(r, 1_200));
      const [recovered] = await claimSlackMessageRelayBatch(1, 5_000);
      expect(recovered).toMatchObject({ eventId: "Ev0SYNTH0001" });
    });
  });

  it("shutdown while maintenance is blocked on a held lock returns within bounds and logs metadata only", async () => {
    const holder = await getPool().connect();
    await holder.query("BEGIN");
    await holder.query("LOCK TABLE slack_message_relay_outbox IN ACCESS EXCLUSIVE MODE");
    const maintenanceBlocked: RelayStore = {
      ...databaseRelayStore,
      requeueParked: () => requeueParkedSlackMessageRelays(undefined, TINY),
      prune: () => pruneSlackMessageRelays({ deliveredMs: 1, failedMs: 1, maxPendingAgeMs: 1e12, batch: 10 }, undefined, TINY),
      stats: () => getSlackMessageRelayStats(undefined, TINY),
      claim: (l, m) => claimSlackMessageRelayBatch(l, m, undefined, TINY),
    };
    const d = drainer("http://127.0.0.1:9/internal/v1/slack/message-events", { stopTimeoutMs: 2_000 }, maintenanceBlocked);
    const started = Date.now();
    await d.start(); // requeue is blocked too
    await new Promise((r) => setTimeout(r, 150)); // first tick is stuck in blocked maintenance
    await d.stop();
    expect(Date.now() - started).toBeLessThan(2_500);
    await holder.query("ROLLBACK"); holder.release();
    await closePool();
    expect(vi.mocked((await import("../../logger.js")).logger.error)).toHaveBeenCalledWith(expect.stringContaining("drain 실패"), { errorName: expect.any(String) });
  });

  describe("drainer against a real HTTP Radar stub", () => {
    it("delivers pending rows with 2xx only after the stub committed; body is exact v1 metadata", async () => {
      const radar = radarStub(); const url = await radar.listen();
      await enqueueSlackMessageRelay(meta(1, { threadTs: "1699999999.000001", subtype: "thread_broadcast" }));
      await enqueueSlackMessageRelay(meta(2, { userId: null, subtype: "bot_message" }));
      const d = drainer(url); await d.start();
      await until(async () => (await getSlackMessageRelayStats()).delivered === 2);
      await d.stop(); await radar.close();
      expect(radar.requests.every((r) => r.key === "shared-key-0123456789")).toBe(true);
      expect(radar.committed.get("Ev0SYNTH0002")).toEqual({ version: 1, teamId: "T2SRCGYPQ", appId: "A0ATZCLF99A", eventId: "Ev0SYNTH0002", channelId: "C0SYNTH01", ts: "1700000000.000002", threadTs: null, userId: null, subtype: "bot_message" });
      expect(Object.keys(radar.requests[0]!.body).sort()).toEqual(["appId", "channelId", "eventId", "subtype", "teamId", "threadTs", "ts", "userId", "version"]);
      expect((await rows()).every((r) => r.status === "delivered" && r.delivered_at && r.claim_token === null)).toBe(true);
    });

    it("503 is retried with the SAME eventId until Radar commits; duplicates are harmless", async () => {
      const radar = radarStub(); const url = await radar.listen();
      radar.script.push("503", "503");
      await enqueueSlackMessageRelay(meta(1));
      const d = drainer(url); await d.start();
      await until(async () => (await getSlackMessageRelayStats()).delivered === 1);
      await d.stop(); await radar.close();
      expect(radar.requests.map((r) => r.body.eventId)).toEqual(["Ev0SYNTH0001", "Ev0SYNTH0001", "Ev0SYNTH0001"]);
      expect(radar.committed.size).toBe(1);
      expect((await rows())[0]).toMatchObject({ status: "delivered", attempts: 3 });
    });

    it("unknown commit (Radar committed but the connection dropped) and lost request both recover by retry", async () => {
      const radar = radarStub(); const url = await radar.listen();
      radar.script.push("commit-then-drop", "drop-before-commit");
      await enqueueSlackMessageRelay(meta(1)); await enqueueSlackMessageRelay(meta(2));
      const d = drainer(url, { concurrency: 1 }); await d.start();
      await until(async () => (await getSlackMessageRelayStats()).delivered === 2);
      await d.stop(); await radar.close();
      expect([...radar.committed.keys()].sort()).toEqual(["Ev0SYNTH0001", "Ev0SYNTH0002"]);
      expect(radar.requests.length).toBeGreaterThan(2); // at least one duplicate send
    });

    it("crash after the HTTP send but before the delivered write: lease expiry resends the same event", async () => {
      const radar = radarStub(); const url = await radar.listen();
      await enqueueSlackMessageRelay(meta(1));
      const crashing: RelayStore = { ...databaseRelayStore, delivered: async () => { throw new Error("process died before write"); } };
      const first = drainer(url, {}, crashing);
      await first.tick(); await first.stop();
      expect(radar.committed.size).toBe(1);
      expect((await rows())[0]).toMatchObject({ status: "delivering" });
      const second = drainer(url); await second.start();
      await until(async () => (await getSlackMessageRelayStats()).delivered === 1);
      await second.stop(); await radar.close();
      expect(radar.requests.map((r) => r.body.eventId)).toEqual(["Ev0SYNTH0001", "Ev0SYNTH0001"]);
    });

    it("full 429 Retry-After is stored durably (>1h) and the row is not retried meanwhile, even across a restart", async () => {
      const radar = radarStub(); const url = await radar.listen();
      radar.script.push("429-long");
      await enqueueSlackMessageRelay(meta(1));
      const d = drainer(url); await d.start();
      await until(async () => (await rows())[0]?.last_status_code === 429);
      await d.stop();
      const [row] = await rows();
      expect(row).toMatchObject({ status: "pending", attempts: 0 });
      expect(new Date(row.next_attempt_at).getTime() - Date.now()).toBeGreaterThan(7_000_000);
      const restarted = drainer(url); await restarted.start();
      await new Promise((r) => setTimeout(r, 250));
      await restarted.stop(); await radar.close();
      expect(radar.requests).toHaveLength(1);
    });

    it("Retry-After: 172800 is stored as >= 172800s (no 24h cap); an absurd value parks visibly and is not auto-requeued", async () => {
      const radar = radarStub(); const url = await radar.listen();
      radar.script.push("429-172800");
      await enqueueSlackMessageRelay(meta(1));
      const d = drainer(url); await d.start();
      await until(async () => (await rows())[0]?.last_status_code === 429);
      await d.stop();
      const [row] = await rows();
      expect(new Date(row.next_attempt_at).getTime() - Date.now()).toBeGreaterThanOrEqual(172_800_000 - 5_000);
      expect(row).toMatchObject({ status: "pending", attempts: 0, last_error: "rate_limited" });

      await getPool().query("TRUNCATE slack_message_relay_outbox RESTART IDENTITY");
      radar.script.push("429-absurd");
      await enqueueSlackMessageRelay(meta(2));
      const e = drainer(url); await e.start();
      await until(async () => (await getSlackMessageRelayStats()).parked === 1);
      await e.stop();
      expect((await rows())[0]).toMatchObject({ status: "parked", last_error: "retry_after_excessive" });
      const again = drainer(url); await again.start(); // restart must NOT requeue it (that would be an early retry)
      await new Promise((r) => setTimeout(r, 200));
      await again.stop(); await radar.close();
      expect((await rows())[0]).toMatchObject({ status: "parked" });
      expect(radar.requests).toHaveLength(2);
    });

    it("401 parks visibly, stops sending (no endless retry), and a restart after fixing the key re-queues parked rows", async () => {
      const radar = radarStub(); const url = await radar.listen();
      radar.script.push("401");
      for (let n = 1; n <= 4; n++) await enqueueSlackMessageRelay(meta(n));
      const d = drainer(url, { concurrency: 1 }); await d.start();
      await until(async () => (await getSlackMessageRelayStats()).parked === 1);
      await new Promise((r) => setTimeout(r, 300));
      await d.stop();
      expect(radar.requests).toHaveLength(1);
      expect(await getSlackMessageRelayStats()).toMatchObject({ parked: 1, delivered: 0, failed: 0 });
      expect((await rows()).filter((r) => r.status === "pending")).toHaveLength(3);

      const fixed = drainer(url); await fixed.start();
      await until(async () => (await getSlackMessageRelayStats()).delivered === 4);
      await fixed.stop(); await radar.close();
    });

    it("shutdown: stop() then closing the pool leaves no writer behind", async () => {
      const radar = radarStub(); const url = await radar.listen();
      for (let n = 1; n <= 30; n++) await enqueueSlackMessageRelay(meta(n));
      const writes = vi.fn();
      const spying: RelayStore = { ...databaseRelayStore,
        delivered: async (...a) => { writes(); return databaseRelayStore.delivered(...a); },
        defer: async (...a) => { writes(); return databaseRelayStore.defer(...a); } };
      const d = drainer(url, { batchSize: 10, concurrency: 3 }, spying); await d.start();
      await until(async () => writes.mock.calls.length > 0);
      await d.stop();
      const after = writes.mock.calls.length;
      await closePool();
      await new Promise((r) => setTimeout(r, 200));
      expect(writes.mock.calls.length).toBe(after);
      await radar.close();
      expect(vi.mocked((await import("../../logger.js")).logger.error).mock.calls.filter(([m]) => String(m).includes("drain 실패"))).toHaveLength(0);
    });
  });
});
