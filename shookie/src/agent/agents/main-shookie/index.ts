import { Agent } from "@mastra/core/agent";
import { buildMainShookieInstructions } from "./instructions.js";
import { mainShookieDescription } from "./description.js";
import { createMainShookieTools } from "./tools.js";
import type { Agent as AgentType } from "@mastra/core/agent";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createMainShookieAgent(subAgents: { posthog?: AgentType; codeExplorer?: AgentType }, model: any, webOptions: Parameters<typeof createMainShookieTools>[1] = {}) {
  const tools = createMainShookieTools(subAgents, webOptions);

  return new Agent({
    id: "main-shookie",
    name: "슈키(shookie)",
    instructions: () => buildMainShookieInstructions({ toolKeys: Object.keys(tools), codeExplorerDescription: subAgents.codeExplorer?.getDescription() }),
    description: mainShookieDescription,
    model,
    tools,
  });
}
