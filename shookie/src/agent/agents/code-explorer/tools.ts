import { createRunAuthenticatedTool } from "../../../tools/code-explorer/run-authenticated.js";
import { createWorkspaceManagerTools } from "../../../tools/code-explorer/workspace-manager.js";

export interface CodeExplorerConfig {
  appId: string;
  privateKey: string;
  installationId: string;
  owner: string;
  workspaceBasePath: string;
  workspaceMaxGb: number;
}

export function createCodeExplorerTools(config: CodeExplorerConfig) {
  const runAuthenticated = createRunAuthenticatedTool(
    config.appId,
    config.privateKey,
    config.installationId,
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
