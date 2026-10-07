import { describe, expect, it, vi } from "vitest";
import { verifyRelayIdentity } from "./identity.js";

const identity = { appId: "A0ATZCLF99A", teamId: "T2SRCGYPQ" };
type Auth = { ok?: boolean; team_id?: string; bot_id?: string };
const client = (test: () => Promise<Auth>, info?: () => Promise<{ ok?: boolean; bot?: { app_id?: string } }>) =>
  ({ auth: { test: vi.fn(test) }, ...(info ? { bots: { info: vi.fn(info) } } : {}) });

describe("startup relay identity verification (one auth.test, never per message)", () => {
  it("accepts a bot token from the configured workspace with a single call", async () => {
    const c = client(async () => ({ ok: true, team_id: "T2SRCGYPQ" }));
    await expect(verifyRelayIdentity(c, identity)).resolves.toEqual({ teamVerified: true, appVerified: false });
    expect(c.auth.test).toHaveBeenCalledTimes(1);
  });
  it("verifies the app id through bots.info when available (one call each)", async () => {
    const c = client(async () => ({ ok: true, team_id: "T2SRCGYPQ", bot_id: "B0SELF001" }), async () => ({ ok: true, bot: { app_id: "A0ATZCLF99A" } }));
    await expect(verifyRelayIdentity(c, identity)).resolves.toEqual({ teamVerified: true, appVerified: true });
    expect(c.bots!.info).toHaveBeenCalledTimes(1);
    expect(c.bots!.info).toHaveBeenCalledWith({ bot: "B0SELF001" });
  });
  it("refuses to start when bots.info reports another app, without echoing any id", async () => {
    const c = client(async () => ({ ok: true, team_id: "T2SRCGYPQ", bot_id: "B0SELF001" }), async () => ({ ok: true, bot: { app_id: "A0OTHERAPP1" } }));
    const error = await verifyRelayIdentity(c, identity).catch((e: Error) => e);
    expect((error as Error).message).toContain("RADAR_SLACK_RELAY_APP_ID");
    expect((error as Error).message).not.toMatch(/A0OTHERAPP1|A0ATZCLF99A|B0SELF001/);
  });
  it.each([
    ["missing_scope", async () => { throw Object.assign(new Error("An API error occurred: missing_scope"), { data: { error: "missing_scope" } }); }],
    ["not ok", async () => ({ ok: false })],
    ["no app id", async () => ({ ok: true, bot: {} })],
  ])("leaves the app unverified (runtime fail-closed) when bots.info is unavailable: %s", async (_n, info) => {
    const c = client(async () => ({ ok: true, team_id: "T2SRCGYPQ", bot_id: "B0SELF001" }), info);
    await expect(verifyRelayIdentity(c, identity)).resolves.toEqual({ teamVerified: true, appVerified: false });
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
