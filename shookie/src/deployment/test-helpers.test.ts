import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { realpathSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupCommands, existsSync, makeTempDir, readFileSync, rmSync, runBash, runCommand, stopChild, writeFileSync } from "./test-helpers.js";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("deployment fixture child lifecycle", () => {
  let dir: string;
  beforeEach(() => { dir = makeTempDir("shookie-runner-"); });
  afterEach(async () => {
    await cleanupCommands();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lets event-loop timers run during runBash (unlike the previous sync runner)", async () => {
    const script = path.join(dir, "wait.sh");
    writeFileSync(script, "sleep 0.3\nprintf done\n");
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 10);
    try {
      const previous = spawnSync("bash", [script], { encoding: "utf8", timeout: 2000 });
      expect(previous.status).toBe(0);
      expect(ticks).toBe(0);
      const result = await runBash(script, { PATH: process.env.PATH ?? "" });
      expect(result.status).toBe(0);
      expect(result.output).toBe("done");
      expect(ticks).toBeGreaterThan(0);
    } finally {
      clearInterval(timer);
    }
  });

  it("awaits complete stdout/stderr and preserves nonzero script status, env and cwd", async () => {
    const result = await runCommand("bash", ["-c", 'printf "%s" "$FIXTURE_VALUE"; sleep 0.05; printf problem >&2; pwd; exit 7'], {
      env: { PATH: process.env.PATH, FIXTURE_VALUE: "literal $x" }, cwd: dir,
    });
    expect(result.status).toBe(7);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe(`literal $x${realpathSync(dir)}\n`);
    expect(result.stderr).toBe("problem");
    expect(result.output).toBe(result.stdout + result.stderr);
  });

  it("rejects timeout with captured logs and kills TERM-ignoring descendants even after the shell exits", async () => {
    const marker = path.join(dir, "orphan");
    const result = runCommand("bash", ["-c", `trap 'exit 0' TERM; (trap '' TERM; sleep 1; echo orphan > '${marker}') & echo ready; wait`], { timeoutMs: 300 });
    await expect(result).rejects.toThrow(/fixture timed out after 300ms[\s\S]*ready/);
    await delay(1100);
    expect(existsSync(marker)).toBe(false);
  });

  it("rejects excessive output with a bounded diagnostic rather than buffering indefinitely", async () => {
    const result = runCommand("bash", ["-c", "while :; do printf 'abcdefghij'; done"], { maxOutputBytes: 64 });
    let error: Error | undefined;
    try { await result; } catch (caught) { error = caught as Error; }
    expect(error?.message).toContain("fixture exceeded 64 output bytes");
    expect(error!.message.length).toBeLessThan(200);
  });

  it("teardown cancels active work and waits for termination before fixture removal", async () => {
    const ready = path.join(dir, "ready");
    const marker = path.join(dir, "orphan");
    const result = runCommand("bash", ["-c", `trap '' TERM; echo ready > '${ready}'; sleep 1; echo orphan > '${marker}'`]);
    // Attach the rejection assertion before teardown to avoid an unhandled rejection.
    const rejected = expect(result).rejects.toThrow("fixture interrupted by teardown");
    const deadline = Date.now() + 2000;
    while (!existsSync(ready) && Date.now() < deadline) await delay(10);
    expect(readFileSync(ready, "utf8")).toBe("ready\n");
    await cleanupCommands();
    await rejected;
    await delay(1100);
    expect(existsSync(marker)).toBe(false);
    await cleanupCommands(); // idempotent
  });

  it("rejects spawn failures without hiding them as expected deployment failures", async () => {
    await expect(runCommand(path.join(dir, "missing"), [])).rejects.toThrow("ENOENT");
  });

  it("can tear down an already closed server without waiting for a second close event", async () => {
    const child = spawn("bash", ["-c", "exit 0"], { detached: true, stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => resolve());
    });
    await stopChild(child);
    expect(child.exitCode).toBe(0);
  });

  it("rejects invalid resource bounds before spawning", async () => {
    for (const timeoutMs of [0, -1, Infinity, 2_147_483_648]) {
      await expect(runCommand("bash", [], { timeoutMs })).rejects.toThrow("positive bounded numbers");
    }
    await expect(runCommand("bash", [], { maxOutputBytes: 0 })).rejects.toThrow("positive bounded numbers");
  });
});
