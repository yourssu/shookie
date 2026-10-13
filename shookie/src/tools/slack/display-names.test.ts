import { describe, expect, it, vi } from "vitest";
import { RequestContext } from "@mastra/core/request-context";
import { SlackDisplayNames, safeDisplayName, type DisplayClient } from "./display-names.js";
import { SlackReader, type SlackReadClient } from "./client.js";
import { bindSlackReadContext } from "./context.js";
import { ExecutionScope, executionStorage } from "../../cancellation/execution-context.js";
import { ConversationStoppedError } from "../../cancellation/conversation-control.js";
import { readSlackThread } from "../../slack/slack-thread-source.js";

const ts = "1700000000.000001";
function fixture() {
  const info = vi.fn(async ({ user }: { user: string }) => ({ ok: true, user: { id: user, profile: { display_name: "민수", real_name: "Other" } } }));
  const bots = vi.fn(async ({ bot }: { bot: string }) => ({ ok: true, bot: { id: bot, name: "알림 봇" } }));
  const messages = [{ ts, text: "root", user: "U1", reply_count: 0 }];
  const client = { users: { info }, bots: { info: bots }, auth: { test: vi.fn().mockResolvedValue({ ok: true, team_id: "T1", bot_id: "B1", url: "https://synthetic.slack.com/" }) },
    conversations: { info: vi.fn().mockResolvedValue({ ok: true, channel: { id: "C1", name: "개발", context_team_id: "T1", is_channel: true, is_private: false, is_group: false } }),
      members: vi.fn().mockResolvedValue({ ok: true, members: ["U1"] }), replies: vi.fn().mockResolvedValue({ ok: true, messages }), history: vi.fn().mockResolvedValue({ ok: true, messages }) },
    apiCall: vi.fn().mockResolvedValue({ ok: true, results: { messages: [{ channel_id: "C1", team_id: "T1", message_ts: ts, content: "root", author_user_id: "U1", is_author_bot: false, permalink: "https://synthetic.slack.com/archives/C1/p1700000000000001" }] } }) };
  const context = new RequestContext(); bindSlackReadContext(context, { teamId: "T1", userId: "U1", channel: "C1", requestId: "names" }, "ACTION_SECRET");
  return { client: client as unknown as SlackReadClient, info, bots, context };
}
describe("bounded Slack display metadata", () => {
  it("wires automatic channel-thread context and explicit channel/thread/search without changing authorship (not DM persistence)", async () => {
    const f = fixture();
    const automatic = await readSlackThread(f.client, { channel: "C1", threadTs: ts, currentTs: ts, userId: "U1", botUserId: "USELF" });
    expect(JSON.parse(automatic[0].content)).toMatchObject({ channelName: "개발", author: { userId: "U1", displayName: "민수", kind: "participant" } });
    expect(automatic[0].role).toBe("user");
    const reader = new SlackReader(f.client);
    for (const result of [await reader.read("channel", {}, f.context), await reader.read("thread", { ts }, f.context), await reader.search({ query: "root" }, f.context)]) {
      expect(result).toMatchObject({ status: "ok", complete: true, messages: [{ author: { displayName: "민수", userId: "U1" } }] });
    }
    f.info.mockRejectedValue(new Error("missing_scope"));
    expect(await reader.read("thread", { ts }, f.context)).toMatchObject({ status: "ok", messages: [{ author: { displayName: "참여자" } }] });
  });
  it.each(["thread", "channel"] as const)("starts metadata budget after delayed %s content fetch and bounds the full enrichment", async kind => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const delayed = vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 1000));
        return { ok: true, messages: [{ ts, text: "root", user: "U1", reply_count: 1 },
          { ts: "1700000000.000002", thread_ts: ts, text: "reply", user: "U2" }] };
      });
      if (kind === "thread") f.client.conversations.replies = delayed;
      else f.client.conversations.history = delayed;
      f.info.mockImplementation(async ({ user }) => {
        if (user === "U2") return new Promise(() => {});
        return { ok: true, user: { id: user, profile: { display_name: "민수", real_name: "" } } };
      });
      const pending = new SlackReader(f.client).read(kind, kind === "thread" ? { ts } : {}, f.context);
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.info).toHaveBeenCalledWith({ user: "U1" });
      await vi.advanceTimersByTimeAsync(751);
      expect(await pending).toMatchObject({ status: "ok", messages: [
        { author: { displayName: "민수" } }, { author: { displayName: "참여자" } },
      ] });
      expect(f.info).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it.each(["channel", "user"] as const)("preserves request cancellation during automatic %s metadata lookup, with no subsequent chat/output", async phase => {
    const f = fixture(), scope = new ExecutionScope();
    const chat = vi.fn(), output = vi.fn();
    let started!: () => void, finish!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    const lookup = vi.fn(async () => { started(); await blocked; throw new Error("transport aborted"); });
    if (phase === "channel") f.client.conversations.info = lookup;
    else f.client.users!.info = lookup;
    try {
      const pending = executionStorage.run(scope, async () => {
        const messages = await readSlackThread(f.client, { channel: "C1", threadTs: ts, currentTs: ts, userId: "U1", botUserId: "USELF" });
        chat(messages); output("answer");
      });
      const stopped = expect(pending).rejects.toBeInstanceOf(ConversationStoppedError);
      await began; scope.control.cancel(); finish(); await stopped;
      expect(chat).not.toHaveBeenCalled(); expect(output).not.toHaveBeenCalled();
      if (phase === "channel") expect(f.info).not.toHaveBeenCalled();
    } finally { scope.control.finish(); }
  });
  it("deduplicates users, attributes user-backed bots via users.info and only missing-user bots via bots.info", async () => {
    const f = fixture(), names = new SlackDisplayNames(f.client);
    const author = { userId: "U1", botId: "B1", kind: "bot" };
    expect(await names.author(author)).toBe("민수"); expect(await names.author(author)).toBe("민수");
    expect(f.info).toHaveBeenCalledTimes(1); expect(f.bots).not.toHaveBeenCalled();
    expect(await names.author({ userId: null, botId: "B1", kind: "bot" })).toBe("알림 봇");
  });
  it("caps sequential lookups and logical deadline without claiming HTTP cancellation", async () => {
    const f = fixture(), names = new SlackDisplayNames(f.client);
    for (let i = 0; i < 30; i++) await names.author({ userId: `U${i}`, botId: null, kind: "participant" });
    expect(f.info).toHaveBeenCalledTimes(20);
    vi.useFakeTimers();
    try {
      f.info.mockImplementation(() => new Promise(() => {}));
      const slow = new SlackDisplayNames(f.client);
      const pending = slow.author({ userId: "U1", botId: null, kind: "participant" });
      await vi.advanceTimersByTimeAsync(751); expect(await pending).toBe("참여자");
      expect(await slow.author({ userId: "U2", botId: null, kind: "shookie" })).toBe("이 봇");
      expect(f.info).toHaveBeenCalledTimes(21);
    } finally { vi.useRealTimers(); }
  });
  it("budgets escaped/redacted whole envelopes including enriched metadata", async () => {
    const f = fixture();
    f.info.mockImplementation(async ({ user }) => ({ ok: true, user: { id: user, profile: { display_name: "한".repeat(80), real_name: "" } } }));
    const text = ('"\\\\😀ACTION_SECRET').repeat(3000);
    const messages = Array.from({ length: 15 }, (_, i) => ({ ts: `1700000000.${String(i + 1).padStart(6, "0")}`, user: "U1", text }));
    f.client.conversations.history = vi.fn().mockResolvedValue({ ok: true, messages });
    f.client.apiCall = vi.fn().mockResolvedValue({ ok: true, results: { messages: messages.map(m => ({ channel_id: "C1", team_id: "T1", message_ts: m.ts, content: text, author_user_id: "U1", is_author_bot: false,
      permalink: `https://synthetic.slack.com/archives/C1/p${m.ts.replace(".", "")}` })) } });
    const reader = new SlackReader(f.client);
    for (const result of [await reader.read("channel", {}, f.context), await reader.search({ query: "root" }, f.context)]) {
      expect(result.status).toBe("ok"); expect(result.truncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(result.limits.maxPageBytes);
      expect(JSON.stringify(result)).not.toContain("ACTION_SECRET");
      expect(result.messages[0].author.displayName).toBe("한".repeat(80));
    }
  });
  it("projects primitive safe names without getters, proxy traps or secret/control markup", async () => {
    const getter = vi.fn(() => { throw Error("metadata getter"); });
    const profile = Object.defineProperty({ real_name: "검증된 이름" }, "display_name", { get: getter });
    const trap = vi.fn(() => { throw Error("proxy trap"); });
    const client = { users: { info: vi.fn().mockResolvedValue({ ok: true, user: { id: "U1", profile } }) } } as unknown as DisplayClient;
    expect(await new SlackDisplayNames(client).author({ userId: "U1", botId: null, kind: "participant" })).toBe("검증된 이름");
    expect(getter).not.toHaveBeenCalled();
    client.users!.info = vi.fn().mockResolvedValue(new Proxy({}, { getOwnPropertyDescriptor: trap }));
    expect(await new SlackDisplayNames(client).author({ userId: "U1", botId: null, kind: "participant" })).toBe("참여자");
    expect(trap).not.toHaveBeenCalled();
    for (const bad of ["<!here>", "@everyone", "a\nname", "ACTION_SECRET", "`code`", "a\u202ename"]) expect(safeDisplayName(bad, "ACTION_SECRET")).toBeUndefined();
  });
});
