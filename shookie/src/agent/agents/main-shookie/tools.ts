import { createTool } from "@mastra/core/tools";
import { createDomainGuidanceTool } from "../../domain-guidance.js";
import { executionTools } from "../../../cancellation/execution-context.js";
import { createWebTools } from "../../../tools/web/tools.js";
import { createSlackReadTools } from "../../../tools/slack/tools.js";
import { createAttachmentTools, type AttachmentToolOptions } from "../../../tools/attachments/tools.js";
import { createImageTools, type ImageToolOptions } from "../../../tools/images/tools.js";
import type { SlackReadClient } from "../../../tools/slack/client.js";

export function createMainShookieTools(webOptions: Parameters<typeof createWebTools>[0] = {}, slackClient?: SlackReadClient, attachments?: AttachmentToolOptions, images?: ImageToolOptions, directTools: Record<string, ReturnType<typeof createTool>> = {}) {
  const tools: Record<string, ReturnType<typeof createTool>> = {
    ...directTools,
    load_domain_guidance: createDomainGuidanceTool([
      ...(directTools.github_read ? ["github" as const] : []),
      ...(directTools.listProjects ? ["posthog" as const] : []),
    ]),
    ...createWebTools(webOptions),
    ...(slackClient ? createSlackReadTools(slackClient) : {}),
    ...(attachments ? createAttachmentTools(attachments) : {}),
    ...(images ? createImageTools(images) : {}),
  };
  return executionTools(Object.fromEntries(Object.entries(tools).sort(([a], [b]) => a.localeCompare(b, "en"))));
}
