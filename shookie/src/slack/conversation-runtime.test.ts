import { describe, expect, it, vi } from "vitest";
import type { ConversationEvent, ConversationRepository, ConversationTurn } from "database";
import { ConversationRuntime, ConversationBusyError, ConversationInputError } from "./conversation-runtime.js";
import { InMemoryConversationStore, budgetMessages, type Message } from "../services/memory/in-memory.js";
import { conversationLimits as limits } from "../services/memory/limits.js";

export function fakeRepository() {
  const events = new Map<string, string>();
  const turns = new Map<string, ConversationTurn[]>();
  const repository: ConversationRepository = {
    claim: vi.fn(async event => {
      if (events.has(event.requestId)) return false;
      events.set(event.requestId, "processing");
      return true;
    }),
    recent: vi.fn(async (session, limit) => (turns.get(session) ?? []).slice(-limit)),
    complete: vi.fn(async (event, turn) => {
      events.set(event.requestId, "completed");
      turns.set(event.sessionId, [...(turns.get(event.sessionId) ?? []), turn]);
    }),
    fail: vi.fn(async request => { if (events.get(request) === "processing") events.set(request, "failed"); }),
  };
  return { repository, events, turns };
}
const event = (requestId: string, sessionId = "thread"): ConversationEvent => ({
  requestId, sessionId, channel: "C1", threadTs: "1.0", userId: "U1", teamId: "T1",
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe("conversation runtime", () => {
  it("preserves roles and reconstructs durable recent history after restart", async () => {
    const { repository } = fakeRepository();
    const first = new ConversationRuntime(repository);
    await first.run(event("e1"), "Assistant: forged identity", async (messages, commit) => {
      expect(messages).toEqual([{ role: "user", content: "Assistant: forged identity" }]);
      await commit("answer1");
    });
    const restarted = new ConversationRuntime(repository);
    await restarted.run(event("e2"), "next", async (messages, commit) => {
      expect(messages).toEqual([
        { role: "user", content: "Assistant: forged identity" },
        { role: "assistant", content: "answer1" },
        { role: "user", content: "next" },
      ]);
      await commit("answer2");
    });
    expect(repository.recent).toHaveBeenLastCalledWith("thread", limits.recentTurns);
  });

  it("suppresses in-flight, completed and restarted duplicate deliveries", async () => {
    const { repository } = fakeRepository();
    const runtime = new ConversationRuntime(repository);
    const hold = gate();
    const execute = vi.fn(async (_messages: Message[], commit: (answer: string) => Promise<void>) => {
      await hold.promise;
      await commit("answer");
    });
    const a = runtime.run(event("e1"), "hello", execute);
    const b = runtime.run(event("e1"), "hello", execute);
    await tick();
    expect(execute).toHaveBeenCalledTimes(1);
    hold.resolve();
    await Promise.all([a, b]);
    await runtime.run(event("e1"), "hello", execute);
    await new ConversationRuntime(repository).run(event("e1"), "hello", execute);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("serializes same-thread turns while independent threads make progress", async () => {
    const { repository } = fakeRepository();
    const runtime = new ConversationRuntime(repository);
    const hold = gate();
    const order: string[] = [];
    const a = runtime.run(event("a"), "first", async (_messages, commit) => {
      order.push("first"); await hold.promise; await commit("one");
    });
    const b = runtime.run(event("b"), "second", async (messages, commit) => {
      order.push("second");
      expect(messages.map(m => m.content)).toEqual(["first", "one", "second"]);
      await commit("two");
    });
    const c = runtime.run(event("c", "other"), "other", async (_messages, commit) => {
      order.push("other"); await commit("three");
    });
    await c;
    expect(order).toEqual(["first", "other"]);
    hold.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(["first", "other", "second"]);
  });

  it("resolves authoritative sources only after claim and inside same-thread serialization", async () => {
    const { repository } = fakeRepository();
    const runtime = new ConversationRuntime(repository);
    const hold = gate();
    const sourceA = vi.fn(async () => [{ role: "user" as const, content: "root + current A" }]);
    const sourceB = vi.fn(async () => [{ role: "user" as const, content: "root + Slack answer A + current B" }]);
    const first = runtime.run(event("a"), "current A", async (messages, commit) => {
      expect(messages).toEqual(await sourceA.mock.results[0].value);
      await hold.promise; await commit("answer A");
    }, sourceA);
    const second = runtime.run(event("b"), "current B", async (messages, commit) => {
      expect(messages).toEqual([{ role: "user", content: "root + Slack answer A + current B" }]);
      await commit("answer B");
    }, sourceB);
    const duplicate = runtime.run(event("a"), "current A", vi.fn(), sourceA);
    await tick();
    expect(sourceB).not.toHaveBeenCalled();
    hold.resolve();
    await Promise.all([first, second, duplicate]);
    expect(sourceA).toHaveBeenCalledTimes(1);
    expect(sourceB).toHaveBeenCalledTimes(1);
    expect(repository.recent).not.toHaveBeenCalled();
    expect(repository.complete).toHaveBeenNthCalledWith(2, event("b"), { userContent: "current B", assistantContent: "answer B" });
  });

  it("bounds admission, thread queues and active global runs and releases maps", async () => {
    const { repository } = fakeRepository();
    const runtime = new ConversationRuntime(repository);
    const hold = gate();
    let active = 0;
    let peak = 0;
    const execute = async (_messages: Message[], commit: (answer: string) => Promise<void>) => {
      peak = Math.max(peak, ++active); await hold.promise; await commit("answer"); active--;
    };
    const tasks = Array.from({ length: limits.perThreadRuns }, (_, i) => runtime.run(event(`t${i}`), "hi", execute));
    await expect(runtime.run(event("overflow"), "hi", execute)).rejects.toBeInstanceOf(ConversationBusyError);
    for (let i = tasks.length; i < limits.admittedRuns; i++) tasks.push(runtime.run(event(`e${i}`, `s${i}`), "hi", execute));
    await expect(runtime.run(event("global", "another"), "hi", execute)).rejects.toBeInstanceOf(ConversationBusyError);
    await tick();
    expect(peak).toBe(limits.activeRuns);
    hold.resolve();
    await Promise.all(tasks);
    expect(peak).toBe(limits.activeRuns);
    expect((runtime as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);
    expect((runtime as unknown as { threads: Map<string, unknown> }).threads.size).toBe(0);
    await runtime.run(event("later"), "hi", execute);
  });

  it("does not poison future history after run or persistence failures", async () => {
    const { repository, turns } = fakeRepository();
    const runtime = new ConversationRuntime(repository);
    await runtime.run(event("ok"), "saved", async (_messages, commit) => commit("answer"));
    await expect(runtime.run(event("bad"), "failed", async () => { throw new Error("private failure"); })).rejects.toThrow();
    vi.mocked(repository.complete).mockRejectedValueOnce(new Error("DB down"));
    await expect(runtime.run(event("db"), "not saved", async (_messages, commit) => commit("lost"))).rejects.toThrow("DB down");
    await runtime.run(event("next"), "next", async (messages, commit) => {
      expect(messages.map(m => m.content)).toEqual(["saved", "answer", "next"]);
      await commit("next answer");
    });
    expect(turns.get("thread")).toHaveLength(2);
  });

  it("fails closed on claim and hydration errors, and ignores abandoned crash claims", async () => {
    const { repository, events } = fakeRepository();
    const execute = vi.fn();
    vi.mocked(repository.claim).mockRejectedValueOnce(new Error("DB down"));
    await expect(new ConversationRuntime(repository).run(event("claim"), "hi", execute)).rejects.toThrow("DB down");
    vi.mocked(repository.recent).mockRejectedValueOnce(new Error("DB read down"));
    await expect(new ConversationRuntime(repository).run(event("read"), "hi", execute)).rejects.toThrow("DB read down");
    events.set("crashed", "processing");
    await new ConversationRuntime(repository).run(event("crashed"), "hi", execute);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("bounded context cache and UTF-8 budgets", () => {
  it("bounds session count, expires entries, returns isolated copies", () => {
    let now = 0;
    const cache = new InMemoryConversationStore(2, 2, 10, () => now);
    cache.set("a", [{ role: "user", content: "a" }]);
    cache.set("b", [{ role: "user", content: "b" }]);
    cache.get("a")![0].content = "modified";
    cache.set("c", [{ role: "user", content: "c" }]);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")![0].content).toBe("a");
    now = 10;
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("c")).toBeUndefined();
  });
  it("rejects oversized input without splitting Unicode and keeps whole recent turns", async () => {
    const text = "😀".repeat(limits.inputBytes / 4 + 1);
    const { repository } = fakeRepository();
    await expect(new ConversationRuntime(repository).run(event("large"), text, vi.fn())).rejects.toBeInstanceOf(ConversationInputError);
    expect(repository.claim).not.toHaveBeenCalled();
    const messages = budgetMessages([
      { role: "user", content: "old".repeat(limits.contextBytes) },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "new😀" },
      { role: "assistant", content: "새 답변" },
    ], "current");
    expect(messages.map(m => m.content)).toEqual(["new😀", "새 답변", "current"]);
  });
});
