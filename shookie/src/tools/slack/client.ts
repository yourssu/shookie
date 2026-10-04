import { createHash, randomUUID } from "node:crypto";
import type { WebClient } from "@slack/web-api";
import { getSlackReadIdentity, type SlackReadIdentity } from "./context.js";
import { channelInput, threadInput, searchInput, slackTs, type ReadResult } from "./schemas.js";

export type SlackReadClient = Pick<WebClient, "auth" | "conversations">;
const limits = { pageSize: 15, maxPages: 4, maxPageBytes: 24_000 };
const fail = (status: ReadResult["status"], message: string): ReadResult => ({
  status, message, messages: [], page: 0, nextCursor: null, complete: false, truncated: false, limits,
});
class ReadError extends Error {
  constructor(readonly result: ReadResult) { super(result.status); }
}
function deny(): never { throw new ReadError(fail("access_denied", "현재 요청자·워크스페이스·채널의 읽기 권한을 확인하지 못했습니다. 다른 채널 조회는 지원하지 않습니다.")); }
function invalid(): never { throw new ReadError(fail("invalid_target", "현재 채널의 유효한 부모 메시지 ts 또는 Slack permalink를 지정해주세요.")); }
function unavailable(): never { throw new ReadError(fail("unavailable", "Slack 결과를 안전하게 확인하지 못했습니다. 잠시 후 다시 시도해주세요.")); }
function check(response: { ok?: boolean; error?: string }) {
  if (response.ok && !response.error) return;
  throw { data: { error: response.error } }; // handled below; never logged or returned
}
function timestamp(ts: string) { return BigInt(ts.replace(".", "")); }
function jsonTextPrefix(text: string, budget: number) {
  let output = "", used = 0;
  for (const char of text) {
    const n = Buffer.byteLength(JSON.stringify(char)) - 2; // count escaped JSON bytes, not just source text
    if (used + n > budget) break;
    output += char; used += n;
  }
  return output;
}
function errorResult(error: unknown): ReadResult {
  if (error instanceof ReadError) return error.result;
  const e = error as { code?: string; statusCode?: number; retryAfter?: number; data?: { error?: string } } | null;
  const code = e?.data?.error;
  if (e?.statusCode === 429 || e?.code === "slack_webapi_rate_limited_error" || code === "ratelimited") {
    const result = fail("rate_limited", "Slack 호출 한도에 도달했습니다. 잠시 후 다시 시도해주세요. 자동 재시도하지 않았습니다.");
    if (typeof e?.retryAfter === "number" && Number.isFinite(e.retryAfter) && e.retryAfter > 0) result.retryAfterSeconds = e.retryAfter;
    return result;
  }
  if (code === "not_allowed_token_type" || code === "method_not_supported_for_channel_type") {
    return fail("unsupported", "현재 bot token/대화 유형에서는 이 Slack 읽기 API를 지원하지 않습니다. 다른 자격 증명이나 스캔으로 우회하지 않았습니다.");
  }
  if (["missing_scope", "not_in_channel", "channel_not_found", "no_permission", "access_denied", "invalid_auth", "not_authed"].includes(code ?? "")) {
    return fail("access_denied", "Slack 읽기 권한을 확인하지 못했습니다. 관리자에게 현재 채널의 bot 읽기 scope와 접근 권한을 확인해주세요.");
  }
  if (["thread_not_found", "invalid_ts", "invalid_cursor"].includes(code ?? "")) return fail("invalid_target", "대상 스레드 또는 페이지가 유효하지 않습니다. 부모 메시지와 현재 채널을 확인해주세요.");
  return fail("unavailable", "Slack 조회를 완료하지 못했습니다. 잠시 후 다시 시도해주세요.");
}
type Target = { channel: string; threadTs?: string; host?: string };
type Continuation = { binding: string; slackCursor: string; page: number;
  rootReplyCount?: number; lossy: boolean; seen: string[]; fingerprints: Record<string, string>;
  expires: number; usedCursors: string[] };

/** Read-only, current-event-channel-only. No user token, global search, auto-join or history scan fallback. */
export class SlackReader {
  private readonly cursors = new Map<string, Continuation>();
  private readonly inFlightCursors = new Set<string>();
  constructor(private readonly client: SlackReadClient) {}

  private identity(context?: object): SlackReadIdentity {
    const identity = getSlackReadIdentity(context);
    if (!identity || !/^[UW][A-Z0-9]{1,63}$/.test(identity.userId) || !/^T[A-Z0-9]{1,63}$/.test(identity.teamId) ||
        !/^[CGD][A-Z0-9]{1,63}$/.test(identity.channel) || !identity.requestId) deny();
    return identity;
  }
  private async authorize(identity: SlackReadIdentity, target: Target) {
    if (target.channel !== identity.channel) deny();
    const auth = await this.client.auth.test(); check(auth);
    // Bot-only even if accidentally injected with a user-token client. Workspace must match trusted event.
    if (!auth.bot_id || auth.team_id !== identity.teamId) deny();
    if (target.host) {
      let host: string;
      try { host = new URL(auth.url!).hostname; } catch { return deny(); }
      if (host !== target.host) deny();
    }
    const info = await this.client.conversations.info({ channel: target.channel }); check(info);
    const channel = info.channel as (NonNullable<typeof info.channel> & { user?: string }) | undefined;
    if (!channel || channel.id !== target.channel ||
        (channel.context_team_id && channel.context_team_id !== identity.teamId) ||
        channel.is_ext_shared || channel.is_org_shared || channel.is_shared) deny();
    if (target.channel.startsWith("D")) {
      if (!channel.is_im || channel.user !== identity.userId) deny();
      return;
    }
    if (!(channel.is_channel || channel.is_group) || channel.is_im || channel.is_mpim) deny();
    // Bot access is NOT requester access. Re-check membership for every page; fail closed on partial membership.
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 3; page++) {
      const members = await this.client.conversations.members({ channel: target.channel, limit: 200, ...(cursor ? { cursor } : {}) });
      check(members);
      if (members.members?.includes(identity.userId)) return;
      const next = members.response_metadata?.next_cursor?.trim();
      if (!next || seen.has(next)) deny();
      seen.add(next); cursor = next;
    }
    deny();
  }
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
  async search(input: unknown, context?: object): Promise<ReadResult> {
    try {
      const identity = this.identity(context);
      const parsed = searchInput.safeParse(input); if (!parsed.success) invalid();
      if (parsed.data.channel && parsed.data.channel !== identity.channel) deny();
      // Reject all scope operators rather than trying to sanitize an arbitrary Slack query language.
      if (/(^|\s)(?:-?in:|channel:)/i.test(parsed.data.query)) deny();
      return fail("unsupported", "Slack search.messages는 user token 전용으로 현재 bot token만으로 검색할 수 없습니다. 검색을 실행하거나 채널 기록 스캔으로 대체하지 않았습니다. 현재 채널의 명시적 읽기 도구를 사용할 수 있습니다.");
    } catch (error) { return errorResult(error); }
  }
  async read(kind: "thread" | "channel", input: unknown, context?: object): Promise<ReadResult> {
    let lockedCursor: string | undefined;
    try {
      const identity = this.identity(context);
      const parsed = (kind === "thread" ? threadInput : channelInput).safeParse(input);
      if (!parsed.success) invalid();
      const target = this.target(parsed.data, identity, kind === "thread");
      const binding = JSON.stringify([identity.teamId, identity.userId, identity.channel, identity.requestId, kind, target.channel, target.threadTs ?? null]);
      for (const [key, state] of this.cursors) if (state.expires < Date.now()) this.cursors.delete(key);
      const previous = parsed.data.cursor ? this.cursors.get(parsed.data.cursor) : undefined;
      if (parsed.data.cursor && (!previous || previous.binding !== binding || previous.page >= limits.maxPages || this.inFlightCursors.has(parsed.data.cursor))) invalid();
      if (parsed.data.cursor) {
        lockedCursor = parsed.data.cursor;
        this.inFlightCursors.add(lockedCursor);
      }
      await this.authorize(identity, target);
      const cursor = previous?.slackCursor;
      const args = { channel: target.channel, limit: limits.pageSize, ...(cursor ? { cursor } : {}) };
      const response = kind === "thread"
        ? await this.client.conversations.replies({ ...args, ts: target.threadTs! })
        : await this.client.conversations.history(args);
      check(response);
      if ((response as { warning?: string }).warning || response.response_metadata?.warnings?.length || !Array.isArray(response.messages) || response.messages.length > limits.pageSize) unavailable();
      const messages: ReadResult["messages"] = [];
      const seen = new Set(previous?.seen ?? []);
      const fingerprints = { ...(previous?.fingerprints ?? {}) };
      let budget = limits.maxPageBytes, lossy = previous?.lossy ?? false;
      let rootReplyCount = previous?.rootReplyCount;
      for (const [index, raw] of response.messages.entries()) {
        const m = raw as typeof raw & { channel?: string; team?: string; subtype?: string };
        if (!slackTs.safeParse(m.ts).success || typeof m.text !== "string" ||
            (m.channel !== undefined && m.channel !== target.channel) || (m.team !== undefined && m.team !== identity.teamId) ||
            (m.thread_ts !== undefined && !slackTs.safeParse(m.thread_ts).success) ||
            (m.user !== undefined && !/^[UW][A-Z0-9]{1,63}$/.test(m.user)) ||
            (m.bot_id !== undefined && !/^B[A-Z0-9]{1,63}$/.test(m.bot_id))) unavailable();
        if (kind === "thread" && ((m.ts !== target.threadTs && m.thread_ts !== target.threadTs) ||
            (m.thread_ts && m.thread_ts !== target.threadTs) || timestamp(m.ts!) < timestamp(target.threadTs!))) unavailable();
        if (kind === "thread" && m.ts === target.threadTs) {
          if (m.reply_count !== undefined && (!Number.isSafeInteger(m.reply_count) || m.reply_count < 0)) unavailable();
          // A plain, unthreaded message can omit reply_count. Infer zero only for a single terminal first page.
          const count = m.reply_count ?? (!previous && !m.thread_ts && response.messages.length === 1 &&
            !response.has_more && !response.response_metadata?.next_cursor?.trim() ? 0 : undefined);
          if (rootReplyCount !== undefined && count !== undefined && rootReplyCount !== count) lossy = true;
          rootReplyCount = count ?? rootReplyCount;
        }
        // Slack may repeat the parent across pages. Conflicting originals fail closed.
        const fingerprint = createHash("sha256").update(JSON.stringify([m.ts, m.thread_ts, m.text, m.user, m.bot_id])).digest("hex");
        if (seen.has(m.ts!)) {
          if (fingerprints[m.ts!] !== fingerprint) unavailable();
          continue;
        }
        fingerprints[m.ts!] = fingerprint;
        seen.add(m.ts!);
        // Reserve bounded metadata for every remaining message, even when its text must become empty.
        const text = jsonTextPrefix(m.text, Math.min(8_000, Math.max(0, budget - 512 * (response.messages.length - index))));
        const textTruncated = text !== m.text;
        const message: ReadResult["messages"][number] = { channel: target.channel, ts: m.ts!,
          ...(m.thread_ts ? { threadTs: m.thread_ts } : {}),
          author: { userId: m.user ?? null, botId: m.bot_id ?? null, kind: m.bot_id || m.subtype === "bot_message" ? "bot" : m.user ? "participant" : "system" },
          text, textTruncated, ...(Number.isSafeInteger(m.reply_count) && m.reply_count! >= 0 ? { replyCount: m.reply_count } : {}),
        };
        budget -= Buffer.byteLength(JSON.stringify(message));
        if (budget < 0) unavailable();
        messages.push(message); lossy ||= textTruncated;
      }
      if (kind === "thread" && !seen.has(target.threadTs!)) unavailable();
      messages.sort((a, b) => timestamp(a.ts) < timestamp(b.ts) ? -1 : timestamp(a.ts) > timestamp(b.ts) ? 1 : 0);
      const next = response.response_metadata?.next_cursor?.trim();
      const hasMore = !!next || !!response.has_more;
      const page = (previous?.page ?? 0) + 1;
      let nextCursor: string | null = null;
      if (next && (next === cursor || previous?.usedCursors.includes(next))) unavailable();
      if (next && page < limits.maxPages) {
        if (this.cursors.size >= 1000) this.cursors.delete(this.cursors.keys().next().value!);
        nextCursor = randomUUID();
        this.cursors.set(nextCursor, { binding, slackCursor: next, page,
          rootReplyCount, lossy, seen: [...seen], fingerprints, expires: Date.now() + 10 * 60_000,
          usedCursors: [...(previous?.usedCursors ?? []), next] });
      }
      if (parsed.data.cursor) this.cursors.delete(parsed.data.cursor); // one-use, request/actor/target-bound
      const complete = !hasMore && !lossy && (kind !== "thread" || seen.size === rootReplyCount! + 1);
      return { status: "ok", message: complete ? "조회 범위를 모두 읽었습니다." : "부분 조회입니다. 다음 페이지·메시지 잘림·누락 가능성을 확인해주세요.",
        source: { channel: target.channel, ...(target.threadTs ? { threadTs: target.threadTs } : {}) },
        messages, page, nextCursor, complete, truncated: !complete, limits };
    } catch (error) { return errorResult(error); }
    finally { if (lockedCursor) this.inFlightCursors.delete(lockedCursor); }
  }
}
