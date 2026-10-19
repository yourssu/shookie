import { DEEPSEEK_AGENT_DEFAULTS } from "../../../llm/policy.js";
import { Agent } from "@mastra/core/agent";
import { buildPostHogInstructions } from "./instructions.js";
import { posthogDescription } from "./description.js";
import { createPostHogAgentTools } from "./tools.js";
import { withSystemPromptLogging } from "../../log-system-prompt.js";
import type { PostHogClientManager } from "../../../tools/posthog/client.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createPostHogAgent(manager: PostHogClientManager, model: any, tools = createPostHogAgentTools(manager)) {
  return new Agent({
    defaultOptions: DEEPSEEK_AGENT_DEFAULTS,
    id: "posthog",
    name: "PostHog Analyst",
    instructions: buildPostHogInstructions(),
    description: posthogDescription,
    model: withSystemPromptLogging(model, "posthog"),
    tools,
  });
}
