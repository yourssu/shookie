import { createPostHogTools } from "../../../tools/posthog/tools.js";
import type { PostHogClient } from "../../../tools/posthog/client.js";

export function createPostHogAgentTools(client: PostHogClient) {
  return createPostHogTools(client);
}
