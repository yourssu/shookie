import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_RESPONSE_BYTES, MAX_RESULT_BYTES, PostHogClient, PostHogClientManager } from "./client.js";
import { createPostHogTools } from "./tools.js";
import { getDashboardSchema, listPersonsSchema, queryEventsSchema, queryHogQLSchema, resultSchema, simpleLimitSchema } from "./schemas.js";

const client = () => new PostHogClient("dummy-only-token", "123", "fixture");
const respond = (body: unknown, status = 200) => vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })));
afterEach(() => vi.unstubAllGlobals());

describe("PostHog structured contracts (mock network only)", () => {
  it("distinguishes empty success from errors and supplies source", async () => {
    respond({ results: [], next: null });
    const result = await client().queryEvents({ limit: 10 });
    expect(resultSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ status: "success", data: { records: [] }, source: { project: "fixture", projectId: "123", resource: "events" }, pagination: { hasMore: false, truncated: false, continuation: null } });
    expect(Number.isFinite(Date.parse(result.source.fetchedAt))).toBe(true);
  });
  it("preserves row/column mapping and original query evidence", async () => {
    respond({ columns: ["date", "count"], results: [["2026-01-02", 2]] });
    const query = "SELECT date, count FROM fixture LIMIT 10";
    expect(await client().queryHogQL(query)).toMatchObject({ status: "success", data: { columns: ["date", "count"], rows: [["2026-01-02", 2]] }, source: { query } });
    respond({ columns: ["a", "b"], results: [[1]] });
    expect(await client().queryHogQL(query)).toMatchObject({ status: "error", error: { code: "invalid_response", retryable: false } });
  });
  it.each([400, 401, 403, 404, 429, 500, 503])("classifies HTTP %s without exposing upstream body", async status => {
    respond({ detail: "secret upstream stack dummy-only-token" }, status);
    const result = await client().listDashboards();
    expect(result).toMatchObject({ status: "error", data: null, error: { retryable: status === 429 || status >= 500, httpStatus: status } });
    expect(JSON.stringify(result)).not.toMatch(/dummy-only-token|upstream stack|Authorization/);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
  it.each(["TimeoutError", "AbortError", "TypeError"])("classifies %s without retry loops or stacks", async name => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Object.assign(new Error("dummy-only-token stack"), { name })));
    expect(await client().listCohorts()).toMatchObject({ status: "error", error: { code: name === "TypeError" ? "network_error" : "timeout", retryable: true } });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
  it.each([{}, { results: "bad" }, { error: "sensitive" }, { detail: "sensitive" }, { status: "failed" }])("rejects malformed or success-shaped upstream errors %j", async body => {
    respond(body);
    expect(await client().listPersons({})).toMatchObject({ status: "error", data: null });
  });
  it("rejects non-JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>upstream secret</html>")));
    expect(await client().queryEvents({})).toMatchObject({ status: "error", error: { code: "invalid_response" } });
  });
  it("cancels advertised oversized body before reading it", async () => {
    const cancel = vi.fn(); const getReader = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, headers: new Headers({ "content-length": String(MAX_RESPONSE_BYTES + 1) }), body: { cancel, getReader } }));
    expect(await client().listDashboards()).toMatchObject({ status: "error", error: { code: "response_too_large" } });
    expect(cancel).toHaveBeenCalledOnce(); expect(getReader).not.toHaveBeenCalled();
  });
  it("stops streaming at the byte budget before allocating/parsing the full response", async () => {
    const cancel = vi.fn(), releaseLock = vi.fn();
    const read = vi.fn().mockResolvedValue({ done: false, value: new Uint8Array(64 * 1024) });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, headers: new Headers(), body: { getReader: () => ({ read, cancel, releaseLock }) } }));
    expect(await client().listDashboards()).toMatchObject({ status: "error", error: { code: "response_too_large" } });
    expect(read).toHaveBeenCalledTimes(5); expect(cancel).toHaveBeenCalledOnce(); expect(releaseLock).toHaveBeenCalledOnce();
  });
  it("reports oversized single records and record limits honestly, without cutting JSON", async () => {
    respond({ results: [{ id: 1, description: "x".repeat(14000) }, { id: 2, name: "fits" }, { id: 3 }] });
    const result = await client().listDashboards({ limit: 1 });
    expect(result).toMatchObject({ status: "success", data: { records: [{ id: 2, name: "fits" }] }, pagination: { truncated: true, omittedRecords: 2, reason: "record_budget" } });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(resultSchema.safeParse(JSON.parse(JSON.stringify(result))).success).toBe(true);
  });
  it("selects person/event fields and partially masks email and sensitive keys in query data", async () => {
    respond({ results: [{ id: "person", distinct_ids: ["private"], properties: { email: "a@example.com", phone: "123" }, created_at: "date" }] });
    expect(await client().listPersons({})).toMatchObject({ data: { records: [{ id: "person", created_at: "date" }] } });
    respond({ columns: ["value"], results: [[{ email: "a@example.com", token: "private", note: "hello a@example.com" }]] });
    const result = await client().queryHogQL("SELECT value");
    expect(JSON.stringify(result.data)).not.toMatch(/a@example.com|private/);
  });
  it("provides bounded same-project offset continuation, reconstructed on the fixed endpoint", async () => {
    respond({ results: [{ id: 1 }], next: "https://app.posthog.com/api/projects/123/events/?limit=10&event=opened&offset=10" });
    const result = await client().queryEvents({ limit: 10, event: "opened" });
    expect(result).toMatchObject({ pagination: { continuation: "offset:10", hasMore: true, truncated: false } });
    respond({ results: [], next: null });
    await client().queryEvents({ limit: 10, event: "opened", continuation: "offset:10" });
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toBe("https://app.posthog.com/api/projects/123/events/?limit=10&offset=10&event=opened");
    expect(options).toMatchObject({ redirect: "error" });
  });
  it.each([
    "https://evil.example/api/projects/123/events/?limit=10&offset=10",
    "http://app.posthog.com/api/projects/123/events/?limit=10&offset=10",
    "https://app.posthog.com/api/projects/999/events/?limit=10&offset=10",
    "https://app.posthog.com/api/projects/123/persons/?limit=10&offset=10",
    "https://user:pass@app.posthog.com/api/projects/123/events/?limit=10&offset=10",
    "?limit=10&offset=10&unexpected=secret", "?limit=10&offset=10&offset=20", "?limit=100&offset=10",
    "?limit=10&offset=0", "?limit=10&offset=10000000", "nonsense", 42, {},
  ])("does not follow untrusted or unsupported next %j", async next => {
    respond({ results: [], next });
    expect(await client().queryEvents({ limit: 10 })).toMatchObject({ status: "success", pagination: { continuation: null, hasMore: true, truncated: true, reason: "unsupported_next" } });
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
  });
  it("retains incomplete query metadata", async () => {
    respond({ columns: ["n"], results: [[1]], hasMore: true });
    expect(await client().queryHogQL("SELECT 1")).toMatchObject({ pagination: { hasMore: true, truncated: true, reason: "upstream_incomplete" } });
  });
  it("bounds multibyte query evidence and errors, masks credential reflections", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const invalid = await client().queryHogQL("한".repeat(3000));
    expect(invalid).toMatchObject({ status: "error", error: { code: "invalid_input" } });
    expect(Buffer.byteLength(JSON.stringify(invalid))).toBeLessThan(MAX_RESULT_BYTES);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(queryHogQLSchema.safeParse({ query: "한".repeat(3000) }).success).toBe(false);
    expect(await client().queryHogQL("SELECT " + "\u0000".repeat(2000))).toMatchObject({ status: "error", error: { code: "invalid_input" } });
    respond({ columns: ["value"], results: [["dummy-only-token"]] });
    const result = await client().queryHogQL("SELECT 'dummy-only-token'");
    expect(JSON.stringify(result)).not.toContain("dummy-only-token");
    expect(result).toMatchObject({ data: { rows: [["[credential masked]"]] } });
  });
  it("bounds recursive data and column metadata", async () => {
    let value: unknown = "nested";
    for (let i = 0; i < 25; i++) value = { nested: value };
    respond({ columns: ["value"], results: [[value]] });
    expect(await client().queryHogQL("SELECT value")).toMatchObject({ status: "error", error: { code: "response_too_complex" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"columns":["n"],"results":[[1e999]]}')));
    expect(await client().queryHogQL("SELECT value")).toMatchObject({ status: "error", error: { code: "invalid_response" } });
    respond({ columns: ["x".repeat(3000)], results: [] });
    expect(await client().queryHogQL("SELECT value")).toMatchObject({ status: "error", error: { code: "response_too_large" } });
  });
  it("uses the fixed resource and limits for each list/detail purpose", async () => {
    for (const [resource, action] of [
      ["insights", () => client().queryInsights(undefined, { limit: 5 })],
      ["feature_flags", () => client().listFeatureFlags({ limit: 5 })],
      ["dashboards", () => client().listDashboards({ limit: 5 })],
      ["persons", () => client().listPersons({ limit: 5 })],
      ["cohorts", () => client().listCohorts(5)],
      ["experiments", () => client().listExperiments(5)],
    ] as const) {
      respond({ results: [{ id: 1, name: "selected", properties: { email: "private" } }] });
      expect(await action()).toMatchObject({ status: "success" });
      expect(String(vi.mocked(fetch).mock.calls[0][0])).toBe(`https://app.posthog.com/api/projects/123/${resource}/?limit=5`);
    }
    respond({ id: 4, name: "insight", result: [3] });
    expect(await client().queryInsights("4")).toMatchObject({ status: "success", data: { records: [{ id: 4, name: "insight", result: [3] }] } });
  });
  it("preserves all nine tool purposes and structured schemas", async () => {
    const manager = new PostHogClientManager("dummy-only-token", [{ name: "fixture", projectId: "123", description: "local" }]);
    const tools = createPostHogTools(manager);
    expect(Object.keys(tools)).toHaveLength(9);
    respond({ results: [] });
    const result = await tools.queryEvents.execute!({ project: "missing", limit: 1 }, {} as never);
    expect(result).toMatchObject({ status: "error", error: { code: "unknown_project" } });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    respond({ id: 3, name: "dashboard", tiles: [{ id: 1, insight: { id: 2, name: "trend", result: [2] } }] });
    expect(await client().getDashboard("3")).toMatchObject({ status: "success", data: { records: [{ id: 3, tiles: [{ id: 1, insight: { id: 2, result: [2] } }] }] } });
  });
});

describe("input bounds", () => {
  it.each([0, -1, 1.5, 101, 1e12, Infinity, NaN])("rejects limit %s at schema and client layers", async limit => {
    expect(simpleLimitSchema.safeParse({ limit }).success).toBe(false);
    vi.stubGlobal("fetch", vi.fn());
    expect(await client().listCohorts(limit)).toMatchObject({ status: "error", error: { code: "invalid_input" } });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
  it("checks dates, IDs, continuation and query lengths", () => {
    expect(queryEventsSchema.safeParse({ after: "yesterday" }).success).toBe(false);
    expect(queryEventsSchema.safeParse({ after: "2026-01-02T00:00:00+09:00", before: "2026-01-01T00:00:00Z" }).success).toBe(false);
    expect(queryEventsSchema.safeParse({ after: "2026-01-01T00:00:00+09:00", before: "2026-01-02T00:00:00+09:00", limit: 1 }).success).toBe(true);
    expect(getDashboardSchema.safeParse({ dashboard_id: "../persons" }).success).toBe(false);
    expect(listPersonsSchema.safeParse({ email: "bad" }).success).toBe(false);
    expect(simpleLimitSchema.safeParse({ continuation: "https://evil.example" }).success).toBe(false);
    expect(queryHogQLSchema.safeParse({ query: "x".repeat(8001) }).success).toBe(false);
    expect(() => new PostHogClient("dummy", "../123")).toThrow();
  });
});
