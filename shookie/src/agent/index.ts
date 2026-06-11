import { createDeepSeek } from "@ai-sdk/deepseek";
import { createMainShookieAgent } from "./agents/main-shookie/index.js";
import { createPostHogAgent } from "./agents/posthog/index.js";
import { createCodeExplorerAgent } from "./agents/code-explorer/index.js";
import { PostHogClientManager, POSTHOG_PROJECTS } from "../tools/posthog/client.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { Agent } from "@mastra/core/agent";

export function createAgent() {
  const provider = createDeepSeek({
    apiKey: config.LLM_API_KEY,
    baseURL: config.LLM_BASE_URL,
  });
  const model = provider(config.LLM_MODEL);

  const subAgents: { posthog?: Agent; codeExplorer?: Agent } = {};

  if (POSTHOG_PROJECTS.length > 0 && config.POSTHOG_API_KEY) {
    const phManager = new PostHogClientManager(config.POSTHOG_API_KEY, POSTHOG_PROJECTS);
    subAgents.posthog = createPostHogAgent(phManager, model);
    logger.info(`PostHog 서브 에이전트 등록 완료 (프로젝트: ${phManager.getProjectNames().join(", ")})`);
  } else {
    logger.info("PostHog 설정이 없어 서브 에이전트를 등록하지 않습니다");
  }

  if (config.GITHUB) {
    subAgents.codeExplorer = createCodeExplorerAgent(model, {
      gitHubToken: config.GITHUB,
      owner: config.GITHUB_OWNER,
      workspaceBasePath: config.THREAD_WORKSPACE_BASE_PATH,
      workspaceMaxGb: config.THREAD_WORKSPACE_MAX_GB,
    });
    logger.info("Code Explorer 서브 에이전트 등록 완료");
  } else {
    logger.info("GitHub 토큰이 없어 Code Explorer 서브 에이전트를 등록하지 않습니다");
  }

  const mainShookie = createMainShookieAgent(subAgents, model);
  logger.info("메인 에이전트 생성 완료");

  return mainShookie;
}
