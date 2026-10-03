import { describe, expect, it } from "vitest";
import { buildCodeExplorerInstructions } from "./instructions.js";
import { createCodeExplorerTools } from "./tools.js";
import { createCodeExplorerAgent } from "./index.js";
const config = { owner: "yourssu", gitHubToken: "dummy-token", workspaceBasePath: "/tmp/unused", workspaceMaxGb: 1 };
describe("read-only capability wiring", () => {
  it("exposes API and controlled snapshot reads without automatic workspace", async () => {
    expect(Object.keys(createCodeExplorerTools(config))).toEqual(["github_read", "repo_clone", "repo_list_files", "repo_read_file", "repo_search"]);
    const agent = createCodeExplorerAgent("openai/gpt-4o-mini", config);
    expect(await agent.getWorkspace()).toBeUndefined();
  });
  it("rejects model identity/commands and fails closed without requestContext", async () => {
    const tools = createCodeExplorerTools(config);
    expect(await tools.repo_clone.inputSchema!["~standard"].validate({ repo: "sample", userId: "U1", command: "sh" })).toHaveProperty("issues");
    expect(await tools.repo_read_file.inputSchema!["~standard"].validate({ snapshotId: "00000000-0000-4000-8000-000000000000", path: "../secret" })).toHaveProperty("issues");
    expect(await tools.repo_clone.execute!({ repo: "sample" }, {} as never)).toHaveProperty("error");
    expect(await tools.repo_list_files.execute!({ snapshotId: "00000000-0000-4000-8000-000000000000", offset: 0 }, {} as never)).toHaveProperty("error");
    expect(await tools.repo_read_file.execute!({ snapshotId: "00000000-0000-4000-8000-000000000000", path: "code.ts", startLine: 1 }, {} as never)).toHaveProperty("error");
    expect(await tools.repo_search.execute!({ snapshotId: "00000000-0000-4000-8000-000000000000", literal: "x" }, {} as never)).toHaveProperty("error");
  });
  it("honestly describes unsupported writes and provenance", () => {
    const text = buildCodeExplorerInstructions(config);
    for (const term of ["읽기 전용", "yourssu", "지원하지 않는다", "PR 생성/병합/삭제", "출처", "민감 정보", "잘림"]) expect(text).toContain(term);
    for (const term of ["repo_clone", "repo_list_files", "repo_read_file", "repo_search", "commitSha", "sandbox", "GitHub ACL"]) expect(text).toContain(term);
    expect(text).not.toContain("run_authenticated");
  });
});
