import { z } from "zod";
import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";

dotenvConfig({ path: resolve(import.meta.dirname, "../../.env") });

const envSchema = z.object({
  // Slack
  SLACK_BOT_TOKEN: z.string().min(1),
  SLACK_APP_TOKEN: z.string().min(1),
  SLACK_USER_OAUTH_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  SLACK_CLIENT_ID: z.string().default(""),
  SLACK_CLIENT_SECRET: z.string().default(""),
  SLACK_OAUTH_REDIRECT_URI: z.string().default(""),
  SLACK_TOKEN_ENCRYPTION_KEY: z.string().default(""),
  SLACK_TOKEN_ROTATION_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  SLACK_USER_OAUTH_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  SLACK_OAUTH_STATE_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(600),
  SLACK_MENTION_GROUP_REPLACEMENT_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  SLACK_MENTION_GROUP_COMMAND_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // Radar mention groups (optional)
  RADAR_MENTION_GROUPS_API_URL: z.string().default(""),
  SHOOKIE_MENTION_GROUPS_API_KEY: z.string().default(""),
  RADAR_MENTION_GROUPS_WRITE_API_URL: z.string().default(""),
  SHOOKIE_MENTION_GROUPS_WRITE_API_KEY: z.string().default(""),
  RADAR_MENTION_GROUPS_CACHE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(300)
    .default(30),
  RADAR_MENTION_GROUPS_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(250)
    .max(10_000)
    .default(3_000),

  // LLM (OpenAI-compatible)
  LLM_API_KEY: z.string().min(1),
  LLM_BASE_URL: z.string().default("https://api.deepseek.com"),
  LLM_MODEL: z.string().default("deepseek-v4-pro"),

  // PostHog (optional)
  POSTHOG_API_KEY: z.string().default(""),

  // GitHub (optional) — PAT, code-explorer에서 GH_TOKEN으로 사용
  GITHUB: z.string().default(""),
  GITHUB_OWNER: z.string().default("yourssu"),

  // Thread Workspace
  THREAD_WORKSPACE_BASE_PATH: z.string().default("/tmp/shookie-workspaces"),
  THREAD_WORKSPACE_MAX_GB: z.coerce.number().default(5),

  // Agent
  MAX_TOOL_ITERATIONS: z.coerce.number().default(8),

  // Database
  DATABASE_URL: z.string().default("postgresql://postgres:postgres@localhost:5432/shookie"),

  // Logging
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export const config = envSchema.parse(process.env);

export function getSlackUserOAuthConfig() {
  if (!config.SLACK_USER_OAUTH_ENABLED) return null;

  const required = {
    SLACK_CLIENT_ID: config.SLACK_CLIENT_ID,
    SLACK_CLIENT_SECRET: config.SLACK_CLIENT_SECRET,
    SLACK_OAUTH_REDIRECT_URI: config.SLACK_OAUTH_REDIRECT_URI,
    SLACK_TOKEN_ENCRYPTION_KEY: config.SLACK_TOKEN_ENCRYPTION_KEY,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => value.trim().length === 0)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Slack user OAuth is enabled but missing configuration: ${missing.join(", ")}`);
  }
  if (!/^\d+\.\d+$/u.test(config.SLACK_CLIENT_ID)) {
    throw new Error("SLACK_CLIENT_ID must use Slack's numeric client ID format");
  }
  if (config.SLACK_CLIENT_SECRET.length < 16 || /\s/u.test(config.SLACK_CLIENT_SECRET)) {
    throw new Error("SLACK_CLIENT_SECRET must be at least 16 characters without whitespace");
  }

  let redirectUri: URL;
  try {
    redirectUri = new URL(config.SLACK_OAUTH_REDIRECT_URI);
  } catch {
    throw new Error("SLACK_OAUTH_REDIRECT_URI must be an absolute URL");
  }
  if (redirectUri.pathname === "/") {
    throw new Error("SLACK_OAUTH_REDIRECT_URI must include a callback path");
  }
  const isLocalHttp =
    redirectUri.protocol === "http:" &&
    (redirectUri.hostname === "localhost" || redirectUri.hostname === "127.0.0.1");
  if (redirectUri.protocol !== "https:" && !isLocalHttp) {
    throw new Error("SLACK_OAUTH_REDIRECT_URI must use HTTPS outside localhost");
  }
  if (redirectUri.username || redirectUri.password || redirectUri.search || redirectUri.hash) {
    throw new Error(
      "SLACK_OAUTH_REDIRECT_URI must not contain credentials, a query, or a fragment",
    );
  }

  return {
    clientId: config.SLACK_CLIENT_ID,
    clientSecret: config.SLACK_CLIENT_SECRET,
    redirectUri: redirectUri.toString(),
    tokenEncryptionKey: config.SLACK_TOKEN_ENCRYPTION_KEY,
    tokenRotationEnabled: config.SLACK_TOKEN_ROTATION_ENABLED,
    port: config.SLACK_USER_OAUTH_PORT,
    stateTtlSeconds: config.SLACK_OAUTH_STATE_TTL_SECONDS,
  };
}

export function getMentionGroupReplacementConfig() {
  if (!config.SLACK_MENTION_GROUP_REPLACEMENT_ENABLED) return null;
  if (!config.SLACK_USER_OAUTH_ENABLED) {
    throw new Error(
      "SLACK_MENTION_GROUP_REPLACEMENT_ENABLED requires SLACK_USER_OAUTH_ENABLED=true",
    );
  }
  if (!config.RADAR_MENTION_GROUPS_API_URL.trim()) {
    throw new Error("Mention group replacement requires RADAR_MENTION_GROUPS_API_URL");
  }
  if (
    config.SHOOKIE_MENTION_GROUPS_API_KEY.length < 16 ||
    config.SHOOKIE_MENTION_GROUPS_API_KEY.length > 512 ||
    /\s/u.test(config.SHOOKIE_MENTION_GROUPS_API_KEY)
  ) {
    throw new Error(
      "SHOOKIE_MENTION_GROUPS_API_KEY must be 16-512 characters without whitespace",
    );
  }

  let apiUrl: URL;
  try {
    apiUrl = new URL(config.RADAR_MENTION_GROUPS_API_URL);
  } catch {
    throw new Error("RADAR_MENTION_GROUPS_API_URL must be an absolute URL");
  }
  const isLocalHttp =
    apiUrl.protocol === "http:" &&
    (apiUrl.hostname === "localhost" || apiUrl.hostname === "127.0.0.1" || apiUrl.hostname === "[::1]");
  if (apiUrl.protocol !== "https:" && !isLocalHttp) {
    throw new Error("RADAR_MENTION_GROUPS_API_URL must use HTTPS outside localhost");
  }
  if (apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash) {
    throw new Error(
      "RADAR_MENTION_GROUPS_API_URL must not contain credentials, a query, or a fragment",
    );
  }
  if (apiUrl.pathname.replace(/\/$/u, "") !== "/internal/v1/mention-groups") {
    throw new Error(
      "RADAR_MENTION_GROUPS_API_URL must target /internal/v1/mention-groups",
    );
  }

  return {
    apiUrl: apiUrl.toString().replace(/\/$/u, ""),
    apiKey: config.SHOOKIE_MENTION_GROUPS_API_KEY,
    cacheTtlMs: config.RADAR_MENTION_GROUPS_CACHE_TTL_SECONDS * 1_000,
    requestTimeoutMs: config.RADAR_MENTION_GROUPS_REQUEST_TIMEOUT_MS,
  };
}

export function getMentionGroupCommandConfig() {
  if (!config.SLACK_MENTION_GROUP_COMMAND_ENABLED) return null;
  if (!config.RADAR_MENTION_GROUPS_WRITE_API_URL.trim()) {
    throw new Error("Mention group command requires RADAR_MENTION_GROUPS_WRITE_API_URL");
  }
  if (
    config.SHOOKIE_MENTION_GROUPS_WRITE_API_KEY.length < 16 ||
    config.SHOOKIE_MENTION_GROUPS_WRITE_API_KEY.length > 512 ||
    /\s/u.test(config.SHOOKIE_MENTION_GROUPS_WRITE_API_KEY)
  ) {
    throw new Error(
      "SHOOKIE_MENTION_GROUPS_WRITE_API_KEY must be 16-512 characters without whitespace",
    );
  }

  let apiUrl: URL;
  try {
    apiUrl = new URL(config.RADAR_MENTION_GROUPS_WRITE_API_URL);
  } catch {
    throw new Error("RADAR_MENTION_GROUPS_WRITE_API_URL must be an absolute URL");
  }
  const isLocalHttp =
    apiUrl.protocol === "http:" &&
    (apiUrl.hostname === "localhost" || apiUrl.hostname === "127.0.0.1" || apiUrl.hostname === "[::1]");
  if (apiUrl.protocol !== "https:" && !isLocalHttp) {
    throw new Error("RADAR_MENTION_GROUPS_WRITE_API_URL must use HTTPS outside localhost");
  }
  if (apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash) {
    throw new Error(
      "RADAR_MENTION_GROUPS_WRITE_API_URL must not contain credentials, a query, or a fragment",
    );
  }
  if (apiUrl.pathname.replace(/\/$/u, "") !== "/internal/v1/mention-groups") {
    throw new Error(
      "RADAR_MENTION_GROUPS_WRITE_API_URL must target /internal/v1/mention-groups",
    );
  }

  return {
    apiUrl: apiUrl.toString().replace(/\/$/u, ""),
    apiKey: config.SHOOKIE_MENTION_GROUPS_WRITE_API_KEY,
  };
}
