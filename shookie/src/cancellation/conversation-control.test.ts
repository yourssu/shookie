import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONVERSATION_DEADLINE_MS, ConversationControl, ConversationStoppedError } from "./conversation-control.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); });

describe("one absolute conversation deadline", () => {
  it("starts after queue wait, not on admission, and expires at exactly 180 seconds", async () => {
    // Runtime integration must construct this controller after acquire; no controller in the queue.
    await vi.advanceTimersByTimeAsync(240_000);
    const control = new ConversationControl();
    expect(control.startedAt).toBe(240_000);
    expect(control.deadlineAt).toBe(420_000);
    await vi.advanceTimersByTimeAsync(CONVERSATION_DEADLINE_MS - 1);
    control.checkpoint();
    await vi.advanceTimersByTimeAsync(1);
    expect(control.signal.aborted).toBe(true);
    expect(control.stopReason).toBe("timed_out");
    expect(() => control.checkpoint()).toThrow(ConversationStoppedError);
    control.finish();
  });

  it("counts source fetch, summary, main, subagent, and tool cumulatively without refreshing", async () => {
    const control = new ConversationControl();
    const stages = ["fetch", "summary", "main", "subagent", "tool"];
    for (const stage of stages) {
      const operation = control.operation(async signal => {
        expect(signal).toBe(control.signal);
        await new Promise<void>(resolve => setTimeout(resolve, 40_000));
        return stage;
      });
      if (stage === "tool") {
        const assertion = expect(operation).rejects.toMatchObject({ reason: "timed_out" });
        await vi.advanceTimersByTimeAsync(40_000);
        await assertion;
      } else {
        await vi.advanceTimersByTimeAsync(40_000);
        expect(await operation).toBe(stage);
      }
    }
    expect(control.deadlineAt).toBe(180_000);
    control.finish();
  });

  it("checks the absolute clock even when the timer callback has not run", () => {
    const control = new ConversationControl();
    vi.setSystemTime(180_000);
    expect(() => control.checkpoint()).toThrow(ConversationStoppedError);
    expect(control.cancel()).toBe(false);
    control.finish();
  });

  it.each(["fetch", "summary", "main", "subagent", "tool"])("propagates cancellation during %s to actual underlying work", async () => {
    const control = new ConversationControl();
    const aborted = vi.fn();
    const operation = control.operation(signal => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => { aborted(); reject(new Error("provider token=secret")); }, { once: true });
    }));
    const assertion = expect(operation).rejects.toMatchObject({ reason: "cancelled", message: "요청이 취소되었습니다." });
    expect(control.cancel()).toBe(true);
    await assertion;
    expect(aborted).toHaveBeenCalledOnce();
    expect(control.cancel()).toBe(false);
    control.finish();
  });

  it("does not pretend an unabortable call settled, consumes its rejection/result, and suppresses late answers", async () => {
    const control = new ConversationControl();
    const pending = deferred<string>();
    const settled = vi.fn();
    const operation = control.operation(() => pending.promise).finally(settled);
    const assertion = expect(operation).rejects.toMatchObject({ reason: "cancelled" });
    control.cancel();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled(); // runtime must still hold its semaphore/thread lane
    pending.resolve("late answer");
    await assertion;
    expect(settled).toHaveBeenCalledOnce();
    const persist = vi.fn();
    await expect(control.commit(persist)).rejects.toMatchObject({ reason: "cancelled" });
    expect(persist).not.toHaveBeenCalled();
    control.finish();
  });

  it("never starts work or persistence after deadline", async () => {
    const control = new ConversationControl();
    await vi.advanceTimersByTimeAsync(180_000);
    const execute = vi.fn();
    await expect(control.operation(execute)).rejects.toMatchObject({ reason: "timed_out" });
    await expect(control.commit(execute)).rejects.toMatchObject({ reason: "timed_out" });
    expect(execute).not.toHaveBeenCalled();
    control.finish();
  });
});

describe("commit/deadline linearization", () => {
  it("preserves success of an in-flight durable commit even when its deadline expires", async () => {
    const control = new ConversationControl();
    await vi.advanceTimersByTimeAsync(179_999);
    const db = deferred();
    const commit = control.commit(() => db.promise);
    expect(control.state).toBe("committing");
    expect(control.cancel()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(control.signal.aborted).toBe(true);
    db.resolve();
    await commit;
    expect(control.isCommitted).toBe(true);
    expect(control.cancel()).toBe(false);
    control.finish();
    expect(control.isCommitted).toBe(true);
  });

  it("already committed success remains successful after cancellation/deadline/delivery failure", async () => {
    const control = new ConversationControl();
    await control.commit(async () => {});
    await vi.advanceTimersByTimeAsync(240_000);
    expect(control.signal.aborted).toBe(false);
    expect(control.cancel()).toBe(false);
    expect(control.isCommitted).toBe(true);
    await expect(control.commit(async () => {})).rejects.toThrow("not executing");
    control.finish();
  });

  it("does not manufacture success for a failed in-flight commit", async () => {
    const control = new ConversationControl();
    const db = deferred();
    const commit = control.commit(() => db.promise);
    const assertion = expect(commit).rejects.toMatchObject({ reason: "timed_out" });
    await vi.advanceTimersByTimeAsync(180_000);
    db.reject(new Error("database secret"));
    await assertion;
    expect(control.isCommitted).toBe(false);
    control.finish();
  });

  it("does not leak timers or cancellation between independent requests", async () => {
    const first = new ConversationControl();
    first.cancel(); first.finish();
    const next = new ConversationControl();
    expect(vi.getTimerCount()).toBe(1);
    expect(next.signal.aborted).toBe(false);
    await next.commit(async () => {});
    next.finish();
    expect(vi.getTimerCount()).toBe(0);
  });
});
