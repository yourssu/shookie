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
import { logSlackSocketTokenBoundary } from "../tools/slack/action-token-diagnostics.js";

const TOKEN = "SYNTHETIC_ACTION_SECRET";
const ALTERNATE = "ALTERNATE_ACTION_SECRET";
const cleanups: (() => void)[] = [];
function records() {
  return vi.mocked(logger.info).mock.calls.filter(c => c[0] === "slack_action_token_diagnostic").map(c => c[1] as Record<string, unknown>);
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(WebClient.prototype, "apiCall").mockImplementation(async (method) => {
    if (method === "auth.test") return { ok: true, bot_id: "B1", user_id: "BOT", team_id: "T1" };
    return { ok: true, ts: "reply" };
  });
});
afterEach(() => { for (const dispose of cleanups.splice(0)) dispose(); vi.restoreAllMocks(); });
function fixture() {
  const f = createSocketModeApp({ token: "xoxb-synthetic", appToken: "xapp-synthetic" });
  cleanups.push(f.disposeDiagnostics);
  return f;
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
    let result: unknown;
    const stream = vi.fn(async (_messages, options) => {
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
    expect(logs.map(r => r.stage)).toEqual(["socket_sdk", "socket_receiver", "receive", "selection", "binding", "search", ...(usable ? ["search_api"] : [])]);
    expect(logs[0]).toMatchObject({ eventCorrelationId: "slack-event:EvSYNTHETIC0001", correlationTrust: "untrusted_event_id",
      sdkBodyAlias: true, sdkEventAlias: true, receiverBodyAlias: false });
    expect(logs[0]).not.toHaveProperty("requestId");
    expect(logs[1]).toMatchObject({ sdkBodyAlias: true, sdkEventAlias: true, receiverBodyAlias: true });
    expect(logs[2]).toMatchObject({ requestId: logs[0].eventCorrelationId, requestIdTrust: "authenticated_handler",
      sdkBodyAlias: true, sdkEventAlias: true, receiverBodyAlias: true });
    for (const r of logs.slice(0, 3)) expect(r).toMatchObject({ eventTokenUsable: usable, bodyEventTokenUsable: usable, bodyTokenUsable: alternate });
    expect(logs.find(r => r.stage === "binding")).toMatchObject({ identityBound: true, tokenBound: usable });
    expect(apiCall).toHaveBeenCalledTimes(usable ? 1 : 0);
    if (usable) expect(apiCall).toHaveBeenCalledWith("assistant.search.context", expect.objectContaining({ action_token: TOKEN }));
    for (const value of [logs, stream.mock.calls.map(c => c[0]), complete.mock.calls, result]) {
      expect(JSON.stringify(value)).not.toContain(TOKEN); expect(JSON.stringify(value)).not.toContain(ALTERNATE);
    }
    expect(WebClient.prototype.apiCall).toHaveBeenCalledWith("auth.test", { token: "xoxb-synthetic" });
  });

  it("contains observer logger exceptions without affecting actual receiver ack/delivery", async () => {
    const f = fixture();
    const delivery = vi.fn();
    f.app.event("app_mention", async () => { delivery(); });
    vi.mocked(logger.info).mockImplementationOnce(() => { throw new Error(TOKEN); }).mockImplementationOnce(() => { throw new Error(TOKEN); });
    const ack = emitParsed(f, envelope());
    await vi.waitFor(() => expect(delivery).toHaveBeenCalledTimes(1));
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it("uses one receiver/client, preserves constructor auth defaults and removes only diagnostic listeners", async () => {
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
    f.disposeDiagnostics(); f.disposeDiagnostics();
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

  it("removes observer listeners if App construction fails before startup", () => {
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
    cleanups.push(f.disposeDiagnostics);
    const start = vi.spyOn(f.receiver.client, "start").mockResolvedValue({ ok: true });
    const disconnect = vi.spyOn(f.receiver.client, "disconnect").mockResolvedValue(undefined);
    try {
      await f.app.start();
      expect(await (await fetch(`http://127.0.0.1:${port}/user/oauth/callback?code=synthetic`)).text()).toBe("synthetic callback");
      expect(callback).toHaveBeenCalledTimes(1); expect(start).toHaveBeenCalledTimes(1);
      expect(SocketModeReceiver).toHaveBeenCalledTimes(1);
    } finally { f.disposeDiagnostics(); await f.app.stop(); }
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("fixed-slot fail-safe Socket Mode projection", () => {
  it("never executes getters, proxy traps, toJSON or malformed/irrelevant event logging", () => {
    const trap = vi.fn(() => { throw new Error(TOKEN); });
    const proxy = new Proxy({}, { get: trap, getOwnPropertyDescriptor: trap, ownKeys: trap });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    for (const args of [undefined, null, 1, {}, proxy, revoked.proxy,
      { type: "hello" }, { type: "disconnect" }, { body: { type: "block_actions" } },
      { body: envelope({ ...human(), type: "reaction_added" }) },
      { body: envelope({ ...human(), type: "message", channel_type: "channel" }) },
      { body: envelope({ ...human(), bot_id: "B1" }) }, { body: envelope({ ...human(), subtype: "bot_message" }) },
      { body: envelope(proxy) }, { body: envelope(Object.defineProperty(human(), "user", { get: trap })) },
      Object.defineProperty({}, "body", { get: trap }), { body: Object.defineProperty(envelope(), "event", { get: trap }) }]) {
      logSlackSocketTokenBoundary("socket_sdk", args); logSlackSocketTokenBoundary("socket_receiver", args);
    }
    expect(records()).toEqual([]);
    const event = Object.defineProperties(human(), { action_token: { get: trap }, text: { get: trap }, files: { get: trap }, toJSON: { get: trap } });
    const body = Object.defineProperty(envelope(event), "action_token", { value: { toJSON: trap } });
    const args = Object.defineProperty({ body, event }, "ack", { get: trap });
    logSlackSocketTokenBoundary("socket_sdk", args); logSlackSocketTokenBoundary("socket_receiver", args);
    expect(records()[0]).toMatchObject({ eventTokenObservation: "accessor", eventTokenPresent: true, eventTokenUsable: false, bodyTokenPresent: true, bodyTokenUsable: false });
    expect(trap).not.toHaveBeenCalled(); expect(JSON.stringify(records())).not.toContain(TOKEN);
  });

  it("reports separate SDK event vs body.event candidates and does not claim alias equality", () => {
    const body = envelope({ ...human(), action_token: TOKEN });
    logSlackSocketTokenBoundary("socket_sdk", { body, event: human() });
    logSlackSocketTokenBoundary("socket_receiver", { body });
    expect(records()[0]).toMatchObject({ sdkBodyAlias: true, sdkEventAlias: false, eventTokenUsable: false, bodyEventTokenUsable: true });
    expect(records()[1]).toMatchObject({ sdkBodyAlias: true, sdkEventAlias: false, eventTokenUsable: true, bodyEventTokenUsable: true });
    const allowed = new Set(["stage", "eventKind", "correlationTrust", "correlationAvailable", "eventCorrelationId",
      "sdkBodyAlias", "sdkEventAlias", "receiverBodyAlias", "eventTokenObservation", "eventTokenPresent", "eventTokenUsable",
      "bodyEventTokenObservation", "bodyEventTokenPresent", "bodyEventTokenUsable", "bodyTokenObservation", "bodyTokenPresent", "bodyTokenUsable",
      "contextTokenObservation", "contextTokenPresent", "contextTokenUsable"]);
    for (const r of records()) for (const [key, value] of Object.entries(r)) {
      expect(allowed.has(key)).toBe(true); expect(["boolean", "string"]).toContain(typeof value);
    }
    expect(JSON.stringify(records())).not.toContain(TOKEN);
  });

  it.each([undefined, TOKEN, "Ev" + "A".repeat(63), "EvSECRET\n12345", {}, 42])("omits nonconforming untrusted correlation IDs", event_id => {
    const body = { ...envelope(), event_id };
    logSlackSocketTokenBoundary("socket_sdk", { body, event: body.event });
    expect(records()[0]).toMatchObject({ correlationAvailable: false, correlationTrust: "untrusted_event_id" });
    expect(records()[0]).not.toHaveProperty("eventCorrelationId");
    expect(records()[0]).not.toHaveProperty("requestId");
    expect(JSON.stringify(records())).not.toContain(TOKEN);
  });
});
