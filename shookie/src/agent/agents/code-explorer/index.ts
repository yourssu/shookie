import { Agent } from "@mastra/core/agent";
import { Workspace, LocalFilesystem } from "@mastra/core/workspace";
import { resolve } from "path";
import { buildCodeExplorerInstructions } from "./instructions.js";
import { codeExplorerDescription } from "./description.js";
import { createCodeExplorerTools, type CodeExplorerConfig } from "./tools.js";

export { type CodeExplorerConfig } from "./tools.js";

function buildThreadPath(basePath: string, channel: string, threadTs: string): string {
  return resolve(basePath, "threads", `${channel}_${threadTs}`);
}

export function createCodeExplorerAgent(model: any, config: CodeExplorerConfig): Agent {
  const workspace = new Workspace({
    filesystem: ({ requestContext }) => {
      const channel = requestContext.get("channel") as string;
      const threadTs = requestContext.get("threadTs") as string;
      const basePath = buildThreadPath(config.workspaceBasePath, channel, threadTs);
      return new LocalFilesystem({ basePath, contained: true });
    },
  });

  const tools = createCodeExplorerTools(config);

  return new Agent({
    id: "code-explorer",
    name: "Code Explorer",
    instructions: buildCodeExplorerInstructions(config),
    description: codeExplorerDescription,
    model,
    tools,
    workspace,
  });
}
