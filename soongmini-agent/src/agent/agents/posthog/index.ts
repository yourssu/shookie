import { Agent } from "@mastra/core/agent";
import { posthogInstructions } from "./instructions.js";
import { posthogDescription } from "./description.js";
import { createPostHogAgentTools } from "./tools.js";
import type { PostHogClient } from "../../../tools/posthog/client.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createPostHogAgent(client: PostHogClient, model: any) {
  const tools = createPostHogAgentTools(client);
  return new Agent({
    id: "posthog",
    name: "PostHog Analyst",
    instructions: posthogInstructions,
    description: posthogDescription,
    model,
    tools,
  });
}
