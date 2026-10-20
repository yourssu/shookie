import { afterEach, expect, it, vi } from "vitest";
import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { LiveAnswer } from "./live-answer.js";
import { deliverFinalAnswer } from "./final-delivery.js";
import { RequestMetrics, type MetricRecord } from "../telemetry/metrics.js";

afterEach(() => vi.restoreAllMocks());
const input = { channel: "PRIVATE_CHANNEL", threadTs: "PRIVATE_TS", userId: "PRIVATE_USER", teamId: "PRIVATE_TEAM", markdown: "PRIVATE_BODY", fallbackText: "PRIVATE_BODY", blocks: [] };
const gate = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
it("gated preview ACK, not delta/control/send creation, sets first confirmed text; finish is distinct", async () => {
  let now = 0; const records: MetricRecord[] = []; const m = new RequestMetrics(0, () => now, r => records.push(r));
  const ack = gate<any>(); const postMessage = vi.fn(() => ack.promise);
  const update = vi.fn(async () => ({ ok: true, ts: "known" }));
  const live = new LiveAnswer({ client: { chat: { postMessage, update } } } as unknown as App, input, new AbortController().signal, undefined, () => m.confirmedText());
  now = 10; m.startGeneration(); now = 20; m.firstDelta();
  live.event({ type: "text-delta", from: "AGENT", runId: "root", payload: { text: "PRIVATE_BODY" } }, "root");
  expect(postMessage).toHaveBeenCalledOnce(); now = 70; ack.resolve({ ok: true, ts: "known" }); await live.seal();
  now = 100; m.endGeneration("success"); m.save = "success"; m.startDelivery(); await live.finalize("PRIVATE_BODY", []);
  now = 130; m.endDelivery(true); m.finish();
  expect(records[0]).toMatchObject({ firstModelDeltaMs: 20, firstConfirmedTextMs: 70, generationMs: 90, finalDeliveryMs: 30, totalMs: 130 });
  expect(JSON.stringify(records)).not.toContain("PRIVATE");
});
it.each([{}, { ok: false }, { ok: true }, { ok: true, ts: "known", warning: "metadata" }])("preview unconfirmed ACK %j does not count visible text", async response => {
  const hook = vi.fn(); const postMessage = vi.fn(async () => response);
  const live = new LiveAnswer({ client: { chat: { postMessage } } } as unknown as App, input, new AbortController().signal, undefined, hook);
  live.event({ type: "text-delta", from: "AGENT", runId: "root", payload: { text: "body" } }, "root");
  await live.seal(); expect(hook).not.toHaveBeenCalled();
});
it("throwing preview hook does not freeze valid preview or prevent finalization", async () => {
  const update = vi.fn(async () => ({ ok: true, ts: "known" }));
  const live = new LiveAnswer({ client: { chat: { postMessage: async () => ({ ok: true, ts: "known" }), update } } } as unknown as App, input, new AbortController().signal, undefined, () => { throw new Error("metrics"); });
  live.event({ type: "text-delta", from: "AGENT", runId: "root", payload: { text: "body" } }, "root");
  await live.seal(); expect(await live.finalize("final", [])).toBe(true); expect(update).toHaveBeenCalledOnce();
});
it("fallback first start ACK precedes finish; failed stop is uncertain without replay", async () => {
  let now = 0; const records: MetricRecord[] = []; const m = new RequestMetrics(0, () => now, r => records.push(r));
  const start = gate<any>(); const stop = gate<any>();
  const apiCall = vi.fn((method: string) => method === "chat.startStream" ? start.promise : stop.promise);
  const postMessage = vi.fn();
  m.startDelivery(); const delivery = deliverFinalAnswer({ apiCall, chat: { postMessage } } as unknown as WebClient, input, new AbortController().signal, () => m.confirmedText());
  now = 40; start.resolve({ ok: true, ts: "known" }); await vi.waitFor(() => expect(apiCall).toHaveBeenCalledTimes(2));
  now = 90; stop.resolve({ ok: false }); await expect(delivery).rejects.toThrow(); m.endDelivery(false); m.finish();
  expect(records[0]).toMatchObject({ firstConfirmedTextMs: 40, finalDeliveryMs: 90, deliveryStatus: "uncertain" }); expect(postMessage).not.toHaveBeenCalled();
});
it.each(["missing-ts", "false", "ack-loss"])("fallback %s never claims visibility or replays", async kind => {
  const hook = vi.fn(); const postMessage = vi.fn(); const apiCall = vi.fn(async () => { if (kind === "ack-loss") throw new Error("ACK lost"); return kind === "false" ? { ok: false } : { ok: true }; });
  await expect(deliverFinalAnswer({ apiCall, chat: { postMessage } } as unknown as WebClient, input, new AbortController().signal, hook)).rejects.toThrow();
  expect(hook).not.toHaveBeenCalled(); expect(postMessage).not.toHaveBeenCalled(); expect(apiCall).toHaveBeenCalledOnce();
});
it.each([true, false])("explicit unsupported fallback post confirmed=%s; throwing hook cannot replay", async ok => {
  const hook = vi.fn(() => { throw new Error("metrics"); }); const postMessage = vi.fn(async () => ({ ok, ts: "known" }));
  const apiCall = vi.fn(async () => ({ ok: false, error: "unknown_method" }));
  const work = deliverFinalAnswer({ apiCall, chat: { postMessage } } as unknown as WebClient, input, new AbortController().signal, hook);
  if (ok) await expect(work).resolves.toBeUndefined(); else await expect(work).rejects.toThrow();
  expect(hook).toHaveBeenCalledTimes(ok ? 1 : 0); expect(postMessage).toHaveBeenCalledOnce(); expect(apiCall).toHaveBeenCalledOnce();
});
