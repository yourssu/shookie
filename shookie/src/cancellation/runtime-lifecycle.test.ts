import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationEvent, ConversationRepository } from "database";
import { ConversationRuntime } from "../slack/conversation-runtime.js";
import { executionOperation, executionTools, type ExecutionScope } from "./execution-context.js";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function event(id: string, thread = id): ConversationEvent {
  return { requestId: id, sessionId: thread, teamId: "T1", channel: "C1", threadTs: thread, userId: "U1" };
}
function fixture() {
  const claims = new Set<string>();
  const repository: ConversationRepository = { claim: vi.fn(async e => { if (claims.has(e.requestId)) return false; claims.add(e.requestId); return true; }),
    recent: vi.fn(async () => []), complete: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
  return { repository, runtime: new ConversationRuntime(repository) };
}
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => vi.useRealTimers());

describe("actual runtime acquire + shared ownership lifecycle", () => {
  it("does not start the queued request's 180-second clock until thread acquire", async () => {
    const { runtime } = fixture(); const hold = deferred();
    let firstScope!: ExecutionScope; let secondScope: ExecutionScope | undefined;
    const first = runtime.run(event("first", "thread"), "one", async (_m, commit, scope) => {
      firstScope = scope; await commit("saved"); await hold.promise;
    });
    const second = runtime.run(event("second", "thread"), "two", async (_m, commit, scope) => { secondScope = scope; await commit("next"); });
    await flush(); expect(firstScope.control.startedAt).toBe(0);
    await vi.advanceTimersByTimeAsync(240_000);
    expect(secondScope).toBeUndefined();
    hold.resolve(); await first; await second;
    expect(secondScope!.control.startedAt).toBe(240_000);
    expect(secondScope!.control.deadlineAt).toBe(420_000);
  });

  it("holds all four slots and the same-thread lane until unabortable residual work actually settles", async () => {
    const { runtime, repository } = fixture(); const holds = Array.from({ length: 4 }, () => deferred());
    const started: string[] = []; const failures: Promise<unknown>[] = [];
    for (let i = 0; i < 4; i++) {
      const run = runtime.run(event(`active-${i}`), "q", async (_m, commit) => {
        started.push(`active-${i}`); await executionOperation(() => holds[i].promise); await commit("late");
      });
      failures.push(run.catch(error => error));
    }
    let nextStartedAt: number | undefined;
    const next = runtime.run(event("next"), "q", async (_m, commit, scope) => {
      nextStartedAt = scope.control.startedAt; started.push("next"); await commit("ok");
    });
    const sameThread = runtime.run(event("same-thread", "active-0"), "q", async (_m, commit) => { started.push("same-thread"); await commit("ok"); });
    await flush(); expect(started).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(started).toHaveLength(4);
    holds.forEach(hold => hold.resolve());
    expect(await Promise.all(failures)).toEqual(Array.from({ length: 4 }, () => expect.objectContaining({ reason: "timed_out" })));
    await next; await sameThread;
    expect(nextStartedAt).toBe(180_000); // Waiting for global capacity did not consume the next request's deadline.
    expect(repository.complete).toHaveBeenCalledTimes(2);
    expect(repository.fail).toHaveBeenCalledTimes(4);
  });

  it("drains a tool which outlives an early Mastra completion before any commit or next thread execution", async () => {
    const { runtime, repository } = fixture(); const residual = deferred(); const entered = deferred();
    const tools = executionTools({ slow: createTool({ id: "slow", description: "test", inputSchema: z.object({}),
      execute: async () => { entered.resolve(); await residual.promise; return { answer: "late" }; } }) });
    let scope!: ExecutionScope;
    const first = runtime.run(event("early", "thread"), "q", async (_m, commit, s) => {
      scope = s;
      void tools.slow.execute!({}, {}).catch(() => {}); // engine abort/completion can precede this real tool
      await entered.promise; scope.control.cancel(); await commit("not allowed");
    }).catch(error => error);
    const nextExecute = vi.fn(async (_m, commit) => commit("next"));
    const next = runtime.run(event("next", "thread"), "q", nextExecute);
    await entered.promise; await flush();
    expect(nextExecute).not.toHaveBeenCalled(); expect(repository.complete).not.toHaveBeenCalled();
    residual.resolve(); expect(await first).toMatchObject({ reason: "cancelled" });
    await next; expect(repository.complete).toHaveBeenCalledOnce();
  });

  it("preserves the successful in-flight DB commit across deadline and ancillary/delivery failure", async () => {
    const { runtime, repository } = fixture(); const db = deferred(); const entered = deferred();
    vi.mocked(repository.complete).mockImplementation(async () => { entered.resolve(); await db.promise; });
    const run = runtime.run(event("commit-race"), "q", async (_m, commit) => {
      await commit("durable"); throw new Error("ancillary failure");
    });
    await entered.promise; await vi.advanceTimersByTimeAsync(180_000);
    db.resolve(); await expect(run).resolves.toBeUndefined();
    expect(repository.complete).toHaveBeenCalledOnce(); expect(repository.fail).not.toHaveBeenCalled();
    await runtime.run(event("commit-race"), "retry", async () => { throw new Error("duplicate executed"); });
    expect(repository.complete).toHaveBeenCalledOnce();
  });
});
