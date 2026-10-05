import { executionSlackInterceptor } from "../cancellation/slack-transport.js";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createMainShookieAgent } from "./agents/main-shookie/index.js";
import { createPostHogAgent } from "./agents/posthog/index.js";
import { createCodeExplorerAgent } from "./agents/code-explorer/index.js";
import { PostHogClientManager } from "../tools/posthog/client.js";
import { getPostHogProjects } from "../projects/index.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { Agent } from "@mastra/core/agent";
import { WebClient, LogLevel } from "@slack/web-api";
import { silentSlackLogger } from "../tools/slack/sdk-logger.js";
import type { SlackReadClient } from "../tools/slack/client.js";
import { createSlackAttachmentOptions } from "../tools/attachments/slack-authorization.js";
import type { DownloadDependencies } from "../tools/attachments/download.js";
import { createSlackImageOptions } from "../tools/images/slack-options.js";
import type { VisionDependencies } from "../tools/images/transport.js";

export function createAgent(options: { slackClient?: SlackReadClient & Partial<Pick<WebClient, "files">>;
  attachmentDownloadDependencies?: DownloadDependencies; imageVisionDependencies?: VisionDependencies } = {}) {
  const provider = createDeepSeek({
    apiKey: config.LLM_API_KEY,
    baseURL: config.LLM_BASE_URL,
  });
  const model = provider(config.LLM_MODEL);

  const subAgents: { posthog?: Agent; codeExplorer?: Agent } = {};

  const phProjects = getPostHogProjects();
  if (phProjects.length > 0 && config.POSTHOG_API_KEY) {
    const entries = phProjects.map((p) => ({
      name: p.displayName,
      projectId: p.posthog.projectId,
      description: p.description,
    }));
    const phManager = new PostHogClientManager(config.POSTHOG_API_KEY, entries);
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

  // Dedicated bot-only read client: no user-OAuth lookup, SDK retries or long 429 waits.
  const slackClient = options.slackClient ?? (config.SLACK_BOT_TOKEN
    ? new WebClient(config.SLACK_BOT_TOKEN, { rejectRateLimitedCalls: true, retryConfig: { retries: 0 }, timeout: 10_000, logger: silentSlackLogger, logLevel: LogLevel.ERROR, requestInterceptor: executionSlackInterceptor })
    : undefined);
  const attachments = slackClient?.files && config.SLACK_BOT_TOKEN
    ? createSlackAttachmentOptions(slackClient as SlackReadClient & Pick<WebClient, "files">,
        config.SLACK_BOT_TOKEN, options.attachmentDownloadDependencies)
    : undefined;
  const images = slackClient?.files && config.SLACK_BOT_TOKEN
    ? createSlackImageOptions(slackClient as SlackReadClient & Pick<WebClient, "files">, config.SLACK_BOT_TOKEN,
        { apiKey: config.LLM_API_KEY, baseURL: config.LLM_BASE_URL, model: config.LLM_MODEL },
        options.attachmentDownloadDependencies, options.imageVisionDependencies)
    : undefined;
  const mainShookie = createMainShookieAgent(subAgents, model, { exaApiKey: config.EXA_API_KEY }, slackClient, attachments, images);
  logger.info("메인 에이전트 생성 완료");

  return mainShookie;
}
