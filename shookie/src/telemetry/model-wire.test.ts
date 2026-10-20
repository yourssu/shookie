import { expect, it } from "vitest";
import { Agent } from "@mastra/core/agent";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { completion, response } from "../agent/deepseek-transport.test-helper.js";
import { RequestMetrics, type MetricRecord } from "./metrics.js";

it("missing wire usage is unknown, never provider/aggregate defaults", async () => {
  const records: MetricRecord[] = []; const m = new RequestMetrics(0, () => 1, r => records.push(r));
  const agent = new Agent({ id: "missing", name: "missing", instructions: "synthetic", model: createDeepSeek({ apiKey: "synthetic", fetch: async () => {
    const body = completion("answer"); body.usage = undefined as any; return response(body, true);
  } })("deepseek-flash") });
  const output = await agent.stream("private", { onStepFinish: step => { m.model(0, step.usage); } });
  for await (const _ of output.fullStream) { /* consume real adapter */ }
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null });
});

it("completed model step remains observable when a later model call fails", async () => {
  const records: MetricRecord[] = []; const m = new RequestMetrics(0, () => 1, r => records.push(r)); let calls = 0; let index = 0;
  const agent = new Agent({ id: "partial", name: "partial", instructions: "synthetic", model: createDeepSeek({ apiKey: "synthetic", fetch: async () => {
    if (++calls === 1) return response(completion("", "lookup"), true);
    return Response.json({ error: { message: "synthetic unavailable", type: "invalid_request_error" } }, { status: 400 });
  } })("deepseek-flash"), tools: { lookup: createTool({ id: "lookup", description: "synthetic", inputSchema: z.object({}), execute: async () => "private" }) } });
  const output = await agent.stream("private", { maxSteps: 3, onStepFinish: step => { m.model(index++, step.usage); } });
  try { for await (const _ of output.fullStream) { /* stream errors may be chunks or rejection */ } } catch { /* expected failed subsequent call */ }
  expect(records[0]).toMatchObject({ kind: "model_call", step: 0, inputTokens: 1, outputTokens: 1 });
  expect(calls).toBe(2); expect(records.filter(r => r.inputTokens !== null)).toHaveLength(1);
});

it.each([false, true])("pinned provider wire -> Mastra step usage, optional cache/reasoning present=%s; aggregate never double counted", async available => {
  let calls = 0;
  const model = createDeepSeek({ apiKey: "synthetic", fetch: async () => {
    const body = ++calls === 1 ? completion("", "lookup") : completion("public final");
    body.usage = { prompt_tokens: calls * 10, completion_tokens: calls * 4, total_tokens: calls * 14,
      ...(available ? { prompt_cache_hit_tokens: calls * 3, completion_tokens_details: { reasoning_tokens: calls } } : {}) } as any;
    return response(body, true);
  } })("deepseek-flash");
  const agent = new Agent({ id: "synthetic", name: "synthetic", instructions: "synthetic", model,
    tools: { lookup: createTool({ id: "lookup", description: "synthetic", inputSchema: z.object({}), execute: async () => "PRIVATE_TOOL_RESULT" }) } });
  const records: MetricRecord[] = []; const m = new RequestMetrics(0, () => 1, r => records.push(r));
  let index = 0;
  const output = await agent.stream("PRIVATE_USER_TEXT", { maxSteps: 3, onStepFinish: step => { m.model(index++, step.usage); } });
  for await (const _ of output.fullStream) { /* real pinned wire adapter */ }
  const steps = await output.steps;
  expect(steps).toHaveLength(2);
  expect(index).toBe(steps.length);
  expect(records.map(r => r.inputTokens)).toEqual([10, 20]);
  expect(records.map(r => r.outputTokens)).toEqual([4, 8]);
  expect(records.map(r => r.cachedInputTokens)).toEqual(available ? [3, 6] : [null, null]);
  expect(records.map(r => r.reasoningTokens)).toEqual(available ? [1, 2] : [null, null]);
  // Existing DB-facing aggregate remains unchanged; metrics contain only step calls.
  expect(await output.usage).toMatchObject({ inputTokens: 30, outputTokens: 12 });
  expect(records).toHaveLength(calls);
  expect(JSON.stringify(records)).not.toMatch(/PRIVATE|prompt_tokens|raw|apiKey/);
});
