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
