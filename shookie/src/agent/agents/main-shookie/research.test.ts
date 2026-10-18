import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
vi.mock("database", () => ({ startInvocation: vi.fn(), completeInvocation: vi.fn(), logToolCall: vi.fn() }));
vi.mock("../../../logger.js", () => ({ logger: { debug: vi.fn() } }));
import { createMainShookieTools } from "./tools.js";
const input = { task: "deep investigation", context: "selected project and interval", outputScope: "evidence and limitations only" };
describe("optional specialist structured outcomes", () => {
  it.each([
    ["stop", "answer", [], "success"], ["length", "partial", [], "partial"],
    ["error", "", [], "error"], ["stop", "partial", [{ toolResults: [{ payload: { toolName: "queryEvents", result: { status: "error" } } }] }], "partial"],
    ["stop", "partial", [{ toolResults: [{ payload: { toolName: "queryEvents", result: { error: true } } }] }], "partial"],
  ])("maps finish=%s and failed evidence to %s", async (finishReason, text, steps, status) => {
    const generate = vi.fn(async () => ({ text, steps, finishReason, usage: {} }));
    const tools = createMainShookieTools({ posthog: { generate } as unknown as Agent });
    const requestContext = new RequestContext();
    const result = await tools.posthog_agent.execute!(input, { requestContext } as never);
    expect(result).toMatchObject({ status, result: text, evidence: expect.any(Array), limitations: expect.any(Array) });
    expect(generate.mock.calls[0]).toEqual([[{role:"user",content:JSON.stringify(input)}], expect.objectContaining({ requestContext })]);
  });
  it("returns a structured sanitized failure, not unconditional success", async () => {
    const generate = vi.fn(async () => { throw new Error("PRIVATE_UPSTREAM_SECRET"); });
    const tool = createMainShookieTools({ posthog: { generate } as unknown as Agent }).posthog_agent;
    const result = await tool.execute!(input, {} as never);
    expect(result).toMatchObject({ status: "error", evidence: [] });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_UPSTREAM_SECRET");
    expect(await tool.execute!({ task: "missing explicit scope" } as never, {} as never)).toMatchObject({ error: true });
  });
});
