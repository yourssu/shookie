import { createPostHogTools } from "../../../tools/posthog/tools.js";
import type { PostHogClientManager } from "../../../tools/posthog/client.js";

export function createPostHogAgentTools(manager: PostHogClientManager) {
  return createPostHogTools(manager);
}
