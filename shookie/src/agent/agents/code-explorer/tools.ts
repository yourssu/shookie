import { executionTools } from "../../../cancellation/execution-context.js";
import { createGithubReadTool } from "../../../tools/code-explorer/github-read.js";
import { createRepositoryTools } from "../../../tools/code-explorer/repository-tools.js";

import type { RegistryConfig } from "../../../tools/code-explorer/registry.js";
export interface CodeExplorerConfig {
  registry: RegistryConfig;
  gitHubToken: string;
  readOnlyToken?: string;
  tokenProvider?: import("../../../tools/code-explorer/github-auth.js").GithubTokenProvider;
  owner: string;
  workspaceBasePath: string;
  workspaceMaxGb: number;
}
export function createCodeExplorerTools(config: CodeExplorerConfig) {
  return executionTools({ github_read: createGithubReadTool(config), ...createRepositoryTools(config) });
}
