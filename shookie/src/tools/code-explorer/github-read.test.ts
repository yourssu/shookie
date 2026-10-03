import { describe, expect, it, vi, afterEach } from "vitest";
import { buildReadUrl, readInput, readGithub, READ_TIMEOUT_MS, createGithubReadTool } from "./github-read.js";
const config = { owner: "yourssu", gitHubToken: "dummy-secret", repositories: ["allowed"] };
const mock = (data: unknown, headers = {}) => vi.fn().mockResolvedValue(new Response(JSON.stringify(data), { headers }));
afterEach(() => vi.useRealTimers());
describe("fixed-host read boundary", () => {
  it.each(["repository", "tree", "file", "history", "pull_requests", "pull_request", "issues", "issue"])("supports %s", async operation => {
    const input = { operation, repo: "allowed", ...(operation === "tree" ? { ref: "main" } : {}), ...(operation === "file" ? { path: "src/a b.ts", ref: "main" } : {}), ...(["pull_request", "issue"].includes(operation) ? { number: 1 } : {}) };
    const fetcher = mock({ sha: "abc", content: Buffer.from("hello").toString("base64"), encoding: "base64", download_url: "https://evil.test" });
    const result = await readGithub(config, input, fetcher);
    expect(result.repo).toBe("allowed"); expect(result.source).toContain("https://api.github.com/repos/yourssu/allowed");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "GET", redirect: "error" });
    if (operation === "file") expect(result.data).toContain("hello");
  });
  it("filters repository listing and never follows next links", async () => {
    const fetcher = mock([{ name: "allowed", owner: { login: "yourssu" } }, { name: "private" }], { link: '<https://evil.test>; rel="next"' });
    const result = await readGithub(config, { operation: "repositories" }, fetcher);
    expect(result.data).not.toContain("private"); expect(result.hasNextPage).toBe(true); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    { operation: "push" }, { operation: "api" }, { operation: "clone" }, { operation: "repository", repo: "other" },
    { operation: "file", repo: "allowed", path: "../secret" }, { operation: "file", repo: "allowed", path: "/etc/passwd" },
    { operation: "tree", repo: "allowed", ref: "-c" }, { operation: "tree", repo: "allowed", ref: "https://evil.test" },
    { operation: "repository", repo: "allowed", args: ["-C", "/tmp"] }, { operation: "repositories", page: 101 },
    { operation: "repository", repo: "allowed", url: "https://evil.test" }, { operation: "file", repo: "allowed", path: "a\\b" },
  ])("refuses unsupported/malicious input %#", async input => {
    const fetcher = mock({}); await expect(readGithub(config, input, fetcher)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  });
  it("encodes path and ref without endpoint injection", () => {
    const url = buildReadUrl(config, readInput.parse({ operation: "file", repo: "allowed", path: "a?#/b%2f", ref: "feature/x" }));
    expect(url.pathname).toContain("a%3F%23/b%252f"); expect(url.searchParams.get("ref")).toBe("feature/x");
  });
  it("uses separate credential when supplied and redacts both tokens and decoded file secrets", async () => {
    const fetcher = mock({ encoding: "base64", content: Buffer.from("dummy-secret read-secret").toString("base64") });
    const result = await readGithub({ ...config, readOnlyToken: "read-secret" }, { operation: "file", repo: "allowed", path: "x" }, fetcher);
    expect(JSON.stringify(result)).not.toMatch(/dummy-secret|read-secret/);
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Bearer read-secret");
  });
  it("bounds response bytes and model output", async () => {
    await expect(readGithub(config, { operation: "repository", repo: "allowed" }, mock({ x: "x".repeat(300000) }))).rejects.toThrow();
    const result = await readGithub(config, { operation: "repository", repo: "allowed" }, mock({ x: "한".repeat(20000) }));
    expect(Buffer.byteLength(result.data)).toBeLessThanOrEqual(32768); expect(result.truncated).toBe(true);
  });
  it("rejects redirect responses", async () => {
    await expect(readGithub(config, { operation: "repository", repo: "allowed" }, vi.fn().mockResolvedValue(new Response(null, { status: 302 })))).rejects.toThrow();
  });
  it("times out and aborts even a hung mock", async () => {
    vi.useFakeTimers(); const fetcher = vi.fn((_url: Parameters<typeof fetch>[0], _options?: RequestInit) => new Promise<Response>(() => {}));
    const pending = readGithub(config, { operation: "repository", repo: "allowed" }, fetcher);
    const assertion = expect(pending).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS); await assertion;
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
  it("accepts the trusted shared context without caller identity arguments", async () => {
    const fetcher = mock({ name: "allowed" }); vi.stubGlobal("fetch", fetcher);
    const ids: Record<string, string> = { channel: "C1", threadTs: "123.456", userId: "U1", teamId: "T1", requestId: "req-1" };
    try {
      const result = await createGithubReadTool(config).execute!({ operation: "repository", repo: "allowed", page: 1, perPage: 20 }, { requestContext: { get: (key: string) => ids[key] } } as never);
      expect(result).toHaveProperty("repo", "allowed"); expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  });
  it("applies the same deadline to response-body stalls", async () => {
    vi.useFakeTimers();
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); } }));
    const pending = readGithub(config, { operation: "repository", repo: "allowed" }, vi.fn().mockResolvedValue(response));
    const assertion = expect(pending).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS); await assertion;
  });
  it("fails closed with old/missing context before network", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    try {
      const tool = createGithubReadTool(config);
      const result = await tool.execute!({ operation: "repositories", page: 1, perPage: 20 }, {} as never);
      expect(result).toHaveProperty("error"); expect(fetcher).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});
