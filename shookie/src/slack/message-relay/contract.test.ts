import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import type { SlackMessageRelayRow } from "database";
import { extractRelayMessage } from "./event.js";
import { RelayDrainer, type RelayStore } from "./drain.js";

const fixture = JSON.parse(readFileSync(new URL("./message-events.contract.json", import.meta.url), "utf8")) as {
  valid: { name: string; envelope: Record<string, unknown>; payload: Record<string, unknown> }[];
  notOutboxed: { name: string; envelope: Record<string, unknown> }[];
};
const identity = { appId: "A0ATZCLF99A", teamId: "T2SRCGYPQ" };
const body = (event: Record<string, unknown>) => ({
  type: "event_callback", team_id: identity.teamId, api_app_id: identity.appId, event_id: "Ev0ATZCONTRACT1",
  event: { type: "message", text: "PRIVATE-TEXT", ...event },
});

const KEYS = ["appId", "channelId", "eventId", "subtype", "teamId", "threadTs", "ts", "userId", "version"];
const TS = /^\d{10}\.\d{6}$/u;
/** Backend (Radar) acceptance rules for version 1, as specified for this task. */
function backendViolations(p: Record<string, unknown>): string[] {
  const v: string[] = [];
  if (JSON.stringify(Object.keys(p).sort()) !== JSON.stringify(KEYS)) v.push("keys");
  if (p.version !== 1) v.push("version");
  if (!/^T[A-Z0-9]+$/u.test(String(p.teamId))) v.push("teamId");
  if (!/^A[A-Z0-9]+$/u.test(String(p.appId))) v.push("appId");
  if (!/^Ev[A-Za-z0-9]+$/u.test(String(p.eventId))) v.push("eventId");
  if (!/^C[A-Z0-9]+$/u.test(String(p.channelId))) v.push("channelId");
  if (!TS.test(String(p.ts))) v.push("ts");
  if (p.userId !== null && !/^[UW][A-Z0-9]+$/u.test(String(p.userId))) v.push("userId");
  if (p.threadTs !== null) {
    if (!TS.test(String(p.threadTs))) v.push("threadTs");
    else if (String(p.threadTs) >= String(p.ts)) v.push("threadTs>=ts"); // parent (== ts) must be null; reply must precede
  }
  if (p.subtype === "thread_broadcast" && p.threadTs === null) v.push("broadcast needs threadTs");
  if (p.subtype !== null && !["bot_message", "thread_broadcast", "file_share", "me_message"].includes(String(p.subtype))) v.push("subtype");
  if (p.userId === null && p.subtype !== "bot_message") v.push("null user needs bot_message");
  return v;
}

describe("shared backend contract fixture", () => {
  it.each(fixture.valid)("valid: $name extracts to a payload the backend accepts", ({ envelope, payload }) => {
    const result = extractRelayMessage(body(envelope), identity);
    if (result.kind !== "capture") throw new Error(JSON.stringify(result));
    const wire = { version: 1, ...result.metadata };
    expect(wire).toMatchObject(payload);
    expect(backendViolations(wire)).toEqual([]);
    expect(JSON.stringify(wire)).not.toContain("PRIVATE-TEXT");
  });

  it.each(fixture.notOutboxed)("rejected: $name is invalid and never outboxed", ({ envelope }) => {
    expect(extractRelayMessage(body(envelope), identity).kind).toBe("invalid");
  });

  it("the validator itself rejects what the backend rejects (guards the fixture against drifting)", () => {
    const ok = { version: 1, teamId: "T1X", appId: "A1X", eventId: "Ev1X", channelId: "C1X", ts: "1700000000.000200", threadTs: null, userId: "U1X", subtype: null };
    expect(backendViolations(ok)).toEqual([]);
    expect(backendViolations({ ...ok, subtype: "thread_broadcast" })).toContain("broadcast needs threadTs");
    expect(backendViolations({ ...ok, threadTs: "1700000000.000200" })).toContain("threadTs>=ts");
    expect(backendViolations({ ...ok, extra: 1 })).toContain("keys");
  });

  it("the drainer puts exactly a backend-valid payload on the wire for every valid fixture", async () => {
    const sent: Record<string, unknown>[] = [];
    const rows: SlackMessageRelayRow[] = fixture.valid.map((f, i) => {
      const r = extractRelayMessage(body(f.envelope), identity);
      if (r.kind !== "capture") throw new Error("fixture");
      return { ...r.metadata, id: String(i + 1), attempts: 1, claimToken: "t", createdAt: new Date(0) };
    });
    const store: RelayStore = {
      claim: async () => rows.splice(0), delivered: async () => true, defer: async () => true, finish: async () => true,
      requeueParked: async () => 0, prune: async () => ({ expired: 0, deleted: 0 }),
      stats: async () => ({ pending: 0, delivering: 0, delivered: 0, failed: 0, parked: 0 }),
    };
    const d = new RelayDrainer({ apiUrl: "https://radar.example.test/internal/v1/slack/message-events", apiKey: "k".repeat(20), store,
      maintenanceEveryMs: 1e12, fetcher: async (_u, init) => { sent.push(JSON.parse(init.body as string)); return new Response(null, { status: 202 }); } });
    await d.tick(); await d.stop();
    expect(sent).toHaveLength(fixture.valid.length);
    for (const wire of sent) expect(backendViolations(wire)).toEqual([]);
  });
});
