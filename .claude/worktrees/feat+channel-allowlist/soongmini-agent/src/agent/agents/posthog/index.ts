import { Agent } from "@mastra/core/agent";
import { buildPostHogInstructions } from "./instructions.js";
import { posthogDescription } from "./description.js";
import { createPostHogAgentTools } from "./tools.js";
import type { PostHogClientManager } from "../../../tools/posthog/client.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createPostHogAgent(manager: PostHogClientManager, model: any) {
  const tools = createPostHogAgentTools(manager);
  return new Agent({
    id: "posthog",
    name: "PostHog Analyst",
    instructions: buildPostHogInstructions(manager),
    description: posthogDescription,
    model,
    tools,
  });
}
