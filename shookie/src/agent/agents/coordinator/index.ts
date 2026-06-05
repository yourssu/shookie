import { Agent } from "@mastra/core/agent";
import { buildCoordinatorInstructions } from "./instructions.js";
import { coordinatorDescription } from "./description.js";
import { createCoordinatorTools } from "./tools.js";
import type { Agent as AgentType } from "@mastra/core/agent";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createCoordinatorAgent(subAgents: { posthog?: AgentType }, model: any) {
  const tools = createCoordinatorTools(subAgents);

  return new Agent({
    id: "coordinator",
    name: "슈키",
    instructions: () => buildCoordinatorInstructions(),
    description: coordinatorDescription,
    model,
    tools,
  });
}
