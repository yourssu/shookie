import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:net";
import { WebClient } from "@slack/web-api";
import { App, SocketModeReceiver } from "@slack/bolt";
import type { Agent } from "@mastra/core/agent";
import type { ConversationRepository } from "database";

vi.mock("@slack/bolt", async (original) => {
  const actual = await original<typeof import("@slack/bolt")>();
  return { ...actual,
    App: vi.fn(function (options) { return new actual.App(options); }),
    SocketModeReceiver: vi.fn(function (options) { return new actual.SocketModeReceiver(options); }),
  };
});
vi.mock("../config.js", () => ({ config: { MAX_TOOL_ITERATIONS: 5, THREAD_WORKSPACE_BASE_PATH: "/synthetic", THREAD_WORKSPACE_MAX_GB: 1 } }));
vi.mock("../logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../tools/code-explorer/workspace-manager.js", () => ({ ensureThreadCapacity: vi.fn() }));
vi.mock("./assistant.js", () => ({ getCurrentChannel: vi.fn() }));
vi.mock("./streaming.js", () => ({
  startPlanStream: vi.fn(async () => { throw new Error("synthetic stream unavailable"); }),
  appendTaskUpdate: vi.fn(), stopStreamWithBlocks: vi.fn(),
}));
vi.mock("database", () => ({ conversationRepository: {}, logAgentCall: vi.fn(), startAgentCall: vi.fn(async () => null),
  startInvocation: vi.fn(), completeAgentCall: vi.fn(), completeInvocation: vi.fn(), logToolCall: vi.fn() }));
import { createSocketModeApp } from "./socket-mode-app.js";
import { registerHandlers } from "./handlers.js";
import { logger } from "../logger.js";
import { SlackReader, type SlackReadClient } from "../tools/slack/client.js";
import { getSlackReadIdentity, getSlackSearchActionToken } from "../tools/slack/context.js";

const TOKEN = "SYNTHETIC_ACTION_SECRET";
const ALTERNATE = "ALTERNATE_ACTION_SECRET";
function records() {
  return vi.mocked(logger.info).mock.calls.filter(([name]) => ["slack_action_token_diagnostic", "slack_search_response_diagnostic", "slack_read_response_diagnostic"].includes(name as string));
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(WebClient.prototype, "apiCall").mockImplementation(async (method) => {
    if (method === "auth.test") return { ok: true, bot_id: "B1", user_id: "BOT", team_id: "T1" };
    return { ok: true, ts: "reply" };
  });
});
afterEach(() => { vi.restoreAllMocks(); });
function fixture() {
  return createSocketModeApp({ token: "xoxb-synthetic", appToken: "xapp-synthetic" });
}
const human = () => ({ type: "app_mention", channel: "C1", user: "U1", ts: "1700000000.000001", text: "<@BOT> launch" });
const envelope = (event: unknown = human()) => ({ type: "event_callback", event_id: "EvSYNTHETIC0001", team_id: "T1", event });
/** Installed public EventEmitter API; reproduce 2.0.7's documented parsed-payload emits, NOT raw frame parsing. */
function emitParsed(f: ReturnType<typeof fixture>, body: ReturnType<typeof envelope>, ack = vi.fn(async () => {})) {
  f.receiver.client.emit("app_mention", { body, event: body.event, ack });
  f.receiver.client.emit("slack_event", { type: "events_api", body, ack });
  return ack;
}

describe("installed SDK public events → receiver → authenticated Bolt handler → search", () => {
  it.each([
    { token: TOKEN, alternate: false, usable: true },
    { token: undefined, alternate: false, usable: false },
    { token: "invalid secret", alternate: false, usable: false },
    { token: undefined, alternate: true, usable: false },
  ])("keeps payload aliases and event-only authority: $usable / $alternate", async ({ token, alternate, usable }) => {
    const f = fixture();
    const complete = vi.fn(async () => {});
    const repository = { claim: vi.fn(async () => true), recent: vi.fn(async () => []), complete, fail: vi.fn() } as unknown as ConversationRepository;
    const apiCall = vi.fn(async () => ({ ok: true, results: { messages: [] } }));
    const reader = new SlackReader({ auth: { test: vi.fn(async () => ({ ok: true, bot_id: "B1", team_id: "T1", url: "https://synthetic.slack.com/" })) },
      conversations: { info: vi.fn(async () => ({ ok: true, channel: { id: "C1", is_channel: true, is_private: false } })),
        members: vi.fn(async () => ({ ok: true, members: ["U1"] })), history: vi.fn(), replies: vi.fn() }, apiCall } as unknown as SlackReadClient);
    let result: unknown, boundContext: object | undefined;
    const stream = vi.fn(async (_messages, options) => {
      boundContext = options.requestContext;
      result = await reader.search({ query: "launch" }, options.requestContext);
      return { fullStream: new ReadableStream({ start(c) { c.close(); } }), text: Promise.resolve("answer"),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }), steps: Promise.resolve([]), finishReason: Promise.resolve("stop") };
    });
    registerHandlers(f.app, { stream } as unknown as Agent, repository);
    const aliases = vi.fn();
    f.app.event("app_mention", async ({ event, body, context }) => { aliases(event === body.event, context.botUserId); });
    const body = { ...envelope({ ...human(), ...(token !== undefined ? { action_token: token } : {}) }), ...(alternate ? { action_token: ALTERNATE } : {}) };
    const ack = emitParsed(f, body);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(aliases).toHaveBeenCalledWith(true, "BOT"));
    expect(ack).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: usable ? "ok" : "unsupported" });
    const logs = records();
    expect(logs).toEqual([]);
    expect(getSlackReadIdentity(boundContext)).toEqual({ userId: "U1", teamId: "T1", channel: "C1", requestId: "slack-event:EvSYNTHETIC0001" });
    expect(getSlackSearchActionToken(boundContext)).toBe(usable ? TOKEN : undefined);
    expect(apiCall).toHaveBeenCalledTimes(usable ? 1 : 0);
    if (usable) expect(apiCall).toHaveBeenCalledWith("assistant.search.context", expect.objectContaining({ action_token: TOKEN }));
    for (const value of [vi.mocked(logger.info).mock.calls, stream.mock.calls.map(c => c[0]), complete.mock.calls, result]) {
      expect(JSON.stringify(value)).not.toContain(TOKEN); expect(JSON.stringify(value)).not.toContain(ALTERNATE);
    }
    expect(WebClient.prototype.apiCall).toHaveBeenCalledWith("auth.test", { token: "xoxb-synthetic" });
  });

  it("delivers and acknowledges through the standard receiver without temporary observers", async () => {
    const f = fixture();
    const delivery = vi.fn();
    f.app.event("app_mention", async () => { delivery(); });
    const ack = emitParsed(f, envelope());
    await vi.waitFor(() => expect(delivery).toHaveBeenCalledTimes(1));
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it("uses one receiver/client, preserves constructor auth defaults and installs no diagnostic plumbing", async () => {
    const f = fixture();
    expect(SocketModeReceiver).toHaveBeenCalledTimes(1); expect(App).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(App).mock.calls[0][0]!;
    expect(opts).toMatchObject({ token: "xoxb-synthetic", appToken: "xapp-synthetic", socketMode: true, receiver: f.receiver });
    for (const key of ["authorize", "ignoreSelf", "tokenVerificationEnabled", "botId", "botUserId"]) expect(opts).not.toHaveProperty(key);
    expect(vi.mocked(SocketModeReceiver).mock.calls[0][0]).toMatchObject({ customRoutes: undefined });
    expect(vi.mocked(SocketModeReceiver).mock.calls[0][0].installerOptions).not.toHaveProperty("port");
    expect(opts.clientOptions?.logger).toBe(opts.logger);
    expect(opts.clientOptions?.retryConfig).toEqual({ retries: 100, factor: 1.3 });
    expect(vi.mocked(SocketModeReceiver).mock.calls[0][0].installerOptions?.clientOptions).toMatchObject({ logger: opts.logger });
    expect(f.receiver.client.listenerCount("slack_event")).toBe(1);
    const delivery = vi.fn(); f.app.event("app_mention", async () => { delivery(); });
    expect(vi.mocked(SocketModeReceiver).mock.calls[0][0]).not.toHaveProperty("customPropertiesExtractor");
    expect(f).not.toHaveProperty("disposeDiagnostics");
    expect(f.receiver.client.listenerCount("app_mention")).toBe(0); expect(f.receiver.client.listenerCount("message")).toBe(0);
    expect(f.receiver.client.listenerCount("slack_event")).toBe(1);
    emitParsed(f, envelope());
    await vi.waitFor(() => expect(delivery).toHaveBeenCalledTimes(1));
    expect(records()).toEqual([]);
  });

  it("ignores malformed public SDK events without disrupting later normal delivery", async () => {
    const f = fixture(); const delivery = vi.fn(); f.app.event("app_mention", async () => { delivery(); });
    for (const args of [undefined, {}, { body: undefined }, { body: envelope(null) }]) {
      expect(() => f.receiver.client.emit("app_mention", args)).not.toThrow();
    }
    expect(records()).toEqual([]);
    const ack = emitParsed(f, envelope());
    await vi.waitFor(() => expect(delivery).toHaveBeenCalledTimes(1));
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it("propagates App construction failure without installing observers or starting a connection", () => {
    vi.mocked(App).mockImplementationOnce(() => { throw new Error("synthetic constructor failure"); });
    expect(() => fixture()).toThrow("synthetic constructor failure");
    const receiver = vi.mocked(SocketModeReceiver).mock.results[0].value as SocketModeReceiver;
    expect(receiver.client.listenerCount("app_mention")).toBe(0);
    expect(receiver.client.listenerCount("message")).toBe(0);
    expect(receiver.client.listenerCount("slack_event")).toBe(1);
  });

  it("retains default ignoreSelf after authentication", async () => {
    const f = fixture(); const delivery = vi.fn(); f.app.event("app_mention", async () => { delivery(); });
    const ack = emitParsed(f, envelope({ ...human(), user: "BOT" }));
    await vi.waitFor(() => expect(ack).toHaveBeenCalledTimes(1));
    expect(delivery).not.toHaveBeenCalled();
  });

  it("preserves the custom OAuth callback GET route and installer port without an extra connection", async () => {
    const probe = createServer();
    await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
    const callback = vi.fn((_req, res) => { res.writeHead(200); res.end("synthetic callback"); });
    const f = createSocketModeApp({ token: "xoxb-synthetic", appToken: "xapp-synthetic",
      customRoutes: [{ path: "/user/oauth/callback", method: "GET", handler: callback }], installerOptions: { port } });
    const start = vi.spyOn(f.receiver.client, "start").mockResolvedValue({ ok: true });
    const disconnect = vi.spyOn(f.receiver.client, "disconnect").mockResolvedValue(undefined);
    try {
      await f.app.start();
      expect(await (await fetch(`http://127.0.0.1:${port}/user/oauth/callback?code=synthetic`)).text()).toBe("synthetic callback");
      expect(callback).toHaveBeenCalledTimes(1); expect(start).toHaveBeenCalledTimes(1);
      expect(SocketModeReceiver).toHaveBeenCalledTimes(1);
    } finally { await f.app.stop(); }
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
