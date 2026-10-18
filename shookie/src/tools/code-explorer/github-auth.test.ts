import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createGithubTokenProvider } from "./github-auth.js";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const settings = { GITHUB_OWNER: "yourssu", GITHUB: "legacy-pat", SHOOKIE_GITHUB_APP_ID: "123", SHOOKIE_GITHUB_APP_INSTALLATION_ID: "456", SHOOKIE_GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from(pem).toString("base64") };
const permissions = { metadata: "read", contents: "read", issues: "read", pull_requests: "read" };
function fixture() {
  let time = Date.parse("2026-06-01T00:00:00Z"); let minted = 0;
  const fetcher = vi.fn(async (url: any, init: any) => {
    expect(init.redirect).toBe("error"); expect(String(url).startsWith("https://api.github.com/")).toBe(true);
    const jwt = init.headers.Authorization.slice(7); const [header, claims, sig] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({ iss: "123", iat: Math.floor(time / 1000) - 60, exp: Math.floor(time / 1000) + 540 });
    expect(verify("RSA-SHA256", Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(sig, "base64url"))).toBe(true);
    if (String(url).endsWith("/access_tokens")) {
      expect(init.method).toBe("POST"); expect(JSON.parse(init.body)).toEqual({ permissions }); minted++;
      return Response.json({ token: `installation-${minted}`, expires_at: new Date(time + 3600000).toISOString(), permissions });
    }
    if (String(url).endsWith("/app")) return Response.json({ id: 123 });
    return Response.json({ id: 456, app_id: 123, target_type: "Organization", account: { type: "Organization", login: "YOURSSU" }, permissions });
  });
  return { fetcher, now: () => time, advance: (ms: number) => { time += ms; } };
}
describe("dedicated GitHub App credentials", () => {
  it("signs skewed JWT, verifies identity, mints explicit read-only tokens and single-flights refresh", async () => {
    const f = fixture(); const p = createGithubTokenProvider(settings, f.fetcher, f.now)!;
    expect(await Promise.all(Array.from({ length: 10 }, () => p.getToken()))).toEqual(Array(10).fill("installation-1"));
    expect(f.fetcher).toHaveBeenCalledTimes(3);
    f.advance(3539000); expect(await p.getToken()).toBe("installation-1");
    f.advance(1000); expect(await Promise.all([p.getToken(), p.getToken()])).toEqual(["installation-2", "installation-2"]);
    expect(f.fetcher).toHaveBeenCalledTimes(6);
    f.advance(3600001); expect(await p.getToken()).toBe("installation-3");
    for (const secret of [pem, settings.SHOOKIE_GITHUB_APP_PRIVATE_KEY_BASE64, settings.GITHUB, "installation-1", "installation-2", "installation-3", Buffer.from("x-access-token:installation-2").toString("base64")]) expect(p.redact(secret)).toBe("[REDACTED]");
  });
  it("allows only all-blank migration; partial or malformed config never selects PAT", () => {
    expect(createGithubTokenProvider({ GITHUB_OWNER: "yourssu", GITHUB: "old" })).toBeUndefined();
    for (const change of [{ SHOOKIE_GITHUB_APP_ID: "" }, { SHOOKIE_GITHUB_APP_ID: "-1" }, { SHOOKIE_GITHUB_APP_INSTALLATION_ID: "0" }, { SHOOKIE_GITHUB_APP_PRIVATE_KEY_BASE64: "bad" }, { SHOOKIE_GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from("not PEM").toString("base64") }]) {
      expect(() => createGithubTokenProvider({ ...settings, ...change })).toThrow("GitHub authentication unavailable");
    }
  });
  it.each([401, 403, 404, 302])("denies HTTP %s without fallback", async status => {
    const p = createGithubTokenProvider(settings, vi.fn(async () => new Response("secret body", { status })))!;
    await expect(p.getToken()).rejects.toThrow("GitHub authentication unavailable");
  });
  it.each([
    { id: 999 }, { id: 456, app_id: 999 },
    { id: 456, app_id: 123, target_type: "Organization", account: { type: "Organization", login: "other" }, permissions },
    { id: 456, app_id: 123, target_type: "Organization", account: { type: "Organization", login: "yourssu" }, permissions: { ...permissions, contents: "write" } },
  ])("rejects mismatched identity or elevated scope", async installation => {
    const p = createGithubTokenProvider(settings, vi.fn(async url => Response.json(String(url).endsWith("/app") ? { id: 123 } : installation)))!;
    await expect(p.getToken()).rejects.toThrow("GitHub authentication unavailable");
  });
  it.each(["not json", "x".repeat(65537), "{}"])("rejects malformed or oversized bodies", async body => {
    const p = createGithubTokenProvider(settings, vi.fn(async () => new Response(body)))!;
    await expect(p.getToken()).rejects.toThrow("GitHub authentication unavailable");
  });
  it.each([
    { token: "bad\\ntoken", expires_at: "2026-06-01T01:00:00Z", permissions },
    { token: "short", expires_at: "2026-06-01T00:00:30Z", permissions },
    { token: "expired", expires_at: "2026-05-01T00:00:00Z", permissions },
    { token: "long", expires_at: "2027-06-01T00:00:00Z", permissions },
    { token: "elevated", expires_at: "2026-06-01T01:00:00Z", permissions: { ...permissions, issues: "write" } },
  ])("rejects invalid token schema, expiry or returned scope", async data => {
    const f = fixture();
    const fetcher: typeof fetch = async (url, init) => String(url).endsWith("/access_tokens") ? Response.json(data) : f.fetcher(url, init);
    const p = createGithubTokenProvider({ ...settings, GITHUB: "" }, fetcher, f.now)!;
    await expect(p.getToken()).rejects.toThrow("GitHub authentication unavailable");
    expect(p.redact(data.token)).toBe("[REDACTED]");
  });
  it("rejects non-RSA PEM and partial configuration without leaking supplied values", () => {
    const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => createGithubTokenProvider({ ...settings, SHOOKIE_GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from(ec).toString("base64") })).toThrow("GitHub authentication unavailable");
    expect(() => createGithubTokenProvider({ GITHUB_OWNER: "yourssu", GITHUB: "legacy", SHOOKIE_GITHUB_APP_ID: "123" })).toThrow("GitHub authentication unavailable");
  });
  it("rejects redirect responses even when a fetch implementation follows them", async () => {
    const response = Response.json({ id: 123 }); Object.defineProperty(response, "redirected", { value: true });
    const p = createGithubTokenProvider(settings, vi.fn(async () => response))!;
    await expect(p.getToken()).rejects.toThrow("GitHub authentication unavailable");
  });
  it("bounds stalled fetch and supports aborting one waiter", async () => {
    vi.useFakeTimers();
    try {
      const p = createGithubTokenProvider(settings, vi.fn(() => new Promise<Response>(() => {})))!;
      const controller = new AbortController();
      const first = expect(p.getToken(controller.signal)).rejects.toThrow(); controller.abort(); await first;
      const second = expect(p.getToken()).rejects.toThrow("GitHub authentication unavailable");
      await vi.advanceTimersByTimeAsync(10000); await second;
    } finally { vi.useRealTimers(); }
  });
});
