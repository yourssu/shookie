import { Agent } from "@mastra/core/agent";
import { buildMainShookieInstructions } from "./instructions.js";
import { mainShookieDescription } from "./description.js";
import { createMainShookieTools } from "./tools.js";
import type { Agent as AgentType } from "@mastra/core/agent";
import type { SlackReadClient } from "../../../tools/slack/client.js";
import type { AttachmentToolOptions } from "../../../tools/attachments/tools.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createMainShookieAgent(subAgents: { posthog?: AgentType; codeExplorer?: AgentType }, model: any, webOptions: Parameters<typeof createMainShookieTools>[1] = {}, slackClient?: SlackReadClient, attachments?: AttachmentToolOptions) {
  const tools = createMainShookieTools(subAgents, webOptions, slackClient, attachments);

  return new Agent({
    id: "main-shookie",
    name: "슈키(shookie)",
    instructions: async () => {
      const explorer = subAgents.codeExplorer;
      const explorerTools = explorer?.listTools ? Object.keys(await explorer.listTools()) : [];
      const description = explorer?.getDescription?.();
      return buildMainShookieInstructions({
        toolKeys: Object.keys(tools),
        codeExplorerDescription: explorer ? `${description ?? '등록된 읽기 도구; 상세 범위는 도구 결과로 확인'} 실제 도구: ${explorerTools.join(', ') || '확인 불가'}` : undefined,
      });
    },
    description: mainShookieDescription,
    model,
    tools,
  });
}
