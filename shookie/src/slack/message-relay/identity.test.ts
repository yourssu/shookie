import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { verifyRelayIdentity } from "./identity.js";

const identity = { appId: "A0ATZCLF99A", teamId: "T2SRCGYPQ" };
type Auth = { ok?: boolean; team_id?: string; bot_id?: string };
const client = (test: () => Promise<Auth>, info?: () => Promise<{ ok?: boolean; bot?: { app_id?: string } }>) =>
  ({ auth: { test: vi.fn(test) }, ...(info ? { bots: { info: vi.fn(info) } } : {}) });
const goodAuth = async () => ({ ok: true, team_id: "T2SRCGYPQ", bot_id: "B0SELF001" });
const goodInfo = async () => ({ ok: true, bot: { app_id: "A0ATZCLF99A" } });

describe("startup relay identity verification (one auth.test + one bots.info, never per message)", () => {
  it("accepts only when BOTH team (auth.test) and app (bots.info) match, one call each", async () => {
    const c = client(goodAuth, goodInfo);
    await expect(verifyRelayIdentity(c, identity)).resolves.toEqual({ teamVerified: true, appVerified: true });
    expect(c.auth.test).toHaveBeenCalledTimes(1);
    expect(c.bots!.info).toHaveBeenCalledTimes(1);
    expect(c.bots!.info).toHaveBeenCalledWith({ bot: "B0SELF001" });
  });

  it("fails startup when the workspace differs (bots.info is not even consulted)", async () => {
    const c = client(async () => ({ ok: true, team_id: "T0OTHER01", bot_id: "B0SELF001" }), goodInfo);
    await expect(verifyRelayIdentity(c, identity)).rejects.toThrow("RADAR_SLACK_RELAY_TEAM_ID");
    expect(c.bots!.info).not.toHaveBeenCalled();
  });

  it("fails startup when bots.info reports another app, without echoing any id", async () => {
    const c = client(goodAuth, async () => ({ ok: true, bot: { app_id: "A0OTHERAPP1" } }));
    const error = await verifyRelayIdentity(c, identity).catch((e: Error) => e);
    expect((error as Error).message).toContain("RADAR_SLACK_RELAY_APP_ID");
    expect((error as Error).message).not.toMatch(/A0OTHERAPP1|A0ATZCLF99A|B0SELF001/);
  });

  it.each([
    ["missing_scope", async () => { throw Object.assign(new Error("An API error occurred: missing_scope for A0ATZCLF99A"), { data: { error: "missing_scope" } }); }],
    ["transient error", async () => { throw new Error("socket hang up B0SELF001"); }],
    ["not ok", async () => ({ ok: false })],
    ["no app id", async () => ({ ok: true, bot: {} })],
  ])("FAILS startup (no unverified-continue) when bots.info is unavailable: %s, without echoing ids", async (_n, info) => {
    const error = await verifyRelayIdentity(client(goodAuth, info), identity).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("RADAR_SLACK_RELAY_APP_ID");
    expect((error as Error).message).not.toMatch(/A0ATZCLF99A|B0SELF001|missing_scope/);
  });

  it("FAILS startup when bots.info hangs past the timeout", async () => {
    const started = Date.now();
    await expect(verifyRelayIdentity(client(goodAuth, () => new Promise(() => undefined)), identity, 50)).rejects.toThrow(/bots\.info/);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it.each([
    ["no bot_id", async () => ({ ok: true, team_id: "T2SRCGYPQ" }), goodInfo],
    ["client without bots API", goodAuth, undefined],
  ])("FAILS startup when the app cannot be looked up: %s", async (_n, test, info) => {
    await expect(verifyRelayIdentity(client(test, info), identity)).rejects.toThrow("RADAR_SLACK_RELAY_APP_ID");
  });

  it.each([
    ["no team", async () => ({ ok: true })],
    ["not ok", async () => ({ ok: false, team_id: "T2SRCGYPQ" })],
    ["rejects", async () => { throw new Error("network"); }],
  ])("fails closed when auth.test gives no usable answer (%s)", async (_n, test) => {
    await expect(verifyRelayIdentity(client(test, goodInfo), identity)).rejects.toThrow();
  });

  it("auth.test is bounded by a timeout", async () => {
    const started = Date.now();
    await expect(verifyRelayIdentity(client(() => new Promise(() => undefined), goodInfo), identity, 50)).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("startup order: identity is verified (and not swallowed) before the Socket starts and before the drainer starts", () => {
    const source = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
    const verify = source.indexOf("await verifyRelayIdentity(");
    const socket = source.indexOf("await app.start()");
    const drain = source.indexOf("messageRelay.drainer.start()");
    expect(verify).toBeGreaterThan(0);
    expect(verify).toBeLessThan(socket);
    expect(socket).toBeLessThan(drain);
    expect(source).not.toMatch(/runtime-enforced|appVerified/);
    expect(source.slice(verify - 120, verify)).not.toMatch(/\btry\b|catch/);
  });
});
