import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "@slack/bolt";
import type { Agent } from "@mastra/core/agent";
import type { ConversationRepository } from "database";
vi.mock("../config.js", () => ({ config: { MAX_TOOL_ITERATIONS: 5, THREAD_WORKSPACE_BASE_PATH: "/synthetic", THREAD_WORKSPACE_MAX_GB: 1 } }));
vi.mock("../logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../tools/code-explorer/workspace-manager.js", () => ({ ensureThreadCapacity: vi.fn() }));
vi.mock("../slack/assistant.js", () => ({ getCurrentChannel: vi.fn() }));
vi.mock("../slack/streaming.js", () => ({ startPlanStream: vi.fn(async () => { throw new Error("mock fallback"); }), appendTaskUpdate: vi.fn(), stopStreamWithBlocks: vi.fn() }));
vi.mock("database", () => ({ conversationRepository: {}, logAgentCall: vi.fn(), startAgentCall: vi.fn(async () => null), startInvocation: vi.fn(), completeAgentCall: vi.fn(), completeInvocation: vi.fn(), logToolCall: vi.fn() }));
import { registerHandlers } from "../slack/handlers.js";
import { CANCEL_ACTION_ID, CANCEL_ACCEPTED_TEXT, CANCEL_UNAVAILABLE_TEXT } from "./request-registry.js";
import { startPlanStream } from "../slack/streaming.js";
import { logAgentCall } from "database";
import { executionSignal } from "./execution-context.js";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
function answer() { return { fullStream: new ReadableStream({ start(c) { c.close(); } }), text: Promise.resolve("safe answer"), usage: Promise.resolve({}), steps: Promise.resolve([]), finishReason: Promise.resolve("stop") }; }
function harness(summary = vi.fn(async () => "summary")) {
  const events = new Map<string, (args: any) => Promise<void>>(); const actions = new Map<string, (args: any) => Promise<void>>();
  const client = { chat: { postMessage: vi.fn(async (_args: any) => ({ ok: true, ts: "2.000001" })),
    update: vi.fn(async (_args: any) => ({ ok: true })), postEphemeral: vi.fn(async (_args: any) => ({ ok: true })) }, conversations: { replies: vi.fn() } };
  const app = { client, event: (id: string, fn: any) => events.set(id, fn), action: (id: string, fn: any) => actions.set(id, fn) } as unknown as App;
  const claimed = new Set<string>();
  const repository: ConversationRepository = { claim: vi.fn(async e => { if (claimed.has(e.requestId)) return false; claimed.add(e.requestId); return true; }), recent: vi.fn(async () => []), complete: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
  const stream = vi.fn(async (_messages: unknown, _opts: { abortSignal: AbortSignal }) => answer());
  registerHandlers(app, { stream } as unknown as Agent, repository, summary);
  const deliver = (id: string, mention = false) => events.get(mention ? "app_mention" : "message")!({
    event: { channel: "C1", user: "U1", channel_type: mention ? "channel" : "im", ts: "1.000003", thread_ts: "1.000001", text: "question" }, body: { team_id: "T1", event_id: id }, context: { botUserId: "UBOT" },
  });
  const click = async (changes: Record<string, unknown> = {}, requestId = "slack-event:fetch") => {
    const ack = vi.fn(async () => {});
    await actions.get(CANCEL_ACTION_ID)!({ ack, action: { value: requestId, actor: "U1", approved: true }, context: { teamId: "T1" },
      body: { user: { id: "U1" }, team: { id: "T1" }, channel: { id: "C1" }, container: { type: "message", channel_id: "C1", message_ts: "2.000001" }, message: { ts: "2.000001", thread_ts: "1.000001" }, ...changes } });
    return ack;
  };
  return { client, repository, stream, summary, deliver, click, actions };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); vi.mocked(logAgentCall).mockReset(); vi.mocked(startPlanStream).mockClear(); });
afterEach(() => vi.useRealTimers());

describe("registered Slack cancel UI/action + actual runtime wiring", () => {
  it("posts a bound control button before thread fetch/summary/plan and acknowledges requester cancellation first", async () => {
    const h = harness(); const fetch = deferred<any>(); h.client.conversations.replies.mockReturnValue(fetch.promise);
    const run = h.deliver("fetch", true); await flush();
    expect(h.client.chat.postMessage).toHaveBeenCalledOnce();
    expect(h.client.chat.postMessage.mock.calls[0][0]).toMatchObject({ channel: "C1", thread_ts: "1.000001", blocks: [{ type: "actions", elements: [{ action_id: CANCEL_ACTION_ID, value: "slack-event:fetch" }] }] });
    expect(startPlanStream).not.toHaveBeenCalled(); expect(h.summary).not.toHaveBeenCalled();
    expect(h.client.chat.postMessage.mock.invocationCallOrder[0]).toBeLessThan(h.client.conversations.replies.mock.invocationCallOrder[0]);
    const ack = await h.click();
    expect(ack).toHaveBeenCalledOnce();
    expect(ack.mock.invocationCallOrder[0]).toBeLessThan(h.client.chat.postEphemeral.mock.invocationCallOrder[0]);
    expect(h.client.chat.postEphemeral).toHaveBeenLastCalledWith({ channel: "C1", user: "U1", text: CANCEL_ACCEPTED_TEXT });
    expect(h.client.chat.update).toHaveBeenCalledWith(expect.objectContaining({ blocks: [], text: expect.stringContaining("취소") }));
    await h.click(); expect(h.client.chat.postEphemeral.mock.calls.at(-1)![0].text).toBe(CANCEL_UNAVAILABLE_TEXT);
    expect(h.client.chat.update).toHaveBeenCalledOnce();
    fetch.resolve({ ok: true, messages: [] }); await run;
    expect(h.stream).not.toHaveBeenCalled(); expect(h.repository.complete).not.toHaveBeenCalled(); expect(h.repository.fail).toHaveBeenCalledOnce();
    await h.click(); expect(h.client.chat.postEphemeral).toHaveBeenLastCalledWith(expect.objectContaining({ text: CANCEL_UNAVAILABLE_TEXT }));
    await h.deliver("fetch", true); expect(h.repository.fail).toHaveBeenCalledOnce(); // failed claim dedupe
    await h.deliver("new"); expect(h.repository.complete).toHaveBeenCalledOnce(); // next fresh event recovers
  });

  it("cancels during summary with the same underlying shared signal before main/plan starts", async () => {
    const entered = deferred<void>(); let signal: AbortSignal | undefined;
    const h = harness(vi.fn(async () => {
      signal = executionSignal(); entered.resolve();
      return new Promise<string>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("private summary token")), { once: true }));
    }));
    h.client.conversations.replies.mockResolvedValue({ ok: true, messages: [
      { ts: "1.000001", user: "U2", text: "root", reply_count: 2 },
      { ts: "1.000002", thread_ts: "1.000001", user: "U2", text: "x".repeat(24_000) },
      { ts: "1.000003", thread_ts: "1.000001", user: "U1", text: "y".repeat(26_000) },
    ] });
    const run = h.deliver("fetch", true); await entered.promise;
    expect(startPlanStream).not.toHaveBeenCalled();
    await h.click(); expect(signal!.aborted).toBe(true); await run;
    expect(h.stream).not.toHaveBeenCalled(); expect(h.repository.complete).not.toHaveBeenCalled();
    expect(JSON.stringify(h.client.chat.postMessage.mock.calls)).not.toContain("private summary");
  });

  it.each([
    { user: { id: "U2" } }, { team: { id: "T2" } }, { channel: { id: "C2" } },
    { container: { type: "message", channel_id: "C1", message_ts: "wrong" } }, { message: { ts: "2.000001", thread_ts: "other-thread" } },
  ])("denies forged/other actor/team/channel/message/thread actions without leaking cancellation state: %j", async mismatch => {
    const h = harness(); const pending = deferred<ReturnType<typeof answer>>(); h.stream.mockReturnValueOnce(pending.promise);
    const run = h.deliver("fetch"); await flush();
    await h.click(mismatch); expect(h.client.chat.postEphemeral.mock.calls.at(-1)![0].text).toBe(CANCEL_UNAVAILABLE_TEXT);
    expect(h.stream.mock.calls[0][1].abortSignal.aborted).toBe(false);
    await h.click(); expect(h.stream.mock.calls[0][1].abortSignal.aborted).toBe(true);
    await h.click(mismatch); expect(h.client.chat.postEphemeral.mock.calls.at(-1)![0].text).toBe(CANCEL_UNAVAILABLE_TEXT);
    pending.resolve(answer()); await run; expect(h.repository.complete).not.toHaveBeenCalled();
  });

  it("notifies at exactly 180 seconds while nonabortable work retains the same-thread lane and suppresses late answers", async () => {
    const h = harness(); const pending = deferred<ReturnType<typeof answer>>(); h.stream.mockReturnValueOnce(pending.promise);
    const run = h.deliver("slow"); await flush(); const next = h.deliver("next");
    await vi.advanceTimersByTimeAsync(179_999); expect(h.client.chat.update).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.client.chat.update).toHaveBeenCalledWith(expect.objectContaining({ blocks: [], text: expect.stringContaining("3분을 초과") }));
    expect(h.stream).toHaveBeenCalledOnce(); expect(h.repository.complete).not.toHaveBeenCalled();
    pending.resolve(answer()); await run; await next;
    expect(h.repository.complete).toHaveBeenCalledOnce(); expect(h.repository.fail).toHaveBeenCalledOnce();
    expect(h.client.chat.postMessage.mock.calls.filter(([args]) => args.text.includes("safe answer"))).toHaveLength(1);
  });

  it("rejects cancel during persistence, preserves a commit that succeeds after deadline, and does not send timeout over success", async () => {
    const h = harness(); const db = deferred<void>(); const entered = deferred<void>();
    vi.mocked(h.repository.complete).mockImplementation(async () => { entered.resolve(); await db.promise; });
    const run = h.deliver("committing"); await entered.promise;
    await h.click({}, "slack-event:committing");
    expect(h.client.chat.postEphemeral.mock.calls.at(-1)![0].text).toBe(CANCEL_UNAVAILABLE_TEXT);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(h.client.chat.update).not.toHaveBeenCalled(); // in-flight transaction's actual result is not known yet
    db.resolve(); await run;
    expect(h.repository.fail).not.toHaveBeenCalled();
    expect(h.client.chat.postMessage.mock.calls.at(-1)![0].text).toContain("safe answer");
    expect(h.client.chat.update).toHaveBeenLastCalledWith(expect.objectContaining({ text: "요청을 완료했습니다." }));
  });

  it("a final delivery error never posts a misleading failure or reverses the saved turn", async () => {
    const h = harness();
    h.client.chat.postMessage.mockImplementation(async args => {
      if (args.text.includes("safe answer")) throw new Error("private delivery error");
      return { ok: true, ts: "2.000001" };
    });
    await h.deliver("delivery-failure");
    expect(h.repository.complete).toHaveBeenCalledOnce(); expect(h.repository.fail).not.toHaveBeenCalled();
    expect(h.client.chat.postMessage).toHaveBeenCalledTimes(2); // control + answer attempt, no failure replacement
    expect(h.client.chat.update).toHaveBeenLastCalledWith(expect.objectContaining({ text: "요청을 완료했습니다.", blocks: [] }));
  });

  it("keeps committed success/answer despite a later logging failure and clears completed buttons", async () => {
    const h = harness(); vi.mocked(logAgentCall).mockRejectedValueOnce(new Error("secret logging failure"));
    await h.deliver("done");
    expect(h.repository.complete).toHaveBeenCalledOnce(); expect(h.repository.fail).not.toHaveBeenCalled();
    expect(h.client.chat.postMessage.mock.calls.at(-1)![0].text).toContain("safe answer");
    expect(h.client.chat.update).toHaveBeenCalledWith(expect.objectContaining({ text: "요청을 완료했습니다.", blocks: [] }));
    await h.click({}, "slack-event:done");
    expect(h.client.chat.postEphemeral.mock.calls.at(-1)![0].text).toBe(CANCEL_UNAVAILABLE_TEXT);
    expect(JSON.stringify(h.client.chat.postMessage.mock.calls)).not.toContain("secret");
  });
});
