/**
 * Real shared `database` pool (getPool/closePool, production options) against a NON-PostgreSQL TCP server that accepts
 * connections but never answers the PostgreSQL startup. Needs no database; proves that relay work fails within its
 * deadline AND that the physical connection attempt is terminated by pg-pool's native connectionTimeoutMillis, so pool
 * capacity is not leaked and closePool() settles even though the peer never responds.
 */
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimSlackMessageRelayBatch, closePool, DB_CONNECTION_TIMEOUT_MS, DEFAULT_ENQUEUE_DEADLINES, enqueueSlackMessageRelay,
  getPool, getSlackMessageRelayStats, type SlackMessageRelayMetadata,
} from "database";

const meta = (n: number): SlackMessageRelayMetadata => ({
  teamId: "T2SRCGYPQ", appId: "A0ATZCLF99A", eventId: `Ev0STALL${String(n).padStart(4, "0")}`, channelId: "C0SYNTH01",
  ts: `1700000000.${String(n).padStart(6, "0")}`, threadTs: null, userId: "U0HUMAN01", subtype: null,
});

let server: Server;
let sockets: Socket[];
let closedSockets: number;
const previousUrl = process.env.DATABASE_URL;

beforeEach(async () => {
  sockets = []; closedSockets = 0;
  server = createServer((socket) => {
    sockets.push(socket);
    socket.on("data", () => undefined); // read the startup packet, never answer
    socket.on("close", () => { closedSockets += 1; });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.DATABASE_URL = `postgres://postgres:x@127.0.0.1:${(server.address() as AddressInfo).port}/stalled`;
});
afterEach(async () => {
  await closePool();
  sockets.forEach((s) => s.destroy());
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl;
});
const until = async (fn: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error("condition not reached in time"); await new Promise((r) => setTimeout(r, 25)); }
};

describe("stalled PostgreSQL handshake on the real shared pool", () => {
  it("production pool options carry a finite native connection timeout", () => {
    const pool = getPool();
    expect(DB_CONNECTION_TIMEOUT_MS).toBe(5_000);
    expect(pool.options).toMatchObject({ max: 10, connectionTimeoutMillis: DB_CONNECTION_TIMEOUT_MS });
    expect(DB_CONNECTION_TIMEOUT_MS).toBeGreaterThan(DEFAULT_ENQUEUE_DEADLINES.acquireMs);
  });

  it("enqueue fails within its acquire deadline, the physical socket is destroyed by the native timeout, capacity returns", async () => {
    const started = Date.now();
    await expect(enqueueSlackMessageRelay(meta(1))).rejects.toThrow(/deadline exceeded \(acquire\)/);
    expect(Date.now() - started).toBeLessThan(DEFAULT_ENQUEUE_DEADLINES.acquireMs + 400);
    const pool = getPool();
    expect(pool.totalCount).toBe(1); // still handshaking: this is exactly the leak the native timeout must end
    await until(() => closedSockets === 1, DB_CONNECTION_TIMEOUT_MS + 2_000);
    await until(() => pool.totalCount === 0, 1_000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(DB_CONNECTION_TIMEOUT_MS - 100);
    expect(pool.waitingCount).toBe(0);
    expect(pool.idleCount).toBe(0);
  }, 20_000);

  it("closePool() settles within the native budget even though the peer never responds", async () => {
    await expect(enqueueSlackMessageRelay(meta(2))).rejects.toThrow(/deadline/);
    expect(getPool().totalCount).toBe(1);
    const started = Date.now();
    await closePool(); // pool.end() must wait for the stalled client, which the native timeout terminates
    expect(Date.now() - started).toBeLessThan(DB_CONNECTION_TIMEOUT_MS + 1_500);
    expect(closedSockets).toBe(1);
  }, 20_000);

  it("drainer claim (2s acquire) and stats (maintenance) fail bounded; a burst beyond max leaks no capacity", async () => {
    const started = Date.now();
    await expect(claimSlackMessageRelayBatch(5, 1_000)).rejects.toThrow(/deadline exceeded \(acquire\)/);
    expect(Date.now() - started).toBeLessThan(2_500);
    const burst = await Promise.allSettled(Array.from({ length: 14 }, (_, i) => enqueueSlackMessageRelay(meta(100 + i))));
    expect(burst.every((r) => r.status === "rejected")).toBe(true);
    const pool = getPool();
    expect(pool.totalCount).toBeLessThanOrEqual(10);
    await expect(getSlackMessageRelayStats()).rejects.toThrow();
    await until(() => pool.totalCount === 0 && pool.waitingCount === 0, DB_CONNECTION_TIMEOUT_MS + 3_000);
    expect(closedSockets).toBeGreaterThanOrEqual(10);
    const closing = Date.now();
    await closePool();
    expect(Date.now() - closing).toBeLessThan(1_000);
  }, 30_000);
});
