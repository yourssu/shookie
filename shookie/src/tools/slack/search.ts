import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { SlackReadClient } from "./client.js";
import { authorizeCurrentSlackChannel, requireSlackReadIdentity } from "./authorization.js";
import { getSlackSearchActionToken } from "./context.js";
import { logSlackTokenSearch } from "./action-token-diagnostics.js";
import { check, deny, errorResult, failure, invalid, unavailable } from "./errors.js";
import { searchInput, type ReadResult } from "./schemas.js";
import { jsonTextPrefix } from "./projection.js";

// Slack's official RTS examples use variable fractional precision; canonicalize only validated API timestamps.
const apiTs = z.string().regex(/^[0-9]{1,16}\.[0-9]{1,6}$/).transform(ts => `${ts.split(".")[0]}.${ts.split(".")[1].padEnd(6, "0")}`);
const userId = z.string().regex(/^[UW][A-Z0-9]{1,63}$/);
const scopeFields = { channel_id: z.string().optional(), team_id: z.string().optional(), channel: z.string().optional(), team: z.string().optional() };
const contextMessage = z.object({ ...scopeFields, ts: apiTs, text: z.string(), user_id: userId.optional(), user: userId.optional(),
  is_author_bot: z.boolean().optional(), bot_id: z.string().regex(/^B[A-Z0-9]{1,63}$/).optional(), thread_ts: apiTs.optional() }).passthrough();
const searchMessage = z.object({ ...scopeFields, channel_id: z.string(), team_id: z.string(), message_ts: apiTs,
  content: z.string(), author_user_id: userId.optional(), is_author_bot: z.boolean(), permalink: z.string().max(512).optional(),
  thread_ts: apiTs.optional(), context_messages: z.object({ before: z.array(contextMessage).max(20).optional(), after: z.array(contextMessage).max(20).optional() }).optional(),
}).passthrough();
const responseSchema = z.object({ results: z.object({ messages: z.array(searchMessage).max(20),
  files: z.array(z.unknown()).max(0).optional(), channels: z.array(z.unknown()).max(0).optional(), users: z.array(z.unknown()).max(0).optional(),
}), response_metadata: z.object({ next_cursor: z.string().max(4096).optional(), warnings: z.array(z.string()).max(0).optional() }).optional(),
  next_cursor: z.string().max(4096).optional(), has_more: z.boolean().optional(), warning: z.string().optional(),
}).passthrough();
type DeliveryRole = "primary" | "context";
type State = { binding: string; cursor: string; page: number; lossy: boolean; fingerprints: Record<string, string>;
  deliveredRoles: Record<string, DeliveryRole>; used: string[]; expires: number };
const limits = { pageSize: 20, maxPages: 4, maxPageBytes: 24_000 };

/** Bot + authenticated event action_token only. Fixed current public channel, keyword messages, no fallback. */
export class SlackSearcher {
  private readonly cursors = new Map<string, State>();
  private readonly inFlight = new Set<string>();
  constructor(private readonly client: SlackReadClient) {}
  async search(input: unknown, context?: object): Promise<ReadResult> {
    let locked: string | undefined;
    try {
      logSlackTokenSearch(context);
      const identity = requireSlackReadIdentity(context);
      const parsed = searchInput.safeParse(input); if (!parsed.success) invalid();
      const { query, channel, cursor, limit } = parsed.data;
      if (channel && channel !== identity.channel) deny();
      // Do not interpret caller-controlled Slack operators. Literal quoted terms + our sole in: filter.
      if (!/^[\p{L}\p{N}_ -]+$/u.test(query) || /(^|\s)(OR|AND|NOT)(\s|$)/i.test(query)) deny();
      const actionToken = getSlackSearchActionToken(context);
      if (!actionToken) return { ...failure("unsupported", "검색용 Slack event action_token이 없습니다. 관리자에게 AI/Real-time Search 활성화·search:read.public 권한·app_mention/message event action_token 수신을 확인해주세요. 사용자 토큰 입력으로 대체하지 않습니다."), limits };
      const binding = JSON.stringify([identity.teamId, identity.userId, identity.channel, identity.requestId, query, limit]);
      for (const [key, state] of this.cursors) if (state.expires <= Date.now()) this.cursors.delete(key);
      const previous = cursor ? this.cursors.get(cursor) : undefined;
      if (cursor && (!previous || previous.binding !== binding || previous.page >= limits.maxPages || this.inFlight.has(cursor))) invalid();
      if (cursor) { locked = cursor; this.inFlight.add(cursor); }
      const access = await authorizeCurrentSlackChannel(this.client, context, { channelId: channel });
      if (access.kind !== "public_channel") return { ...failure("unsupported", "bot token 검색은 현재 공개 채널의 메시지만 지원합니다. private 채널·DM/MPIM 검색이나 다른 채널 우회는 지원하지 않습니다."), limits };
      if (!access.workspaceHost || !this.client.apiCall) unavailable();
      const terms = query.trim().split(/\s+/).map(term => `"${term}"`).join(" ");
      // SDK lacks this new method's types: apiCall uses the documented endpoint/official argument names.
      logSlackTokenSearch(context, "search_api");
      const raw = await this.client.apiCall("assistant.search.context", {
        action_token: actionToken, query: `in:<#${identity.channel}> ${terms}`,
        channel_types: ["public_channel"], content_types: ["messages"], context_channel_id: identity.channel,
        include_bots: true, include_context_messages: true, include_message_blocks: false,
        disable_semantic_search: true, highlight: false, sort: "timestamp", sort_dir: "asc", limit,
        ...(previous ? { cursor: previous.cursor } : {}),
      });
      check(raw);
      const response = responseSchema.safeParse(raw); if (!response.success) unavailable();
      const data = response.data;
      if (data.warning || data.results.messages.length > limit) unavailable();
      const candidates: ReadResult["messages"] = [], contexts: ReadResult["messages"] = [];
      const validateScope = (m: { channel_id?: string; channel?: string; team_id?: string; team?: string }) => {
        if ((m.channel_id !== undefined && m.channel_id !== identity.channel) || (m.channel !== undefined && m.channel !== identity.channel) ||
            (m.team_id !== undefined && m.team_id !== identity.teamId) || (m.team !== undefined && m.team !== identity.teamId)) unavailable();
      };
      for (const m of data.results.messages) {
        validateScope(m);
        if (m.permalink) {
          let url: URL; try { url = new URL(m.permalink); } catch { return unavailable(); }
          if (url.href !== m.permalink || url.protocol !== "https:" || url.hostname !== access.workspaceHost || url.username || url.password || url.port || url.hash || url.search ||
              url.pathname !== `/archives/${identity.channel}/p${m.message_ts.replace(".", "")}`) unavailable();
        }
        candidates.push({ channel: identity.channel, ts: m.message_ts, text: m.content, textTruncated: false,
          author: { userId: m.author_user_id ?? null, botId: null, kind: m.is_author_bot ? "bot" : m.author_user_id ? "participant" : "system" },
          ...(m.thread_ts ? { threadTs: m.thread_ts } : {}), ...(m.permalink ? { permalink: m.permalink } : {}), searchMatch: true });
        for (const position of ["before", "after"] as const) for (const c of m.context_messages?.[position] ?? []) {
          // Official contextual objects omit scope: they inherit the verified parent result's channel/team.
          // Any explicit scope, including alternate field names, must agree; never silently discard leaks.
          validateScope(c);
          const contextTime = BigInt(c.ts.replace(".", "")), matchTime = BigInt(m.message_ts.replace(".", ""));
          if ((position === "before" && contextTime >= matchTime) || (position === "after" && contextTime <= matchTime)) unavailable();
          if (m.thread_ts && c.thread_ts && c.thread_ts !== m.thread_ts) unavailable();
          contexts.push({ channel: identity.channel, ts: c.ts, text: c.text, textTruncated: false,
            author: { userId: c.user_id ?? c.user ?? null, botId: c.bot_id ?? null, kind: c.is_author_bot || c.bot_id ? "bot" : c.user_id || c.user ? "participant" : "system" },
            ...(c.thread_ts ? { threadTs: c.thread_ts } : {}), searchMatch: false, contextForTs: m.message_ts, contextPosition: position });
        }
      }
      const fingerprints = { ...(previous?.fingerprints ?? {}) };
      const deliveredRoles = { ...(previous?.deliveredRoles ?? {}) };
      // Validate conflicts across ALL observed objects, even ones omitted by the page budget.
      // Persist only delivered objects below, keeping continuation memory bounded.
      const observed = new Map(Object.entries(fingerprints));
      const projected = new Map<string, ReadResult["messages"][number]>();
      let lossy = previous?.lossy ?? false;
      for (const message of [...candidates, ...contexts]) {
        const fingerprint = createHash("sha256").update(message.text).digest("hex");
        const previousText = observed.get(message.ts);
        if (previousText && previousText !== fingerprint) unavailable();
        observed.set(message.ts, fingerprint);
        const role: DeliveryRole = message.searchMatch ? "primary" : "context";
        // Context delivery is not proof of match delivery. Return the full primary object on promotion.
        if (deliveredRoles[message.ts] === "primary" || (role === "context" && deliveredRoles[message.ts] === "context")) continue;
        const selected = projected.get(message.ts);
        if (selected && (selected.searchMatch || role === "context")) continue;
        if (!selected && projected.size >= 40) { lossy = true; continue; }
        projected.set(message.ts, message); // primary wins; context keeps its first representative relation
      }
      const messages = [...projected.values()];
      const primaryCount = messages.filter(m => m.searchMatch).length;
      const headerBytes = () => messages.reduce((sum, m) => sum + Buffer.byteLength(JSON.stringify({ ...m, text: "" })), 0);
      while (headerBytes() > limits.maxPageBytes && messages.length > primaryCount) { messages.pop(); lossy = true; }
      let budget = limits.maxPageBytes - headerBytes();
      if (budget < 0) unavailable();
      for (const message of messages) {
        const original = message.text;
        const safeText = original.split(actionToken).join("[SLACK_ACTION_TOKEN_REDACTED]");
        message.text = jsonTextPrefix(safeText, Math.min(8_000, budget));
        message.textTruncated = message.text !== original;
        lossy ||= message.textTruncated;
        budget -= Buffer.byteLength(JSON.stringify(message.text)) - 2;
      }
      for (const message of messages) {
        fingerprints[message.ts] = observed.get(message.ts)!;
        deliveredRoles[message.ts] = message.searchMatch ? "primary" : "context";
      }
      messages.sort((a, b) => BigInt(a.ts.replace(".", "")) < BigInt(b.ts.replace(".", "")) ? -1 : 1);
      const next = data.response_metadata?.next_cursor?.trim() || data.next_cursor?.trim();
      if (data.response_metadata?.next_cursor && data.next_cursor && data.response_metadata.next_cursor !== data.next_cursor) unavailable();
      if (next && (next === previous?.cursor || previous?.used.includes(next))) unavailable();
      const page = (previous?.page ?? 0) + 1;
      let nextCursor: string | null = null;
      if (next && page < limits.maxPages) {
        if (this.cursors.size >= 1000) this.cursors.delete(this.cursors.keys().next().value!);
        nextCursor = randomUUID();
        this.cursors.set(nextCursor, { binding, cursor: next, page, lossy, fingerprints, deliveredRoles, used: [...(previous?.used ?? []), next], expires: Date.now() + 10 * 60_000 });
      }
      if (cursor) this.cursors.delete(cursor);
      const complete = !next && !data.has_more && !lossy;
      return { status: "ok", api: "assistant.search.context", source: { channel: identity.channel },
        message: complete ? "현재 공개 채널의 메시지 검색 범위를 확인했습니다 (키워드 검색 결과이며 채널 전체 기록이 아닙니다)." : "부분 검색 결과입니다. 다음 페이지와 본문/context 잘림을 확인해주세요.",
        messages, page, nextCursor, complete, truncated: !complete, limits: { ...limits, pageSize: limit } };
    } catch (error) { return { ...errorResult(error), limits }; }
    finally { if (locked) this.inFlight.delete(locked); }
  }
}
