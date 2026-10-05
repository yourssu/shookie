import { executionTools } from "../../../cancellation/execution-context.js";
import { createGithubReadTool } from "../../../tools/code-explorer/github-read.js";
import { createRepositoryTools } from "../../../tools/code-explorer/repository-tools.js";

export interface CodeExplorerConfig {
  gitHubToken: string;
  readOnlyToken?: string;
  owner: string;
  repositories?: string[];
  workspaceBasePath: string;
  workspaceMaxGb: number;
}
export function createCodeExplorerTools(config: CodeExplorerConfig) {
  return executionTools({ github_read: createGithubReadTool(config), ...createRepositoryTools(config) });
}
