import { createOpenAI } from "@ai-sdk/openai";
import { createCoordinatorAgent } from "./agents/coordinator/index.js";
import { createPostHogAgent } from "./agents/posthog/index.js";
import { PostHogClient } from "../tools/posthog/client.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { Agent } from "@mastra/core/agent";

export function createAgent() {
  const provider = createOpenAI({
    apiKey: config.LLM_API_KEY,
    baseURL: config.LLM_BASE_URL,
  });
  const model = provider(config.LLM_MODEL);

  const subAgents: { posthog?: Agent } = {};

  if (config.POSTHOG_API_KEY && config.POSTHOG_PROJECT_ID) {
    const phClient = new PostHogClient(config.POSTHOG_API_KEY, config.POSTHOG_PROJECT_ID);
    subAgents.posthog = createPostHogAgent(phClient, model);
    logger.info("PostHog 서브 에이전트 등록 완료");
  } else {
    logger.info("PostHog API 키가 없어 서브 에이전트를 등록하지 않습니다");
  }

  const coordinator = createCoordinatorAgent(subAgents, model);
  logger.info("코디네이터 에이전트 생성 완료");

  return coordinator;
}
