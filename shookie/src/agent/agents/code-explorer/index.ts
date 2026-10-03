import { Agent } from "@mastra/core/agent";
import { buildCodeExplorerInstructions } from "./instructions.js";
import { codeExplorerDescription } from "./description.js";
import { createCodeExplorerTools, type CodeExplorerConfig } from "./tools.js";
export { type CodeExplorerConfig } from "./tools.js";

export function createCodeExplorerAgent(model: any, config: CodeExplorerConfig): Agent {
  return new Agent({
    id: "code-explorer", name: "Code Explorer",
    instructions: buildCodeExplorerInstructions(config), description: codeExplorerDescription,
    model, tools: createCodeExplorerTools(config),
    // Deliberately no Workspace: automatic file/edit tools are not authorized in Wave1.
  });
}
