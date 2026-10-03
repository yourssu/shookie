import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, access, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RepositorySnapshots, SNAPSHOT_LIMITS, repositoryPath, repositoryRef, type CloneTransport } from "./repository-snapshots.js";
import { isolatedGitEnv, runBoundedProcess } from "./git-process.js";

const actor = { userId: "U1", channel: "C1", threadTs: "123.456", requestId: "req-1", teamId: "T1" };
const context = (changes = {}) => ({ get: (key: string) => ({ ...actor, ...changes })[key as keyof typeof actor] });
let base: string, fixture: string, home: string, workspace: string;
const git = (args: string[]) => runBoundedProcess("/usr/bin/git", args, {
  env: { ...isolatedGitEnv(home), GIT_ALLOW_PROTOCOL: "file" }, timeoutMs: 5_000, maxOutputBytes: 4 * 1024 ** 2,
});
const fixtureTransport: CloneTransport = async request => {
  expect(request.url).toBe("https://github.com/example/sample.git");
  expect(Object.values(request.env).join(" ")).not.toContain("production-secret");
  expect(request.env.GIT_CONFIG_VALUE_8).toContain("Authorization: Basic ");
  await runBoundedProcess("/usr/bin/git", ["clone", "--bare", "--no-local", "--depth=1", "--single-branch", "--no-tags", "--template=", ...(request.ref ? ["--branch", request.ref] : []), "--", `file://${fixture}`, request.destination], {
    env: { ...request.env, GIT_ALLOW_PROTOCOL: "file", GIT_CONFIG_COUNT: "10", GIT_CONFIG_KEY_9: "protocol.file.allow", GIT_CONFIG_VALUE_9: "always" },
    timeoutMs: 5_000, maxOutputBytes: SNAPSHOT_LIMITS.treeBytes, monitor: request.monitor, signal: request.signal,
  });
};
const manager = (transport = fixtureTransport, maxGb = 1) => new RepositorySnapshots({ owner: "example", repositories: ["sample"],
  gitHubToken: "production-secret", readOnlyToken: "dummy-read-token", workspaceBasePath: workspace, workspaceMaxGb: maxGb }, transport);
async function write(path: string, content: string | Buffer) { await writeFile(join(fixture, path), content); }
async function commit() { await git(["-C", fixture, "add", "--all"]); await git(["-C", fixture, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"]); }
async function stages() { const roots = await readdir(workspace); return (await Promise.all(roots.map(root => readdir(join(workspace, root))))).flat(); }

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "controlled-git-test-")); home = join(base, "home"); fixture = join(base, "source"); workspace = join(base, "workspace");
  await mkdir(home); await mkdir(fixture); await mkdir(workspace);
  await git(["init", "--initial-branch=main", "--", fixture]);
  await write("code.ts", "hello needle\nsecond needle\n"); await write("empty", ""); await write("binary", Buffer.from([0, 1, 2]));
  await write("large", Buffer.alloc(SNAPSHOT_LIMITS.blobBytes + 1, 97));
  await write("long", "needle".repeat(10_000));
  await write(".gitmodules", '[submodule "evil"]\npath = evil\nurl = ext::sh -c touch SHOULD_NOT_RUN\n');
  await write(".gitattributes", "*.ts filter=evil\n");
  await symlink("/outside-secret", join(fixture, "link"));
  await commit();
  const sha = (await git(["-C", fixture, "rev-parse", "HEAD"])).toString("ascii").trim();
  await git(["-C", fixture, "update-index", "--add", "--cacheinfo", "160000", sha, "gitlink"]);
  await git(["-C", fixture, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "gitlink"]);
});
afterEach(async () => { await rm(base, { recursive: true, force: true }); });

describe("real bare clone snapshots", () => {
  it("clones once, pins commit, lists and reads/searches with provenance and states", async () => {
    const m = manager(), s = await m.clone({ repo: "sample", ref: "main" }, context());
    expect(s.commitSha).toMatch(/^[a-f0-9]{40}$/); expect(s.owner).toBe("example"); expect(s.ref).toBe("main");
    const list = await m.list(s.snapshotId, context());
    expect(list.files.find(f => f.path === "link")?.mode).toBe("120000");
    const text = await m.read(s.snapshotId, context(), "code.ts");
    expect(text).toMatchObject({ commitSha: s.commitSha, path: "code.ts", lines: ["hello needle", "second needle"], startLine: 1, endLine: 2, complete: true, next: null });
    await write("code.ts", "changed after clone\n"); await commit();
    expect(await m.read(s.snapshotId, context(), "code.ts")).toEqual(text);
    for (const [path, state] of [["empty", "text"], ["binary", "binary"], ["large", "large"], ["long", "large_line"], ["link", "unsupported_symlink_or_gitlink"], ["gitlink", "unsupported_symlink_or_gitlink"], ["absent", "missing"]]) {
      expect(await m.read(s.snapshotId, context(), path)).toMatchObject({ state });
    }
    const found = await m.search(s.snapshotId, context(), "needle");
    expect(found.matches).toEqual([{ path: "code.ts", startLine: 1, endLine: 1, text: "hello needle" }, { path: "code.ts", startLine: 2, endLine: 2, text: "second needle" }]);
    expect(found.skipped.length).toBeGreaterThan(0); expect(found.complete).toBe(false);
    const roots = await readdir(workspace); const [stage] = await readdir(join(workspace, roots[0]));
    const config = await readFile(join(workspace, roots[0], stage, "repository.git", "config"), "utf8");
    expect(config).not.toContain("token"); expect(config).not.toContain("Authorization");
    const dirs = await readdir(join(workspace, roots[0], stage)); expect(dirs).toEqual(["repository.git"]);
  });
  it("requires trusted actor and thread ownership on every operation, with fresh request IDs allowed", async () => {
    const m = manager(); await expect(m.clone({ repo: "sample" }, undefined)).rejects.toThrow();
    const s = await m.clone({ repo: "sample" }, context());
    for (const c of [undefined, context({ userId: "U2" }), context({ channel: "C2" }), context({ threadTs: "123.457" }), context({ teamId: "T2" }), context({ requestId: undefined })]) {
      await expect(m.list(s.snapshotId, c)).rejects.toThrow(); await expect(m.read(s.snapshotId, c, "code.ts")).rejects.toThrow();
      await expect(m.search(s.snapshotId, c, "needle")).rejects.toThrow();
    }
    expect((await m.list(s.snapshotId, context({ requestId: "req-2" }))).files.length).toBeGreaterThan(0);
    await expect(m.list("00000000-0000-4000-8000-000000000000", context())).rejects.toThrow();
  });
  it("rejects scope, URL, revision and path injection before transport", async () => {
    let calls = 0; const m = manager(async () => { calls++; });
    for (const repo of ["other", "--upload-pack=evil", "file:///tmp/a", "../sample", "sample\0"]) await expect(m.clone({ repo }, context())).rejects.toThrow();
    for (const ref of ["--main", "HEAD^{commit}", "main:code.ts", "../main", "a//b", "main\0", "a.lock", "main/", "a".repeat(40)]) {
      expect(repositoryRef.safeParse(ref).success).toBe(false); await expect(m.clone({ repo: "sample", ref }, context())).rejects.toThrow();
    }
    for (const path of ["../code.ts", "/code.ts", ":(glob)*", "a/../b", "a\\b", "code.ts\0", "--option", "a/-x"]) expect(repositoryPath.safeParse(path).success).toBe(false);
    expect(calls).toBe(0);
  });
  it("does not execute hooks, filters or submodules; ignores inherited configuration", async () => {
    const marker = join(base, "SHOULD_NOT_RUN");
    const badConfig = join(home, "malicious-config");
    await writeFile(badConfig, `[core]\n hooksPath = ${home}\n[filter "evil"]\n smudge = touch ${marker}\n[credential]\n helper = !touch ${marker}\n`);
    await writeFile(join(home, "post-checkout"), `#!/bin/sh\ntouch '${marker}'`, { mode: 0o755 });
    const previous = process.env.GIT_CONFIG_GLOBAL; process.env.GIT_CONFIG_GLOBAL = badConfig;
    try {
      const env = isolatedGitEnv(home); expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null"); expect(env).not.toHaveProperty("NODE_OPTIONS");
      const m = manager(), s = await m.clone({ repo: "sample" }, context());
      await m.read(s.snapshotId, context(), "code.ts"); await expect(access(marker)).rejects.toThrow();
    } finally { if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous; }
  });
  it("redacts token representations in source contents and never persists auth configuration", async () => {
    await write("secrets", `dummy-read-token ${Buffer.from("x-access-token:dummy-read-token").toString("base64")} production-secret`); await commit();
    const m = manager(), s = await m.clone({ repo: "sample" }, context());
    const data = JSON.stringify(await m.read(s.snapshotId, context(), "secrets"));
    expect(data).not.toContain("dummy-read-token"); expect(data).not.toContain("production-secret"); expect(data).toContain("REDACTED");
  });
  it("paginates files, lines and literal search without gaps", async () => {
    await write("code.ts", Array.from({ length: 205 }, (_, i) => `needle ${i}`).join("\n"));
    for (let i = 0; i < 105; i++) await write(`file-${i}`, "other"); await commit();
    const m = manager(), s = await m.clone({ repo: "sample" }, context());
    const first = await m.list(s.snapshotId, context()); expect(first.next).toBe(100);
    const second = await m.list(s.snapshotId, context(), first.next!); expect(second.complete).toBe(true);
    expect(new Set([...first.files, ...second.files].map(f => f.path)).size).toBe(first.files.length + second.files.length);
    const read = await m.read(s.snapshotId, context(), "code.ts"); expect(read.next).toBe(101);
    expect(await m.read(s.snapshotId, context(), "code.ts", read.next!)).toMatchObject({ lines: expect.arrayContaining(["needle 100"]) });
    let cursor: { fileIndex: number; line: number } | undefined; const matches: number[] = [];
    for (let page = 0; page < 10; page++) {
      const found = await m.search(s.snapshotId, context(), "needle", cursor); matches.push(...found.matches.map(m => m.startLine));
      if (!found.next) break; cursor = found.next;
    }
    expect(matches).toEqual(Array.from({ length: 205 }, (_, i) => i + 1));
    expect((await m.search(s.snapshotId, context(), "needle.*")).matches).toEqual([]);
  });
  it("reserves capacity across concurrent clones, preserves snapshots and local edits", async () => {
    let release!: () => void, started!: () => void;
    const begun = new Promise<void>(r => { started = r; }); const pause = new Promise<void>(r => { release = r; });
    const m = manager(async request => { started(); await pause; await fixtureTransport(request); }, 0.15);
    await writeFile(join(workspace, "local-edit"), "preserve me");
    const pending = m.clone({ repo: "sample" }, context()); await begun;
    await expect(m.clone({ repo: "sample" }, context())).rejects.toThrow("capacity"); release();
    const s = await pending;
    await writeFile(join(workspace, "reserved-by-existing-work"), "");
    await truncate(join(workspace, "reserved-by-existing-work"), 64 * 1024 ** 2);
    await expect(m.clone({ repo: "sample" }, context())).rejects.toThrow("capacity");
    expect((await m.list(s.snapshotId, context())).files.length).toBeGreaterThan(0);
    expect(await readFile(join(workspace, "local-edit"), "utf8")).toBe("preserve me");
  });
  it("enforces snapshot count, expires ownership, and cleans only inactive proven-owned snapshots", async () => {
    const m = manager(); const snapshots = [];
    for (let i = 0; i < SNAPSHOT_LIMITS.maxSnapshots; i++) snapshots.push(await m.clone({ repo: "sample" }, context()));
    await expect(m.clone({ repo: "sample" }, context())).rejects.toThrow("capacity");
    await mkdir(join(workspace, "unknown-session")); await writeFile(join(workspace, "unknown-session", "edit"), "preserved");
    const now = Date.now(); const clock = vi.spyOn(Date, "now").mockReturnValue(now + SNAPSHOT_LIMITS.ttlMs + 1);
    try {
      await expect(m.list(snapshots[0].snapshotId, context())).rejects.toThrow();
      const newSnapshot = await m.clone({ repo: "sample" }, context());
      expect((await m.list(newSnapshot.snapshotId, context())).files.length).toBeGreaterThan(0);
      expect(await readFile(join(workspace, "unknown-session", "edit"), "utf8")).toBe("preserved");
      expect((await stages()).filter(s => s.startsWith("staged-")).length).toBe(1);
    } finally { clock.mockRestore(); }
  });
  it("rejects invalid UTF-8 and traversal-like tree metadata, cleaning the failed clone", async () => {
    await write("bad:name", "unsafe path"); await commit();
    const m = manager(); await expect(m.clone({ repo: "sample" }, context())).rejects.toThrow();
    // macOS filesystems reject invalid UTF-8 filenames; create the Git tree object directly.
    const blobSha = (await git(["-C", fixture, "rev-parse", "HEAD:code.ts"])).toString("ascii").trim();
    const rawTree = join(base, "raw-tree");
    await writeFile(rawTree, Buffer.concat([Buffer.from("100644 invalid-"), Buffer.from([255, 0]), Buffer.from(blobSha, "hex")]));
    const treeSha = (await git(["-C", fixture, "hash-object", "-t", "tree", "-w", "--", rawTree])).toString("ascii").trim();
    const commitSha = (await git(["-C", fixture, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit-tree", treeSha, "-m", "invalid utf8 tree"])).toString("ascii").trim();
    await git(["-C", fixture, "update-ref", "refs/heads/main", commitSha]);
    await expect(m.clone({ repo: "sample" }, context())).rejects.toThrow();
    expect((await stages()).filter(s => s.startsWith("staged-"))).toEqual([]);
  });
  it("rejects simultaneous reads of a snapshot rather than racing cleanup", async () => {
    const m = manager(), s = await m.clone({ repo: "sample" }, context());
    const pending = m.read(s.snapshotId, context(), "code.ts");
    await expect(m.list(s.snapshotId, context())).rejects.toThrow(); await pending;
  });
  it("cleans only owned failed stages on timeout, abort and monitored disk overrun; supports retry", async () => {
    await mkdir(join(workspace, "legacy")); await writeFile(join(workspace, "legacy", "edit"), "keep");
    const timeout: CloneTransport = request => runBoundedProcess(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { env: request.env, timeoutMs: 50, maxOutputBytes: 1024, signal: request.signal }).then(() => {});
    await expect(manager(timeout).clone({ repo: "sample" }, context())).rejects.toThrow();
    const controller = new AbortController(); controller.abort();
    await expect(manager(timeout).clone({ repo: "sample" }, context(), controller.signal)).rejects.toThrow();
    const disk: CloneTransport = request => runBoundedProcess(process.execPath, ["-e", `require('fs').writeFileSync(process.argv[1],Buffer.alloc(1));require('fs').truncateSync(process.argv[1],${SNAPSHOT_LIMITS.cloneBytes + 1});setTimeout(()=>{},10000)`, join(request.destination, "..", "oversized")], { env: request.env, timeoutMs: 1000, maxOutputBytes: 1024, monitor: request.monitor }).then(() => {});
    await expect(manager(disk).clone({ repo: "sample" }, context())).rejects.toThrow();
    expect((await stages()).filter(s => s.startsWith("staged-"))).toEqual([]);
    expect(await readFile(join(workspace, "legacy", "edit"), "utf8")).toBe("keep");
    const m = manager(); expect((await m.clone({ repo: "sample" }, context())).complete).toBe(true);
  });
});

describe("bounded subprocess", () => {
  it("terminates real descendant groups on timeout and cancellation", async () => {
    const marker = join(base, "descendant-marker");
    const code = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'escaped'),400)`)}],{stdio:'ignore'});setTimeout(()=>{},10000)`;
    await expect(runBoundedProcess(process.execPath, ["-e", code], { env: isolatedGitEnv(home), timeoutMs: 80, maxOutputBytes: 1024 })).rejects.toThrow();
    await new Promise(r => setTimeout(r, 600)); await expect(access(marker)).rejects.toThrow();
    const controller = new AbortController();
    const pending = runBoundedProcess(process.execPath, ["-e", code], { env: isolatedGitEnv(home), timeoutMs: 2000, maxOutputBytes: 1024, signal: controller.signal });
    setTimeout(() => controller.abort(), 80); await expect(pending).rejects.toThrow();
    await new Promise(r => setTimeout(r, 600)); await expect(access(marker)).rejects.toThrow();
  });
  it("bounds combined stdout/stderr and emits no raw child error", async () => {
    await expect(runBoundedProcess(process.execPath, ["-e", "process.stderr.write('dummy-read-token'.repeat(10000));setTimeout(()=>{},10000)"], { env: isolatedGitEnv(home), timeoutMs: 1000, maxOutputBytes: 128 })).rejects.toThrow("controlled subprocess failed");
  });
});
