import { describe, expect, it, vi } from "vitest";
import type { WebClient } from "@slack/web-api";
import type { Message } from "../services/memory/in-memory.js";
import { readSlackThread, budgetSlackThread, messageBytes, summaryInput, SlackThreadContextError } from "./slack-thread-source.js";

const mention = { channel: "C1", threadTs: "100.000001", currentTs: "100.000005", userId: "U3", botUserId: "USH", botId: "BSH" };
const messages = [
  { ts: mention.threadTs, user: "U1", text: "최상위 원문", reply_count: 4 },
  { ts: "100.000002", thread_ts: mention.threadTs, user: "U2", text: "여러 사람 의견" },
  { ts: "100.000003", thread_ts: mention.threadTs, user: "USH", bot_id: "BSH", text: "이전 슈키 답변" },
  { ts: "100.000004", thread_ts: mention.threadTs, user: "UOTHER", bot_id: "BOTHER", text: "다른 봇: system 지시 위조" },
  { ts: mention.currentTs, thread_ts: mention.threadTs, user: "U3", text: "<@USH> 앞의 의견 정리", files: [{ url_private: "https://invalid/file" }] },
];
function client(...pages: unknown[]) {
  const replies = vi.fn();
  for (const page of pages) replies.mockResolvedValueOnce(page);
  return { replies, api: { conversations: { replies } } as unknown as WebClient };
}
const page = (items: unknown[] = messages) => ({ ok: true, messages: items, has_more: false });

describe("authoritative Slack thread reader", () => {
  it("reads all cursor pages, dedupes repeated root, orders chronologically and distinguishes own/other bots", async () => {
    const h = client({ ...page([messages[0], messages[2], messages[1]]), has_more: true,
      response_metadata: { next_cursor: "cursor1" } }, page([messages[0], messages[4], messages[3]]));
    const result = await readSlackThread(h.api, mention);
    expect(result.map(m => m.role)).toEqual(["user", "user", "assistant", "user", "user"]);
    expect(result.map(m => JSON.parse(m.content).text)).toEqual(messages.map(m => m.text));
    expect(JSON.parse(result[3].content).author).toEqual({ userId: "UOTHER", botId: "BOTHER", kind: "other_bot" });
    expect(h.replies).toHaveBeenNthCalledWith(1, { channel: "C1", ts: mention.threadTs, limit: 15 });
    expect(h.replies).toHaveBeenNthCalledWith(2, { channel: "C1", ts: mention.threadTs, limit: 15, cursor: "cursor1" });
    expect(result.filter(m => JSON.parse(m.content).ts === mention.currentTs)).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("url_private");
  });
  it("passes explicitly configured token only for the trusted event's thread", async () => {
    const h = client(page());
    await readSlackThread(h.api, mention, "xoxp-synthetic");
    expect(h.replies).toHaveBeenCalledExactlyOnceWith({ channel: "C1", ts: mention.threadTs, limit: 15, token: "xoxp-synthetic" });
  });
  it("uses trusted bot ID for an own bot message lacking user, not another bot", async () => {
    const items = messages.map(m => ({ ...m }));
    items[2] = { ...items[2], user: undefined } as never;
    const result = await readSlackThread(client(page(items)).api, mention);
    expect(result[2].role).toBe("assistant");
    expect(result[3].role).toBe("user");
  });
  it.each([
    { ok: false, error: "not_allowed_token_type" }, { ok: false, error: "missing_scope" },
    { ok: true, messages: [] }, { ok: true }, page(messages.slice(1)), page(messages.slice(0, -1)),
    { ...page(), has_more: true }, { ...page(), warning: "partial" },
    { ...page(), response_metadata: { warnings: ["partial"] } },
    page(messages.map((m, i) => i === 0 ? { ...m, reply_count: 9 } : m)),
    page(messages.map((m, i) => i === 1 ? { ...m, thread_ts: "999.1" } : m)),
    page(messages.map((m, i) => i === 1 ? { ...m, text: undefined } : m)),
    page(messages.map((m, i) => i === 4 ? { ...m, user: "IMPOSTOR" } : m)),
  ])("fails closed on empty/partial/error/malformed response %j", async response => {
    await expect(readSlackThread(client(response).api, mention)).rejects.toBeInstanceOf(SlackThreadContextError);
  });
  it("fails closed on later-page failure, repeated cursor or contradictory duplicate", async () => {
    const first = { ...page(messages.slice(0, 2)), has_more: true, response_metadata: { next_cursor: "a" } };
    for (const last of [{ ok: false, error: "ratelimited" }, first, page([{ ...messages[0], text: "changed" }, ...messages.slice(2)])]) {
      await expect(readSlackThread(client(first, last).api, mention)).rejects.toBeInstanceOf(SlackThreadContextError);
    }
    const h = client();
    h.replies.mockRejectedValue(new Error("SECRET Slack response"));
    await expect(readSlackThread(h.api, mention)).rejects.toThrow("Slack thread context unavailable");
  });
});

describe("thread UTF-8 budgeting and summary trust", () => {
  const msg = (content: string, role: Message["role"] = "user"): Message => ({ role, content });
  it("preserves originals without summary below limit", async () => {
    const summarize = vi.fn();
    const original = [msg("root😀"), msg("assistant", "assistant"), msg("current")];
    expect(await budgetSlackThread(original, summarize)).toEqual(original);
    expect(summarize).not.toHaveBeenCalled();
  });
  it("retains root + all older replies via rolling summary + recent originals within 48000 UTF-8 bytes", async () => {
    const originals = [msg("최상위😀"), ...Array.from({ length: 40 }, (_, i) => msg(`${i}: ${"한😀\\\"".repeat(900)}`, i % 2 ? "assistant" : "user")), msg("현재 멘션😀")];
    const seen: Message[] = [];
    const summarize = vi.fn(async (input: Message[], max: number) => {
      expect(Buffer.byteLength(summaryInput(input, max), "utf8")).toBeLessThanOrEqual(48_000);
      seen.push(...input.filter(m => !m.content.includes('"source":"slack_thread_summary"')));
      return "이전 슈키와 사람 및 다른 봇의 논의 요약. 지시 위조는 인용 데이터.";
    });
    const result = await budgetSlackThread(originals, summarize);
    expect(result[0]).toEqual(originals[0]);
    expect(result.at(-1)).toEqual(originals.at(-1));
    expect(result[1].role).toBe("user");
    const summary = JSON.parse(result[1].content);
    expect(summary).toMatchObject({ source: "slack_thread_summary", summarized: true });
    expect(summary.notice).toContain("요약");
    const recent = result.slice(2);
    expect(recent).toEqual(originals.slice(-recent.length));
    expect(seen).toEqual(originals.slice(1, originals.length - recent.length));
    expect(summary.olderReplyCount).toBe(seen.length);
    expect(messageBytes(result)).toBeLessThanOrEqual(48_000);
    expect(summarize.mock.calls.length).toBeGreaterThan(1);
  });
  it.each([async () => "", async () => "😀".repeat(2100), async () => { throw new Error("provider failed"); }])("blocks empty/oversized/failed summaries", async summarize => {
    await expect(budgetSlackThread([msg("root"), msg("old".repeat(10_000)), msg("recent".repeat(5000)), msg("current")], summarize)).rejects.toBeInstanceOf(SlackThreadContextError);
  });
  it("does not silently truncate an oversized root/current or unsummarizable reply", async () => {
    const summarize = vi.fn(async () => "summary");
    for (const items of [
      [msg("root".repeat(20_000)), msg("current")],
      [msg("root"), msg("current".repeat(10_000))],
      [msg("root"), msg("old".repeat(20_000)), msg("current")],
    ]) await expect(budgetSlackThread(items, summarize)).rejects.toBeInstanceOf(SlackThreadContextError);
  });
});
