import type { WebClient } from "@slack/web-api";
import type { KnownBlock } from "@slack/types";
import type { ShookieBlock } from "../types/block.js";

// Slack stopStream blocks are appended BELOW streamed markdown, not a replacement.
// https://docs.slack.dev/reference/methods/chat.stopStream/
// Stream the final body once and attach feedback only. Never stream model intermediates.
const CHUNK_CHARS = 12_000;
const MAX_CHUNKS = 2;
const SAFE_START_REJECTIONS = new Set(["unknown_method", "method_not_supported", "not_allowed_token_type", "missing_scope"]);
function rejection(error: unknown): string | undefined {
  const e = error as { code?: string; data?: { error?: string } };
  return e?.code === "slack_webapi_platform_error" ? e.data?.error : undefined;
}
export async function deliverFinalAnswer(client: WebClient, input: {
  channel: string; threadTs: string; teamId?: string; userId: string;
  markdown: string; fallbackText: string; blocks: ShookieBlock[];
}, signal: AbortSignal, onConfirmedText: () => void = () => {}): Promise<void> {
  const { channel, threadTs, teamId, userId, markdown, fallbackText, blocks } = input;
  const observed = () => { try { onConfirmedText(); } catch { /* telemetry cannot change delivery or trigger replay */ } };
  const post = async () => {
    signal.throwIfAborted();
    const res = await client.chat.postMessage({ channel, thread_ts: threadTs, text: fallbackText, blocks: blocks as KnownBlock[] });
    if (!res.ok || !res.ts) throw new Error("Final delivery not confirmed");
    if (fallbackText.length) observed();
  };
  // Keep long output and unsupported recipient contexts on the existing bounded renderer.
  if (!teamId || markdown.length > CHUNK_CHARS * MAX_CHUNKS) return post();
  // Split by code point, avoiding broken surrogate pairs at the transport boundary.
  const points = Array.from(markdown);
  const chunks = [points.slice(0, CHUNK_CHARS).join(""), points.slice(CHUNK_CHARS).join("")].filter(Boolean);
  let ts: string | undefined;
  signal.throwIfAborted();
  try {
    const res = await client.apiCall("chat.startStream", {
      channel, thread_ts: threadTs, recipient_team_id: teamId, recipient_user_id: userId,
      markdown_text: chunks[0],
    }) as { ok: boolean; ts?: string; error?: string };
    if (!res.ok) {
      if (SAFE_START_REJECTIONS.has(res.error ?? "")) return post();
      throw new Error("Stream start not confirmed");
    }
    ts = res.ts;
    if (!ts) throw new Error("Stream identity missing");
    if (chunks[0]?.length) observed();
  } catch (error) {
    if (SAFE_START_REJECTIONS.has(rejection(error) ?? "")) return post();
    throw error; // Ambiguous creation must never trigger a second message.
  }
  try {
    signal.throwIfAborted();
    if (chunks[1]) {
      const res = await client.apiCall("chat.appendStream", { channel, ts, markdown_text: chunks[1] });
      if (!res.ok) throw new Error("Stream append not confirmed");
    }
    signal.throwIfAborted();
    const feedback = blocks.filter(block => block.type === "context_actions");
    const res = await client.apiCall("chat.stopStream", { channel, ts, blocks: feedback });
    if (!res.ok) throw new Error("Stream finalization not confirmed");
  } catch (error) {
    // Known session only: best effort stop, no text replay and no duplicate final body.
    if (!signal.aborted) {
      try { await client.apiCall("chat.stopStream", { channel, ts }); } catch { /* no replay */ }
    }
    throw error;
  }
}
