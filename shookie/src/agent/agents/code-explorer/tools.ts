import { createRunAuthenticatedTool } from "../../../tools/code-explorer/run-authenticated.js";
import { createWorkspaceManagerTools } from "../../../tools/code-explorer/workspace-manager.js";

export interface CodeExplorerConfig {
  gitHubToken: string;
  owner: string;
  workspaceBasePath: string;
  workspaceMaxGb: number;
}

export function createCodeExplorerTools(config: CodeExplorerConfig) {
  const runAuthenticated = createRunAuthenticatedTool(
    config.gitHubToken,
    config.workspaceBasePath,
  );

  const workspaceManagerTools = createWorkspaceManagerTools(
    config.workspaceBasePath,
    config.workspaceMaxGb,
  );

  return {
    run_authenticated: runAuthenticated,
    ...workspaceManagerTools,
  };
}
