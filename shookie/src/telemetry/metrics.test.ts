import { describe, it, expect, vi, afterEach } from "vitest";
import { RequestMetrics, type MetricRecord } from "./metrics.js";
import { resultSize } from "./result-size.js";
import { ExecutionScope, executionStorage, executionTools } from "../cancellation/execution-context.js";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { logger } from "../logger.js";

afterEach(() => vi.restoreAllMocks());
describe("bounded private result measurement", () => {
  it.each(["", "한😀\n\"\\", "\ud800", "\udfff", "\u0000\t", 123, null, true, NaN])("matches JSON UTF8 for primitive %s", value => {
    expect(resultSize(value)).toMatchObject({ totalResultBytes: Buffer.byteLength(JSON.stringify(value)), totalResultBytesStatus: "exact" });
  });
  it("caps huge unicode without serialization, and refuses objects, cycles, BigInt and proxy traps", () => {
    expect(resultSize("😀".repeat(1_000_000))).toMatchObject({ totalResultBytes: 65536, totalResultBytesStatus: "capped" });
    const value: any = { partial: true, truncated: false, secret: "NEVER_LOG", toJSON() { throw new Error("do not invoke"); } }; value.self = value;
    Object.defineProperty(value, "other", { get() { throw new Error("hostile getter"); } });
    expect(resultSize(value)).toMatchObject({ totalResultBytes: null, totalResultBytesStatus: "unknown", partial: true, truncated: false });
    Object.defineProperty(value, "partial", { get() { throw new Error("hostile flag"); } });
    expect(resultSize(value).partial).toBeNull();
    expect(resultSize(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("trap"); } })).totalResultBytes).toBeNull();
    expect(resultSize(1n).totalResultBytes).toBeNull();
    expect(resultSize(Array(1_000_000))).toMatchObject({ totalResultBytes: null, totalResultBytesStatus: "unknown" });
  });
  it("measures only independent fixed own string payload fields, never total object bytes", () => {
    const data = '{"private":"한😀"}';
    expect(resultSize({ data, text: "same", content: "same", status: "partial" })).toMatchObject({ totalResultBytes: null, totalResultBytesStatus: "unknown", dataJsonBytes: Buffer.byteLength(JSON.stringify(data)), dataJsonBytesStatus: "exact", textJsonBytes: 6, contentJsonBytes: 6, resultStatus: "partial" });
    const getter = vi.fn(() => { throw new Error("do not read"); });
    const value = Object.create({ data: "inherited" }, { text: { get: getter }, constructor: { get: getter }, toJSON: { get: getter } });
    expect(resultSize(value)).toMatchObject({ dataJsonBytes: null, textJsonBytes: null }); expect(getter).not.toHaveBeenCalled();
    const trap = vi.fn(() => { throw new Error("proxy"); });
    expect(resultSize(new Proxy({}, { get: trap, getOwnPropertyDescriptor: trap, ownKeys: trap }))).toMatchObject({ dataJsonBytes: null }); expect(trap).not.toHaveBeenCalled();
    expect(resultSize({ data: "😀".repeat(1_000_000) })).toMatchObject({ dataJsonBytes: 65536, dataJsonBytesStatus: "capped", totalResultBytes: null });
    expect(resultSize({ data: "a".repeat(65533) })).toMatchObject({ dataJsonBytes: 65535, dataJsonBytesStatus: "exact" });
    expect(resultSize({ data: "a".repeat(65534) })).toMatchObject({ dataJsonBytes: 65536, dataJsonBytesStatus: "capped" });
    expect(resultSize({ data: { text: "nested" } })).toMatchObject({ dataJsonBytes: null });
    expect(resultSize(Object.assign([], { data: "array" }))).toMatchObject({ dataJsonBytes: null });
  });
});
it("monotonic request stages distinguish public delta, confirmed text, generation, final delivery and terminal total", () => {
  let time = 100; const records: MetricRecord[] = [];
  const m = new RequestMetrics(time, () => time, r => records.push(r));
  time = 110; m.startGeneration(); time = 120; m.firstDelta();
  time = 150; m.confirmedText(); time = 180; m.endGeneration("success");
  m.save = "success"; time = 200; m.startDelivery(); time = 230; m.endDelivery(false);
  time = 250; m.finish(); m.finish();
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ generationStatus: "success", saveStatus: "success", deliveryStatus: "uncertain", firstModelDeltaMs: 20, firstConfirmedTextMs: 50, generationMs: 70, finalDeliveryMs: 30, totalMs: 150 });
});
it("missing usage and unacknowledged delivery stay unknown, cancellation gets one terminal record", () => {
  const records: MetricRecord[] = []; const m = new RequestMetrics(0, () => 10, r => records.push(r));
  m.model(0, undefined); m.startGeneration(); m.stop = "cancelled"; m.finish();
  expect(records[0]).toMatchObject({ inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningTokens: null });
  expect(records[1]).toMatchObject({ generationStatus: "cancelled", firstConfirmedTextMs: null, deliveryStatus: "not_started" });
});
it("throwing sinks never escape and default logger runs detached and tolerates failures", async () => {
  const m = new RequestMetrics(0, () => 10, () => { throw new Error("metrics down"); });
  expect(() => { m.tool("SECRET_NAME", 0, "success", "SECRET"); m.model(0, undefined); m.finish(); }).not.toThrow();
  new RequestMetrics(0, () => 10, async () => { throw new Error("async sink down"); }).finish();
  const log = vi.spyOn(logger, "info").mockImplementation(() => { throw new Error("logger down"); });
  new RequestMetrics().finish(); expect(log).not.toHaveBeenCalled();
  await new Promise(r => setImmediate(r)); expect(log).toHaveBeenCalledOnce();
});
it("tool wrapper preserves return/reject/context, drains async execution, does not double wrap, emits no payload", async () => {
  const records: MetricRecord[] = []; const scope = new ExecutionScope(); scope.metrics = new RequestMetrics(0, () => 10, r => records.push(r));
  const value = { partial: true, secret: "SECRET_PAYLOAD" }; const failure = new Error("SECRET_ERROR");
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const ctx = { requestContext: {} } as any;
  const execute = vi.fn(async (_input: any, context: any) => { expect(context.requestContext).toBe(ctx.requestContext); await gate; return value; });
  const tools = executionTools({ github_read: createTool({ id: "github_read", description: "x", inputSchema: z.object({}), execute }) });
  const wrapped = tools.github_read.execute; executionTools(tools); expect(tools.github_read.execute).toBe(wrapped);
  const work = executionStorage.run(scope, () => tools.github_read.execute!({}, ctx));
  let drained = false; const draining = scope.drain().then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false); release(); expect(await work).toBe(value); await draining;
  const bad = executionTools({ privateName: createTool({ id: "bad", description: "x", inputSchema: z.object({}), execute: async () => { throw failure; } }) });
  await expect(executionStorage.run(scope, () => bad.privateName.execute!({}, ctx))).rejects.toBe(failure);
  expect(records).toHaveLength(2); expect(records[0]).toMatchObject({ kind: "tool", tool: "github_read", status: "success", partial: true });
  expect(records[1]).toMatchObject({ tool: "other", status: "error" });
  expect(JSON.stringify(records)).not.toMatch(/SECRET|privateName|requestContext/);
  scope.control.finish();
});
it("cancelled tools are not relabeled success, metrics exceptions cannot change return or rejection, missing scope works", async () => {
  const scope = new ExecutionScope(); const records: MetricRecord[] = [];
  scope.metrics = new RequestMetrics(0, () => 1, r => records.push(r));
  const tools = executionTools({ github_read: createTool({ id: "x", description: "x", inputSchema: z.object({}), execute: async () => { scope.control.cancel(); return "late"; } }) });
  await expect(executionStorage.run(scope, () => tools.github_read.execute!({}, {} as any))).rejects.toThrow();
  expect(records[0]).toMatchObject({ status: "cancelled" }); scope.control.finish();
  const clean = executionTools({ github_read: createTool({ id: "x", description: "x", inputSchema: z.object({}), execute: async () => "same" }) });
  const healthy = new ExecutionScope(); healthy.metrics = new RequestMetrics(); vi.spyOn(healthy.metrics, "tool").mockImplementation(() => { throw new Error("telemetry"); });
  expect(await executionStorage.run(healthy, () => clean.github_read.execute!({}, {} as any))).toBe("same");
  expect(await clean.github_read.execute!({}, {} as any)).toBe("same"); healthy.control.finish();
});
