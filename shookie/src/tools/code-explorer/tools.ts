import { executionTools } from "../../cancellation/execution-context.js";
import { createGithubReadTool } from "./github-read.js";
import { createRepositoryTools } from "./repository-tools.js";
import type { RegistryConfig } from "./registry.js";
export interface CodeExplorerConfig {
  registry: RegistryConfig;
  gitHubToken: string;
  readOnlyToken?: string;
  tokenProvider?: import("./github-auth.js").GithubTokenProvider;
  owner: string;
  workspaceBasePath: string;
  workspaceMaxGb: number;
}
export function createCodeExplorerTools(config: CodeExplorerConfig) {
  return executionTools({ github_read: createGithubReadTool(config), ...createRepositoryTools(config) });
}
