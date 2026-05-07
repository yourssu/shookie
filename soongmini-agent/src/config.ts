import { z } from "zod";
import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";

dotenvConfig({ path: resolve(import.meta.dirname, "../../.env") });

const envSchema = z.object({
  // Slack
  SLACK_BOT_TOKEN: z.string().min(1),
  SLACK_APP_TOKEN: z.string().min(1),

  // LLM (OpenAI-compatible)
  LLM_API_KEY: z.string().min(1),
  LLM_BASE_URL: z.string().default("https://api.upstage.ai/v1"),
  LLM_MODEL: z.string().default("solar-pro3"),

  // PostHog (optional)
  POSTHOG_API_KEY: z.string().default(""),
  POSTHOG_PROJECT_ID: z.string().default(""),

  // GitHub (optional)
  GITHUB: z.string().default(""),
  GITHUB_OWNER: z.string().default("yourssu"),
  GITHUB_REPOS: z.string().default(""),

  // Agent
  MAX_TOOL_ITERATIONS: z.coerce.number().default(8),

  // Logging
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export const config = envSchema.parse(process.env);
