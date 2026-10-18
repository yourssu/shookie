import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRegistry, registryConfig } from "./registry.js";
import { registryFixture as config, registeredFixture as repo } from "./registry-fixture.test-helper.js";
import { readGithub, createGithubReadTool } from "./github-read.js";
import { createRepositoryTools } from "./repository-tools.js";
const response = (repositories: unknown) => new Response(JSON.stringify({ repositories }));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("fail-closed Radar registry", () => {
  it("disables blank configuration and validates partial/malformed endpoints", () => {
    expect(registryConfig("", "")).toBeNull();
    for (const url of ["", "/relative", "http://radar.test/internal/v1/shookie/github/repositories", `${config.apiUrl}?`, `${config.apiUrl}#x`, `${config.apiUrl}/`, "https://user:pass@radar.test/internal/v1/shookie/github/repositories", "https://radar.test/other"]) expect(() => registryConfig(url, config.apiKey)).toThrow();
    expect(() => registryConfig(config.apiUrl, "")).toThrow();
    expect(registryConfig(config.apiUrl.replace("https://radar.test", "http://localhost"), config.apiKey)).not.toBeNull();
  });
  it("cannot construct production tools with an unrestricted/static-only config", async () => {
    const legacy = { owner: "yourssu", gitHubToken: "token", repositories: ["allowed"], workspaceBasePath: "/tmp/unused", workspaceMaxGb: 1 };
    expect(() => createGithubReadTool(legacy as never)).toThrow();
    expect(() => createRepositoryTools(legacy as never)).toThrow();
    await expect(readGithub({ owner: "yourssu", gitHubToken: "token" }, { operation: "repository", repo: "allowed" })).rejects.toThrow();
  });
  it.each([undefined, {}, [repo, repo], [{ ...repo, owner: "other" }], [{ ...repo, name: "../bad" }], [{ ...repo, instructions: "x".repeat(10001) }], [{ ...repo, updatedAt: "bad" }], [{ ...repo, id: "bad" }], [repo, { ...repo, id: "12345678-1234-4234-8234-123456789abd", name: "ALLOWED" }], Array(1001).fill(repo)])("rejects malformed catalog %# without leaking raw failures", async repositories => {
    await expect(fetchRegistry(config, "yourssu", undefined, vi.fn(async () => response(repositories)))).rejects.toThrow("등록 저장소");
  });
  it("lists and paginates the actual registered catalog without GitHub organization requests", async () => {
    const repositories = Array.from({ length: 61 }, (_, i) => ({ ...repo, id: `12345678-1234-4234-8234-${String(i).padStart(12, "0")}`, name: `repo-${i}`, instructions: `guidance ${i}` }));
    const fetcher = vi.fn(async (_url: unknown) => response(repositories));
    const cfg = { owner: "yourssu", gitHubToken: "github-secret", registry: config };
    const seen: string[] = [];
    for (let page = 1; page <= 4; page++) {
      const result = await readGithub(cfg, { operation: "repositories", page, perPage: 20 }, fetcher);
      seen.push(...JSON.parse(result.data).map((r: typeof repo) => r.name));
      expect(result.hasNextPage).toBe(page < 4);
      expect(result.truncated).toBe(false);
    }
    expect(seen).toEqual(repositories.map(r => r.name));
    for (const call of fetcher.mock.calls) expect(call[0]).toBe(config.apiUrl);
  });
  it("reaches the last of 1000 entries at perPage=1 and bounds instruction previews without dropping repos", async () => {
    const repositories = Array.from({ length: 1000 }, (_, i) => ({ ...repo, id: `12345678-1234-4234-8234-${String(i).padStart(12, "0")}`, name: `repo-${i}`, instructions: "😀".repeat(5000) }));
    const fetcher = vi.fn(async () => response(repositories));
    const cfg = { owner: "yourssu", gitHubToken: "github-secret", registry: config };
    const last = await readGithub(cfg, { operation: "repositories", page: 1000, perPage: 1 }, fetcher);
    expect(JSON.parse(last.data)[0]).toMatchObject({ name: "repo-999", instructionsTruncated: true });
    expect(last.hasNextPage).toBe(false);
    const page = await readGithub(cfg, { operation: "repositories", perPage: 30 }, fetcher);
    expect(JSON.parse(page.data)).toHaveLength(30);
    expect(Buffer.byteLength(page.data)).toBeLessThan(32768);
  });
  it("rejects malformed JSON and oversized bodies, including unadvertised streams", async () => {
    for (const responseFactory of [() => new Response("not json"), () => new Response("{}", { headers: { "content-length": "67108865" } }), () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024 * 1024)); } }))]) {
      await expect(fetchRegistry(config, "yourssu", undefined, vi.fn(async () => responseFactory()))).rejects.toThrow("등록 저장소");
    }
  });
  it("checks fresh catalog for direct repo/ref actions, case variants, revocation and scoped instruction updates", async () => {
    let repositories = [repo];
    const fetcher = vi.fn(async (url: unknown) => String(url) === config.apiUrl ? response(repositories) : new Response(JSON.stringify({ name: "allowed", full_name: "yourssu/allowed", owner: { login: "yourssu" } })));
    vi.stubGlobal("fetch", fetcher);
    const cfg = { owner: "YOURSSU", gitHubToken: "github-secret", registry: config };
    for (const operation of ["repository", "tree", "file", "history", "pull_requests", "pull_request", "issues", "issue"]) await expect(readGithub(cfg, { operation, repo: "unknown", ref: "main" })).rejects.toThrow();
    expect(fetcher.mock.calls.every(c => c[0] === config.apiUrl)).toBe(true);
    await expect(readGithub(cfg, { operation: "file", repo: "allowed", path: config.apiKey })).rejects.toThrow("secret in source");
    const first = await readGithub(cfg, { operation: "repository", repo: "ALLOWED" });
    expect(first.repositoryGuidance?.repository.instructions).toBe(repo.instructions);
    repositories = [{ ...repo, instructions: `updated ${config.apiKey} github-secret` }];
    const second = await readGithub(cfg, { operation: "repository", repo: "allowed" });
    expect(second.repositoryGuidance?.repository.instructions).toBe("updated [REDACTED] [REDACTED]");
    repositories = [];
    await expect(readGithub(cfg, { operation: "repository", repo: "allowed" })).rejects.toThrow();
    expect(JSON.parse((await readGithub(cfg, { operation: "repositories" })).data)).toEqual([]);
    fetcher.mockRejectedValue(new Error(config.apiKey));
    await expect(readGithub(cfg, { operation: "repository", repo: "allowed" })).rejects.toThrow("등록 저장소");
  });
  it("uses only a dedicated header, disallows redirects and redacts registry instructions", async () => {
    const fetcher = vi.fn(async () => response([{ ...repo, instructions: config.apiKey }]));
    const result = await fetchRegistry(config, "yourssu", undefined, fetcher);
    expect(result[0].instructions).toBe("[REDACTED]");
    expect(fetcher).toHaveBeenCalledWith(config.apiUrl, expect.objectContaining({ redirect: "error", headers: { "X-API-Key": config.apiKey, Accept: "application/json" } }));
    for (const status of [302, 401, 500]) await expect(fetchRegistry(config, "yourssu", undefined, vi.fn(async () => new Response("secret", { status })))).rejects.toThrow("등록 저장소");
  });
  it("aborts already-cancelled and in-flight requests even if transport ignores cancellation", async () => {
    const controller = new AbortController(); controller.abort();
    const fetcher = vi.fn(() => new Promise<Response>(() => {}));
    await expect(fetchRegistry(config, "yourssu", controller.signal, fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    const active = new AbortController();
    const pending = fetchRegistry(config, "yourssu", active.signal, fetcher);
    active.abort(); await expect(pending).rejects.toThrow("등록 저장소");
  });
  it("bounds request and body stalls with timeout", async () => {
    vi.useFakeTimers();
    for (const fetcher of [vi.fn((_url: unknown, _init?: RequestInit) => new Promise<Response>(() => {})), vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{")); } })))]) {
      const pending = fetchRegistry({ ...config, requestTimeoutMs: 25 }, "yourssu", undefined, fetcher);
      const check = expect(pending).rejects.toThrow("등록 저장소");
      await vi.advanceTimersByTimeAsync(25); await check;
      expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    }
  });
});
