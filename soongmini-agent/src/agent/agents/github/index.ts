import { Agent } from "@mastra/core/agent";
import { githubInstructions } from "./instructions.js";
import { githubDescription } from "./description.js";
import { createGitHubAgentTools } from "./tools.js";
import type { GitHubClient } from "../../../tools/github/client.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createGitHubAgent(client: GitHubClient, model: any) {
  const tools = createGitHubAgentTools(client);
  return new Agent({
    id: "github",
    name: "GitHub Explorer",
    instructions: githubInstructions,
    description: githubDescription,
    model,
    tools,
  });
}
