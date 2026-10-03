import { mkdir, mkdtemp, rm, lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { trustedActor } from "./workspace-manager.js";
import type { ReadConfig } from "./github-read.js";
import { diskBytes, isolatedGitEnv, runBoundedProcess } from "./git-process.js";

export const repositoryName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/).refine(v => v !== "." && v !== "..");
export const repositoryRef = z.string().max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine(v => !/^[a-f0-9]{40}$/i.test(v) && !v.includes("..") && !v.includes("//") && !v.endsWith("/") && v.split("/").every(p => !p.endsWith(".lock") && !p.endsWith(".")));
export const repositoryPath = z.string().min(1).max(1000).refine(v =>
  !v.startsWith("/") && !/[\\\x00-\x1f\x7f:*?\[\]]/.test(v) &&
  v.split("/").every(p => p !== "" && p !== "." && p !== ".." && !p.startsWith("-")));
export const snapshotIdSchema = z.string().uuid();
const MiB = 1024 ** 2;
export const SNAPSHOT_LIMITS = Object.freeze({ cloneBytes: 64 * MiB, reservationBytes: 96 * MiB,
  cloneTimeoutMs: 30_000, commandTimeoutMs: 5_000, treeBytes: 4 * MiB,
  blobBytes: MiB, outputBytes: 32 * 1024, pageFiles: 100, pageLines: 100,
  searchFiles: 50, searchResults: 100, maxSnapshots: 8, ttlMs: 30 * 60_000 });
type Context = Parameters<typeof trustedActor>[0];
type Actor = ReturnType<typeof trustedActor>;
type Entry = { path: string; mode: string; type: string; oid: string };
type Snapshot = { snapshotId: string; owner: string; repo: string; ref: string | null; commitSha: string;
  dir: string; actor: Actor; entries: Entry[]; created: number; busy: boolean };
export interface SnapshotConfig extends ReadConfig { workspaceBasePath: string; workspaceMaxGb: number }
export interface CloneRequest { url: string; destination: string; ref?: string; env: NodeJS.ProcessEnv;
  signal?: AbortSignal; monitor: () => Promise<void> }
// Constructor-only test seam; not configurable by tools, env, or production agent wiring.
export type CloneTransport = (request: CloneRequest) => Promise<void>;
const productionClone: CloneTransport = async request => {
  const args = ["clone", "--bare", "--depth=1", "--single-branch", "--no-tags", "--template=", "--quiet"];
  if (request.ref) args.push("--branch", request.ref);
  args.push("--", request.url, request.destination);
  await runBoundedProcess("/usr/bin/git", args, { env: request.env, timeoutMs: SNAPSHOT_LIMITS.cloneTimeoutMs,
    maxOutputBytes: SNAPSHOT_LIMITS.treeBytes, signal: request.signal, monitor: request.monitor });
};
const actorKey = (a: Actor) => JSON.stringify([a.teamId ?? null, a.userId, a.channel, a.threadTs]);

export class RepositorySnapshots {
  private snapshots = new Map<string, Snapshot>();
  private root?: Promise<string>;
  private gate: Promise<void> = Promise.resolve();
  private reserved = 0;
  private cloning = 0;
  constructor(private config: SnapshotConfig, private transport: CloneTransport = productionClone) {}
  private async locked<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.gate;
    let release!: () => void;
    this.gate = new Promise<void>(r => { release = r; });
    await previous;
    try { return await work(); } finally { release(); }
  }
  private getRoot() {
    return this.root ??= (async () => {
      await mkdir(this.config.workspaceBasePath, { recursive: true });
      if ((await lstat(this.config.workspaceBasePath)).isSymbolicLink()) throw new Error("unsafe base");
      const base = await realpath(this.config.workspaceBasePath);
      return mkdtemp(join(base, "controlled-snapshots-"));
    })();
  }
  private async git(dir: string, args: string[], signal?: AbortSignal) {
    const root = await this.getRoot();
    return runBoundedProcess("/usr/bin/git", ["--git-dir", dir, ...args], {
      env: isolatedGitEnv(root), timeoutMs: SNAPSHOT_LIMITS.commandTimeoutMs,
      maxOutputBytes: SNAPSHOT_LIMITS.treeBytes, signal });
  }
  private redact(text: string) {
    for (const secret of [this.config.gitHubToken, this.config.readOnlyToken].filter(Boolean) as string[]) {
      for (const value of [secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64"),
        Buffer.from(`x-access-token:${secret}`).toString("base64")]) text = text.split(value).join("[REDACTED]");
    }
    return text;
  }
  private source(s: Snapshot, path?: string) {
    return { snapshotId: s.snapshotId, owner: s.owner, repo: s.repo, ref: s.ref, commitSha: s.commitSha, ...(path ? { path } : {}) };
  }
  async clone(raw: { repo: string; ref?: string }, context: Context, signal?: AbortSignal) {
    const actor = trustedActor(context), repo = repositoryName.parse(raw.repo), ref = raw.ref === undefined ? undefined : repositoryRef.parse(raw.ref);
    const owner = repositoryName.parse(this.config.owner);
    if (this.config.repositories && !this.config.repositories.some(r => r.toLowerCase() === repo.toLowerCase())) throw new Error("repository scope");
    const token = this.config.readOnlyToken || this.config.gitHubToken;
    if (!token || /[\r\n\x00]/.test(token)) throw new Error("credential required");
    const url = `https://github.com/${owner}/${repo}.git`;
    if (this.redact(url) !== url || (ref && this.redact(ref) !== ref)) throw new Error("secret in source");
    const root = await this.getRoot();
    const staging = await this.locked(async () => {
      const expired = [...this.snapshots].filter(([, s]) => !s.busy && Date.now() - s.created > SNAPSHOT_LIMITS.ttlMs);
      const maxBytes = this.config.workspaceMaxGb * 1024 ** 3;
      // Preflight counts even expired bytes: capacity failure must not evict anything.
      if (!Number.isFinite(maxBytes) || maxBytes <= 0 || this.snapshots.size - expired.length + this.cloning >= SNAPSHOT_LIMITS.maxSnapshots ||
        await diskBytes(this.config.workspaceBasePath, maxBytes) + this.reserved + SNAPSHOT_LIMITS.reservationBytes > maxBytes) throw new Error("capacity; existing snapshots preserved");
      // Only after successful capacity preflight, clean proven-owned inactive expired snapshots.
      for (const [id, s] of expired) { await rm(s.dir, { recursive: true, force: true }); this.snapshots.delete(id); }
      const staging = await mkdtemp(join(root, "staged-"));
      this.reserved += SNAPSHOT_LIMITS.reservationBytes; this.cloning++;
      return staging;
    });
    try {
      const dir = join(staging, "repository.git");
      const monitor = async () => { if (await diskBytes(staging, SNAPSHOT_LIMITS.cloneBytes) > SNAPSHOT_LIMITS.cloneBytes) throw new Error("clone disk limit"); };
      const env = isolatedGitEnv(root);
      // Scoped HTTPS authorization is only in child environment. Never URL/argv/config file.
      env.GIT_CONFIG_COUNT = "9";
      env.GIT_CONFIG_KEY_8 = "http.https://github.com/.extraHeader";
      env.GIT_CONFIG_VALUE_8 = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
      await this.transport({ url, destination: dir, ref, env, signal, monitor });
      await monitor();
      const commitSha = (await this.git(dir, ["rev-parse", "--verify", "HEAD^{commit}"], signal)).toString("ascii").trim();
      if (!/^[0-9a-f]{40}$/.test(commitSha) || this.redact(commitSha) !== commitSha) throw new Error("invalid commit");
      const tree = await this.git(dir, ["ls-tree", "-rz", "--full-tree", commitSha], signal);
      const entries = new TextDecoder("utf-8", { fatal: true }).decode(tree).split("\0").filter(Boolean).map(record => {
        const match = /^([0-7]{6}) (blob|commit) ([0-9a-f]{40})\t([\s\S]+)$/.exec(record);
        if (!match) throw new Error("invalid tree");
        const path = repositoryPath.parse(match[4]);
        if (this.redact(path) !== path || this.redact(match[3]) !== match[3]) throw new Error("secret in tree metadata");
        return { mode: match[1], type: match[2], oid: match[3], path };
      });
      const s: Snapshot = { snapshotId: randomUUID(), owner, repo, ref: ref ?? null, commitSha,
        dir: staging, actor, entries, created: Date.now(), busy: false };
      this.snapshots.set(s.snapshotId, s);
      return { ...this.source(s), complete: true, truncated: false, next: null };
    } catch { await rm(staging, { recursive: true, force: true }); throw new Error("controlled clone failed"); }
    finally { this.reserved -= SNAPSHOT_LIMITS.reservationBytes; this.cloning--; }
  }
  private async use<T>(id: string, context: Context, work: (s: Snapshot) => Promise<T>) {
    const actor = trustedActor(context), s = this.snapshots.get(snapshotIdSchema.parse(id));
    if (!s || actorKey(s.actor) !== actorKey(actor) || Date.now() - s.created > SNAPSHOT_LIMITS.ttlMs || s.busy) throw new Error("snapshot unavailable");
    s.busy = true;
    try { return await work(s); } finally { s.busy = false; }
  }
  async list(id: string, context: Context, offset = 0) {
    z.number().int().min(0).max(100_000).parse(offset);
    return this.use(id, context, async s => {
      const entries: Entry[] = []; let end = offset, bytes = 0;
      for (const entry of s.entries.slice(offset, offset + SNAPSHOT_LIMITS.pageFiles)) {
        const size = Buffer.byteLength(JSON.stringify(entry));
        if (bytes + size > SNAPSHOT_LIMITS.outputBytes) break;
        entries.push(entry); bytes += size; end++;
      }
      const truncated = end < s.entries.length;
      return { ...this.source(s), files: entries, complete: !truncated, truncated, next: truncated ? end : null };
    });
  }
  private async blob(s: Snapshot, entry: Entry, signal?: AbortSignal): Promise<{ state: string; text?: string }> {
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) return { state: "unsupported_symlink_or_gitlink" };
    const dir = join(s.dir, "repository.git");
    const size = Number((await this.git(dir, ["cat-file", "-s", entry.oid], signal)).toString("ascii").trim());
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("invalid object size");
    if (size > SNAPSHOT_LIMITS.blobBytes) return { state: "large" };
    const data = await this.git(dir, ["cat-file", "blob", entry.oid], signal);
    if (data.length !== size) throw new Error("invalid blob");
    if (data.includes(0)) return { state: "binary" };
    try { return { state: "text", text: this.redact(new TextDecoder("utf-8", { fatal: true }).decode(data)) }; }
    catch { return { state: "binary" }; }
  }
  async read(id: string, context: Context, path: string, startLine = 1, signal?: AbortSignal) {
    repositoryPath.parse(path); z.number().int().min(1).max(1_000_001).parse(startLine);
    return this.use(id, context, async s => {
      const entry = s.entries.find(e => e.path === path);
      if (!entry) return { ...this.source(s, path), state: "missing", complete: false, truncated: false, next: null };
      const blob = await this.blob(s, entry, signal);
      if (blob.text === undefined) return { ...this.source(s, path), state: blob.state, complete: false, truncated: false, next: null };
      const lines = blob.text === "" ? [] : blob.text.split("\n");
      if (lines.at(-1) === "") lines.pop();
      let end = startLine - 1, bytes = 0; const output: string[] = [];
      for (const line of lines.slice(startLine - 1, startLine - 1 + SNAPSHOT_LIMITS.pageLines)) {
        const size = Buffer.byteLength(JSON.stringify(line)) + 1;
        if (bytes + size > SNAPSHOT_LIMITS.outputBytes) break;
        output.push(line); bytes += size; end++;
      }
      const truncated = end < lines.length;
      return { ...this.source(s, path), state: truncated && !output.length ? "large_line" : "text",
        lines: output, startLine, endLine: output.length ? end : null, complete: !truncated, truncated,
        next: truncated && output.length ? end + 1 : null };
    });
  }
  async search(id: string, context: Context, literal: string, cursor = { fileIndex: 0, line: 1 }, signal?: AbortSignal) {
    z.string().min(1).max(200).refine(v => !/[\x00-\x1f\x7f]/.test(v)).parse(literal);
    z.object({ fileIndex: z.number().int().min(0).max(100_000), line: z.number().int().min(1).max(1_000_001) }).strict().parse(cursor);
    return this.use(id, context, async s => {
      const matches: { path: string; startLine: number; endLine: number; text: string }[] = [];
      const skipped: { path: string; state: string }[] = [];
      let index = cursor.fileIndex, bytes = 0;
      const deadline = Date.now() + SNAPSHOT_LIMITS.commandTimeoutMs;
      for (; index < Math.min(s.entries.length, cursor.fileIndex + SNAPSHOT_LIMITS.searchFiles); index++) {
        if (Date.now() > deadline) break;
        const entry = s.entries[index], blob = await this.blob(s, entry, signal);
        if (blob.text === undefined) {
          const skip = { path: entry.path, state: blob.state };
          const size = Buffer.byteLength(JSON.stringify(skip));
          if (bytes + size > SNAPSHOT_LIMITS.outputBytes) break;
          bytes += size; skipped.push(skip); continue;
        }
        const lines = blob.text.split("\n");
        for (let line = index === cursor.fileIndex ? cursor.line - 1 : 0; line < lines.length; line++) {
          if (!lines[line].includes(literal)) continue;
          const match = { path: entry.path, startLine: line + 1, endLine: line + 1, text: lines[line] };
          const size = Buffer.byteLength(JSON.stringify(match));
          if (size > SNAPSHOT_LIMITS.outputBytes) {
            const skip = { path: entry.path, state: "large_line" };
            const skipSize = Buffer.byteLength(JSON.stringify(skip));
            if (bytes + skipSize > SNAPSHOT_LIMITS.outputBytes) {
              return { ...this.source(s), matches, skipped, complete: false, truncated: true, next: { fileIndex: index, line: line + 1 } };
            }
            bytes += skipSize; skipped.push(skip); continue;
          }
          if (bytes + size > SNAPSHOT_LIMITS.outputBytes || matches.length >= SNAPSHOT_LIMITS.searchResults) {
            return { ...this.source(s), matches, skipped, complete: false, truncated: true, next: { fileIndex: index, line: line + 1 } };
          }
          bytes += size; matches.push(match);
        }
      }
      const truncated = index < s.entries.length;
      return { ...this.source(s), matches, skipped, complete: !truncated && skipped.length === 0,
        truncated, next: truncated ? { fileIndex: index, line: 1 } : null };
    });
  }
}
