import { describe, expect, it } from "vitest";
import { buildCodeExplorerInstructions } from "./instructions.js";
import { createCodeExplorerTools } from "./tools.js";
import { createCodeExplorerAgent } from "./index.js";
const config = { owner: "yourssu", gitHubToken: "dummy-token", workspaceBasePath: "/tmp/unused", workspaceMaxGb: 1 };
describe("read-only capability wiring", () => {
  it("only exposes typed GET reads and no automatic workspace", async () => {
    expect(Object.keys(createCodeExplorerTools(config))).toEqual(["github_read"]);
    const agent = createCodeExplorerAgent("openai/gpt-4o-mini", config);
    expect(await agent.getWorkspace()).toBeUndefined();
  });
  it("honestly describes unsupported writes and provenance", () => {
    const text = buildCodeExplorerInstructions(config);
    for (const term of ["읽기 전용", "yourssu", "지원하지 않는다", "PR 생성/병합/삭제", "출처", "민감 정보", "잘림"]) expect(text).toContain(term);
    expect(text).not.toContain("run_authenticated");
  });
});
