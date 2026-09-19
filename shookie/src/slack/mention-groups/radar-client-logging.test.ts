import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RadarMentionGroupsClient } from "./radar-client.js";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const privateValue =
  "https://private.example/192.0.2.1?token=xoxp-secret UPRIVATE body-secret";
const body = {
  revision: 1,
  groups: [
    {
      id: "61b37086-28f7-44fd-9683-e1d8821cd51f",
      handle: "private-group",
      aliases: [],
      memberUserIds: ["UPRIVATE"],
    },
  ],
};
const ok = () =>
  new Response(JSON.stringify(body), {
    headers: { ETag: '"mention-groups-1"' },
  });
let logs: Record<string, unknown>[];
let output: unknown[];

beforeEach(() => {
  logs = [];
  output = [];
  for (const method of ["info", "warn", "error", "log"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      output.push(args);
      for (const arg of args) {
        if (arg && typeof arg === "object")
          logs.push(arg as Record<string, unknown>);
      }
    });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setup(fetcher: ReturnType<typeof vi.fn>) {
  let now = 0;
  const radar = new RadarMentionGroupsClient({
    apiUrl: "https://private.example/192.0.2.1",
    apiKey: "private-api-key",
    cacheTtlMs: 1000,
    requestTimeoutMs: 3000,
    fetcher,
    now: () => now,
  });
  return {
    radar,
    expire: () => {
      now += 1001;
    },
  };
}
function requestId(fetcher: ReturnType<typeof vi.fn>, index = 0): string {
  const id = new Headers(fetcher.mock.calls[index]![1].headers).get(
    "X-Request-Id",
  )!;
  expect(id).toMatch(uuid);
  return id;
}
function assertDiagnostics(id: string) {
  const records = logs.filter(
    (log) =>
      log.event === "radar_mention_groups_request" && log.requestId === id,
  );
  expect(records.length).toBeGreaterThan(1);
  for (const record of records) {
    expect(record.elapsedMs).toEqual(expect.any(Number));
    expect(record.stageElapsedMs).toEqual(expect.any(Number));
    expect(record.elapsedMs as number).toBeGreaterThanOrEqual(
      record.stageElapsedMs as number,
    );
    expect(record.stageElapsedMs as number).toBeGreaterThanOrEqual(0);
  }
  const serialized = JSON.stringify(output);
  for (const secret of [
    "private.example",
    "192.0.2.1",
    "private-api-key",
    "UPRIVATE",
    "body-secret",
    "xoxp-secret",
    "private-group",
    "61b37086-28f7-44fd-9683-e1d8821cd51f",
  ]) {
    expect(serialized).not.toContain(secret);
  }
  return records;
}

describe("Radar catalog request diagnostics", () => {
  it("correlates 200/304 stages and only creates a UUID for an actual single-flight request", async () => {
    const notModified = new Response(null, {
      status: 304,
      headers: { ETag: '"mention-groups-1"' },
    });
    const readBody = vi.spyOn(notModified, "text");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(notModified);
    const { radar, expire } = setup(fetcher);
    const [first, concurrent] = await Promise.all([
      radar.getCatalog(),
      radar.getCatalog(),
    ]);
    expect(concurrent).toBe(first);
    expect(await radar.getCatalog()).toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const id = requestId(fetcher);
    const records = assertDiagnostics(id);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: "fetch", outcome: "started" }),
        ...["fetch", "body", "json", "schema", "etag"].map((stage) =>
          expect.objectContaining({ stage, outcome: "completed" }),
        ),
      ]),
    );
    expire();
    expect(await radar.getCatalog()).toBe(first);
    const nextId = requestId(fetcher, 1);
    expect(nextId).not.toBe(id);
    expect(assertDiagnostics(nextId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: "etag", outcome: "completed" }),
      ]),
    );
    expect(readBody).not.toHaveBeenCalled();
  });

  it.each(["fetch", "body"] as const)(
    "reports a 3000ms timeout during %s and permits a later retry",
    async (stage) => {
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "performance"],
      });
      const fetcher = vi
        .fn()
        .mockImplementation((_url: unknown, init: RequestInit) => {
          const pending = () =>
            new Promise<never>((_resolve, reject) => {
              init.signal!.addEventListener("abort", () =>
                reject(new Error(privateValue)),
              );
            });
          return stage === "fetch"
            ? pending()
            : Promise.resolve({ status: 200, text: pending });
        });
      const { radar } = setup(fetcher);
      const result = radar.getCatalog();
      const assertion = expect(result).rejects.toMatchObject({
        code: "timeout",
        diagnostics: { stage, elapsedMs: 3000 },
      });
      await vi.advanceTimersByTimeAsync(3000);
      await assertion;
      expect(assertDiagnostics(requestId(fetcher))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stage,
            outcome: "failed",
            error: "timeout",
            elapsedMs: 3000,
          }),
        ]),
      );
      fetcher.mockResolvedValueOnce(ok());
      await expect(radar.getCatalog()).resolves.toMatchObject({ revision: 1 });
      expect(requestId(fetcher, 1)).not.toBe(requestId(fetcher));
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    ["network_error", "fetch", () => Promise.reject(new Error(privateValue))],
    [
      "network_error",
      "body",
      () =>
        Promise.resolve({
          status: 200,
          text: () => Promise.reject(new Error(privateValue)),
        }),
    ],
    [
      "http_503",
      "http",
      () => Promise.resolve(new Response(privateValue, { status: 503 })),
    ],
    ["invalid_json", "json", () => Promise.resolve(new Response(privateValue))],
    [
      "invalid_schema",
      "schema",
      () => Promise.resolve(new Response(JSON.stringify({ privateValue }))),
    ],
    [
      "invalid_etag",
      "etag",
      () =>
        Promise.resolve(
          new Response(JSON.stringify(body), {
            headers: { ETag: privateValue },
          }),
        ),
    ],
    [
      "unexpected_not_modified",
      "etag",
      () => Promise.resolve(new Response(null, { status: 304 })),
    ],
  ])(
    "preserves %s and records the %s stage without raw input",
    async (code, stage, response) => {
      const fetcher = vi
        .fn()
        .mockImplementation(response as () => Promise<Response>);
      const { radar } = setup(fetcher);
      await expect(radar.getCatalog()).rejects.toMatchObject({
        code,
        diagnostics: { stage },
      });
      const records = assertDiagnostics(requestId(fetcher));
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ stage, outcome: "failed", error: code }),
        ]),
      );
    },
  );
});

it("measures fetch and body durations independently", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const fetcher = vi.fn().mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const response = ok();
    vi.spyOn(response, "text").mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 75));
      return JSON.stringify(body);
    });
    return response;
  });
  const { radar } = setup(fetcher);
  const result = radar.getCatalog();
  await vi.advanceTimersByTimeAsync(100);
  await result;
  expect(assertDiagnostics(requestId(fetcher))).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        stage: "fetch",
        outcome: "completed",
        elapsedMs: 25,
        stageElapsedMs: 25,
        httpStatus: 200,
      }),
      expect.objectContaining({
        stage: "body",
        outcome: "completed",
        elapsedMs: 100,
        stageElapsedMs: 75,
      }),
    ]),
  );
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects an invalid 304 ETag without logging the header or falling back to stale membership", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(ok())
    .mockResolvedValueOnce(
      new Response(null, { status: 304, headers: { ETag: privateValue } }),
    );
  const { radar, expire } = setup(fetcher);
  await radar.getCatalog();
  expire();
  await expect(radar.getCatalog()).rejects.toMatchObject({
    code: "invalid_not_modified_etag",
  });
  expect(assertDiagnostics(requestId(fetcher, 1))).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        stage: "etag",
        outcome: "failed",
        error: "invalid_not_modified_etag",
        httpStatus: 304,
      }),
    ]),
  );
});
