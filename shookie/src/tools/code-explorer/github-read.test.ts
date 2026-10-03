import { describe, expect, it, vi, afterEach } from "vitest";
import { buildReadUrl, readInput, readGithub, READ_TIMEOUT_MS, createGithubReadTool } from "./github-read.js";
const config = { owner: "yourssu", gitHubToken: "dummy-secret", repositories: ["allowed"] };
const mock = (data: unknown, headers = {}) => vi.fn().mockResolvedValue(new Response(JSON.stringify(data), { headers }));
const sha = "a".repeat(40);
const repo = { name: "allowed", full_name: "yourssu/allowed", owner: { login: "yourssu" } };
const file = (content = "hello", path = "src/a b.ts") => ({ type: "file", sha, path, size: Buffer.byteLength(content), encoding: "base64", content: Buffer.from(content).toString("base64"), download_url: "https://evil.test" });
const detail = { number: 1, title: "Read fixture", state: "open" };
const fixtures: Record<string, unknown> = {
  repository: repo, tree: { sha, truncated: false, tree: [{ path: "src", mode: "040000", type: "tree", sha }] },
  file: file(), history: [{ sha, commit: { message: "Fixture" } }],
  pull_requests: [detail], pull_request: detail, issues: [detail], issue: detail,
};
afterEach(() => vi.useRealTimers());
describe("fixed-host read boundary", () => {
  it.each(["repository", "tree", "file", "history", "pull_requests", "pull_request", "issues", "issue"])("supports %s", async operation => {
    const input = { operation, repo: "allowed", ...(operation === "tree" ? { ref: "main" } : {}), ...(operation === "file" ? { path: "src/a b.ts", ref: "main" } : {}), ...(["pull_request", "issue"].includes(operation) ? { number: 1 } : {}) };
    const fetcher = mock(fixtures[operation]);
    const result = await readGithub(config, input, fetcher);
    expect(result.repo).toBe("allowed"); expect(result.source).toContain("https://api.github.com/repos/yourssu/allowed");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "GET", redirect: "error" });
    if (operation === "file") expect(result.data).toContain("hello");
  });
  it("filters repository listing and never follows next links", async () => {
    const fetcher = mock([repo, { ...repo, name: "private", full_name: "yourssu/private" }], { link: '<https://evil.test>; rel="next"' });
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
    const fetcher = mock(file("dummy-secret read-secret", "x"));
    const result = await readGithub({ ...config, readOnlyToken: "read-secret" }, { operation: "file", repo: "allowed", path: "x" }, fetcher);
    expect(JSON.stringify(result)).not.toMatch(/dummy-secret|read-secret/);
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Bearer read-secret");
  });
  it("bounds response bytes and model output", async () => {
    await expect(readGithub(config, { operation: "repository", repo: "allowed" }, mock({ ...repo, x: "x".repeat(300000) }))).rejects.toThrow();
    const result = await readGithub(config, { operation: "repository", repo: "allowed" }, mock({ ...repo, x: "한".repeat(20000) }));
    expect(Buffer.byteLength(result.data)).toBeLessThanOrEqual(32768); expect(result.truncated).toBe(true);
    expect(result.complete).toBe(false); expect(JSON.parse(result.data).incomplete).toBe(true);
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
    const fetcher = mock(repo); vi.stubGlobal("fetch", fetcher);
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
  it.each(Object.keys(fixtures))("rejects unexpected %s response shape", async operation => {
    const input = { operation, repo: "allowed", ...(operation === "tree" ? { ref: "main" } : {}), ...(operation === "file" ? { path: "src/a b.ts" } : {}), ...(["pull_request", "issue"].includes(operation) ? { number: 1 } : {}) };
    await expect(readGithub(config, input, mock("unexpected"))).rejects.toThrow();
    await expect(readGithub(config, input, mock({}))).rejects.toThrow();
  });
  it.each([
    { ...file(), encoding: "none", content: "", size: 2000000 },
    { ...file(), content: undefined }, { ...file(), content: "", size: 1 },
    { ...file(), type: "dir" }, [file()], { ...file(), type: "symlink", target: "outside" },
    { ...file(), submodule_git_url: "https://evil.test" }, { ...file(), content: "!!!!" },
    { ...file(), content: "aGVsbG8" }, { ...file(), content: "aGVsbG9=", size: 5 },
    { ...file(), size: 999 }, { ...file(), path: "other" },
    { ...file(), content: "/w==", size: 1 },
  ])("rejects unavailable/unsupported file %#", async data => {
    await expect(readGithub(config, { operation: "file", repo: "allowed", path: "src/a b.ts" }, mock(data))).rejects.toThrow();
  });
  it("supports genuine empty files and newline-wrapped base64", async () => {
    const empty = await readGithub(config, { operation: "file", repo: "allowed", path: "empty" }, mock(file("", "empty")));
    expect(JSON.parse(empty.data).content).toBe(""); expect(empty.complete).toBe(true); expect(empty.truncated).toBe(false);
    const wrapped = await readGithub(config, { operation: "file", repo: "allowed", path: "src/a b.ts" }, mock({ ...file(), content: "aGVs\nbG8=\n" }));
    expect(JSON.parse(wrapped.data).content).toBe("hello");
  });
  it("rejects malformed tree entries, details, history and out-of-scope repository responses", async () => {
    await expect(readGithub(config, { operation: "tree", repo: "allowed", ref: "main" }, mock({ sha, truncated: false, tree: [{}] }))).rejects.toThrow();
    await expect(readGithub(config, { operation: "issue", repo: "allowed", number: 1 }, mock({ ...detail, number: 2 }))).rejects.toThrow();
    await expect(readGithub(config, { operation: "history", repo: "allowed" }, mock([{ sha, commit: {} }]))).rejects.toThrow();
    await expect(readGithub(config, { operation: "repositories" }, mock([{ ...repo, owner: { login: "other" } }]))).rejects.toThrow();
    await expect(readGithub(config, { operation: "repositories" }, mock({}))).rejects.toThrow();
    const partial = await readGithub(config, { operation: "tree", repo: "allowed", ref: "main" }, mock({ ...(fixtures.tree as object), truncated: true }));
    expect(partial.complete).toBe(false); expect(partial.truncated).toBe(true);
  });
  it("returns only a friendly error for HTTP200 unavailable inline contents", async () => {
    const fetcher = mock({ ...file(), encoding: "none", content: "dummy-secret", size: 2000000 }); vi.stubGlobal("fetch", fetcher);
    const ids: Record<string, string> = { channel: "C1", threadTs: "123.456", userId: "U1", requestId: "req-1" };
    try {
      const result = await createGithubReadTool(config).execute!({ operation: "file", repo: "allowed", path: "src/a b.ts", page: 1, perPage: 20 }, { requestContext: { get: (key: string) => ids[key] } } as never);
      expect(result).toHaveProperty("error"); expect(result).not.toHaveProperty("data");
      expect(JSON.stringify(result)).not.toContain("dummy-secret");
    } finally { vi.unstubAllGlobals(); }
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
