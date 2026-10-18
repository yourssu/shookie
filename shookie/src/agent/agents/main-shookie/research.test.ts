import { expect, it, vi } from "vitest";
import { noopObserve } from "@mastra/core/tools";
import type { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { createMainShookieTools } from "./tools.js";
vi.mock("database", () => ({ startInvocation: vi.fn(), completeInvocation: vi.fn(), logToolCall: vi.fn() }));
const input = { task: "원인 조사", target: "example/sample main", context: "관련 오류 근거", outputScope: "읽기 조사만" };
const evidence = { source: { repo: "sample", path: "a.ts", startLine: 2 }, data: "verified source" };
it.each([
  ["success", "stop", "success", false],
  ["partial", "stop", "partial", false],
  ["error", "stop", "error", false],
  ["success", "length", "partial", false],
  ["success", "stop", "partial", true],
  ["success", "stop", "partial", "string-error"],
  ["success", "stop", "partial", "truncated"],
] as const)("structured %s / %s / tool failure %s", async (reported, finishReason, expected, failed) => {
  const generate = vi.fn(async () => ({ text: JSON.stringify({ status: reported, result: "finding", limitations: reported === "success" ? [] : ["source missing"] }),
    usage: {}, finishReason, steps: [{ toolResults: [{ payload: { toolName: "github_read", result: failed === "string-error" ? { ...evidence, error: "조회 실패" } : failed === "truncated" ? { ...evidence, complete: false, truncated: true } : failed ? { ...evidence, status: "error" } : evidence } }] }] }));
  const tools = createMainShookieTools({ codeExplorer: { generate } as unknown as Agent });
  const requestContext = new RequestContext(); requestContext.set("userId", "U1");
  const result = await tools.code_explorer_agent.execute!(input, { requestContext, observe: noopObserve });
  expect(result).toMatchObject({ status: expected, result: "finding", evidence: [{ tool: "github_read", result: evidence }] });
  expect(generate.mock.calls[0]).toBeDefined();
  const call = generate.mock.calls[0] as unknown as [unknown, { requestContext: RequestContext }];
  expect(call[1].requestContext).toBe(requestContext);
  expect(JSON.stringify(call[0])).toContain("example/sample main");
  expect(JSON.stringify(call[0])).toContain("limitations");
});
it("represents malformed output and exceptions honestly; requires explicit target/context/scope", async () => {
  for (const [expected, generate] of [["partial", vi.fn(async () => ({ text: "opaque report", usage: {}, finishReason: "stop", steps: [] }))], ["error", vi.fn(async () => { throw Error("PRIVATE_ERROR"); })]] as const) {
    const tools = createMainShookieTools({ posthog: { generate } as unknown as Agent });
    const result = await tools.posthog_agent.execute!(input, { observe: noopObserve });
    expect(result).toMatchObject({ status: expected });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_ERROR");
    const invalid = await tools.posthog_agent.execute!({ task: "no boundary" }, { observe: noopObserve });
    expect(invalid).toMatchObject({ error: true });
    expect(generate).toHaveBeenCalledTimes(1);
  }
});
