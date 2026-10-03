import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { runBoundedProcess } from "./git-process.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let child: EventEmitter & { pid: number; stdout: PassThrough; stderr: PassThrough };
let signals: MockInstance<typeof process.kill>;
beforeEach(() => {
  vi.useFakeTimers();
  child = Object.assign(new EventEmitter(), { pid: 424242, stdout: new PassThrough(), stderr: new PassThrough() });
  vi.mocked(spawn).mockReturnValue(child as never);
  // Synthetic PID must never be signalled: all signalling is mocked before any invocation.
  signals = vi.spyOn(process, "kill").mockImplementation(() => true);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.mocked(spawn).mockReset(); });
const options = (monitor: () => Promise<void>, signal?: AbortSignal) => ({ env: { HOME: "/unused" }, timeoutMs: 1000, maxOutputBytes: 1024, monitor, signal });

// A deferred monitor can outlive close. Its fulfilled/rejected result must be consumed
// without touching a potentially reused process group, changing settlement, or leaking rejection.
describe("bounded process lifecycle settlement", () => {
  it.each(["resolve", "reject"] as const)("ignores late monitor %s after successful close", async outcome => {
    const pending = deferred(), monitor = vi.fn(() => pending.promise);
    const controller = new AbortController();
    const run = runBoundedProcess("/unused/git", [], options(monitor, controller.signal));
    await vi.advanceTimersByTimeAsync(100); expect(monitor).toHaveBeenCalledTimes(1);
    child.stdout.write("success"); child.emit("close", 0);
    await expect(run).resolves.toEqual(Buffer.from("success"));
    expect(signals).toHaveBeenCalledExactlyOnceWith(-child.pid, "SIGKILL");
    if (outcome === "reject") pending.reject(new Error("late monitor failure")); else pending.resolve();
    await vi.advanceTimersByTimeAsync(2000);
    controller.abort(); child.emit("error", new Error("late error")); child.emit("close", 1);
    child.stderr.write(Buffer.alloc(2048));
    expect(signals).toHaveBeenCalledTimes(1);
    await expect(run).resolves.toEqual(Buffer.from("success"));
  });
  it("ignores deferred rejection after a failed close without a second settlement", async () => {
    const pending = deferred(), run = runBoundedProcess("/unused/git", [], options(() => pending.promise));
    const assertion = expect(run).rejects.toThrow("controlled subprocess failed");
    await vi.advanceTimersByTimeAsync(100); child.emit("close", 1); await assertion;
    pending.reject(new Error("late monitor failure")); await vi.advanceTimersByTimeAsync(2000);
    child.emit("close", 0); expect(signals).toHaveBeenCalledTimes(1);
    await expect(run).rejects.toThrow("controlled subprocess failed");
  });
  it.each(["abort", "timeout"] as const)("preserves live %s cancellation and ignores monitor rejection after close", async cause => {
    const pending = deferred(), controller = new AbortController();
    const run = runBoundedProcess("/unused/git", [], options(() => pending.promise, controller.signal));
    const assertion = expect(run).rejects.toThrow("controlled subprocess failed");
    await vi.advanceTimersByTimeAsync(100);
    if (cause === "abort") controller.abort(); else await vi.advanceTimersByTimeAsync(900);
    expect(signals).toHaveBeenCalledExactlyOnceWith(-child.pid, "SIGKILL");
    child.emit("close", 0); await assertion;
    expect(signals).toHaveBeenCalledTimes(2); // live cancellation plus initial close cleanup
    pending.reject(new Error("late monitor failure")); await vi.advanceTimersByTimeAsync(2000);
    child.emit("close", 0); expect(signals).toHaveBeenCalledTimes(2);
  });
  it("still terminates on monitor rejection while the child is live", async () => {
    const pending = deferred(), run = runBoundedProcess("/unused/git", [], options(() => pending.promise));
    const assertion = expect(run).rejects.toThrow("controlled subprocess failed");
    await vi.advanceTimersByTimeAsync(100);
    pending.reject(new Error("live monitor failure")); await vi.advanceTimersByTimeAsync(0);
    expect(signals).toHaveBeenCalledExactlyOnceWith(-child.pid, "SIGKILL");
    child.emit("close", 0); await assertion; expect(signals).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000); expect(signals).toHaveBeenCalledTimes(2);
  });
});
