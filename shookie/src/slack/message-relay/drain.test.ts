import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackMessageRelayRow } from "database";

vi.mock("../../logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import { logger } from "../../logger.js";
import { parseRetryAfter, RelayDrainer, type RelayStore } from "./drain.js";

const row = (n: number, attempts = 1): SlackMessageRelayRow => ({
  id: String(n), teamId: "T2SRCGYPQ", appId: "A0ATZCLF99A", eventId: `Ev0SYNTH${n}`, channelId: "C0SYNTH01",
  ts: "1700000000.000200", threadTs: null, userId: "U0HUMAN01", subtype: null, attempts, claimToken: `tok-${n}`, createdAt: new Date(0),
});
function store(rows: SlackMessageRelayRow[][]): RelayStore & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = { delivered: [], defer: [], finish: [], claim: [], requeue: [] };
  const queue = [...rows];
  return {
    calls,
    claim: async (...a) => { calls.claim!.push(a); return queue.shift() ?? []; },
    delivered: async (...a) => { calls.delivered!.push(a); return true; },
    defer: async (...a) => { calls.defer!.push(a); return true; },
    finish: async (...a) => { calls.finish!.push(a); return true; },
    requeueParked: async () => { calls.requeue!.push([]); return 0; },
    prune: async () => ({ expired: 0, deleted: 0 }),
    stats: async () => ({ pending: 0, delivering: 0, delivered: 0, failed: 0, parked: 0 }),
  };
}
const respond = (status: number, headers: Record<string, string> = {}) => new Response(null, { status, headers });
const make = (s: RelayStore, fetcher: (u: string, i: RequestInit) => Promise<Response>, extra = {}) =>
  new RelayDrainer({ apiUrl: "https://radar.example.test/internal/v1/slack/message-events", apiKey: "k".repeat(24), store: s, fetcher, random: () => 0.5, maintenanceEveryMs: 1e12, ...extra });

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); });

describe("RelayDrainer HTTP contract", () => {
  it("POSTs exactly the version-1 body with the dedicated header, no redirects, and marks 2xx delivered", async () => {
    const s = store([[row(1)]]);
    const fetcher = vi.fn(async () => respond(202));
    const d = make(s, fetcher);
    await d.tick(); await d.stop();
    const [url, init] = fetcher.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://radar.example.test/internal/v1/slack/message-events");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(init.headers).toEqual({ "Content-Type": "application/json", "X-Radar-Internal-Key": "k".repeat(24) });
    expect(JSON.parse(init.body as string)).toEqual({
      version: 1, teamId: "T2SRCGYPQ", appId: "A0ATZCLF99A", eventId: "Ev0SYNTH1", channelId: "C0SYNTH01",
      ts: "1700000000.000200", threadTs: null, userId: "U0HUMAN01", subtype: null,
    });
    expect(s.calls.delivered).toHaveLength(1);
    expect(s.calls.defer).toHaveLength(0);
  });

  it.each([500, 502, 503, 504, 408])("%s keeps the row for a same-eventId retry with bounded exponential jittered backoff", async (status) => {
    const s = store([[row(1, 1)], [row(1, 4)], [row(1, 40)]]);
    const d = make(s, async () => respond(status), { maxAttempts: 100, baseBackoffMs: 1_000, maxBackoffMs: 60_000 });
    await d.tick(); await d.tick(); await d.tick(); await d.stop();
    expect(s.calls.delivered).toHaveLength(0);
    const delays = s.calls.defer.map((c) => c[1] as number);
    // random()=0.5 => 75% of the ceiling; ceilings: 1s, 8s, capped at 60s
    expect(delays).toEqual([750, 6_000, 45_000]);
    for (const c of s.calls.defer) expect(c[2]).toMatchObject({ statusCode: status, countAttempt: true });
  });

  it("network error and timeout are treated as unknown outcomes (retry, same eventId, attempt counted)", async () => {
    vi.useFakeTimers();
    const s = store([[row(1)], [row(2)]]);
    let n = 0;
    const d = make(s, (_u, init) => {
      if (++n === 1) return Promise.reject(new TypeError("fetch failed"));
      return new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }, { requestTimeoutMs: 2_000 });
    await d.tick();
    const second = d.tick();
    await vi.advanceTimersByTimeAsync(2_500);
    await second; await d.stop();
    expect(s.calls.defer.map((c) => (c[2] as { error: string }).error)).toEqual(["network:TypeError", "timeout"]);
    expect(s.calls.defer.every((c) => (c[2] as { countAttempt: boolean }).countAttempt)).toBe(true);
    expect(s.calls.delivered).toHaveLength(0);
  });

  it("honours a full 429 Retry-After durably with NO 30s clamp and refunds the attempt", async () => {
    const s = store([[row(1)], [row(2)], [row(3)]]);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(respond(429, { "retry-after": "3600" }))
      .mockResolvedValueOnce(respond(429, { "retry-after": new Date(Date.now() + 7_200_000).toUTCString() }))
      .mockResolvedValueOnce(respond(429, { "retry-after": String(10 * 24 * 3600) }));
    const d = make(s, fetcher);
    await d.tick(); await d.tick(); await d.tick(); await d.stop();
    const [a, b, c] = s.calls.defer.map((x) => x[1] as number);
    expect(a).toBe(3_600_000);
    expect(b).toBeGreaterThan(7_100_000);
    expect(b).toBeLessThanOrEqual(7_200_000);
    expect(c).toBe(24 * 3600_000); // only a sanity ceiling of 24h for absurd values
    expect(s.calls.defer.every((x) => (x[2] as { countAttempt: boolean }).countAttempt === false)).toBe(true);
    expect(s.calls.finish).toHaveLength(0);
  });

  it("429 without a usable Retry-After defers a conservative default instead of hammering", async () => {
    const s = store([[row(1)]]);
    const d = make(s, async () => respond(429));
    await d.tick(); await d.stop();
    expect(s.calls.defer[0]![1]).toBe(60_000);
    expect(parseRetryAfter("soon", 0)).toBeNull();
    expect(parseRetryAfter(null, 0)).toBeNull();
  });

  it.each([401, 403, 404, 405, 302])("%s is a configuration error: park the row, halt delivery (no endless retry), stay visible", async (status) => {
    const s = store([[row(1), row(2), row(3)], [row(4)]]);
    const fetcher = vi.fn(async () => respond(status));
    const d = make(s, fetcher, { concurrency: 1 });
    await d.tick();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(s.calls.finish[0]!.slice(1)).toEqual(["parked", { statusCode: status, error: "config" }]);
    // The rest of the claimed batch is handed back untouched (no attempt spent) and nothing is sent afterwards.
    expect(s.calls.defer.map((c) => (c[2] as { countAttempt: boolean }).countAttempt)).toEqual([false, false]);
    await d.tick(); await d.tick(); await d.stop();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(s.calls.claim).toHaveLength(1);
    expect(s.calls.delivered).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("park"), expect.objectContaining({ statusCode: status }));
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain("kkkkkkkk");
  });

  it("other 4xx (400/422) is a terminal dead-letter, retained as metadata", async () => {
    const s = store([[row(1)], [row(2)]]);
    const d = make(s, vi.fn().mockResolvedValueOnce(respond(400)).mockResolvedValueOnce(respond(422)));
    await d.tick(); await d.tick(); await d.stop();
    expect(s.calls.finish.map((c) => [c[1], (c[2] as { statusCode: number }).statusCode])).toEqual([["failed", 400], ["failed", 422]]);
  });

  it("gives up with a terminal failed row only after the attempt budget", async () => {
    const s = store([[row(1, 15)]]);
    const d = make(s, async () => respond(503), { maxAttempts: 15 });
    await d.tick(); await d.stop();
    expect(s.calls.finish[0]!.slice(1)).toEqual(["failed", { statusCode: 503, error: "http_503" }]);
    expect(s.calls.defer).toHaveLength(0);
  });

  it("start() re-queues parked rows after the operator fixed configuration", async () => {
    const s = store([]);
    const d = make(s, async () => respond(200));
    await d.start(); await d.stop();
    expect(s.calls.requeue).toHaveLength(1);
  });

  it("bounds request concurrency and batch size", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => row(i + 1));
    const s = store([rows]);
    let active = 0, peak = 0;
    const d = make(s, async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 10)); active--; return respond(200); }, { concurrency: 2, batchSize: 8 });
    await d.tick(); await d.stop();
    expect(peak).toBe(2);
    expect(s.calls.delivered).toHaveLength(8);
    expect(s.calls.claim[0]![0]).toBe(8);
  });

  it("a database write failure after a 2xx leaves the lease to expire (duplicate-safe), never marking success twice", async () => {
    const s = store([[row(1)]]);
    s.delivered = async () => { throw new Error("db write lost"); };
    const d = make(s, async () => respond(200));
    await d.tick(); await d.stop();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("결과 기록 실패"), expect.objectContaining({ eventId: "Ev0SYNTH1" }));
    expect(s.calls.defer).toHaveLength(0);
    expect(s.calls.finish).toHaveLength(0);
  });

  it("a claim failure (database outage) is logged metadata-only and polling continues", async () => {
    vi.useFakeTimers();
    const s = store([]);
    let n = 0;
    s.claim = async () => { if (++n === 1) throw new Error("conn refused"); return []; };
    const d = make(s, async () => respond(200), { errorPollMs: 1_000, idlePollMs: 1_000 });
    await d.start();
    await vi.advanceTimersByTimeAsync(5_000);
    await d.stop();
    expect(n).toBeGreaterThanOrEqual(2);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("drain 실패"), { errorName: "Error" });
  });

  it("stop() aborts in-flight HTTP, hands the row back, and no store call happens afterwards", async () => {
    const s = store([[row(1)]]);
    let started!: () => void;
    const inFlight = new Promise<void>((r) => { started = r; });
    const d = make(s, (_u, init) => new Promise((_, reject) => { started(); init.signal!.addEventListener("abort", () => reject(new Error("aborted"))); }), { requestTimeoutMs: 60_000 });
    const tick = d.tick();
    await inFlight;
    await d.stop();
    await tick;
    expect(s.calls.defer).toHaveLength(1);
    expect(s.calls.defer[0]![2]).toMatchObject({ error: "shutdown", countAttempt: false });
    const before = Object.values(s.calls).flat().length;
    await new Promise((r) => setTimeout(r, 30));
    expect(Object.values(s.calls).flat().length).toBe(before);
  });
});
