import { describe, expect, it, vi } from "vitest";
import type { WebClient } from "@slack/web-api";
import { deliverFinalAnswer } from "./final-delivery.js";
import { convertMarkdownToBlocks } from "./markdown-to-blocks.js";
function harness(markdown = "## 답변\n**확인**\n```ts\nconst n = 1;\n```\nhttps://example.org") {
  const apiCall = vi.fn(async (_method: string, _args: unknown): Promise<any> => ({ ok: true, ts: "2.1" }));
  const postMessage = vi.fn(async () => ({ ok: true, ts: "3.1" }));
  const client = { apiCall, chat: { postMessage } } as unknown as WebClient;
  const rendered = convertMarkdownToBlocks(markdown, "", { withFeedback: true });
  const input = { channel: "C1", threadTs: "1.1", teamId: "T1", userId: "U1", markdown, ...rendered };
  const controller = new AbortController();
  return { apiCall, postMessage, input, controller, run: () => deliverFinalAnswer(client, input, controller.signal) };
}
describe("buffered final-only Slack delivery (mock transport, not live Slack)", () => {
  it("sends the final markdown once and attaches only feedback below it, never duplicate rendered body", async () => {
    const h = harness(); await h.run();
    expect(h.apiCall.mock.calls.map(c => c[0])).toEqual(["chat.startStream", "chat.stopStream"]);
    expect(h.apiCall.mock.calls[0][1]).toMatchObject({ markdown_text: h.input.markdown, thread_ts: "1.1", recipient_team_id: "T1", recipient_user_id: "U1" });
    expect(h.apiCall.mock.calls[1][1]).toMatchObject({ blocks: [expect.objectContaining({ type: "context_actions" })] });
    expect(JSON.stringify(h.apiCall.mock.calls[1])).not.toContain("const n");
    expect(h.postMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(h.input.blocks)).not.toMatch(/💰|💵|🔧/);
    expect(h.input.blocks.every(b => b.type !== "context")).toBe(true);
  });
  it("bounds to two body chunks without sleeps, preserves incremental fenced markdown and Unicode", async () => {
    const text = "```\n" + "😀한".repeat(6000) + "\n```";
    const h = harness(text); await h.run();
    expect(h.apiCall).toHaveBeenCalledTimes(3);
    const chunks = h.apiCall.mock.calls.filter(c => c[0] !== "chat.stopStream").map(c => (c[1] as any).markdown_text);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every(c => c.length <= 24_000 && !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(c))).toBe(true);
  });
  it.each(["unknown_method", "method_not_supported", "missing_scope", "not_allowed_token_type"])("falls back only on explicit start rejection: %s", async error => {
    const h = harness(); h.apiCall.mockResolvedValueOnce({ ok: false, error }); await h.run();
    expect(h.postMessage).toHaveBeenCalledOnce(); expect(h.apiCall).toHaveBeenCalledOnce();
  });
  it("supports SDK structured platform rejection, not message substring guesses", async () => {
    const h = harness(); h.apiCall.mockRejectedValueOnce({ code: "slack_webapi_platform_error", data: { error: "unknown_method" } }); await h.run();
    expect(h.postMessage).toHaveBeenCalledOnce();
    const ambiguous = harness(); ambiguous.apiCall.mockRejectedValueOnce(new Error("unknown_method transport closed"));
    await expect(ambiguous.run()).rejects.toThrow(); expect(ambiguous.postMessage).not.toHaveBeenCalled();
  });
  it.each(["internal_error", "request_timeout", "ratelimited", "invalid_auth"])("never reposts ambiguous/other start failures: %s", async error => {
    const h = harness(); h.apiCall.mockResolvedValueOnce({ ok: false, error });
    await expect(h.run()).rejects.toThrow(); expect(h.postMessage).not.toHaveBeenCalled();
  });
  it.each(["chat.appendStream", "chat.stopStream"])("does not duplicate after %s transport failure", async method => {
    const h = harness("x".repeat(13_000));
    h.apiCall.mockImplementation(async name => { if (name === method) throw new Error("ambiguous"); return { ok: true, ts: "2.1" }; });
    await expect(h.run()).rejects.toThrow(); expect(h.postMessage).not.toHaveBeenCalled();
    expect(h.apiCall.mock.calls.filter(c => c[0] === "chat.startStream")).toHaveLength(1);
    expect(h.apiCall.mock.calls.length).toBeLessThanOrEqual(4);
  });
  it("cancellation between final chunks suppresses append/fallback", async () => {
    const h = harness("x".repeat(13_000));
    h.apiCall.mockImplementationOnce(async () => { h.controller.abort(); return { ok: true, ts: "2.1" }; });
    await expect(h.run()).rejects.toThrow(); expect(h.apiCall).toHaveBeenCalledOnce(); expect(h.postMessage).not.toHaveBeenCalled();
  });
  it("uses the existing blocks renderer for oversized answers", async () => {
    const h = harness("x".repeat(24_001)); await h.run();
    expect(h.apiCall).not.toHaveBeenCalled(); expect(h.postMessage).toHaveBeenCalledOnce();
  });
});
