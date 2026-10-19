import { expect, it, vi } from "vitest";
import { Agent } from "@mastra/core/agent";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { App } from "@slack/bolt";
import { completion, response } from "../agent/deepseek-transport.test-helper.js";
import { LiveAnswer } from "./live-answer.js";
import { canonicalAnswer } from "./canonical-answer.js";

it.each([1, 3])("pinned real DeepSeek→Mastra separates root public payload.text with %i tool steps from reasoning and private direct tool results", async toolSteps => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const root = new Agent({ id: "root", name: "root", instructions: "synthetic", model: createDeepSeek({ apiKey: "synthetic", fetch: async () => {
    if (++calls <= toolSteps) {
      const body = completion("", "lookup");
      if (calls === 1) body.choices[0].message.content = "public before tool";
      return response(body, true);
    }
    await gate;
    return response(completion("public final"), true);
  } })("deepseek-flash"), tools: { lookup: createTool({ id: "lookup", description: "synthetic", inputSchema: z.object({}), execute: async () => ({ internal: "DIRECT_TOOL_PRIVATE" }) }) } });
  const postMessage = vi.fn(async () => ({ ok: true, ts: "known" }));
  const update = vi.fn(async () => ({ ok: true, ts: "known" }));
  const live = new LiveAnswer({ client: { chat: { postMessage, update } } } as unknown as App, { channel: "C1", threadTs: "1.0" }, new AbortController().signal);
  const result = await root.stream("synthetic", { runId: "root-run", maxSteps: 5 });
  const events: any[] = [];
  const consume = (async () => { for await (const event of result.fullStream) { events.push(event); live.event(event, "root-run"); } })();
  await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
  expect(calls).toBeLessThanOrEqual(toolSteps + 1);
  expect(events.find(e => e.type === "text-delta")).toMatchObject({ runId: "root-run", from: "AGENT", payload: { text: "public before tool" } });
  release(); await consume;
  expect(await result.text).toBe("public before toolpublic final");
  const final = canonicalAnswer(await result.steps, await result.finishReason);
  expect(final).toBe("public final");
  await live.finalize(final, []);
  expect(events.some(e => e.type === "reasoning-delta")).toBe(true);
  expect(events.filter(e => e.type === "text-delta").every(e => e.runId === "root-run")).toBe(true);
  expect(events.some(e => e.type === "tool-result" && JSON.stringify(e).includes("DIRECT_TOOL_PRIVATE"))).toBe(true);
  expect(JSON.stringify([postMessage.mock.calls, update.mock.calls])).not.toMatch(/DIRECT_TOOL_PRIVATE|synthetic-reasoning/);
});

it.each(["empty", "tool+text", "length"])("real provider last %s is never promoted from aggregate text/reasoning", async kind => {
  const body = kind === "tool+text" ? completion("", "lookup") : completion(kind === "empty" ? "  " : "partial");
  if (kind === "tool+text") body.choices[0].message.content = "public before tool";
  if (kind === "length") body.choices[0].finish_reason = "length";
  const agent = new Agent({ id: "root", name: "root", instructions: "synthetic", model: createDeepSeek({ apiKey: "synthetic", fetch: async () => response(body, true) })("deepseek-flash"),
    tools: { lookup: createTool({ id: "lookup", description: "synthetic", inputSchema: z.object({}), execute: async () => ({ internal: "PRIVATE" }) }) } });
  const result = await agent.stream("synthetic", { runId: "root", maxSteps: 1 });
  for await (const _ of result.fullStream) { /* consume real adapter */ }
  const steps = await result.steps; const finish = await result.finishReason;
  expect(() => canonicalAnswer(steps, finish)).toThrow("no completed answer");
});
