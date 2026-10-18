import { expect, it, vi } from "vitest";
import { noopObserve } from "@mastra/core/tools";
import type { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { createMainShookieTools } from "./tools.js";
import { ExecutionScope, executionStorage } from "../../../cancellation/execution-context.js";
import { logger } from "../../../logger.js";
import { RESEARCH_LIMITS, researchOutput } from "./research-output.js";
vi.mock("../../../logger.js", () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));
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
  expect(result).toMatchObject({ status: expected, result: "finding", evidence: [{ tool: "github_read", source: evidence.source, excerpt: "verified source" }] });
  expect(generate.mock.calls[0]).toBeDefined();
  const call = generate.mock.calls[0] as unknown as [unknown, { requestContext: RequestContext }];
  expect(call[1].requestContext).toBe(requestContext);
  expect(JSON.stringify(call[0])).toContain("example/sample main");
  expect(JSON.stringify(call[0])).toContain("limitations");
});
it("represents malformed output and exceptions honestly; requires explicit target/context/scope", async () => {
  for (const [expected, generate] of [["partial", vi.fn(async () => ({ text: "opaque report", usage: {}, finishReason: "stop", steps: [] }))], ["error", vi.fn(async () => { throw Object.assign(Error("PRIVATE_ERROR"), { name: "PRIVATE_ERROR_NAME" }); })]] as const) {
    const tools = createMainShookieTools({ posthog: { generate } as unknown as Agent });
    const result = await tools.posthog_agent.execute!(input, { observe: noopObserve });
    expect(result).toMatchObject({ status: expected });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_ERROR");
    if (expected === "error") {
      expect(logger.warn).toHaveBeenCalledWith("전문 조사 실행 실패 (sanitized)");
      expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("PRIVATE_ERROR");
    }
    const invalid = await tools.posthog_agent.execute!({ task: "no boundary" }, { observe: noopObserve });
    expect(invalid).toMatchObject({ error: true });
    expect(generate).toHaveBeenCalledTimes(1);
  }
});

it("bounds multi-step evidence/report in serialized UTF-8 and preserves only supplied provenance", async () => {
  const long = '슈키😀\n"\\'.repeat(10000);
  const generate = vi.fn(async () => ({ text: JSON.stringify({ status: "success", result: long, limitations: Array(100).fill(long) }),
    usage: {}, finishReason: "stop", steps: Array.from({ length: 40 }, (_, i) => ({ toolResults: [
      { payload: { toolName: "repo_read_file", result: { complete: true, source: { repo: "sample", ref: "main", path: `src/${i}.ts`, startLine: 12,
        permalink: `https://github.com/example/sample/blob/main/src/${i}.ts#L12`, ignored: "NOT_A_SOURCE_FIELD" }, text: long, nested: { raw: "RAW_NESTED_SENTINEL" } } } },
    ] })) }));
  const tool = createMainShookieTools({ codeExplorer: { generate } as unknown as Agent }).code_explorer_agent;
  const output = researchOutput.parse(await tool.execute!(input, { observe: noopObserve }));
  expect(output).toMatchObject({ status: "partial", truncated: true });
  expect(output.evidence).toHaveLength(RESEARCH_LIMITS.items);
  expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(RESEARCH_LIMITS.totalBytes);
  expect(Buffer.byteLength(JSON.stringify(output.evidence))).toBeLessThanOrEqual(RESEARCH_LIMITS.evidenceBytes);
  expect(Buffer.byteLength(JSON.stringify(output.result))).toBeLessThanOrEqual(RESEARCH_LIMITS.resultBytes);
  expect(output.limitations.length).toBeLessThanOrEqual(RESEARCH_LIMITS.limitationItems);
  for (const limitation of output.limitations) expect(Buffer.byteLength(JSON.stringify(limitation))).toBeLessThanOrEqual(RESEARCH_LIMITS.limitationBytes);
  for (const [i, entry] of output.evidence.entries()) {
    expect(entry).toMatchObject({ tool: "repo_read_file", source: { repo: "sample", ref: "main", path: `src/${i}.ts`, startLine: 12,
      permalink: `https://github.com/example/sample/blob/main/src/${i}.ts#L12` }, status: "success", truncated: true });
    expect(Buffer.byteLength(JSON.stringify(entry))).toBeLessThanOrEqual(RESEARCH_LIMITS.entryBytes);
    expect(Buffer.byteLength(JSON.stringify(entry.excerpt))).toBeLessThanOrEqual(RESEARCH_LIMITS.excerptBytes);
    expect(entry.excerpt).not.toMatch(/[\uD800-\uDBFF]$/u);
    expect(Object.keys(entry)).not.toContain("result");
  }
  expect(JSON.stringify(output)).not.toContain("RAW_NESTED_SENTINEL");
  expect(JSON.stringify(output)).not.toContain("NOT_A_SOURCE_FIELD");
  expect(output.limitations.join(" ")).toContain("전체 조사 결과가 아닙니다");
});
it("bounds invalid raw report fallback and never invents sources from target/report", async () => {
  const generate = vi.fn(async () => ({ text: "invalid-report ".repeat(100000), usage: {}, finishReason: "stop",
    steps: [{ toolResults: [{ payload: { toolName: "queryEvents", result: { status: "success", data: { nested: "NOT_EXCERPT" } } } }] }] }));
  const output = researchOutput.parse(await createMainShookieTools({ posthog: { generate } as unknown as Agent }).posthog_agent.execute!(input, { observe: noopObserve }));
  expect(output).toMatchObject({ status: "partial", truncated: true, evidence: [{ source: {}, excerpt: "", truncated: true }] });
  expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(RESEARCH_LIMITS.totalBytes);
  expect(Buffer.byteLength(JSON.stringify(output.result))).toBeLessThanOrEqual(RESEARCH_LIMITS.resultBytes);
  expect(output.limitations.length).toBeLessThanOrEqual(RESEARCH_LIMITS.limitationItems);
  for (const limitation of output.limitations) expect(Buffer.byteLength(JSON.stringify(limitation))).toBeLessThanOrEqual(RESEARCH_LIMITS.limitationBytes);
  expect(output.limitations.join(" ")).toContain("보고서 형식 미확인");
  expect(JSON.stringify(output)).not.toContain("example/sample");
  expect(JSON.stringify(output)).not.toContain("NOT_EXCERPT");
});
it("rejects cancellation occurring inside specialist instead of converting it to error output", async () => {
  const scope = new ExecutionScope();
  const generate = vi.fn(async () => { scope.control.cancel(); throw Object.assign(Error("PRIVATE_CANCEL_MESSAGE"), { name: "PRIVATE_CANCEL_NAME" }); });
  const tool = createMainShookieTools({ posthog: { generate } as unknown as Agent }).posthog_agent;
  const warningsBefore = vi.mocked(logger.warn).mock.calls.length;
  await expect(executionStorage.run(scope, () => tool.execute!(input, { observe: noopObserve }))).rejects.toMatchObject({ reason: "cancelled" });
  await scope.drain();
  expect(vi.mocked(logger.warn).mock.calls).toHaveLength(warningsBefore);
  expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("PRIVATE_CANCEL");
});
