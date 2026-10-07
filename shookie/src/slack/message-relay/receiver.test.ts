import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebClient } from "@slack/web-api";
import type { SocketModeReceiver } from "@slack/bolt";
import { DEFAULT_ENQUEUE_DEADLINES, enqueueSlackMessageRelay } from "database";

vi.mock("../../config.js", () => ({ config: { MAX_TOOL_ITERATIONS: 5, THREAD_WORKSPACE_BASE_PATH: "/synthetic", THREAD_WORKSPACE_MAX_GB: 1 } }));
vi.mock("../../logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import { logger } from "../../logger.js";
import { createSocketModeApp } from "../socket-mode-app.js";
import { createRelayCapture, RelayCaptureError } from "./capture.js";
import { extractRelayMessage } from "./event.js";
import { extractMentionMessageEvent } from "../mention-groups/event.js";
import { registerMentionGroupReplacement } from "../mention-groups/index.js";
import type { MentionGroupReplacementService } from "../mention-groups/service.js";

const identity = { appId: "A0ATZCLF99A", teamId: "T2SRCGYPQ" };
const order: string[] = [];

beforeEach(() => {
  order.length = 0;
  vi.clearAllMocks();
  vi.spyOn(WebClient.prototype, "apiCall").mockImplementation(async (method) => {
    if (method === "auth.test") return { ok: true, bot_id: "B0SELF001", user_id: "U0BOTSELF", team_id: "T2SRCGYPQ" };
    return { ok: true, ts: "reply" };
  });
});
afterEach(() => { vi.restoreAllMocks(); });

const message = (event: Record<string, unknown> = {}, eventId = "Ev0ATZSYNTH01") => ({
  type: "event_callback", team_id: identity.teamId, api_app_id: identity.appId, event_id: eventId,
  event: { type: "message", channel_type: "channel", channel: "C0SYNTH01", user: "U0HUMAN01", ts: "1700000000.000200", text: "PRIVATE-TEXT-SECRET", ...event },
});

function fixture(persist: (m: unknown) => Promise<unknown>, enabled = true) {
  const capture = createRelayCapture(identity, async (metadata) => { order.push("persist:start"); const r = await persist(metadata); order.push("persist:end"); return r; });
  const f = createSocketModeApp({ token: "xoxb-synthetic", appToken: "xapp-synthetic", ...(enabled ? { messageRelay: capture } : {}) });
  return { ...f, capture };
}
/** Real SDK public path: SocketModeClient 'slack_event' -> Receiver -> (facade) -> App.processEvent. */
function deliver(f: { receiver: SocketModeReceiver }, body: unknown) {
  const ack = vi.fn(async () => { order.push("ack"); });
  f.receiver.client.emit("slack_event", { type: "events_api", body, ack });
  return ack;
}

describe("relay capture at the real SocketModeReceiver -> Bolt App boundary", () => {
  it("persists BEFORE Bolt acknowledges and before any listener/ignoreSelf logic", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const f = fixture(() => gate);
    f.app.event("message", async () => { order.push("listener"); });
    const ack = deliver(f, message());
    await new Promise((r) => setTimeout(r, 40));
    expect(order).toEqual(["persist:start"]);
    expect(ack).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(order).toEqual(["persist:start", "persist:end", "ack", "listener"]));
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it("captures the app's own bot messages even though Bolt's default ignoreSelf skips every listener", async () => {
    const persist = vi.fn(async () => undefined);
    const f = fixture(persist);
    const listener = vi.fn();
    f.app.event("message", async () => { listener(); });
    const ack = deliver(f, message({ user: "U0BOTSELF" }, "Ev0ATZOWNBOT"));
    await vi.waitFor(() => expect(ack).toHaveBeenCalledTimes(1));
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ eventId: "Ev0ATZOWNBOT", userId: "U0BOTSELF" }));
    expect(listener).not.toHaveBeenCalled(); // existing ignoreSelf semantics untouched
    // And a human message still reaches listeners on the same app.
    deliver(f, message({}, "Ev0ATZHUMAN2"));
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
  });

  it("fails closed with Bolt's DEFAULT-equivalent error path: no ACK, no listeners, metadata-only error log", async () => {
    const persist = vi.fn(async () => { throw new Error("db down PRIVATE-TEXT-SECRET xoxb-leaky"); });
    const f = fixture(persist);
    const listener = vi.fn();
    f.app.event("message", async () => { listener(); });
    const ack = deliver(f, message());
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 60));
    expect(ack).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(expect.stringContaining("ACK하지 않음"),
      expect.objectContaining({ eventId: "Ev0ATZSYNTH01", channelId: "C0SYNTH01", ts: "1700000000.000200" }));
    const logged = JSON.stringify([...vi.mocked(logger.error).mock.calls, ...vi.mocked(logger.warn).mock.calls, ...vi.mocked(logger.info).mock.calls]);
    expect(logged).not.toContain("PRIVATE-TEXT-SECRET");
    expect(logged).not.toContain("xoxb-leaky");
  });

  it("Slack's redelivery after a failed commit is persisted, acknowledged and handled exactly once more", async () => {
    let calls = 0;
    const persist = vi.fn(async () => { if (++calls === 1) throw new Error("transient"); });
    const f = fixture(persist);
    const listener = vi.fn();
    f.app.event("message", async () => { listener(); });
    const first = deliver(f, message());
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 30));
    const retry = deliver(f, message());
    await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    expect(first).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    // A further duplicate is de-duplicated locally (no extra commit) but still acknowledged and handled.
    const dup = deliver(f, message());
    await vi.waitFor(() => expect(dup).toHaveBeenCalledTimes(1));
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it("the explicit error handler never acknowledges capture failures but keeps Bolt defaults for other errors", async () => {
    const f = fixture(async () => undefined);
    const receiverHandler = (f.receiver as unknown as { processEventErrorHandler: (a: unknown) => Promise<boolean> }).processEventErrorHandler;
    const args = (error: unknown) => ({ error, logger: { error: vi.fn(), debug: vi.fn() }, event: { body: { type: "events_api" }, ack: vi.fn() } });
    expect(await receiverHandler(args(new RelayCaptureError("x")))).toBe(false);
    expect(await receiverHandler(args(Object.assign(new Error("auth"), { code: "slack_bolt_authorization_error" })))).toBe(true);
    expect(await receiverHandler(args(new Error("listener")))).toBe(false);
  });

  it.each([
    ["DM", { channel_type: "im", channel: "D0SYNTH01" }],
    ["private channel", { channel_type: "group" }],
    ["edit", { subtype: "message_changed" }],
    ["delete", { subtype: "message_deleted" }],
    ["app_mention wrapper", { type: "app_mention" }],
    ["reaction", { type: "reaction_added" }],
  ])("passes %s through untouched: no persistence and normal ACK + listener", async (_name, event) => {
    const persist = vi.fn(async () => undefined);
    const f = fixture(persist);
    const type = (event as { type?: string }).type ?? "message";
    const listener = vi.fn();
    f.app.event(type as "message", async ({ event: received }) => { listener(received); });
    const body = message(event);
    const before = JSON.stringify(body);
    const ack = deliver(f, body);
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    expect(ack).toHaveBeenCalledTimes(1);
    expect(persist).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).toBe(before);
    expect(listener.mock.calls[0]![0]).toBe(body.event);
  });

  it("passes a captured event to listeners unmodified (same object, no extra keys)", async () => {
    const f = fixture(async () => undefined);
    const seen = vi.fn();
    const body = message({ thread_ts: "1700000000.000200", files: [{ id: "F1" }] });
    const before = JSON.stringify(body);
    f.app.event("message", async ({ event, body: received }) => { seen(event === body.event, received === body); });
    deliver(f, body);
    await vi.waitFor(() => expect(seen).toHaveBeenCalledWith(true, true));
    expect(JSON.stringify(body)).toBe(before);
  });

  it("keeps ONE receiver/connection and Bolt defaults; existing mention-group message registration still works relay on and off", async () => {
    for (const enabled of [false, true]) {
      vi.clearAllMocks();
      const f = fixture(async () => undefined, enabled);
      expect(f.receiver.client.listenerCount("slack_event")).toBe(1);
      expect(f.receiver.client.listenerCount("message")).toBe(0);
      const service = { handleEvent: vi.fn(async () => undefined) } as unknown as MentionGroupReplacementService;
      registerMentionGroupReplacement(f.app, service);
      const other = vi.fn();
      f.app.event("message", async () => { other(); });
      const body = message({ text: "hello <!subteam^S0SYNTH01>" }, `Ev0ATZMENTION${enabled ? 1 : 0}`);
      expect(extractMentionMessageEvent(body, body.event)).not.toBeNull();
      const ack = deliver(f, body);
      await vi.waitFor(() => expect(ack).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(service.handleEvent).toHaveBeenCalledTimes(1));
      expect(other).toHaveBeenCalledTimes(1);
      expect(f.receiver.client.listenerCount("slack_event")).toBe(1);
    }
    expect(vi.mocked(WebClient.prototype.apiCall)).toHaveBeenCalled();
  });

  it("relay disabled leaves receiver construction byte-for-byte on defaults", () => {
    const f = fixture(async () => undefined, false);
    expect(Object.getOwnPropertyDescriptor(f.receiver, "init")).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(f.receiver, "processEventErrorHandler")?.value.name).toBe("defaultProcessEventErrorHandler");
  });

  it("shutdown: closed capture rejects new capturable events without ACK and waits for in-flight commits", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const f = fixture(() => gate);
    const ack = deliver(f, message());
    await vi.waitFor(() => expect(order).toEqual(["persist:start"]));
    let closed = false;
    const closing = f.capture.close().then(() => { closed = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(false);
    release();
    await closing;
    await vi.waitFor(() => expect(ack).toHaveBeenCalledTimes(1));
    const late = deliver(f, message({}, "Ev0ATZLATE001"));
    await new Promise((r) => setTimeout(r, 40));
    expect(late).not.toHaveBeenCalled();
  });
});

describe("ack-path latency and database failure bounds (real enqueue, fake pool)", () => {
  const event = { teamId: identity.teamId, appId: identity.appId, eventId: "Ev0ATZSYNTH01", channelId: "C0SYNTH01", ts: "1700000000.000200", threadTs: null, userId: "U0HUMAN01", subtype: null };

  it("a hung connection acquisition fails within the acquire deadline, so Slack is never acknowledged", async () => {
    const release = vi.fn();
    const pool = { connect: () => new Promise((resolve) => setTimeout(() => resolve({ release, query: vi.fn() }), 400)) };
    const f = fixture((m) => enqueueSlackMessageRelay(m as typeof event, { acquireMs: 50, lockMs: 50, statementMs: 50, totalMs: 120 }, pool as never));
    const started = Date.now();
    const ack = deliver(f, message());
    await vi.waitFor(() => expect(vi.mocked(logger.error)).toHaveBeenCalled());
    expect(Date.now() - started).toBeLessThan(300);
    await new Promise((r) => setTimeout(r, 450));
    expect(ack).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1); // late connection is returned, never leaked
  });

  it("a stalled statement fails at the total deadline and destroys the connection", async () => {
    const release = vi.fn();
    const query = vi.fn(() => new Promise(() => undefined));
    const pool = { connect: async () => ({ release, query }) };
    const started = Date.now();
    await expect(enqueueSlackMessageRelay(event, { acquireMs: 50, lockMs: 50, statementMs: 50, totalMs: 100 }, pool as never)).rejects.toThrow(/deadline/);
    expect(Date.now() - started).toBeLessThan(400);
    expect(release).toHaveBeenCalledWith(true);
  });

  it("a healthy commit adds only local overhead and returns the connection to the pool", async () => {
    const release = vi.fn();
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rowCount: 1 }));
    const pool = { connect: async () => ({ release, query }) };
    const started = Date.now();
    await expect(enqueueSlackMessageRelay(event, DEFAULT_ENQUEUE_DEADLINES, pool as never)).resolves.toBe("inserted");
    expect(Date.now() - started).toBeLessThan(100);
    expect(query.mock.calls.map((c) => String(c[0]).split(/\s+/)[0])).toEqual(["BEGIN;", "INSERT", "COMMIT"]);
    expect(JSON.stringify(query.mock.calls)).not.toMatch(/PRIVATE|text|token/i);
    expect(release).toHaveBeenCalledWith(undefined);
  });
});

describe("extraction is independent of the mention-group extractor", () => {
  it("captures what extractMentionMessageEvent rejects (bot/subtype/no text)", () => {
    const body = message({ subtype: "file_share", text: undefined, bot_id: "B0SYNTH01" });
    expect(extractMentionMessageEvent(body, body.event)).toBeNull();
    expect(extractRelayMessage(body, identity).kind).toBe("capture");
  });
});
