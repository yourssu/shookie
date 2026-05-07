import { Agent } from "@mastra/core/agent";
import { buildGithubInstructions } from "./instructions.js";
import { githubDescription } from "./description.js";
import { createGitHubAgentTools } from "./tools.js";
import type { GitHubClient } from "../../../tools/github/client.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createGitHubAgent(client: GitHubClient, model: any) {
  const tools = createGitHubAgentTools(client);
  const instructions = buildGithubInstructions(client);
  return new Agent({
    id: "github",
    name: "GitHub Explorer",
    instructions,
    description: githubDescription,
    model,
    tools,
  });
}
