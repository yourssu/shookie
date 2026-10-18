import { executionSlackInterceptor } from "../cancellation/slack-transport.js";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createMainShookieAgent } from "./agents/main-shookie/index.js";
import { createPostHogAgent } from "./agents/posthog/index.js";
import { createCodeExplorerAgent } from "./agents/code-explorer/index.js";
import { createCodeExplorerTools } from "./agents/code-explorer/tools.js";
import { createPostHogAgentTools } from "./agents/posthog/tools.js";
import { createTool } from "@mastra/core/tools";
import { PostHogClientManager } from "../tools/posthog/client.js";
import { posthogRegistryConfig } from "../tools/posthog/registry.js";
import { createGithubTokenProvider } from "../tools/code-explorer/github-auth.js";
import { registryConfig } from "../tools/code-explorer/registry.js";
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
  const directTools: Record<string, ReturnType<typeof createTool>> = {};

  // Startup only validates configuration; it never fetches the project catalog/guidance.
  const posthogRegistry = posthogRegistryConfig(config.RADAR_POSTHOG_REGISTRY_API_URL ?? "", config.SHOOKIE_POSTHOG_REGISTRY_INTERNAL_API_KEY ?? "");
  if (config.POSTHOG_API_KEY && posthogRegistry) {
    const phManager = new PostHogClientManager(config.POSTHOG_API_KEY, posthogRegistry);
    const tools = createPostHogAgentTools(phManager);
    Object.assign(directTools, tools);
    subAgents.posthog = createPostHogAgent(phManager, model, tools);
    logger.info("PostHog 서브 에이전트 등록 완료 (프로젝트는 Radar 등록 정보를 매 동작 조회)");
  } else {
    logger.info("PostHog API 키 또는 Radar PostHog 프로젝트 등록 API 설정이 없어 PostHog 서브 에이전트를 비활성화합니다");
  }

  const githubRegistry = registryConfig(config.RADAR_GITHUB_REGISTRY_API_URL ?? "", config.SHOOKIE_GITHUB_REGISTRY_INTERNAL_API_KEY ?? "");
  const tokenProvider = createGithubTokenProvider(config);
  if ((tokenProvider || config.GITHUB) && githubRegistry) {
    const explorerConfig = {
      registry: githubRegistry,
      gitHubToken: config.GITHUB,
      tokenProvider,
      owner: config.GITHUB_OWNER,
      workspaceBasePath: config.THREAD_WORKSPACE_BASE_PATH,
      workspaceMaxGb: config.THREAD_WORKSPACE_MAX_GB,
    };
    const tools = createCodeExplorerTools(explorerConfig);
    Object.assign(directTools, tools);
    subAgents.codeExplorer = createCodeExplorerAgent(model, explorerConfig, tools);
    logger.info("Code Explorer 서브 에이전트 등록 완료");
  } else {
    logger.info("GitHub 토큰 또는 Radar 등록 저장소 API 설정이 없어 Code Explorer를 비활성화합니다. 관리자에게 설정을 요청하세요");
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
  const mainShookie = createMainShookieAgent(subAgents, model, { exaApiKey: config.EXA_API_KEY }, slackClient, attachments, images, directTools);
  logger.info("메인 에이전트 생성 완료");

  return mainShookie;
}
