import { afterEach, describe, expect, it, vi } from "vitest";
import type { App } from "@slack/bolt";
import { LiveAnswer, PREVIEW_MARKER } from "./live-answer.js";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function harness() {
  const postMessage = vi.fn(async (_args?: unknown) => ({ ok: true, ts: "preview" }));
  const update = vi.fn(async (_args?: unknown) => ({ ok: true, ts: "preview" }));
  const app = { client: { chat: { postMessage, update } } } as unknown as App;
  const abort = new AbortController();
  const live = new LiveAnswer(app, { channel: "C1", threadTs: "root" }, abort.signal);
  const event = (text: string, type = "text-delta", runId = "root", from = "AGENT") => live.event({ type, runId, from, payload: { text } }, "root");
  return { live, event, postMessage, update, abort };
}
afterEach(() => vi.useRealTimers());
describe("generation-time provisional transport", () => {
  it("first public delta is sent immediately; reasoning, tools, nested runs/sources never appear", async () => {
    const h = harness();
    for (const type of ["reasoning-delta", "tool-call", "tool-result", "agent-execution-event-text-delta"]) h.event("SECRET", type);
    h.event("SECRET", "text-delta", "specialist"); h.event("SECRET", "text-delta", "root", "SYSTEM");
    expect(h.postMessage).not.toHaveBeenCalled();
    h.event("public");
    expect(h.postMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("public"), metadata: { event_type: PREVIEW_MARKER, event_payload: {} } }));
    await h.live.seal();
    expect(JSON.stringify(h.postMessage.mock.calls)).not.toContain("SECRET");
  });
  it("coalesces tool-only steps without clearing visible prose, then reconciles authoritative mismatch once", async () => {
    vi.useFakeTimers(); const h = harness();
    h.event("pre-tool"); await tick();
    h.event("", "step-start"); h.event("", "step-start");
    await vi.advanceTimersByTimeAsync(1600); expect(h.update).not.toHaveBeenCalled();
    h.event("final step"); await tick();
    expect(h.update).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("final step") }));
    await h.live.finalize("canonical", [{ type: "section", text: { type: "mrkdwn", text: "canonical" } }]);
    expect(h.update.mock.calls.at(-1)?.[0]).toMatchObject({ text: "canonical", metadata: { event_type: "shookie_response_committed" } });
    await h.live.cleanup(); expect(h.update).toHaveBeenCalledTimes(2);
  });
  it("slow transport never blocks consumption or queues deltas; sealing drains and fences late overwrite", async () => {
    const h = harness(); const gate = deferred();
    h.postMessage.mockImplementation(async () => { await gate.promise; return { ok: true, ts: "preview" }; });
    h.event("first"); for (let i = 0; i < 1000; i++) h.event("x");
    expect(h.postMessage).toHaveBeenCalledTimes(1); expect(h.update).not.toHaveBeenCalled();
    let finished = false; const final = h.live.finalize("canonical", []).then(() => { finished = true; });
    await tick(); expect(finished).toBe(false);
    gate.resolve(); await final; h.event("late"); await tick();
    expect(h.update).toHaveBeenCalledTimes(1); expect(h.update.mock.calls[0][0]).toMatchObject({ text: "canonical" });
  });
  it.each(["ambiguous", "429", "warning"])("does not repost after %s preview creation", async kind => {
    const h = harness();
    if (kind === "warning") h.postMessage.mockResolvedValue({ ok: true, ts: "preview", warning: "metadata_ignored" } as never);
    else h.postMessage.mockRejectedValue(new Error(kind));
    h.event("first"); await h.live.seal();
    if (kind === "warning") expect(await h.live.finalize("answer", [])).toBe(true); // known ts can reconcile metadata
    else await expect(h.live.finalize("answer", [])).rejects.toThrow();
    await h.live.cleanup(); expect(h.postMessage).toHaveBeenCalledTimes(1);
  });
  it("allows fallback only before attempt or explicit unsupported creation rejection", async () => {
    const a = harness(); expect(await a.live.finalize("answer", [])).toBe(false);
    const b = harness(); b.postMessage.mockRejectedValue({ code: "slack_webapi_platform_error", data: { error: "missing_scope" } });
    b.event("first"); await b.live.seal(); expect(await b.live.finalize("answer", [])).toBe(false);
  });
  it("never overwrites potentially committed final after lost update ACK", async () => {
    const h = harness(); h.event("preview"); await h.live.seal();
    h.update.mockRejectedValue(new Error("ack lost"));
    await expect(h.live.finalize("canonical", [])).rejects.toThrow(); await h.live.cleanup();
    await expect(h.live.finalize("canonical", [])).rejects.toThrow("already attempted");
    expect(h.update).toHaveBeenCalledTimes(1);
  });
  it.each(["before", "after", "append"])("abort %s start prevents late text; independent cleanup retains preview marker", async stage => {
    vi.useFakeTimers(); const h = harness();
    if (stage === "before") h.abort.abort();
    h.event("first"); await tick();
    if (stage === "append") { h.event("second"); await vi.advanceTimersByTimeAsync(1500); }
    h.abort.abort(); h.event("late");
    await h.live.cleanup(); await vi.advanceTimersByTimeAsync(5000);
    expect(JSON.stringify(h.update.mock.calls)).not.toContain("late");
    if (stage === "before") expect(h.postMessage).not.toHaveBeenCalled();
    else expect(h.update.mock.calls.at(-1)?.[0]).toMatchObject({ metadata: { event_type: PREVIEW_MARKER }, text: expect.stringContaining("미완료") });
  });
  it("long markdown, fences and Unicode are unchanged; code-unit cap freezes delivery without changing canonical source", async () => {
    const h = harness(); const body = "```ts\n" + "한글😀".repeat(1000) + "\n```";
    h.event(body); await h.live.seal();
    expect(h.postMessage.mock.calls[0][0]).toMatchObject({ text: `생성 중 · 미확정 답변\n\n${body}` });
    await h.live.finalize(body, []);
    const capped = harness(); capped.event("a"); capped.event("x".repeat(24001)); await capped.live.seal();
    expect(await capped.live.finalize("canonical still saved by caller", [])).toBe(true);
    expect(capped.update.mock.calls.at(-1)?.[0]).toMatchObject({ text: "canonical still saved by caller" });
  });
  it("enforces an independent UTF-8 byte budget for multibyte text below the code-unit cap", async () => {
    const h = harness(); h.event("first");
    // 22,005 code units fit the 24,000 unit bound, but 66,005 UTF-8 bytes exceed 64,000.
    h.event("한".repeat(22_000));
    await h.live.seal();
    expect(h.postMessage).toHaveBeenCalledTimes(1); expect(h.update).not.toHaveBeenCalled();
    expect(await h.live.finalize("canonical still owned by caller", [])).toBe(true);
    const below = harness(); below.event("한".repeat(21_000)); await below.live.seal();
    expect(await below.live.finalize("canonical", [])).toBe(true);
  });
  it("caps calls and retains only a latest bounded snapshot", async () => {
    vi.useFakeTimers(); const h = harness();
    h.event("first"); await tick();
    for (let i = 0; i < 65; i++) { h.event("x"); await vi.advanceTimersByTimeAsync(1500); }
    expect(h.postMessage.mock.calls.length + h.update.mock.calls.length).toBe(60);
    expect(await h.live.finalize("canonical", [])).toBe(true);
    await h.live.cleanup(); expect(h.update).toHaveBeenCalledTimes(60); // 59 previews + one distinct finalization
  });
  it.each([2, 30])("honors structured Retry-After=%i before one distinct finalization, or keeps saved delivery unconfirmed", async retryAfter => {
    vi.useFakeTimers(); const h = harness(); h.event("first"); await tick();
    h.update.mockRejectedValueOnce({ code: "slack_webapi_rate_limited_error", retryAfter });
    h.event("second"); await vi.advanceTimersByTimeAsync(1500); await h.live.seal(); h.live.markSaved();
    const finalized = h.live.finalize("canonical", []).then(() => true, () => false);
    await tick(); expect(h.update).toHaveBeenCalledTimes(1);
    if (retryAfter === 2) {
      await vi.advanceTimersByTimeAsync(1999); expect(h.update).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1); expect(await finalized).toBe(true);
      expect(h.update).toHaveBeenCalledTimes(2);
    } else expect(await finalized).toBe(false);
    const count = h.update.mock.calls.length; await h.live.cleanup(); expect(h.update).toHaveBeenCalledTimes(count);
    expect(JSON.stringify(h.update.mock.calls)).not.toContain("미완료");
  });
  it("holds a split surrogate until the complete code point is available", async () => {
    const h = harness(); h.event(String.fromCharCode(0xD83D)); expect(h.postMessage).not.toHaveBeenCalled();
    h.event(String.fromCharCode(0xDE00)); await h.live.seal();
    expect(h.postMessage.mock.calls[0][0]).toMatchObject({ text: "생성 중 · 미확정 답변\n\n😀" });
  });
  it("abort during in-flight append drains actual settlement before independent cleanup; never appends late model text", async () => {
    vi.useFakeTimers(); const h = harness(); const gate = deferred();
    h.event("first"); await tick();
    h.update.mockImplementationOnce(async () => { await gate.promise; return { ok: true, ts: "preview" }; });
    h.event("second"); await vi.advanceTimersByTimeAsync(1500);
    h.abort.abort(); h.event("LATE_SECRET");
    let cleaned = false; const cleanup = h.live.cleanup().then(() => { cleaned = true; });
    await tick(); expect(cleaned).toBe(false); gate.resolve(); await cleanup;
    expect(h.update).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(h.update.mock.calls)).not.toContain("LATE_SECRET");
    expect(h.update.mock.calls.at(-1)?.[0]).toMatchObject({ text: expect.stringContaining("미완료") });
  });
  it.each(["rate_limited", "ack lost"])("freezes after ambiguous/limited append: %s", async reason => {
    vi.useFakeTimers(); const h = harness(); h.event("first"); await tick(); h.update.mockRejectedValueOnce(new Error(reason));
    h.event("second"); await vi.advanceTimersByTimeAsync(1500); h.event("third");
    await h.live.seal(); expect(h.update).toHaveBeenCalledTimes(1);
    expect(await h.live.finalize("canonical", [])).toBe(true);
    await h.live.cleanup();
    expect(h.update).toHaveBeenCalledTimes(2);
    expect(h.update.mock.calls.at(-1)?.[0]).toMatchObject({ text: "canonical", metadata: { event_type: "shookie_response_committed" } });
  });
});
