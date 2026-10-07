import { describe, expect, it, vi } from "vitest";
import { verifyRelayIdentity } from "./identity.js";

const identity = { appId: "A0ATZCLF99A", teamId: "T2SRCGYPQ" };
const client = (test: () => Promise<{ ok?: boolean; team_id?: string }>) => ({ auth: { test: vi.fn(test) } });

describe("startup relay identity verification (one auth.test, never per message)", () => {
  it("accepts a bot token from the configured workspace with a single call", async () => {
    const c = client(async () => ({ ok: true, team_id: "T2SRCGYPQ" }));
    await expect(verifyRelayIdentity(c, identity)).resolves.toBeUndefined();
    expect(c.auth.test).toHaveBeenCalledTimes(1);
  });
  it("refuses to start when the workspace differs, without echoing ids beyond the config names", async () => {
    await expect(verifyRelayIdentity(client(async () => ({ ok: true, team_id: "T0OTHER01" })), identity)).rejects.toThrow("RADAR_SLACK_RELAY_TEAM_ID");
  });
  it.each([
    ["no team", async () => ({ ok: true })],
    ["not ok", async () => ({ ok: false, team_id: "T2SRCGYPQ" })],
    ["rejects", async () => { throw new Error("network"); }],
  ])("fails closed when auth.test gives no usable answer (%s)", async (_n, test) => {
    await expect(verifyRelayIdentity(client(test), identity)).rejects.toThrow();
  });
  it("is bounded by a timeout", async () => {
    const started = Date.now();
    await expect(verifyRelayIdentity(client(() => new Promise(() => undefined)), identity, 50)).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
