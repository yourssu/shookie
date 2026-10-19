import { DEEPSEEK_AGENT_DEFAULTS } from "../../../llm/policy.js";
import { Agent } from "@mastra/core/agent";
import { buildMainShookieInstructions } from "./instructions.js";
import { mainShookieDescription } from "./description.js";
import { createMainShookieTools } from "./tools.js";
import type { SlackReadClient } from "../../../tools/slack/client.js";
import type { AttachmentToolOptions } from "../../../tools/attachments/tools.js";
import type { ImageToolOptions } from "../../../tools/images/tools.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createMainShookieAgent(model: any, webOptions: Parameters<typeof createMainShookieTools>[0] = {}, slackClient?: SlackReadClient, attachments?: AttachmentToolOptions, images?: ImageToolOptions, directTools: Parameters<typeof createMainShookieTools>[4] = {}) {
  const tools = createMainShookieTools(webOptions, slackClient, attachments, images, directTools);

  return new Agent({
    defaultOptions: DEEPSEEK_AGENT_DEFAULTS,
    id: "main-shookie",
    name: "슈키(shookie)",
    instructions: () => buildMainShookieInstructions({ toolKeys: Object.keys(tools) }),
    description: mainShookieDescription,
    model,
    tools,
  });
}
