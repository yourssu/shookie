import { describe, expect, it } from "vitest";
import { extractRelayMessage } from "./event.js";

const identity = { appId: "A0ATZCLF99A", teamId: "T2SRCGYPQ" };
const envelope = (event: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
  type: "event_callback",
  team_id: "T2SRCGYPQ",
  api_app_id: "A0ATZCLF99A",
  event_id: "Ev0ATZSYNTH01",
  event: { type: "message", channel_type: "channel", channel: "C0SYNTH01", user: "U0SYNTH01", ts: "1700000000.000200", text: "SECRET-BODY", ...event },
  ...overrides,
});
const captured = (body: unknown) => {
  const result = extractRelayMessage(body, identity);
  if (result.kind !== "capture") throw new Error(`expected capture, got ${JSON.stringify(result)}`);
  return result.metadata;
};

describe("relay message extraction", () => {
  it("emits exactly the version-1 metadata and never reads text/files", () => {
    const metadata = captured(envelope({ files: [{ id: "F1" }], blocks: [{ type: "section" }], bot_id: "B0SYNTH01" }));
    expect(metadata).toEqual({
      teamId: "T2SRCGYPQ", appId: "A0ATZCLF99A", eventId: "Ev0ATZSYNTH01", channelId: "C0SYNTH01",
      ts: "1700000000.000200", threadTs: null, userId: "U0SYNTH01", subtype: null,
    });
    expect(JSON.stringify(metadata)).not.toContain("SECRET-BODY");
    expect(Object.keys(metadata).sort()).toEqual(["appId", "channelId", "eventId", "subtype", "teamId", "threadTs", "ts", "userId"]);
  });

  it("captures own-bot messages (no text or mention required) and empty-text messages", () => {
    expect(captured(envelope({ user: "UBOTSELF1", text: undefined })).userId).toBe("UBOTSELF1");
    expect(captured(envelope({ text: "" })).subtype).toBeNull();
  });

  it.each(["bot_message", "thread_broadcast", "file_share", "me_message"])("captures subtype %s", (subtype) => {
    const event: Record<string, unknown> = { subtype };
    if (subtype === "thread_broadcast") event.thread_ts = "1699999999.999999";
    if (subtype === "bot_message") { delete event.user; event.bot_id = "B0SYNTH01"; }
    expect(captured(envelope(event)).subtype).toBe(subtype);
  });

  it("allows a null user only for bot_message with a valid bot id, and never forwards the bot id", () => {
    const metadata = captured(envelope({ subtype: "bot_message", user: undefined, bot_id: "B0SYNTH01" }));
    expect(metadata.userId).toBeNull();
    expect(JSON.stringify(metadata)).not.toContain("B0SYNTH01");
    for (const event of [
      { subtype: "bot_message", user: undefined, bot_id: undefined },
      { subtype: "bot_message", user: undefined, bot_id: "not-a-bot" },
      { user: undefined, bot_id: "B0SYNTH01" },
      { subtype: "file_share", user: undefined, bot_id: "B0SYNTH01" },
    ]) expect(extractRelayMessage(envelope(event), identity).kind).toBe("invalid");
  });

  it.each([
    ["missing thread_ts", {}],
    ["null thread_ts", { thread_ts: null }],
    ["thread_ts == ts (normalizes to null)", { thread_ts: "1700000000.000200" }],
  ])("rejects thread_broadcast with %s as invalid, matching the backend contract (never outboxed)", (_name, extra) => {
    expect(extractRelayMessage(envelope({ subtype: "thread_broadcast", ...extra }), identity))
      .toEqual({ kind: "invalid", reason: "thread_broadcast_thread_ts", eventId: "Ev0ATZSYNTH01" });
  });

  it("normalizes thread parents to null and keeps replies/broadcast thread timestamps", () => {
    expect(captured(envelope({ thread_ts: "1700000000.000200" })).threadTs).toBeNull();
    expect(captured(envelope({ thread_ts: "1700000000.000100" })).threadTs).toBe("1700000000.000100");
    expect(captured(envelope({ subtype: "thread_broadcast", thread_ts: "1699999999.999999" })).threadTs).toBe("1699999999.999999");
    expect(extractRelayMessage(envelope({ thread_ts: "1700000000.000300" }), identity).kind).toBe("invalid");
    expect(extractRelayMessage(envelope({ thread_ts: "garbage" }), identity).kind).toBe("invalid");
  });

  it.each([
    ["DM", { channel_type: "im", channel: "D0SYNTH01" }],
    ["group DM", { channel_type: "mpim", channel: "G0SYNTH01" }],
    ["private channel", { channel_type: "group", channel: "C0SYNTH01" }],
    ["missing channel_type", { channel_type: undefined }],
    ["edit wrapper", { subtype: "message_changed" }],
    ["delete wrapper", { subtype: "message_deleted" }],
    ["message_replied", { subtype: "message_replied" }],
    ["channel_join", { subtype: "channel_join" }],
    ["unknown subtype", { subtype: "something_new" }],
    ["non-string subtype", { subtype: 7 }],
    ["non-message event", { type: "reaction_added" }],
    ["app_mention", { type: "app_mention" }],
  ])("ignores %s", (_name, event) => {
    expect(extractRelayMessage(envelope(event), identity)).toEqual({ kind: "ignore" });
  });

  it("ignores non-event_callback and non-object envelopes", () => {
    for (const body of [null, undefined, "x", 1, [], {}, { type: "block_actions" }, { type: "url_verification" }, envelope({}, { type: "interactive" })]) {
      expect(extractRelayMessage(body, identity)).toEqual({ kind: "ignore" });
    }
  });

  it("requires the configured team/app identity and never captures a different one", () => {
    expect(extractRelayMessage(envelope({}, { team_id: "T0OTHER01" }), identity)).toEqual({ kind: "mismatch", reason: "team" });
    expect(extractRelayMessage(envelope({}, { api_app_id: "A0OTHER01" }), identity)).toEqual({ kind: "mismatch", reason: "app" });
    expect(extractRelayMessage(envelope({}, { team_id: undefined }), identity).kind).toBe("invalid");
    expect(extractRelayMessage(envelope({}, { api_app_id: undefined }), identity).kind).toBe("invalid");
  });

  it.each([
    ["event id", {}, { event_id: "x" }],
    ["missing event id", {}, { event_id: undefined }],
    ["channel", { channel: "c0synth01" }, {}],
    ["ts seconds", { ts: "170000000.000200" }, {}],
    ["ts micros", { ts: "1700000000.0002" }, {}],
    ["ts type", { ts: 1700000000.0002 }, {}],
    ["user", { user: "lowercase" }, {}],
  ])("rejects malformed %s as invalid (metadata-only)", (_name, event, overrides) => {
    expect(extractRelayMessage(envelope(event, overrides), identity).kind).toBe("invalid");
  });

  it("does not mutate the original envelope", () => {
    const body = envelope({ thread_ts: "1700000000.000200", files: [{ id: "F1" }] });
    const before = JSON.stringify(body);
    captured(body);
    expect(JSON.stringify(body)).toBe(before);
  });
});
