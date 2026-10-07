import { afterEach, describe, expect, it, vi } from "vitest";

const baseEnvironment = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_APP_TOKEN: "xapp-test",
  SLACK_USER_OAUTH_ENABLED: "true",
  SLACK_CLIENT_ID: "123.456",
  SLACK_CLIENT_SECRET: "0123456789abcdef0123456789abcdef",
  SLACK_OAUTH_REDIRECT_URI: "https://example.com/slack/user-oauth/callback",
  SLACK_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
  SLACK_TOKEN_ROTATION_ENABLED: "false",
  SLACK_USER_OAUTH_PORT: "3000",
  SLACK_OAUTH_STATE_TTL_SECONDS: "600",
  LLM_API_KEY: "test-llm-key",
};

async function loadConfig(overrides: Record<string, string> = {}) {
  vi.resetModules();
  vi.doMock("dotenv", () => ({ config: vi.fn() }));
  for (const [name, value] of Object.entries({ ...baseEnvironment, ...overrides })) {
    vi.stubEnv(name, value);
  }
  return import("./config.js");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("dotenv");
  vi.resetModules();
});

describe("optional public web search config", () => {
  it("defaults to no search key while permitting explicit synthetic configuration", async () => {
    vi.stubEnv("EXA_API_KEY", undefined);
    expect((await loadConfig()).config.EXA_API_KEY).toBe("");
    expect((await loadConfig({ EXA_API_KEY: "synthetic-exa-key" })).config.EXA_API_KEY).toBe("synthetic-exa-key");
  });
});

describe("Slack user OAuth config", () => {
  it("유효한 보안 설정을 정규화한다", async () => {
    const { getSlackUserOAuthConfig } = await loadConfig();

    expect(getSlackUserOAuthConfig()).toMatchObject({
      clientId: "123.456",
      redirectUri: "https://example.com/slack/user-oauth/callback",
      tokenRotationEnabled: false,
      port: 3000,
      stateTtlSeconds: 600,
    });
  });

  it("callback URI의 query와 비 HTTPS 외부 주소를 거부한다", async () => {
    const withQuery = await loadConfig({
      SLACK_OAUTH_REDIRECT_URI: "https://example.com/callback?source=unsafe",
    });
    expect(() => withQuery.getSlackUserOAuthConfig()).toThrow("query");

    const insecure = await loadConfig({
      SLACK_OAUTH_REDIRECT_URI: "http://example.com/callback",
    });
    expect(() => insecure.getSlackUserOAuthConfig()).toThrow("HTTPS");
  });

  it("state TTL과 listener port의 안전 범위를 강제한다", async () => {
    await expect(
      loadConfig({ SLACK_OAUTH_STATE_TTL_SECONDS: "901" }),
    ).rejects.toThrow();
    await expect(loadConfig({ SLACK_USER_OAUTH_PORT: "65536" })).rejects.toThrow();
  });

  it("기능이 꺼져 있으면 OAuth secret 없이 null을 반환한다", async () => {
    const { getSlackUserOAuthConfig } = await loadConfig({
      SLACK_USER_OAUTH_ENABLED: "false",
      SLACK_CLIENT_ID: "",
      SLACK_CLIENT_SECRET: "",
      SLACK_TOKEN_ENCRYPTION_KEY: "",
    });

    expect(getSlackUserOAuthConfig()).toBeNull();
  });
});

describe("mention group replacement config", () => {
  it("defaults the request timeout to 10000ms and allows the maximum", async () => {
    const defaults = await loadConfig();
    expect(defaults.config.RADAR_MENTION_GROUPS_REQUEST_TIMEOUT_MS).toBe(10_000);

    const maximum = await loadConfig({
      RADAR_MENTION_GROUPS_REQUEST_TIMEOUT_MS: "10000",
    });
    expect(maximum.config.RADAR_MENTION_GROUPS_REQUEST_TIMEOUT_MS).toBe(10_000);
    await expect(
      loadConfig({ RADAR_MENTION_GROUPS_REQUEST_TIMEOUT_MS: "10001" }),
    ).rejects.toThrow();
  });

  it("SPR-128 HTTPS endpoint와 cache/timeout 설정을 정규화한다", async () => {
    const { getMentionGroupReplacementConfig } = await loadConfig({
      SLACK_MENTION_GROUP_REPLACEMENT_ENABLED: "true",
      RADAR_MENTION_GROUPS_API_URL:
        "https://radar.example.com/internal/v1/mention-groups",
      SHOOKIE_MENTION_GROUPS_API_KEY: "0123456789abcdef0123456789abcdef",
      RADAR_MENTION_GROUPS_CACHE_TTL_SECONDS: "15",
      RADAR_MENTION_GROUPS_REQUEST_TIMEOUT_MS: "2500",
    });

    expect(getMentionGroupReplacementConfig()).toEqual({
      apiUrl: "https://radar.example.com/internal/v1/mention-groups",
      apiKey: "0123456789abcdef0123456789abcdef",
      cacheTtlMs: 15_000,
      requestTimeoutMs: 2_500,
    });
  });

  it("OAuth 없이 활성화하거나 외부 HTTP/key 포함 URL을 사용하면 실패한다", async () => {
    const withoutOAuth = await loadConfig({
      SLACK_USER_OAUTH_ENABLED: "false",
      SLACK_MENTION_GROUP_REPLACEMENT_ENABLED: "true",
      RADAR_MENTION_GROUPS_API_URL:
        "https://radar.example.com/internal/v1/mention-groups",
      SHOOKIE_MENTION_GROUPS_API_KEY: "0123456789abcdef",
    });
    expect(() => withoutOAuth.getMentionGroupReplacementConfig()).toThrow(
      "requires SLACK_USER_OAUTH_ENABLED",
    );

    const insecure = await loadConfig({
      SLACK_MENTION_GROUP_REPLACEMENT_ENABLED: "true",
      RADAR_MENTION_GROUPS_API_URL:
        "http://radar.example.com/internal/v1/mention-groups",
      SHOOKIE_MENTION_GROUPS_API_KEY: "0123456789abcdef",
    });
    expect(() => insecure.getMentionGroupReplacementConfig()).toThrow("HTTPS");

    const keyInUrl = await loadConfig({
      SLACK_MENTION_GROUP_REPLACEMENT_ENABLED: "true",
      RADAR_MENTION_GROUPS_API_URL:
        "https://secret@radar.example.com/internal/v1/mention-groups",
      SHOOKIE_MENTION_GROUPS_API_KEY: "0123456789abcdef",
    });
    expect(() => keyInUrl.getMentionGroupReplacementConfig()).toThrow("credentials");
  });

  it("기능이 꺼져 있으면 Radar secret 없이 null을 반환한다", async () => {
    const { getMentionGroupReplacementConfig } = await loadConfig({
      SLACK_MENTION_GROUP_REPLACEMENT_ENABLED: "false",
      RADAR_MENTION_GROUPS_API_URL: "",
      SHOOKIE_MENTION_GROUPS_API_KEY: "",
    });

    expect(getMentionGroupReplacementConfig()).toBeNull();
  });
});

describe("Radar Slack message relay config", () => {
  const enabled = {
    RADAR_SLACK_RELAY_ENABLED: "true",
    RADAR_SLACK_RELAY_URL: "https://radar.example.com/internal/v1/slack/message-events",
    RADAR_SLACK_RELAY_APP_ID: "A0ATZCLF99A",
    RADAR_SLACK_RELAY_TEAM_ID: "T2SRCGYPQ",
    RADAR_SLACK_RELAY_INTERNAL_API_KEY: "0123456789abcdef0123",
  };

  it("is disabled by default and needs no other values", async () => {
    vi.stubEnv("RADAR_SLACK_RELAY_ENABLED", undefined);
    const loaded = await loadConfig();
    expect(loaded.config.RADAR_SLACK_RELAY_ENABLED).toBe(false);
    expect(loaded.getSlackMessageRelayConfig()).toBeNull();
    // Stray partial values never enable it.
    expect((await loadConfig({ RADAR_SLACK_RELAY_URL: "https://x.example/internal/v1/slack/message-events" })).getSlackMessageRelayConfig()).toBeNull();
  });

  it("returns the fixed identity, URL and dedicated key when fully configured", async () => {
    expect((await loadConfig(enabled)).getSlackMessageRelayConfig()).toEqual({
      apiUrl: enabled.RADAR_SLACK_RELAY_URL, apiKey: enabled.RADAR_SLACK_RELAY_INTERNAL_API_KEY,
      appId: "A0ATZCLF99A", teamId: "T2SRCGYPQ",
    });
    expect((await loadConfig({ ...enabled, RADAR_SLACK_RELAY_URL: "http://localhost:8080/internal/v1/slack/message-events/" })).getSlackMessageRelayConfig()?.apiUrl)
      .toBe("http://localhost:8080/internal/v1/slack/message-events");
  });

  it.each([
    ["missing URL", { RADAR_SLACK_RELAY_URL: "" }, "RADAR_SLACK_RELAY_URL"],
    ["plain HTTP off localhost", { RADAR_SLACK_RELAY_URL: "http://radar.example.com/internal/v1/slack/message-events" }, "HTTPS"],
    ["credentials in URL", { RADAR_SLACK_RELAY_URL: "https://user:pw@radar.example.com/internal/v1/slack/message-events" }, "credentials"],
    ["query in URL", { RADAR_SLACK_RELAY_URL: "https://radar.example.com/internal/v1/slack/message-events?key=1" }, "query"],
    ["wrong route", { RADAR_SLACK_RELAY_URL: "https://radar.example.com/internal/v1/mention-groups" }, "/internal/v1/slack/message-events"],
    ["relative URL", { RADAR_SLACK_RELAY_URL: "/internal/v1/slack/message-events" }, "absolute"],
    ["bad app id", { RADAR_SLACK_RELAY_APP_ID: "app" }, "APP_ID"],
    ["missing team id", { RADAR_SLACK_RELAY_TEAM_ID: "" }, "TEAM_ID"],
    ["short key", { RADAR_SLACK_RELAY_INTERNAL_API_KEY: "short" }, "16-512"],
    ["key with whitespace", { RADAR_SLACK_RELAY_INTERNAL_API_KEY: "0123456789 abcdef0123" }, "whitespace"],
    ["missing key", { RADAR_SLACK_RELAY_INTERNAL_API_KEY: "" }, "16-512"],
  ])("fails closed at boot when enabled with %s", async (_name, overrides, message) => {
    const loaded = await loadConfig({ ...enabled, ...overrides });
    expect(() => loaded.getSlackMessageRelayConfig()).toThrow(message);
  });

  it("does not depend on mention group or user OAuth flags", async () => {
    const loaded = await loadConfig({ ...enabled, SLACK_USER_OAUTH_ENABLED: "false", SLACK_MENTION_GROUP_REPLACEMENT_ENABLED: "false" });
    expect(loaded.getSlackMessageRelayConfig()).not.toBeNull();
  });
});
