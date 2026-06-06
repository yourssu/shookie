import { createGitHubTools } from "../../../tools/github/tools.js";
import type { GitHubClient } from "../../../tools/github/client.js";

export function createGitHubAgentTools(client: GitHubClient) {
  return createGitHubTools(client);
}
