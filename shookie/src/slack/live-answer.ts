import type { App } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import { scopedSlackClient, slackDelivery } from "../cancellation/slack-transport.js";
import type { ShookieBlock } from "../types/block.js";

export const PREVIEW_MARKER = "shookie_response_preview";
const COMMITTED_MARKER = "shookie_response_committed";
const LIMIT = 24_000;
const MAX_CALLS = 60;
const SAFE_REJECTIONS = new Set(["unknown_method", "method_not_supported", "not_allowed_token_type", "missing_scope"]);
const marker = (event_type: string) => ({ event_type, event_payload: {} });
function confirmed(res: { ok?: boolean; warning?: string; response_metadata?: { warnings?: string[] } }) {
  return res.ok && !res.warning && !res.response_metadata?.warnings?.length;
}

/** One mutable, explicitly provisional message. No model-consumption await on Slack.
 * One request in flight + one latest snapshot; no unbounded delta queue or replay.
 */
export class LiveAnswer {
  private phase: "preview" | "sealed" | "finalizing" | "committed" = "preview";
  private ts?: string;
  private attempted = false;
  private fallbackSafe = false;
  private failed = false;
  private text = "";
  private pending?: string;
  private flight?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private calls = 0;
  private lastSent = 0;
  private limited = false;
  markLimited() { this.limited = true; }
  constructor(private app: App, private input: { channel: string; threadTs: string }, private signal: AbortSignal) {}

  event(value: { type: string; from: string; runId: string; payload?: unknown }, rootRunId: string) {
    if (this.phase !== "preview" || this.signal.aborted || this.failed || value.from !== "AGENT" || value.runId !== rootRunId) return;
    if (value.type === "step-start") { this.text = ""; return; }
    if (value.type !== "text-delta") return;
    const delta = (value.payload as { text?: unknown })?.text;
    if (typeof delta !== "string" || !delta) return;
    if (this.text.length + delta.length > LIMIT) { this.failed = true; this.pending = undefined; return; }
    this.text += delta;
    // Do not split a trailing high surrogate across Slack requests.
    const snapshot = this.text.replace(/[\uD800-\uDBFF]$/, "");
    if (!snapshot) return;
    this.pending = snapshot;
    this.pump();
  }

  private pump() {
    if (this.flight || this.timer || !this.pending || this.failed || this.signal.aborted || this.phase !== "preview") return;
    const wait = this.attempted ? Math.max(0, 1500 - (Date.now() - this.lastSent)) : 0;
    if (wait) { this.timer = setTimeout(() => { this.timer = undefined; this.pump(); }, wait); return; }
    if (this.calls >= MAX_CALLS) { this.failed = true; this.pending = undefined; return; }
    const text = `생성 중 · 미확정 답변\n\n${this.pending}`;
    this.pending = undefined;
    this.attempted = true;
    this.calls++;
    this.lastSent = Date.now();
    this.flight = (async () => {
      try {
        this.signal.throwIfAborted();
        const client = scopedSlackClient(this.app, this.signal);
        const res = this.ts
          ? await client.chat.update({ channel: this.input.channel, ts: this.ts, text, blocks: [], metadata: marker(PREVIEW_MARKER) })
          : await client.chat.postMessage({ channel: this.input.channel, thread_ts: this.input.threadTs, text, metadata: marker(PREVIEW_MARKER) });
        if (!res.ok && !this.ts && SAFE_REJECTIONS.has(res.error ?? "")) this.fallbackSafe = true;
        // Retain a known identity even when metadata warnings make visibility unsafe.
        if (res.ok && res.ts) this.ts = res.ts;
        if (!confirmed(res) || !this.ts) throw new Error("Preview delivery unconfirmed");
      } catch (error) {
        const e = error as { code?: string; data?: { error?: string } };
        if (!this.ts && e.code === "slack_webapi_platform_error" && SAFE_REJECTIONS.has(e.data?.error ?? "")) this.fallbackSafe = true;
        this.failed = true;
        this.pending = undefined;
      }
    })().finally(() => { this.flight = undefined; this.pump(); });
  }

  async seal() {
    if (this.phase === "preview") this.phase = "sealed";
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
    await this.flight; // Actual mutation settlement, not a race; prevents late overwrite.
  }

  async finalize(text: string, blocks: ShookieBlock[]): Promise<boolean> {
    await this.seal();
    if (!this.attempted || this.fallbackSafe) return false;
    if (this.failed || !this.ts) throw new Error("Preview transport incomplete");
    this.phase = "finalizing"; // ACK loss must never allow error cleanup to overwrite a committed answer.
    await slackDelivery(this.app, async client => {
      const res = await client.chat.update({ channel: this.input.channel, ts: this.ts!, text, blocks: blocks as KnownBlock[], metadata: marker(COMMITTED_MARKER) });
      if (!confirmed(res)) throw new Error("Final update unconfirmed");
    });
    this.phase = "committed";
    return true;
  }

  async cleanup() {
    await this.seal();
    if (!this.ts || this.phase === "finalizing" || this.phase === "committed") return;
    try {
      await slackDelivery(this.app, client => client.chat.update({ channel: this.input.channel, ts: this.ts!, text: this.limited ? "생성 한도에 도달해 중단된 미완성 답변입니다. 확정된 답변이 아니므로 사용하지 마세요." : "미완료 답변입니다. 확정된 답변이 아니므로 사용하지 마세요.", blocks: [], metadata: marker(PREVIEW_MARKER) }));
    } catch { /* Known message only, bounded independent cleanup. Never replay. */ }
  }
}
