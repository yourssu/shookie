import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setImmediate as nodeImmediate } from "node:timers";
import { logger } from "../logger.js";
import { resultSize } from "./result-size.js";

type RecordValue = string | number | boolean | null;
export type MetricRecord = Readonly<Record<string, RecordValue>>;
export type MetricSink = (record: MetricRecord) => void;
// Bounded, detached logging: no await, no raw payload references retained. Drop on overload.
const schedule = nodeImmediate;
const queue: MetricRecord[] = [];
let scheduled = false;
const flush = () => {
  const record = queue.shift();
  try { if (record) logger.info("observability", record); } catch { /* telemetry is best effort */ }
  if (queue.length) schedule(flush).unref(); else scheduled = false;
};
const enqueue: MetricSink = record => {
  if (queue.length >= 256) return;
  queue.push(record);
  if (!scheduled) { scheduled = true; schedule(flush).unref(); }
};
const TOOLS = new Set(["github_read", "repo_clone", "repo_list_files", "repo_read_file", "repo_search", "web_fetch", "web_search", "web_read_more", "web_find_in_content", "slack_search", "slack_read_thread", "slack_read_channel", "slack_read_attachment", "slack_analyze_image", "listProjects", "queryEvents", "queryInsights", "listFeatureFlags", "listDashboards", "getDashboard", "queryHogQL", "listPersons", "listCohorts", "listExperiments", "load_domain_guidance"]);
export type PhaseStatus = "not_started" | "running" | "success" | "error" | "cancelled" | "limited" | "uncertain";
export class RequestMetrics {
  readonly correlationId = randomUUID();
  generation: PhaseStatus = "not_started";
  save: PhaseStatus = "not_started";
  delivery: PhaseStatus = "not_started";
  stop: "none" | "cancelled" | "timeout" = "none";
  private generationStart?: number;
  private generationMs: number | null = null;
  private deliveryStart?: number;
  private deliveryMs: number | null = null;
  private confirmedDeliveryTotalMs: number | null = null;
  private visibleMs: number | null = null;
  private deltaMs: number | null = null;
  private terminal = false;
  constructor(private readonly start = performance.now(), private readonly now = () => performance.now(), private readonly sink: MetricSink = enqueue) {}
  private elapsed(start = this.start) { return Math.max(0, this.now() - start); }
  private emit(record: MetricRecord) {
    try {
      const pending: unknown = this.sink({ ...record, correlationId: this.correlationId });
      if (pending instanceof Promise) void pending.catch(() => {});
    } catch { /* never fail execution */ }
  }
  firstDelta() { if (this.deltaMs === null) this.deltaMs = this.elapsed(); }
  confirmedText() { if (this.visibleMs === null) this.visibleMs = this.elapsed(); }
  startGeneration() { this.generation = "running"; this.generationStart = this.now(); }
  endGeneration(status: PhaseStatus) { this.generation = status; if (this.generationStart !== undefined && this.generationMs === null) this.generationMs = this.elapsed(this.generationStart); }
  startDelivery() { this.delivery = "running"; this.deliveryStart = this.now(); }
  endDelivery(confirmed: boolean) { this.delivery = confirmed ? "success" : "uncertain"; this.deliveryMs = this.deliveryStart === undefined ? null : this.elapsed(this.deliveryStart); if (confirmed) { this.confirmedDeliveryTotalMs = this.elapsed(); this.confirmedText(); } }
  tool(name: string, start: number, status: "success" | "error" | "cancelled", value?: unknown) {
    try {
      this.emit({ kind: "tool", tool: TOOLS.has(name) ? name : "other", elapsedMs: this.elapsed(start), status, ...resultSize(value) });
    } catch { /* hostile results and instrumentation cannot change tool behavior */ }
  }
  model(step: number, usage: { inputTokens?: number; outputTokens?: number; raw?: unknown } | undefined) {
    try {
      // Pinned DeepSeek v3 → Mastra normalization preserves provider usage at raw.raw.
      // Cache/reasoning normalized zeros may be SDK defaults: use actual wire presence only.
      let raw: any = usage?.raw;
      for (let i = 0; i < 3 && raw?.raw && typeof raw.raw === "object"; i++) raw = raw.raw;
      const number = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
      this.emit({ kind: "model_call", model: "main", status: "completed", step, inputTokens: number(raw ? raw.prompt_tokens ?? raw.inputTokens : usage?.inputTokens), outputTokens: number(raw ? raw.completion_tokens ?? raw.outputTokens : usage?.outputTokens), cachedInputTokens: number(raw?.prompt_cache_hit_tokens ?? raw?.prompt_tokens_details?.cached_tokens), reasoningTokens: number(raw?.completion_tokens_details?.reasoning_tokens) });
    } catch { /* no raw usage logged */ }
  }
  finish() {
    if (this.terminal) return;
    this.terminal = true;
    if (this.generation === "running") this.endGeneration(this.stop === "none" ? "error" : "cancelled");
    this.emit({ kind: "request", requestStatus: this.save === "success" ? this.delivery === "success" ? "success" : "saved_delivery_uncertain" : this.stop !== "none" ? "stopped" : "error", generationStatus: this.generation, saveStatus: this.save, deliveryStatus: this.delivery, stopStatus: this.stop, firstConfirmedTextMs: this.visibleMs, firstModelDeltaMs: this.deltaMs, generationMs: this.generationMs, finalDeliveryMs: this.deliveryMs, finalConfirmedDeliveryTotalMs: this.confirmedDeliveryTotalMs, totalMs: this.elapsed() });
  }
}
export const monotonicNow = () => performance.now();
export function createRequestMetrics(start: number): RequestMetrics | undefined {
  try { return new RequestMetrics(start); } catch { return undefined; }
}
