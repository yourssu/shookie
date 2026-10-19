import { DEEPSEEK_AGENT_DEFAULTS } from "../../../llm/policy.js";
import { Agent } from "@mastra/core/agent";
import { buildCodeExplorerInstructions } from "./instructions.js";
import { codeExplorerDescription } from "./description.js";
import { createCodeExplorerTools, type CodeExplorerConfig } from "./tools.js";
export { type CodeExplorerConfig } from "./tools.js";

export function createCodeExplorerAgent(model: any, config: CodeExplorerConfig, tools = createCodeExplorerTools(config)): Agent {
  return new Agent({
    defaultOptions: DEEPSEEK_AGENT_DEFAULTS,
    id: "code-explorer", name: "Code Explorer",
    instructions: buildCodeExplorerInstructions(config), description: codeExplorerDescription,
    model, tools,
    // Deliberately no Workspace: only controlled snapshot reads; no automatic file/edit tools.
  });
}
