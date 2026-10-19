import { describe, it, expect, vi } from "vitest";
import { readGithub, readInput, buildReadUrl } from "./github-read.js";
import { projectGithub } from "./github-projection.js";
import { registryFixture } from "./registry-fixture.test-helper.js";
const config = { owner: "yourssu", gitHubToken: "dummy-secret", repositories: ["allowed"] };
const sha = "a".repeat(40);
const pr = { number: 1, title: "증거", state: "closed", html_url: "https://github.com/yourssu/allowed/pull/1", created_at: "2026-01-01T00:00:00Z" };
const fetcher = (data: unknown, link = "") => vi.fn(async () => Response.json(data, { headers: { link } }));
describe("PR query and operation-specific projection", () => {
  it("makes recent scope explicit and uses exactly requested count", async () => {
    const f = fetcher([pr]);
    const out = await readGithub(config, { operation: "pull_requests", repo: "allowed", perPage: 3 }, f);
    expect("query" in out && out.query).toEqual({ state: "all", sort: "created", direction: "desc", perPage: 3 });
    expect(out.source).toContain("per_page=3");
    expect(out.source).toContain("state=all");
  });
  it.each(["created", "updated", "popularity", "long-running"])("supports GitHub sort %s and explicit direction/state", sort => {
    const url = buildReadUrl(config, readInput.parse({ operation: "pull_requests", repo: "allowed", state: "closed", sort, direction: "desc", page: 2, perPage: 30 }));
    expect(url.searchParams.get("sort")).toBe(sort); expect(url.searchParams.get("direction")).toBe("desc");
    expect(url.searchParams.get("state")).toBe("closed"); expect(url.searchParams.get("page")).toBe("2");
    const implicit = buildReadUrl(config, readInput.parse({ operation: "pull_requests", repo: "allowed", sort }));
    expect(implicit.searchParams.get("direction")).toBe(sort === "created" ? "desc" : "asc");
  });
  it.each([
    { operation: "repositories", state: "all" }, { operation: "repositories", sort: "created" },
    { operation: "repositories", direction: "desc" }, { operation: "repositories", path: "" },
    { operation: "issues", state: "all" }, { operation: "pull_request", state: "open", number: 1 },
    { state: "merged" }, { sort: "comments" }, { direction: "backwards" },
    { page: 0 }, { page: 101 }, { perPage: 0 }, { perPage: 31 }, { count: 3 }, { number: 3 }, { path: "x" }, { ref: "main" },
  ])("rejects incompatible/invalid options before network %#", async patch => {
    const f = fetcher([]);
    await expect(readGithub({ ...config, registry: registryFixture }, { operation: "pull_requests", repo: "allowed", ...patch }, f)).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });
  it("preserves merged_at absent/null/value, never equates closed with merged", async () => {
    const out = await readGithub(config, { operation: "pull_requests", repo: "allowed" }, fetcher([pr, { ...pr, number: 2, merged_at: null }, { ...pr, number: 3, merged_at: "2026-01-02T00:00:00Z" }]));
    const rows = JSON.parse(out.data);
    expect(rows[0]).not.toHaveProperty("merged_at"); expect(rows[0]).not.toHaveProperty("merged");
    expect(rows[1].merged_at).toBeNull(); expect(rows[2].merged_at).toContain("2026");
  });
  it("omits nested payloads and list bodies without losing selected evidence", async () => {
    const out = await readGithub(config, { operation: "pull_requests", repo: "allowed" }, fetcher([{ ...pr, body: "body".repeat(10000), user: { email: "secret@example.org" }, head: { repo: { graph: "huge" } }, merged_at: null }]));
    expect(JSON.parse(out.data)).toEqual([{ ...pr, merged_at: null }]); expect(out.complete).toBe(true);
  });
  it("retains issue endpoint PR discriminator without nested graphs", async () => {
    const out = await readGithub(config, { operation: "issues", repo: "allowed" }, fetcher([{ ...pr, pull_request: { html_url: pr.html_url, merged_at: null, nested: { email: "private" } } }]));
    expect(JSON.parse(out.data)[0].pull_request).toEqual({ html_url: pr.html_url, merged_at: null });
  });
  it("bounds unicode details, preserves refs/stats, redacts selected fields", async () => {
    const out = await readGithub(config, { operation: "pull_request", repo: "allowed", number: 1 }, fetcher({ ...pr, title: "dummy-secret", body: "😀".repeat(16000), base: { ref: "main", sha, repo: { full_name: "yourssu/allowed", owner: { email: "private" } } }, additions: 3 }));
    const data = JSON.parse(out.data);
    expect(data.title).toBe("[REDACTED]"); expect(data.bodyTruncated).toBe(true);
    expect(Buffer.byteLength(data.body)).toBeLessThanOrEqual(8192); expect(data.body).not.toContain("�");
    expect(data.base.sha).toBe(sha); expect(data.additions).toBe(3); expect(data.base.repo).not.toHaveProperty("owner");
    expect(out.truncated).toBe(true); expect(out.complete).toBe(false);
  });
  it("validates every upstream row before requested-count projection and preserves pagination", async () => {
    await expect(readGithub(config, { operation: "pull_requests", repo: "allowed", perPage: 1 }, fetcher([pr, {}]))).rejects.toThrow();
    const out = await readGithub(config, { operation: "pull_requests", repo: "allowed", perPage: 1 }, fetcher([pr, pr], '<https://evil.test>; rel="next"'));
    expect(JSON.parse(out.data)).toHaveLength(1); expect("omittedItems" in out && out.omittedItems).toBe(1); expect(out.complete).toBe(false); expect(out.hasNextPage).toBe(true);
    const partial = await readGithub(config, { operation: "pull_requests", repo: "allowed", perPage: 3 }, fetcher([pr], '<x>; rel="next"'));
    expect(partial.hasNextPage).toBe(true); expect(partial.complete).toBe(true);
  });
  it("uses structural UTF8 byte budget for huge files and trees", async () => {
    const content = "한".repeat(15000);
    const file = await readGithub(config, { operation: "file", repo: "allowed", path: "x" }, fetcher({ type: "file", encoding: "base64", content: Buffer.from(content).toString("base64"), size: Buffer.byteLength(content), sha, path: "x" }));
    expect(JSON.parse(file.data)).toMatchObject({ incomplete: true, data: { sha, path: "x", size: 45000 }, omittedFields: expect.arrayContaining(["content"]) });
    const tree = await readGithub(config, { operation: "tree", repo: "allowed", ref: "main" }, fetcher({ sha, truncated: false, tree: Array.from({ length: 300 }, (_, i) => ({ path: `${i}${"한".repeat(60)}`, mode: "100644", type: "blob", sha })) }));
    expect(Buffer.byteLength(tree.data)).toBeLessThanOrEqual(32768); expect(JSON.parse(tree.data).omittedItems).toBeGreaterThan(0); expect(tree.complete).toBe(false);
  });
  it("measures synthetic serialized PR/history fixtures, not live savings", () => {
    for (const count of [3, 30]) {
      const rows = Array.from({ length: count }, (_, i) => ({ ...pr, number: i + 1, body: "detail evidence not requested ".repeat(100), user: { email: "example@test.invalid", avatar_url: "https://example.invalid/avatar" } }));
      const input = readInput.parse({ operation: "pull_requests", repo: "allowed", perPage: count });
      const projected = projectGithub(input, rows).data;
      expect(projected).toEqual(rows.map(({ body, user, ...evidence }) => evidence));
      console.log(`synthetic PR ${count}: ${Buffer.byteLength(JSON.stringify(rows))} -> ${Buffer.byteLength(JSON.stringify(projected))}`);
      const commits = rows.map(() => ({ sha, html_url: "https://github.com/yourssu/allowed/commit/" + sha, commit: { message: "subject\n\nlong detail ".repeat(50), committer: { date: "2026-01-01T00:00:00Z", email: "example@test.invalid" } } }));
      const history = projectGithub(readInput.parse({ operation: "history", repo: "allowed", perPage: count }), commits).data;
      expect(history.every((row: any) => row.sha === sha && row.subject === "subject" && row.date === "2026-01-01T00:00:00Z")).toBe(true);
      console.log(`synthetic history ${count}: ${Buffer.byteLength(JSON.stringify(commits))} -> ${Buffer.byteLength(JSON.stringify(history))}`);
    }
  });
});
