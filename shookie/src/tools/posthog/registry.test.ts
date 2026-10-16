import { afterEach, describe, expect, it, vi } from "vitest";
import { PostHogClientManager } from "./client.js";
import { createPostHogTools } from "./tools.js";
import { fetchPostHogRegistry, posthogRegistryConfig, POSTHOG_REGISTRY_PATH, type RegisteredPostHogProject } from "./registry.js";
import { listProjectsResultSchema, resultSchema } from "./schemas.js";

const registry = { apiUrl: `https://radar.test${POSTHOG_REGISTRY_PATH}`, apiKey: "dedicated-posthog-registry-key" };
const POSTHOG_KEY = "phx-dummy-posthog-account-key";
const uuid = (i: number) => `12345678-1234-4234-8234-${String(i).padStart(12, "0")}`;
const project = (i: number, overrides: Partial<RegisteredPostHogProject> = {}): RegisteredPostHogProject => ({
  id: uuid(i), projectId: String(1000 + i), name: `Project-${i}`, organizationId: "org-1",
  description: `description ${i}`, instructions: `guidance ${i}`,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...overrides,
});
const json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init);

/** Routes registry vs PostHog requests; the catalog can change between calls. */
function harness(initial: unknown[] | (() => Response)) {
  const state = { catalog: initial, posthog: () => json({ results: [{ id: 1, name: "row" }], next: null, columns: ["n"] }) };
  const registryCalls: RequestInit[] = [];
  const posthogCalls: { url: string; init?: RequestInit }[] = [];
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url) === registry.apiUrl) {
      registryCalls.push(init!);
      return typeof state.catalog === "function" ? state.catalog() : json({ projects: state.catalog });
    }
    posthogCalls.push({ url: String(url), init });
    const body = String(url).includes("/query/") ? { columns: ["n"], results: [[1]] } : String(url).match(/\/(insights|dashboards)\/\d+\/$/) ? { id: 7, name: "detail" } : { results: [{ id: 1, name: "row" }], next: null };
    return json(body);
  });
  vi.stubGlobal("fetch", fetcher);
  const tools = createPostHogTools(new PostHogClientManager(POSTHOG_KEY, registry));
  return { state, tools, registryCalls, posthogCalls, fetcher };
}
type Tools = ReturnType<typeof createPostHogTools>;
const exec = (tools: Tools, name: keyof Tools, input: Record<string, unknown>) =>
  (tools[name] as unknown as { execute: (i: unknown, c: unknown) => Promise<any> }).execute(input, {});

// All nine PostHog operations with valid inputs (project is merged per test).
const operations: [keyof Tools, Record<string, unknown>, string][] = [
  ["queryEvents", { limit: 5 }, "events"],
  ["queryInsights", { limit: 5 }, "insights"],
  ["listFeatureFlags", { limit: 5 }, "feature_flags"],
  ["listDashboards", { limit: 5 }, "dashboards"],
  ["getDashboard", { dashboard_id: "7" }, "dashboards/7"],
  ["queryHogQL", { query: "SELECT 1" }, "query"],
  ["listPersons", { limit: 5 }, "persons"],
  ["listCohorts", { limit: 5 }, "cohorts"],
  ["listExperiments", { limit: 5 }, "experiments"],
];

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Radar PostHog registry configuration", () => {
  it("disables on blank, rejects partial/malformed endpoints and keys", () => {
    expect(posthogRegistryConfig("", "")).toBeNull();
    expect(posthogRegistryConfig(" ", " ")).toBeNull();
    for (const url of ["", "/relative", `http://radar.test${POSTHOG_REGISTRY_PATH}`, `${registry.apiUrl}?`, `${registry.apiUrl}?a=1`, `${registry.apiUrl}#x`, `${registry.apiUrl}/`,
      `https://user:pass@radar.test${POSTHOG_REGISTRY_PATH}`, "https://radar.test/internal/v1/shookie/github/repositories", `${registry.apiUrl.replace("projects", registry.apiKey)}`]) {
      expect(() => posthogRegistryConfig(url, registry.apiKey)).toThrow();
    }
    expect(() => posthogRegistryConfig(registry.apiUrl, "")).toThrow();
    expect(() => posthogRegistryConfig(registry.apiUrl, "short")).toThrow();
    expect(() => posthogRegistryConfig(registry.apiUrl, "has whitespace in key value")).toThrow();
    expect(posthogRegistryConfig(`http://localhost:8080${POSTHOG_REGISTRY_PATH}`, registry.apiKey)).not.toBeNull();
    expect(posthogRegistryConfig(`http://127.0.0.1${POSTHOG_REGISTRY_PATH}`, registry.apiKey)).not.toBeNull();
  });
  it("cannot construct production tools from a static project list or without a registry", () => {
    expect(() => new PostHogClientManager(POSTHOG_KEY, [{ name: "static", projectId: "1", description: "x" }] as never)).toThrow();
    expect(() => new PostHogClientManager(POSTHOG_KEY, undefined as never)).toThrow();
    expect(() => new PostHogClientManager("", registry)).toThrow();
    expect(() => createPostHogTools({ getClient: () => ({}) } as never)).toThrow();
    expect("getClient" in PostHogClientManager.prototype).toBe(false);
  });
});

describe("strict catalog schema", () => {
  it.each([
    ["undefined body", undefined],
    ["missing projects", {}],
    ["extra top-level", { projects: [], extra: 1 }],
    ["duplicate id", { projects: [project(1), project(2, { id: uuid(1) })] }],
    ["duplicate id case", { projects: [project(1, { id: "ABCDEF12-1234-4234-8234-123456789ABC" }), project(2, { id: "abcdef12-1234-4234-8234-123456789abc" })] }],
    ["duplicate projectId", { projects: [project(1), project(2, { projectId: "1001" })] }],
    ["duplicate name case-insensitive", { projects: [project(1), project(2, { name: "PROJECT-1" })] }],
    ["zero projectId", { projects: [project(1, { projectId: "0" })] }],
    ["non-decimal projectId", { projects: [project(1, { projectId: "12a" })] }],
    ["17-digit projectId", { projects: [project(1, { projectId: "1".repeat(17) })] }],
    ["numeric projectId", { projects: [{ ...project(1), projectId: 1001 }] }],
    ["empty name", { projects: [project(1, { name: "" })] }],
    ["long name", { projects: [project(1, { name: "x".repeat(101) })] }],
    ["control char name", { projects: [project(1, { name: "a\nb" })] }],
    ["long description", { projects: [project(1, { description: "x".repeat(1001) })] }],
    ["long instructions", { projects: [project(1, { instructions: "x".repeat(20001) })] }],
    ["bad date", { projects: [project(1, { updatedAt: "yesterday" })] }],
    ["bad uuid", { projects: [project(1, { id: "nope" })] }],
    ["missing organizationId", { projects: [(({ organizationId: _o, ...rest }) => rest)(project(1))] }],
    ["unknown field", { projects: [{ ...project(1), apiToken: "x" }] }],
    ["secret in name", { projects: [project(1, { name: registry.apiKey })] }],
    ["too many", { projects: Array.from({ length: 1001 }, (_, i) => project(i)) }],
  ])("rejects %s without leaking raw failures", async (_label, body) => {
    const failure = fetchPostHogRegistry(registry, { fetcher: vi.fn(async () => json(body)) });
    await expect(failure).rejects.toThrow("Radar PostHog 프로젝트 등록 정보");
    await expect(failure).rejects.not.toThrow(registry.apiKey);
  });
  it("accepts 1000 entries and redacts registry/PostHog secrets in description and instructions", async () => {
    const catalog = Array.from({ length: 1000 }, (_, i) => project(i));
    catalog[0] = project(0, { instructions: `a ${registry.apiKey} b ${POSTHOG_KEY} c ${encodeURIComponent(registry.apiKey)}`, description: `d ${POSTHOG_KEY}` });
    const result = await fetchPostHogRegistry(registry, { fetcher: vi.fn(async () => json({ projects: catalog })), secrets: [POSTHOG_KEY] });
    expect(result).toHaveLength(1000);
    expect(result[0].instructions).toBe("a [REDACTED] b [REDACTED] c [REDACTED]");
    expect(result[0].description).toBe("d [REDACTED]");
  });
  it("uses only the dedicated header, refuses redirects and rejects non-OK/non-JSON/oversized bodies", async () => {
    const fetcher = vi.fn(async () => json({ projects: [] }));
    await fetchPostHogRegistry(registry, { fetcher });
    expect(fetcher).toHaveBeenCalledWith(registry.apiUrl, expect.objectContaining({ method: "GET", redirect: "error", headers: { "X-API-Key": registry.apiKey, Accept: "application/json" } }));
    for (const factory of [
      () => new Response("secret", { status: 302, headers: { location: "https://evil.test" } }), () => new Response("secret", { status: 401 }), () => new Response("secret", { status: 500 }),
      () => new Response("not json"), () => new Response("{}", { headers: { "content-length": String(64 * 1024 * 1024 + 1) } }),
      () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024 * 1024)); } })),
    ]) await expect(fetchPostHogRegistry(registry, { fetcher: vi.fn(async () => factory()) })).rejects.toThrow("Radar PostHog");
    await expect(fetchPostHogRegistry(registry, { fetcher: vi.fn(async () => { throw new Error(registry.apiKey); }) })).rejects.not.toThrow(registry.apiKey);
  });
  it("aborts already-cancelled and in-flight requests even if transport ignores cancellation", async () => {
    const fetcher = vi.fn(() => new Promise<Response>(() => {}));
    const aborted = new AbortController(); aborted.abort();
    await expect(fetchPostHogRegistry(registry, { signal: aborted.signal, fetcher })).rejects.toThrow("Radar PostHog");
    expect(fetcher).not.toHaveBeenCalled();
    const active = new AbortController();
    const pending = fetchPostHogRegistry(registry, { signal: active.signal, fetcher });
    active.abort(); await expect(pending).rejects.toThrow("Radar PostHog");
  });
  it("bounds request and body stalls with a timeout", async () => {
    vi.useFakeTimers();
    for (const fetcher of [vi.fn((_u: unknown, _i?: RequestInit) => new Promise<Response>(() => {})),
      vi.fn(async (_u: unknown, _i?: RequestInit) => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{")); } })))]) {
      const pending = fetchPostHogRegistry({ ...registry, requestTimeoutMs: 25 }, { fetcher });
      const check = expect(pending).rejects.toThrow("Radar PostHog");
      await vi.advanceTimersByTimeAsync(25); await check;
      expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    }
  });
});

describe("every PostHog tool authorizes against the live registry before PostHog", () => {
  it.each(operations)("%s: registry failure, empty, ambiguous, unknown and ID-bypass are denied before any PostHog request", async (name, input) => {
    const h = harness(() => new Response("upstream secret " + registry.apiKey, { status: 503 }));
    const unavailable = await exec(h.tools, name, input);
    expect(unavailable).toMatchObject({ status: "error", data: null, error: { code: "registry_unavailable", retryable: true } });
    expect(JSON.stringify(unavailable)).not.toContain(registry.apiKey);
    h.state.catalog = () => { throw new TypeError("network " + registry.apiKey); };
    expect(await exec(h.tools, name, input)).toMatchObject({ error: { code: "registry_unavailable" } });
    h.state.catalog = [];
    expect(await exec(h.tools, name, input)).toMatchObject({ status: "error", error: { code: "no_registered_projects", retryable: false } });
    h.state.catalog = [project(1), project(2)];
    expect(await exec(h.tools, name, input)).toMatchObject({ status: "error", error: { code: "project_selection_required" } });
    for (const bypass of ["Project-3", "1001", "https://app.posthog.com/project/1001", "Project-1 ", ""]) {
      const result = await exec(h.tools, name, { ...input, project: bypass });
      if (bypass === "Project-1 ") { expect(result).toMatchObject({ status: "success" }); continue; }
      if (bypass === "") { expect(result.status).not.toBe("success"); continue; }
      expect(result).toMatchObject({ status: "error", error: { code: "unknown_project" } });
    }
    expect(h.posthogCalls).toHaveLength(1);
  });

  it.each(operations)("%s: single project is used implicitly, named project is matched case-insensitively and bound to its registered ID with fresh guidance", async (name, input, resource) => {
    const h = harness([project(1, { instructions: "v1" })]);
    const implicit = await exec(h.tools, name, input);
    expect(implicit).toMatchObject({ status: "success", source: { project: "Project-1", projectId: "1001", resource },
      guidance: { project: "Project-1", projectId: "1001", instructions: "v1", selectedImplicitly: true } });
    expect(resultSchema.parse(implicit).guidance?.instructions).toBe("v1");
    expect(h.posthogCalls.at(-1)!.url).toContain("https://app.posthog.com/api/projects/1001/");
    expect(new Headers(h.posthogCalls.at(-1)!.init?.headers).get("Authorization")).toBe(`Bearer ${POSTHOG_KEY}`);
    expect(JSON.stringify(h.posthogCalls)).not.toContain(registry.apiKey);
    h.state.catalog = [project(1, { instructions: `v2 ${POSTHOG_KEY}`, updatedAt: "2026-02-01T00:00:00Z" }), project(2)];
    const named = await exec(h.tools, name, { ...input, project: "project-1" });
    expect(named).toMatchObject({ status: "success", guidance: { instructions: "v2 [REDACTED]", updatedAt: "2026-02-01T00:00:00Z", selectedImplicitly: false } });
    expect(JSON.stringify(named)).not.toContain(POSTHOG_KEY);
    expect(h.registryCalls).toHaveLength(2);
  });

  it("re-fetches on every call: registration, rename, ID change and revocation apply without restart, including continuations", async () => {
    const h = harness([project(1)]);
    h.fetcher.mockImplementationOnce(async () => json({ projects: h.state.catalog }))
      .mockImplementationOnce(async (url: unknown) => json({ results: [{ id: 1 }], next: `${String(url)}&offset=5` }));
    const first = await exec(h.tools, "queryEvents", { limit: 5 });
    expect(first.pagination.continuation).toBe("offset:5");
    // Dynamic registration on the same tool instance.
    h.state.catalog = [project(1), project(9, { name: "New-Project", projectId: "9999" })];
    expect(await exec(h.tools, "listCohorts", { project: "new-project", limit: 5 })).toMatchObject({ status: "success", source: { projectId: "9999" } });
    // Changing the registered ID rebinds the same name to the new ID.
    h.state.catalog = [project(1, { projectId: "4242" })];
    expect(await exec(h.tools, "queryEvents", { limit: 5, continuation: "offset:5" })).toMatchObject({ status: "success", source: { projectId: "4242" } });
    // Rename: the old alias is gone.
    h.state.catalog = [project(1, { name: "Renamed" })];
    expect(await exec(h.tools, "queryEvents", { project: "Project-1", limit: 5, continuation: "offset:5" })).toMatchObject({ error: { code: "unknown_project" } });
    // Revocation: continuations and previously working calls are denied.
    const before = h.posthogCalls.length;
    h.state.catalog = [];
    for (const [name, input] of operations) expect(await exec(h.tools, name, { ...input, ...(name !== "getDashboard" && name !== "queryHogQL" ? { continuation: "offset:5" } : {}) })).toMatchObject({ status: "error", error: { code: "no_registered_projects" } });
    h.state.catalog = [project(2)];
    expect(await exec(h.tools, "queryEvents", { project: "Renamed", limit: 5, continuation: "offset:5" })).toMatchObject({ error: { code: "unknown_project" } });
    expect(h.posthogCalls).toHaveLength(before);
  });

  it("preserves PostHog error classification and masking after authorization", async () => {
    const h = harness([project(1)]);
    h.fetcher.mockImplementation(async (url: unknown) => String(url) === registry.apiUrl ? json({ projects: h.state.catalog }) : json({ detail: `stack ${POSTHOG_KEY}` }, { status: 500 }));
    const result = await exec(h.tools, "listDashboards", { limit: 5 });
    expect(result).toMatchObject({ status: "error", error: { code: "http_error", retryable: true, httpStatus: 500 }, guidance: { project: "Project-1" } });
    expect(resultSchema.safeParse(result).success).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/stack|phx-dummy/);
  });
});

describe("listProjects (PostHog subagent only)", () => {
  it("lists only Radar projects with bounded previews and pagination; empty and failure are friendly", async () => {
    const catalog = Array.from({ length: 61 }, (_, i) => project(i, { instructions: "😀".repeat(5000), description: "설명".repeat(500) }));
    const h = harness(catalog);
    const seen: string[] = [];
    for (let page = 1; page <= 4; page++) {
      const result = await exec(h.tools, "listProjects", { page, perPage: 20 });
      expect(listProjectsResultSchema.parse(result)).toEqual(result);
      expect(result).toMatchObject({ status: "success", total: 61, hasNextPage: page < 4 });
      for (const entry of result.projects) {
        expect(entry.instructionsTruncated).toBe(true);
        expect(entry.descriptionTruncated).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(entry))).toBeLessThanOrEqual(1200);
      }
      seen.push(...result.projects.map((p: { name: string }) => p.name));
    }
    expect(seen).toEqual(catalog.map(p => p.name));
    expect(h.posthogCalls).toHaveLength(0);
    h.state.catalog = Array.from({ length: 1000 }, (_, i) => project(i));
    expect((await exec(h.tools, "listProjects", { page: 1000, perPage: 1 })).projects[0].name).toBe("Project-999");
    h.state.catalog = [];
    expect(await exec(h.tools, "listProjects", {})).toMatchObject({ status: "success", projects: [], total: 0, message: expect.stringContaining("등록된 PostHog 프로젝트가 없습니다") });
    h.state.catalog = () => new Response(registry.apiKey, { status: 500 });
    const failed = await exec(h.tools, "listProjects", {});
    expect(failed).toMatchObject({ status: "error", error: { code: "registry_unavailable", retryable: true } });
    expect(JSON.stringify(failed)).not.toContain(registry.apiKey);
  });
  it("reflects registry updates on the next call and redacts secrets", async () => {
    const h = harness([project(1)]);
    expect((await exec(h.tools, "listProjects", {})).projects.map((p: { name: string }) => p.name)).toEqual(["Project-1"]);
    h.state.catalog = [project(1), project(2, { instructions: `see ${POSTHOG_KEY}` })];
    const next = await exec(h.tools, "listProjects", {});
    expect(next.projects.map((p: { name: string }) => p.name)).toEqual(["Project-1", "Project-2"]);
    expect(JSON.stringify(next)).not.toContain(POSTHOG_KEY);
    expect(next.message).toContain("여러 개");
    expect(h.registryCalls).toHaveLength(2);
  });
});
