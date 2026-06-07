import { Agent } from "@mastra/core/agent";
import { buildMainShookieInstructions } from "./instructions.js";
import { mainShookieDescription } from "./description.js";
import { createMainShookieTools } from "./tools.js";
import type { Agent as AgentType } from "@mastra/core/agent";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createMainShookieAgent(subAgents: { posthog?: AgentType }, model: any) {
  const tools = createMainShookieTools(subAgents);

  return new Agent({
    id: "main-shookie",
    name: "슈키(shookie)",
    instructions: () => buildMainShookieInstructions(),
    description: mainShookieDescription,
    model,
    tools,
  });
}
