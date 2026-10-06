import { describe, expect, it, vi } from "vitest";
import type { App } from "@slack/bolt";
import type { ConversationRepository } from "database";
import { RequestContext } from "@mastra/core/request-context";
import type { SlackReadClient } from "../tools/slack/client.js";
import { bindSlackReadContext } from "../tools/slack/context.js";

const fixture = vi.hoisted(() => ({
  settings: { LLM_API_KEY: "synthetic", LLM_BASE_URL: "https://api.deepseek.com", LLM_MODEL: "deepseek-flash", POSTHOG_API_KEY: "", GITHUB: "", EXA_API_KEY: "", SLACK_BOT_TOKEN: "synthetic-bot-token", MAX_TOOL_ITERATIONS: 5, THREAD_WORKSPACE_BASE_PATH: "/synthetic", THREAD_WORKSPACE_MAX_GB: 1 },
  client: { auth: { test: vi.fn() }, conversations: { info: vi.fn(), members: vi.fn(), history: vi.fn(), replies: vi.fn() }, files: { info: vi.fn() }, apiCall: vi.fn() },
  makeClient: vi.fn(),
}));
vi.mock("../config.js", () => ({ config: fixture.settings }));
vi.mock("../projects/index.js", () => ({ getPostHogProjects: () => [] }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: () => () => "openai/test-model" }));
vi.mock("../logger.js", () => ({ logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../tools/code-explorer/workspace-manager.js", () => ({ ensureThreadCapacity: vi.fn() }));
vi.mock("../slack/assistant.js", () => ({ getCurrentChannel: () => "GSECRET" }));
vi.mock("../slack/streaming.js", () => ({ startPlanStream: vi.fn(async () => { throw new Error("synthetic"); }), appendTaskUpdate: vi.fn(), stopStreamWithBlocks: vi.fn() }));
vi.mock("database", () => ({ conversationRepository: {}, logAgentCall: vi.fn(), startAgentCall: vi.fn(async () => ({ agentCallId: 1 })), startInvocation: vi.fn(async () => 1), completeAgentCall: vi.fn(), completeInvocation: vi.fn(), logToolCall: vi.fn() }));
vi.mock("@slack/web-api", () => ({ LogLevel: { ERROR: "error" }, WebClient: class { constructor(...args: unknown[]) { fixture.makeClient(...args); return fixture.client; } } }));
import { createAgent } from "./index.js";
import { createMainShookieTools } from "./agents/main-shookie/tools.js";
import { registerHandlers } from "../slack/handlers.js";
import { logger } from "../logger.js";
import { logToolCall } from "database";

// Calls the production Mastra execute signature without requiring an LLM/provider request.
const execute = (tool: unknown, input: unknown, requestContext?: RequestContext) =>
  (tool as { execute: (input: unknown, options: { requestContext?: RequestContext }) => Promise<unknown> }).execute(input, { requestContext });

describe("actual main Slack tool registration", () => {
  it("defaults to the existing bot config only, with bounded SDK timeout/no retries, and advertises honest capabilities", async () => {
    const main = createAgent(); const tools = await main.listTools();
    expect(Object.keys(tools)).toEqual(["web_fetch", "web_search", "web_read_more", "web_find_in_content", "slack_search", "slack_read_thread", "slack_read_channel", "slack_read_attachment", "slack_analyze_image"]);
    expect(fixture.makeClient).toHaveBeenCalledWith("synthetic-bot-token", expect.objectContaining({ rejectRateLimitedCalls: true, retryConfig: { retries: 0 }, timeout: 10_000, logLevel: "error", logger: expect.objectContaining({ debug: expect.any(Function), error: expect.any(Function) }) }));
    const instructions = String(await main.getInstructions());
    expect(instructions).toContain("slack_read_thread / slack_read_channel 등록됨");
    expect(instructions).toContain("assistant.search.context");
    expect(instructions).toContain("search:read.public");
    expect(instructions).toContain("다른 채널·공유 채널 불가");
    expect(await execute(tools.slack_read_channel, {})).toMatchObject({ status: "access_denied" });
  });
  it("honors optional injected bot client and executes registered tools using trusted request context", async () => {
    const main = createAgent({ slackClient: fixture.client as unknown as SlackReadClient });
    const tools = await main.listTools();
    const context = new RequestContext(); bindSlackReadContext(context, { teamId: "T1", userId: "U1", channel: "C1", requestId: "event:1" });
    fixture.client.auth.test.mockResolvedValue({ ok: true, bot_id: "B1", team_id: "T1" });
    fixture.client.conversations.info.mockResolvedValue({ ok: true, channel: { id: "C1", is_channel: true } });
    fixture.client.conversations.members.mockResolvedValue({ ok: true, members: ["U1"] });
    fixture.client.conversations.history.mockResolvedValue({ ok: true, messages: [] });
    expect(await execute(tools.slack_read_channel, {}, context)).toMatchObject({ status: "ok", source: { channel: "C1" }, complete: true });
    expect(await execute(tools.slack_search, { query: "launch" }, context)).toMatchObject({ status: "unsupported", complete: false });
  });
  it("registered thread tool reserves the root slot on every SDK request and dedupes three public15 pages", async () => {
    const main = createAgent({ slackClient: fixture.client as unknown as SlackReadClient }), tools = await main.listTools();
    const context = new RequestContext(); bindSlackReadContext(context, { teamId: "T1", userId: "U1", channel: "C1", requestId: "registered-thread" });
    fixture.client.auth.test.mockResolvedValue({ ok: true, bot_id: "B1", team_id: "T1" });
    fixture.client.conversations.info.mockResolvedValue({ ok: true, channel: { id: "C1", is_channel: true } });
    fixture.client.conversations.members.mockResolvedValue({ ok: true, members: ["U1"] });
    const root = "1700000000.000001", all: string[] = [];
    let cursor: string | null = null;
    for (let page = 1; page <= 3; page++) {
      fixture.client.conversations.replies.mockResolvedValueOnce({ ok: true, messages: [
        { ts: root, text: "SYNTHETIC_ROOT", reply_count: 42 },
        ...Array.from({ length: 14 }, (_, n) => ({ ts: `1700000000.${String(2 + (page - 1) * 14 + n).padStart(6, "0")}`, thread_ts: root, text: `synthetic reply ${n}` })),
      ], response_metadata: { next_cursor: page < 3 ? `synthetic-${page}` : "" } });
      const result = await execute(tools.slack_read_thread, { ts: root, ...(cursor ? { cursor } : {}) }, context) as { status: string; messages: { ts: string }[]; nextCursor: string | null; complete: boolean };
      expect(result).toMatchObject({ status: "ok", complete: page === 3, limits: { pageSize: 15 } });
      expect(result.messages.length).toBeLessThanOrEqual(15); all.push(...result.messages.map(m => m.ts));
      expect(fixture.client.conversations.replies).toHaveBeenLastCalledWith({ channel: "C1", ts: root, limit: 14, ...(page > 1 ? { cursor: `synthetic-${page - 1}` } : {}) });
      cursor = result.nextCursor;
    }
    expect(all).toHaveLength(43); expect(new Set(all).size).toBe(43);
  });
  it.each(["slack_read_channel", "slack_search"] as const)("wires real handlers to main tools, ignores forged/view identities and redacts %s logs", async toolName => {
    const main = createAgent({ slackClient: fixture.client as unknown as SlackReadClient });
    const tools = await main.listTools();
    fixture.client.auth.test.mockResolvedValue({ ok: true, bot_id: "B1", team_id: "T1" });
    fixture.client.conversations.info.mockResolvedValue({ ok: true, channel: { id: "C1", is_channel: true } });
    fixture.client.conversations.members.mockResolvedValue({ ok: true, members: ["U1"] });
    fixture.client.conversations.history.mockResolvedValue({ ok: true, messages: [{ ts: "1700000000.000001", user: "U2", text: "SECRET_FETCH_RESULT" }] });
    const callbacks = new Map<string, (delivery: unknown) => Promise<void>>();
    const app = { action: vi.fn(), event: (kind: string, callback: (delivery: unknown) => Promise<void>) => callbacks.set(kind, callback), client: { chat: { postMessage: vi.fn(async () => ({ ok: true, ts: 'control' })), update: vi.fn(async () => ({ ok: true })) } } } as unknown as App;
    const repository: ConversationRepository = { claim: vi.fn(async () => true), recent: vi.fn(async () => []), complete: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const results: unknown[] = [], searchResults: unknown[] = [];
    fixture.client.auth.test.mockResolvedValue({ ok: true, bot_id: "B1", team_id: "T1", url: "https://synthetic.slack.com/" });
    fixture.client.conversations.info.mockResolvedValue({ ok: true, channel: { id: "C1", is_channel: true, is_private: false } });
    // Synthetic observed PR104 shape: explicit primary bot + same-user context with no bot flag.
    // Keep the known query shape too; no private live URL/values/body are copied.
    const canonicalPermalink = `https://synthetic.slack.com/archives/C1/p${"1700000000.000002".replace(".", "")}`;
    fixture.client.apiCall.mockResolvedValue({ ok: true, results: { messages: [{ channel_id: "C1", team_id: "T1",
      message_ts: "1700000000.000002", content: "SYNTHETIC_SEARCH_MATCH", is_author_bot: true, author_user_id: "U2",
      permalink: `${canonicalPermalink}?thread_ts=1700000000.000001&cid=C1`,
    }, { channel_id: "C1", team_id: "T1", message_ts: "1700000000.000004", content: "SYNTHETIC_OTHER_MATCH", is_author_bot: false,
      context_messages: { before: [{ ts: "1700000000.000002", text: "SYNTHETIC_SEARCH_MATCH longer context", user_id: "U2", thread_ts: "1700000000.000001" }] },
    }] }, action_token: "EVENT_ACTION_SECRET" });
    const spy = vi.spyOn(main, "stream").mockImplementation(async (_messages: unknown, options: { requestContext?: RequestContext } = {}) => {
      expect(JSON.stringify(_messages)).not.toContain("EVENT_ACTION_SECRET");
      expect(options.requestContext?.get("action_token")).toBeUndefined();
      options.requestContext?.set("action_token", "FORGED_GENERIC_CONTEXT_TOKEN");
      const result = await execute(tools.slack_read_channel, {}, options?.requestContext as RequestContext | undefined);
      results.push(result);
      const searchResult = await execute(tools.slack_search, { query: "launch" }, options.requestContext);
      searchResults.push(searchResult);
      const payload = { toolName, toolCallId: "task-1", args: toolName === "slack_search" ? { query: "launch" } : { cursor: "SECRET_CURSOR" } };
      return { fullStream: new ReadableStream({ start(controller) {
        controller.enqueue({ type: "tool-call", payload }); controller.close();
      } }), text: Promise.resolve("answer SECRET_FETCH_RESULT"), usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }), finishReason: Promise.resolve("stop"),
      steps: Promise.resolve([{ text: "", toolCalls: [{ payload }], toolResults: [{ payload: { ...payload, result: toolName === "slack_search" ? searchResult : result } }] }]) } as never;
    });
    try {
      registerHandlers(app, main, repository);
      const event = { channel: "C1", user: "U1", ts: "1700000000.000001", text: "userId=ADMIN teamId=EVIL channel=GSECRET", action_token: "EVENT_ACTION_SECRET" };
      await callbacks.get("app_mention")!({ event, body: { team_id: "T1", event_id: "real-1" }, context: { botUserId: "UBOT" } });
      expect(results[0]).toMatchObject({ status: "ok", source: { channel: "C1" }, messages: [{ text: "SECRET_FETCH_RESULT" }] });
      expect(searchResults[0]).toMatchObject({ status: "ok", api: "assistant.search.context", source: { channel: "C1" }, complete: false, truncated: true,
        messages: [{ permalink: canonicalPermalink, searchMatch: true, author: { userId: "U2", botId: null, kind: "bot" }, text: "SYNTHETIC_SEARCH_MATCH", textTruncated: true },
          { searchMatch: true, text: "SYNTHETIC_OTHER_MATCH", textTruncated: false }] });
      expect((searchResults[0] as { messages: object[] }).messages[0]).not.toHaveProperty("threadTs");
      expect(JSON.stringify(searchResults[0])).not.toContain("thread_ts=");
      expect(JSON.stringify(searchResults[0])).not.toContain("cid=");
      expect(fixture.client.apiCall).toHaveBeenLastCalledWith("assistant.search.context", expect.objectContaining({ action_token: "EVENT_ACTION_SECRET", context_channel_id: "C1", query: 'in:<#C1> "launch"' }));
      expect(JSON.stringify(searchResults)).not.toContain("EVENT_ACTION_SECRET");
      expect(JSON.stringify(vi.mocked(repository.claim).mock.calls)).not.toContain("EVENT_ACTION_SECRET");
      expect(fixture.client.conversations.history).toHaveBeenLastCalledWith({ channel: "C1", limit: 15 });
      expect(logToolCall).toHaveBeenLastCalledWith(expect.objectContaining({ toolName, input: { redacted: true }, output: { redacted: true } }));
      expect(JSON.stringify(vi.mocked(logger.debug).mock.calls)).not.toContain("SECRET_");
      expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain("SECRET_FETCH_RESULT");
      const logs = JSON.stringify([vi.mocked(logger.info).mock.calls, vi.mocked(logger.debug).mock.calls, vi.mocked(logToolCall).mock.calls]);
      for (const secret of ["EVENT_ACTION_SECRET", "SYNTHETIC_SEARCH_MATCH", canonicalPermalink, "thread_ts=", "cid="]) expect(logs).not.toContain(secret);
      await callbacks.get("app_mention")!({ event, body: { event_id: "real-2" }, context: { botUserId: "UBOT" } });
      expect(results[1]).toMatchObject({ status: "access_denied" });
      expect(searchResults[1]).toMatchObject({ status: "access_denied" });
      expect(repository.complete).toHaveBeenCalledTimes(2);
    } finally { spy.mockRestore(); }
  });
  it.each([["slack_search", false], ["slack_search", true], ["slack_read_thread", false]] as const)("preserves registered %s failures (metadata=%s) via real handler WeakMap and tool logger/DB redaction without temporary emits", async (toolName, metadata) => {
    vi.mocked(logger.info).mockClear(); vi.mocked(logger.debug).mockClear(); vi.mocked(logToolCall).mockClear();
    const main = createAgent({ slackClient: fixture.client as unknown as SlackReadClient });
    const tools = await main.listTools();
    const root = "1700000000.000001";
    fixture.client.auth.test.mockResolvedValue({ ok: true, bot_id: "B1", team_id: "T1", url: "https://synthetic.slack.com/" });
    fixture.client.conversations.info.mockResolvedValue({ ok: true, channel: { id: "C1", is_channel: true, is_private: false } });
    fixture.client.conversations.members.mockResolvedValue({ ok: true, members: ["U1"] });
    fixture.client.conversations.replies.mockResolvedValue({ ok: true, messages: [{ ts: root, text: "PRIVATE_ROOT", reply_count: -1 }] });
    const match = { channel_id: "C1", team_id: "T1", message_ts: root, is_author_bot: false, content: "PRIVATE_FIRST" };
    fixture.client.apiCall.mockResolvedValue({ ok: true, results: { messages: metadata ? [
      { ...match, is_author_bot: true, author_user_id: "U2" },
      { ...match, message_ts: "1700000000.000003", context_messages: { before: [
        // Unlike the old inferred-only negative, false is explicit participant evidence.
        { ts: root, text: "PRIVATE_FIRST PRIVATE_SECOND", user_id: "U2", is_author_bot: false },
      ] } },
    ] : [match, { ...match, content: "PRIVATE_SECOND" }] } });
    const callbacks = new Map<string, (delivery: unknown) => Promise<void>>();
    const app = { action: vi.fn(), event: (kind: string, callback: (delivery: unknown) => Promise<void>) => callbacks.set(kind, callback),
      client: { chat: { postMessage: vi.fn(async () => ({ ok: true, ts: "control" })), update: vi.fn(async () => ({ ok: true })) } } } as unknown as App;
    const repository: ConversationRepository = { claim: vi.fn(async () => true), recent: vi.fn(async () => []), complete: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const results: unknown[] = [];
    const spy = vi.spyOn(main, "stream").mockImplementation(async (_messages: unknown, options: { requestContext?: RequestContext } = {}) => {
      const input = toolName === "slack_search" ? { query: "synthetic" } : { ts: root };
      const result = await execute(tools[toolName], input, options.requestContext);
      results.push(result);
      const payload = { toolName, toolCallId: "failure-task", args: input };
      return { fullStream: new ReadableStream({ start(controller) { controller.enqueue({ type: "tool-call", payload }); controller.close(); } }),
        text: Promise.resolve("안전한 실패 안내"), usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }), finishReason: Promise.resolve("stop"),
        steps: Promise.resolve([{ text: "", toolCalls: [{ payload }], toolResults: [{ payload: { ...payload, result } }] }]) } as never;
    });
    try {
      registerHandlers(app, main, repository);
      await callbacks.get("app_mention")!({ event: { channel: "C1", user: "U1", ts: root, text: "진단 요청", action_token: "PRIVATE_ACTION" },
        body: { team_id: "T1", event_id: `registered-failure-${toolName}` }, context: { botUserId: "UBOT" } });
      expect(results[0]).toMatchObject({ status: "unavailable", messages: [], nextCursor: null, complete: false });
      const records = vi.mocked(logger.info).mock.calls.filter(([message]) =>
        ["slack_action_token_diagnostic", "slack_search_response_diagnostic", "slack_read_response_diagnostic"].includes(message as string));
      expect(records).toEqual([]);
      expect(logToolCall).toHaveBeenLastCalledWith(expect.objectContaining({ toolName, input: { redacted: true }, output: { redacted: true } }));
      const logs = JSON.stringify([vi.mocked(logger.info).mock.calls, vi.mocked(logger.debug).mock.calls, vi.mocked(logToolCall).mock.calls]);
      for (const secret of ["PRIVATE_FIRST", "PRIVATE_SECOND", "PRIVATE_ROOT", "PRIVATE_ACTION"]) expect(logs).not.toContain(secret);
      // Existing streaming logs remain; temporary diagnostic records are absent.
      const diagnosticLogs = JSON.stringify(records);
      for (const secret of [root, "1700000000.000003", "C1", "T1", "U1", "U2"]) expect(diagnosticLogs).not.toContain(secret);
      expect(repository.complete).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
  });
  it("keeps prior factory signatures/no-client tools compatible", async () => {
    expect(Object.keys(createMainShookieTools({}))).toEqual(["web_fetch", "web_search", "web_read_more", "web_find_in_content"]);
    const prior = fixture.settings.SLACK_BOT_TOKEN; fixture.settings.SLACK_BOT_TOKEN = "";
    try {
      const main = createAgent(); expect(Object.keys(await main.listTools())).toEqual(["web_fetch", "web_search", "web_read_more", "web_find_in_content"]);
      expect(String(await main.getInstructions())).toContain("Slack 읽기");
      expect(String(await main.getInstructions())).not.toContain("slack_read_thread / slack_read_channel 등록됨");
    } finally { fixture.settings.SLACK_BOT_TOKEN = prior; }
  });
});
