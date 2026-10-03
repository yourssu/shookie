import { mkdtemp, mkdir, writeFile, symlink, readFile, rm, realpath } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { ensureThreadCapacity, trustedActor, validateThreadPath, within } from "./workspace-manager.js";
const values = { channel: "C1", threadTs: "123.456", userId: "U1", requestId: "req-1" };
const context = { get: (key: string) => values[key as keyof typeof values] };
describe("legacy workspace preservation", () => {
  it("refuses capacity without deleting active work or local edits", async () => {
    const base = await mkdtemp(join(tmpdir(), "github-capacity-"));
    try {
      await mkdir(join(base, "threads", "active"), { recursive: true });
      const file = join(base, "threads", "active", "local-edit"); await writeFile(file, "unpreserved");
      await expect(ensureThreadCapacity(base, 0.000000001)).rejects.toThrow("삭제하지 않았습니다");
      expect(await readFile(file, "utf8")).toBe("unpreserved");
      await ensureThreadCapacity(base, 1);
    } finally { await rm(base, { recursive: true }); }
  });
  it("validates trusted actor and current directory boundaries", async () => {
    expect(() => trustedActor()).toThrow();
    expect(() => trustedActor({ get: key => key === "channel" ? "../escape" : context.get(key) })).toThrow();
    expect(within("/tmp/thread", "/tmp/thread-other")).toBe(false);
    const base = await mkdtemp(join(tmpdir(), "github-scope-"));
    try {
      const root = join(base, "actors", "no-team", "U1", "C1", "123.456"); await mkdir(root, { recursive: true });
      const other = join(base, "actors", "no-team", "U1", "C1", "123.457"); await mkdir(other);
      expect(await validateThreadPath(base, context, ".")).toBe(await realpath(root));
      await expect(validateThreadPath(base, context, other)).rejects.toThrow();
      await symlink(other, join(root, "escape"));
      await expect(validateThreadPath(base, context, "escape")).rejects.toThrow();
    } finally { await rm(base, { recursive: true }); }
  });
});
