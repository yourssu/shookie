import { createHash, randomUUID } from "node:crypto";
import type { WebClient } from "@slack/web-api";
import { getSlackSearchActionToken, type SlackReadIdentity } from "./context.js";
import { authorizeCurrentSlackChannel, requireSlackReadIdentity } from "./authorization.js";
import { check, deny, invalid, unavailable, errorResult, readLimits as limits } from "./errors.js";
import { channelInput, threadInput, slackTs, type ReadResult } from "./schemas.js";
import { SlackSearcher } from "./search.js";
import { jsonTextPrefix } from "./projection.js";
import { logSlackReadDiagnostic, type ReadDiagnosticReason } from "./read-diagnostics.js";

export type SlackReadClient = Pick<WebClient, "auth" | "conversations"> & Partial<Pick<WebClient, "apiCall">>;
function timestamp(ts: string) { return BigInt(ts.replace(".", "")); }
type Target = { channel: string; threadTs?: string; host?: string };
type Continuation = { binding: string; slackCursor: string; page: number;
  rootReplyCount?: number; lossy: boolean; seen: string[]; fingerprints: Record<string, string>;
  expires: number; usedCursors: string[] };

/** Read-only, current-event-channel-only. No user token, global search, auto-join or history scan fallback. */
export class SlackReader {
  private readonly cursors = new Map<string, Continuation>();
  private readonly inFlightCursors = new Set<string>();
  private readonly searcher: SlackSearcher;
  constructor(private readonly client: SlackReadClient) { this.searcher = new SlackSearcher(client); }

  private target(input: { channel?: string; ts?: string; url?: string }, identity: SlackReadIdentity, thread: boolean): Target {
    let channel = input.channel ?? identity.channel, threadTs = input.ts, host: string | undefined;
    if (input.url) {
      let url: URL;
      try { url = new URL(input.url); } catch { return invalid(); }
      const match = /^\/archives\/([CGD][A-Z0-9]{1,63})\/p([0-9]{7,22})$/.exec(url.pathname);
      if (url.href !== input.url || url.protocol !== "https:" || url.username || url.password || url.port || url.hash ||
          !/^[a-z0-9-]+\.slack\.com$/.test(url.hostname) || !match) invalid();
      if ([...url.searchParams.keys()].some(k => !["thread_ts", "cid"].includes(k)) ||
          url.searchParams.getAll("thread_ts").length > 1 || url.searchParams.getAll("cid").length > 1) invalid();
      const ts = `${match[2].slice(0, -6)}.${match[2].slice(-6)}`;
      const parent = url.searchParams.get("thread_ts") ?? ts;
      if (!slackTs.safeParse(ts).success || !slackTs.safeParse(parent).success ||
          (url.searchParams.has("cid") && url.searchParams.get("cid") !== match[1]) ||
          (input.channel && input.channel !== match[1]) || (input.ts && input.ts !== parent)) invalid();
      channel = match[1]; threadTs = parent; host = url.hostname;
    }
    if (channel !== identity.channel) deny();
    if (thread && !threadTs) invalid();
    return { channel, ...(thread ? { threadTs } : {}), ...(host ? { host } : {}) };
  }
  async search(input: unknown, context?: object): Promise<ReadResult> { return this.searcher.search(input, context); }
  async read(kind: "thread" | "channel", input: unknown, context?: object): Promise<ReadResult> {
    let lockedCursor: string | undefined;
    let pendingFailure: ReadDiagnosticReason = "identity_failed", diagnosed = false;
    const reject: (reason: ReadDiagnosticReason) => never = reason => {
      logSlackReadDiagnostic(context, kind, reason); diagnosed = true; return unavailable();
    };
    try {
      const identity = requireSlackReadIdentity(context);
      pendingFailure = "input_failed";
      const parsed = (kind === "thread" ? threadInput : channelInput).safeParse(input);
      if (!parsed.success) invalid();
      pendingFailure = "target_failed";
      const target = this.target(parsed.data, identity, kind === "thread");
      pendingFailure = "cursor_invalid";
      const binding = JSON.stringify([identity.teamId, identity.userId, identity.channel, identity.requestId, kind, target.channel, target.threadTs ?? null]);
      for (const [key, state] of this.cursors) if (state.expires < Date.now()) this.cursors.delete(key);
      const previous = parsed.data.cursor ? this.cursors.get(parsed.data.cursor) : undefined;
      if (parsed.data.cursor && (!previous || previous.binding !== binding || previous.page >= limits.maxPages || this.inFlightCursors.has(parsed.data.cursor))) invalid();
      if (parsed.data.cursor) {
        lockedCursor = parsed.data.cursor;
        this.inFlightCursors.add(lockedCursor);
      }
      pendingFailure = "authorization_failed";
      await authorizeCurrentSlackChannel(this.client, context, { channelId: target.channel, workspaceHost: target.host });
      const cursor = previous?.slackCursor;
      // Observed replies pages include the parent in addition to requested replies.
      // Reserve its slot on every page; the published response bound stays unchanged.
      const args = { channel: target.channel, limit: kind === "thread" ? limits.pageSize - 1 : limits.pageSize, ...(cursor ? { cursor } : {}) };
      pendingFailure = "api_call_failed";
      const response = kind === "thread"
        ? await this.client.conversations.replies({ ...args, ts: target.threadTs! })
        : await this.client.conversations.history(args);
      pendingFailure = "check_failed";
      check(response);
      pendingFailure = "response_exception";
      // Split the existing OR chain without changing short-circuit order or property access counts.
      if ((response as { warning?: string }).warning) reject("response_warning");
      if (response.response_metadata?.warnings?.length) reject("metadata_warning");
      if (!Array.isArray(response.messages)) reject("messages_shape_invalid");
      if (response.messages.length > limits.pageSize) reject("result_limit_exceeded");
      const messages: ReadResult["messages"] = [];
      const seen = new Set(previous?.seen ?? []);
      const fingerprints = { ...(previous?.fingerprints ?? {}) };
      let budget = limits.maxPageBytes, lossy = previous?.lossy ?? false;
      let rootReplyCount = previous?.rootReplyCount;
      pendingFailure = "message_exception";
      for (const [index, raw] of response.messages.entries()) {
        pendingFailure = "message_exception";
        const m = raw as typeof raw & { channel?: string; team?: string; subtype?: string };
        if (!slackTs.safeParse(m.ts).success) reject("message_ts_invalid");
        if (typeof m.text !== "string") reject("message_text_invalid");
        if (m.channel !== undefined && m.channel !== target.channel) reject("message_channel_mismatch");
        if (m.team !== undefined && m.team !== identity.teamId) reject("message_team_mismatch");
        if (m.thread_ts !== undefined && !slackTs.safeParse(m.thread_ts).success) reject("message_thread_ts_invalid");
        if (m.user !== undefined && !/^[UW][A-Z0-9]{1,63}$/.test(m.user)) reject("message_user_invalid");
        if (m.bot_id !== undefined && !/^B[A-Z0-9]{1,63}$/.test(m.bot_id)) reject("message_bot_id_invalid");
        pendingFailure = "thread_exception";
        if (kind === "thread") {
          if (m.ts !== target.threadTs && m.thread_ts !== target.threadTs) reject("thread_parent_mismatch");
          if (m.thread_ts && m.thread_ts !== target.threadTs) reject("thread_relation_mismatch");
          if (timestamp(m.ts!) < timestamp(target.threadTs!)) reject("thread_time_invalid");
        }
        pendingFailure = "root_reply_count_exception";
        if (kind === "thread" && m.ts === target.threadTs) {
          if (m.reply_count !== undefined && (!Number.isSafeInteger(m.reply_count) || m.reply_count < 0)) reject("root_reply_count_invalid");
          // A plain, unthreaded message can omit reply_count. Infer zero only for a single terminal first page.
          const count = m.reply_count ?? (!previous && !m.thread_ts && response.messages.length === 1 &&
            !response.has_more && !response.response_metadata?.next_cursor?.trim() ? 0 : undefined);
          if (rootReplyCount !== undefined && count !== undefined && rootReplyCount !== count) lossy = true;
          rootReplyCount = count ?? rootReplyCount;
        }
        pendingFailure = "fingerprint_exception";
        const fingerprint = createHash("sha256").update(JSON.stringify([m.ts, m.thread_ts, m.text, m.user, m.bot_id])).digest("hex");
        if (seen.has(m.ts!)) {
          if (fingerprints[m.ts!] !== fingerprint) reject("fingerprint_conflict");
          continue;
        }
        fingerprints[m.ts!] = fingerprint;
        seen.add(m.ts!);
        pendingFailure = "projection_exception";
        const actionToken = getSlackSearchActionToken(context);
        const safeText = actionToken ? m.text.split(actionToken).join("[SLACK_ACTION_TOKEN_REDACTED]") : m.text;
        const text = jsonTextPrefix(safeText, Math.min(8_000, Math.max(0, budget - 512 * (response.messages.length - index))));
        const textTruncated = text !== m.text;
        const message: ReadResult["messages"][number] = { channel: target.channel, ts: m.ts!,
          ...(m.thread_ts ? { threadTs: m.thread_ts } : {}),
          author: { userId: m.user ?? null, botId: m.bot_id ?? null, kind: m.bot_id || m.subtype === "bot_message" ? "bot" : m.user ? "participant" : "system" },
          text, textTruncated, ...(Number.isSafeInteger(m.reply_count) && m.reply_count! >= 0 ? { replyCount: m.reply_count } : {}),
        };
        budget -= Buffer.byteLength(JSON.stringify(message));
        if (budget < 0) reject("budget_exceeded");
        messages.push(message); lossy ||= textTruncated;
      }
      pendingFailure = "continuation_exception";
      if (kind === "thread" && !seen.has(target.threadTs!)) reject("root_missing");
      messages.sort((a, b) => timestamp(a.ts) < timestamp(b.ts) ? -1 : timestamp(a.ts) > timestamp(b.ts) ? 1 : 0);
      const next = response.response_metadata?.next_cursor?.trim();
      const hasMore = !!next || !!response.has_more;
      const page = (previous?.page ?? 0) + 1;
      let nextCursor: string | null = null;
      if (next && (next === cursor || previous?.usedCursors.includes(next))) reject("cursor_replay");
      if (next && page < limits.maxPages) {
        if (this.cursors.size >= 1000) this.cursors.delete(this.cursors.keys().next().value!);
        nextCursor = randomUUID();
        this.cursors.set(nextCursor, { binding, slackCursor: next, page,
          rootReplyCount, lossy, seen: [...seen], fingerprints, expires: Date.now() + 10 * 60_000,
          usedCursors: [...(previous?.usedCursors ?? []), next] });
      }
      if (parsed.data.cursor) this.cursors.delete(parsed.data.cursor);
      const complete = !hasMore && !lossy && (kind !== "thread" || seen.size === rootReplyCount! + 1);
      return { status: "ok", message: complete ? "조회 범위를 모두 읽었습니다." : "부분 조회입니다. 다음 페이지·메시지 잘림·누락 가능성을 확인해주세요.",
        source: { channel: target.channel, ...(target.threadTs ? { threadTs: target.threadTs } : {}) },
        messages, page, nextCursor, complete, truncated: !complete, limits };
    } catch (error) {
      if (!diagnosed) logSlackReadDiagnostic(context, kind, pendingFailure);
      return errorResult(error);
    }
    finally { if (lockedCursor) this.inFlightCursors.delete(lockedCursor); }
  }
}
