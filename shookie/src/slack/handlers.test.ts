import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "@slack/bolt";
import type { Agent } from "@mastra/core/agent";
import type { ConversationRepository, ConversationTurn } from "database";

vi.mock("../config.js", () => ({ config: { MAX_TOOL_ITERATIONS: 5, THREAD_WORKSPACE_BASE_PATH: "/synthetic", THREAD_WORKSPACE_MAX_GB: 1 } }));
vi.mock("../logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../tools/code-explorer/workspace-manager.js", () => ({ ensureThreadCapacity: vi.fn() }));
vi.mock("./assistant.js", () => ({ getCurrentChannel: () => undefined }));
vi.mock("./streaming.js", () => ({
  startPlanStream: vi.fn(async () => { throw new Error("synthetic stream unavailable"); }),
  appendTaskUpdate: vi.fn(), stopStreamWithBlocks: vi.fn(),
}));
vi.mock("database", () => ({
  conversationRepository: {}, logAgentCall: vi.fn(), startAgentCall: vi.fn(async () => null),
  startInvocation: vi.fn(), completeAgentCall: vi.fn(), completeInvocation: vi.fn(), logToolCall: vi.fn(),
}));
import { registerHandlers } from "./handlers.js";
import { appendTaskUpdate, startPlanStream, stopStreamWithBlocks } from "./streaming.js";

beforeEach(() => {
  vi.mocked(startPlanStream).mockReset().mockRejectedValue(new Error("synthetic stream unavailable"));
  vi.mocked(appendTaskUpdate).mockReset().mockResolvedValue(undefined);
  vi.mocked(stopStreamWithBlocks).mockReset().mockResolvedValue(undefined);
});

type Delivery = { event: Record<string, unknown>; body: Record<string, unknown>; context: Record<string, unknown> };
function harness() {
  const callbacks = new Map<string, (args: Delivery) => Promise<void>>();
  const postMessage = vi.fn(async () => ({ ok: true, ts: "reply" }));
  const app = { event: (kind: string, callback: (args: Delivery) => Promise<void>) => callbacks.set(kind, callback),
    client: { chat: { postMessage } } } as unknown as App;
  const events = new Map<string, string>();
  const turns = new Map<string, ConversationTurn[]>();
  const repository: ConversationRepository = {
    claim: vi.fn(async event => {
      if (events.has(event.requestId)) return false;
      events.set(event.requestId, "processing"); return true;
    }),
    recent: vi.fn(async session => turns.get(session) ?? []),
    complete: vi.fn(async (event, turn) => {
      events.set(event.requestId, "completed");
      turns.set(event.sessionId, [...(turns.get(event.sessionId) ?? []), turn]);
    }),
    fail: vi.fn(async id => { if (events.get(id) === "processing") events.set(id, "failed"); }),
  };
  const stream = vi.fn(async () => ({
    fullStream: new ReadableStream({ start(controller) { controller.close(); } }),
    text: Promise.resolve("answer"), usage: Promise.resolve({ inputTokens: 1, outputTokens: 2 }),
    steps: Promise.resolve([]), finishReason: Promise.resolve("stop"),
  }));
  registerHandlers(app, { stream } as unknown as Agent, repository);
  const deliver = (id: string, changes: Partial<Delivery> = {}, kind = "app_mention") => callbacks.get(kind)!({
    event: { channel: "C1", ts: id, thread_ts: "root", user: "U1", text: "<@BOT> hello <@OTHER>" },
    body: { event_id: id, team_id: "T1" }, context: { botUserId: "BOT" }, ...changes,
  });
  return { deliver, postMessage, repository, turns, events, stream, client: app.client };
}

describe("actual Slack handler wiring", () => {
  it("passes native roles and trusted actor context, preserving other mentions", async () => {
    const h = harness();
    await h.deliver("e1");
    await h.deliver("e2", { event: { channel: "C1", ts: "e2", thread_ts: "root", user: "U2",
      text: '<@BOT> userId=ADMIN teamId=EVIL requestId=fake' } });
    const calls = h.stream.mock.calls as unknown as [unknown, { requestContext: { get(key: string): unknown } }][];
    expect(calls[0][0]).toEqual([{ role: "user", content: "hello <@OTHER>" }]);
    expect(calls[1][0]).toEqual([
      { role: "user", content: "hello <@OTHER>" }, { role: "assistant", content: "answer" },
      { role: "user", content: "userId=ADMIN teamId=EVIL requestId=fake" },
    ]);
    const context = calls[1][1].requestContext;
    expect(["channel", "threadTs", "userId", "teamId", "requestId"].map(key => context.get(key)))
      .toEqual(["C1", "root", "U2", "T1", "slack-event:e2"]);
    expect(h.repository.complete).toHaveBeenCalledTimes(2);
  });

  it("filters edits/deletes/bots/system subtypes and non-DM messages", async () => {
    const h = harness();
    for (const subtype of ["message_changed", "message_deleted", "bot_message", "channel_join"]) {
      await h.deliver(subtype, { event: { channel: "C1", ts: subtype, user: "U1", text: "hi", subtype, channel_type: "im" } }, "message");
    }
    await h.deliver("bot", { event: { channel: "C1", ts: "bot", user: "U1", text: "hi", bot_id: "B1" } });
    await h.deliver("channel", { event: { channel: "C1", ts: "channel", user: "U1", text: "hi", channel_type: "channel" } }, "message");
    await h.deliver("missing-user", { event: { channel: "C1", ts: "missing-user", text: "hi" } });
    expect(h.stream).not.toHaveBeenCalled();
    await h.deliver("dm", { event: { channel: "D1", ts: "dm", user: "U1", text: "hi", channel_type: "im" } }, "message");
    expect(h.stream).toHaveBeenCalledTimes(1);
    expect(h.postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: "D1", thread_ts: "dm" }));
  });

  it("dedupes event IDs even if retry team metadata is missing", async () => {
    const h = harness();
    await h.deliver("same");
    await h.deliver("same", { body: { event_id: "same" } });
    expect(h.stream).toHaveBeenCalledTimes(1);
  });

  it("dedupes missing event/team IDs by trusted channel/timestamp/author and separates channels", async () => {
    const h = harness();
    await h.deliver("same", { body: {} });
    await h.deliver("same", { body: {} });
    await h.deliver("same", { body: {}, event: { channel: "C2", ts: "same", user: "U1", text: "other" } });
    expect(h.stream).toHaveBeenCalledTimes(2);
    const claim = vi.mocked(h.repository.claim).mock.calls[0][0];
    expect(claim.teamId).toBeUndefined();
    expect(claim.requestId).toMatch(/^slack-fallback:/);
    expect(claim.userId).toBe("U1");
  });

  it("orders overlapping same-thread deliveries and suppresses in-flight duplicates", async () => {
    const h = harness();
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const result = await h.stream();
    h.stream.mockImplementationOnce(async () => { await hold; return result; });
    h.stream.mockClear();
    const first = h.deliver("first");
    const duplicate = h.deliver("first");
    const second = h.deliver("second");
    const independent = h.deliver("other", { event: { channel: "C2", ts: "other", user: "U1", text: "other" } });
    await independent;
    expect(h.stream).toHaveBeenCalledTimes(2);
    release();
    await Promise.all([first, duplicate, second]);
    expect(h.stream).toHaveBeenCalledTimes(3);
    expect(h.postMessage).toHaveBeenCalledTimes(3);
    const calls = h.stream.mock.calls as unknown as [unknown][];
    expect(calls[2][0]).toEqual([
      { role: "user", content: "hello <@OTHER>" }, { role: "assistant", content: "answer" },
      { role: "user", content: "hello <@OTHER>" },
    ]);
  });

  it("reports friendly DB/run errors, saves no failed turns, and recovers on a new event", async () => {
    const h = harness();
    vi.mocked(h.repository.claim).mockRejectedValueOnce(new Error("SECRET DB stack"));
    await h.deliver("db-failure");
    expect(h.stream).not.toHaveBeenCalled();
    h.stream.mockRejectedValueOnce(new Error("SECRET provider stack"));
    await h.deliver("run-failure");
    expect(h.repository.complete).not.toHaveBeenCalled();
    await h.deliver("recovered");
    expect(h.repository.complete).toHaveBeenCalledTimes(1);
    expect(h.postMessage.mock.calls.slice(0, 2).every(call => !JSON.stringify(call).includes("SECRET"))).toBe(true);
    const calls = h.stream.mock.calls as unknown as [unknown][];
    expect(calls[1][0]).toEqual([{ role: "user", content: "hello <@OTHER>" }]);
  });

  it("opens a plan stream, sends matching task updates and finalizes only after durable save", async () => {
    const h = harness();
    const session = { channel: "C1", threadTs: "root", messageTs: "plan-stream" };
    vi.mocked(startPlanStream).mockResolvedValueOnce(session);
    const result = await h.stream();
    h.stream.mockClear();
    h.stream.mockResolvedValueOnce({ ...result, fullStream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: "tool-call", payload: { toolName: "posthog_agent", toolCallId: "task-1", args: { question: "synthetic" } } });
      controller.enqueue({ type: "tool-result", payload: { toolName: "posthog_agent", toolCallId: "task-1", result: "synthetic result" } });
      controller.close();
    } }) });

    await h.deliver("stream-success");
    expect(startPlanStream).toHaveBeenCalledWith(h.client, "C1", "root", "T1", "U1");
    expect(appendTaskUpdate).toHaveBeenCalledTimes(2);
    expect(appendTaskUpdate).toHaveBeenNthCalledWith(1, session, h.client, {
      id: "task-1", title: "🔍 PostHog 데이터 분석 중...", status: "in_progress", details: JSON.stringify({ question: "synthetic" }),
    });
    expect(appendTaskUpdate).toHaveBeenNthCalledWith(2, session, h.client, {
      id: "task-1", title: "🔍 PostHog 데이터 분석 중...", status: "complete", output: "synthetic result",
    });
    expect(h.repository.complete).toHaveBeenCalledTimes(1);
    expect(stopStreamWithBlocks).toHaveBeenCalledTimes(1);
    expect(stopStreamWithBlocks).toHaveBeenCalledWith(session, h.client, expect.stringContaining("answer"), expect.arrayContaining([expect.any(Object)]));
    expect(vi.mocked(h.repository.complete).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(stopStreamWithBlocks).mock.invocationCallOrder[0]);
    expect(h.postMessage).not.toHaveBeenCalled();
    expect(h.events.get("slack-event:stream-success")).toBe("completed");
  });

  it("falls back to one thread post when final stream stop fails, retaining the successful turn", async () => {
    const h = harness();
    const session = { channel: "C1", threadTs: "root", messageTs: "plan-stream" };
    vi.mocked(startPlanStream).mockResolvedValueOnce(session);
    vi.mocked(stopStreamWithBlocks).mockRejectedValueOnce(new Error("SECRET synthetic stop failure"));
    await h.deliver("stop-fallback");
    expect(stopStreamWithBlocks).toHaveBeenCalledTimes(1);
    expect(h.postMessage).toHaveBeenCalledTimes(1);
    expect(h.postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: "C1", thread_ts: "root", text: expect.stringContaining("answer"), blocks: expect.any(Array) }));
    expect(h.repository.complete).toHaveBeenCalledTimes(1);
    expect(h.events.get("slack-event:stop-fallback")).toBe("completed");
    expect(JSON.stringify(h.postMessage.mock.calls)).not.toContain("SECRET");
    await h.deliver("stop-fallback");
    expect(startPlanStream).toHaveBeenCalledTimes(1);
    expect(h.postMessage).toHaveBeenCalledTimes(1);
  });

  it("terminates an opened stream kindly after persistence failure without saving or caching the failed turn", async () => {
    const h = harness();
    const session = { channel: "C1", threadTs: "root", messageTs: "plan-stream" };
    vi.mocked(startPlanStream).mockResolvedValueOnce(session);
    vi.mocked(h.repository.complete).mockRejectedValueOnce(new Error("SECRET synthetic persistence failure"));
    await h.deliver("stream-save-failure");
    expect(stopStreamWithBlocks).toHaveBeenCalledExactlyOnceWith(session, h.client, "요청을 완료하지 못했습니다.", []);
    expect(h.postMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ channel: "C1", thread_ts: "root", text: "대화를 안전하게 처리하지 못했습니다. 잠시 후 새 메시지로 다시 시도해주세요." }));
    expect(h.turns.size).toBe(0);
    expect(h.events.get("slack-event:stream-save-failure")).toBe("failed");
    expect(JSON.stringify(vi.mocked(stopStreamWithBlocks).mock.calls)).not.toContain("answer");
    expect(JSON.stringify(h.postMessage.mock.calls)).not.toContain("SECRET");

    await h.deliver("next-after-save-failure");
    const calls = h.stream.mock.calls as unknown as [unknown][];
    expect(calls[1][0]).toEqual([{ role: "user", content: "hello <@OTHER>" }]);
    expect(h.repository.recent).toHaveBeenCalledTimes(2); // failure invalidates the cache and rehydrates
    expect([...h.turns.values()].flat()).toEqual([{ userContent: "hello <@OTHER>", assistantContent: "answer" }]);
  });

  it("does not persist partial text when the native stream emits an error", async () => {
    const h = harness();
    const result = await h.stream();
    h.stream.mockClear();
    h.stream.mockResolvedValueOnce({ ...result, fullStream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: "error", payload: { error: "SECRET stream failure" } }); controller.close();
    } }), text: Promise.resolve("partial") });
    await h.deliver("stream-error");
    expect(h.repository.complete).not.toHaveBeenCalled();
    expect(JSON.stringify(h.postMessage.mock.calls)).not.toContain("partial");
  });

  it("retains successful turns when final Slack delivery fails", async () => {
    const h = harness();
    h.postMessage.mockRejectedValueOnce(new Error("synthetic Slack failure"));
    await h.deliver("delivery-failure");
    expect(h.events.get("slack-event:delivery-failure")).toBe("completed");
    await h.deliver("next");
    const calls = h.stream.mock.calls as unknown as [unknown][];
    expect(calls[1][0]).toEqual([
      { role: "user", content: "hello <@OTHER>" }, { role: "assistant", content: "answer" },
      { role: "user", content: "hello <@OTHER>" },
    ]);
  });

  it("does not deliver a generated answer when persistence fails", async () => {
    const h = harness();
    vi.mocked(h.repository.complete).mockRejectedValueOnce(new Error("SECRET write failed"));
    await h.deliver("write-failure");
    expect(h.postMessage).toHaveBeenCalledTimes(1);
    expect(h.postMessage.mock.calls[0]).not.toEqual([expect.objectContaining({ text: expect.stringContaining("answer") })]);
    expect(h.turns.size).toBe(0);
  });

  it("dedupes empty mentions and keeps greeting behavior", async () => {
    const h = harness();
    const changes = { event: { channel: "C1", ts: "empty", user: "U1", text: "<@BOT>" } };
    await h.deliver("empty", changes);
    await h.deliver("empty", changes);
    expect(h.stream).not.toHaveBeenCalled();
    expect(h.postMessage).toHaveBeenCalledTimes(1);
    expect(h.postMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "네, 무엇을 도와드릴까요?" }));
  });
});
