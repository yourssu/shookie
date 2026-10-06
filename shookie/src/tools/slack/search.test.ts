import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../logger.js";
import { unavailable } from "./errors.js";
import { RequestContext } from "@mastra/core/request-context";
import { bindSlackReadContext, getSlackReadIdentity } from "./context.js";
import { SlackReader, type SlackReadClient } from "./client.js";
import { readOutput } from "./schemas.js";
import { silentSlackLogger } from "./sdk-logger.js";

const token = "SYNTHETIC_EVENT_ACTION_SECRET";
const ts = (n: number) => `1700000000.${String(n).padStart(6, "0")}`;
const message = (n = 2) => ({ channel_id: "C1", team_id: "T1", message_ts: ts(n), content: `match ${n}`,
  author_user_id: "U2", is_author_bot: false, permalink: `https://synthetic.slack.com/archives/C1/p${ts(n).replace(".", "")}` });
function ctx(changes = {}, action: unknown = token) {
  const c = new RequestContext();
  bindSlackReadContext(c, { userId: "U1", teamId: "T1", channel: "C1", requestId: "event:1", ...changes }, action);
  return c;
}
function fixture() {
  const auth = vi.fn().mockResolvedValue({ ok: true, bot_id: "B1", team_id: "T1", url: "https://synthetic.slack.com/" });
  const info = vi.fn().mockResolvedValue({ ok: true, channel: { id: "C1", is_channel: true, is_private: false } });
  const members = vi.fn().mockResolvedValue({ ok: true, members: ["U1"] });
  const apiCall = vi.fn().mockResolvedValue({ ok: true, results: { messages: [message()] } });
  const history = vi.fn(), replies = vi.fn();
  const client = { auth: { test: auth }, conversations: { info, members, history, replies }, apiCall } as unknown as SlackReadClient;
  return { auth, info, members, apiCall, history, replies, reader: new SlackReader(client), context: ctx() };
}
afterEach(() => vi.restoreAllMocks());
function diagnostics() {
  const spy = vi.spyOn(logger, "info").mockImplementation(() => {});
  return { spy, records: () => spy.mock.calls.filter(([name]) => name === "slack_search_response_diagnostic").map(([, record]) => record as Record<string, unknown>) };
}
function localUnavailable() {
  try { unavailable(); } catch (error) { return (error as { result: { message: string } }).result.message; }
}

describe("search response safe diagnostics", () => {
  it.each([
    ["schema_invalid", { ok: true, results: { messages: [{ ...message(), team_id: undefined }] } }],
    ["warning_present", { ok: true, results: { messages: [] }, warning: token }],
    ["result_limit_exceeded", { ok: true, results: { messages: [message(), message(3)] } }],
    ["scope_mismatch", { ok: true, results: { messages: [{ ...message(), team_id: "TOTHER" }] } }],
    ["permalink_invalid", { ok: true, results: { messages: [{ ...message(), permalink: token }] } }],
    ["permalink_invalid", { ok: true, results: { messages: [{ ...message(), permalink: "https://private.invalid/" }] } }],
    ["context_time_invalid", { ok: true, results: { messages: [{ ...message(), context_messages: { before: [{ ts: ts(3), text: token }] } }] } }],
    ["thread_scope_mismatch", { ok: true, results: { messages: [{ ...message(), thread_ts: ts(1), context_messages: { after: [{ ts: ts(3), text: token, thread_ts: ts(2) }] } }] } }],
    ["fingerprint_conflict", { ok: true, results: { messages: [message(), { ...message(), content: token }] } }],
    ["cursor_conflict", { ok: true, results: { messages: [] }, next_cursor: token, response_metadata: { next_cursor: "other" } }],
  ])("maps local rejection to %s without changing failure/API calls", async (reason, raw) => {
    const d = diagnostics(), f = fixture(); f.apiCall.mockResolvedValue(raw);
    const result = await f.reader.search({ query: "launch", limit: reason === "result_limit_exceeded" ? 1 : 20 }, f.context);
    expect(result).toMatchObject({ status: "unavailable", message: localUnavailable(), messages: [], complete: false, nextCursor: null });
    expect(f.apiCall).toHaveBeenCalledTimes(1);
    expect(d.records().map(r => r.reason)).toEqual(["response_received", "check_passed", reason]);
    expect(d.records().at(-1)).toMatchObject({ requestId: "event:1", correlationAvailable: true });
    expect(JSON.stringify(d.spy.mock.calls)).not.toContain(token);
    expect(f.history).not.toHaveBeenCalled(); expect(f.replies).not.toHaveBeenCalled();
  });
  it("distinguishes API call rejection, check failure and schema failure without error codes", async () => {
    const d = diagnostics(), f = fixture();
    f.apiCall.mockRejectedValueOnce({ message: token });
    expect((await f.reader.search({ query: "launch" }, f.context)).status).toBe("unavailable");
    expect(d.records().map(r => r.reason)).toEqual(["api_call_failed"]);
    d.spy.mockClear(); f.apiCall.mockResolvedValueOnce({ ok: false, error: token });
    expect((await f.reader.search({ query: "launch" }, f.context)).status).toBe("unavailable");
    expect(d.records().map(r => r.reason)).toEqual(["response_received", "check_failed"]);
    d.spy.mockClear(); f.apiCall.mockResolvedValueOnce({ ok: true });
    expect((await f.reader.search({ query: "launch" }, f.context)).message).toBe(localUnavailable());
    expect(d.records().at(-1)).toMatchObject({ reason: "schema_invalid", schemaField: "results", schemaCode: "invalid_type", schemaMissing: true });
    expect(f.apiCall).toHaveBeenCalledTimes(3); expect(JSON.stringify(d.spy.mock.calls)).not.toContain(token);
  });
  it.each(["message_ts", "content", "team_id", "channel_id", "is_author_bot"] as const)("distinguishes missing/invalid required %s in the unchanged response schema", async field => {
    const d = diagnostics(), f = fixture();
    for (const value of [undefined, null]) {
      f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(), [field]: value }] } });
      expect(await f.reader.search({ query: "launch" }, f.context)).toMatchObject({ status: "unavailable", message: localUnavailable() });
      expect(d.records().at(-1)).toMatchObject({ reason: "schema_invalid", schemaField: `message_${field}`, schemaCode: "invalid_type", schemaMissing: value === undefined });
    }
    expect(f.apiCall).toHaveBeenCalledTimes(2);
  });
  it("maps nonempty metadata warnings to the existing schema rejection", async () => {
    const d = diagnostics(), f = fixture();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [] }, response_metadata: { warnings: [token] } });
    expect((await f.reader.search({ query: "launch" }, f.context)).message).toBe(localUnavailable());
    expect(d.records().at(-1)).toMatchObject({ reason: "schema_invalid", schemaField: "metadata_warnings", schemaCode: "too_big", schemaMissing: false });
    expect(JSON.stringify(d.spy.mock.calls)).not.toContain(token);
  });
  it("classifies existing parser/check exceptions without diagnostic response reads", async () => {
    const d = diagnostics(), f = fixture(), execute = vi.fn(() => { throw new Error(token); });
    const raw = Object.defineProperty({ ok: true }, "results", { get: execute });
    f.apiCall.mockResolvedValueOnce(raw);
    expect((await f.reader.search({ query: "launch" }, f.context)).status).toBe("unavailable");
    expect(execute).toHaveBeenCalledTimes(1); // Existing Zod parser read only; diagnostics never inspect raw.
    expect(d.records().at(-1)).toMatchObject({ stage: "schema", reason: "schema_exception" });
    execute.mockClear(); f.apiCall.mockResolvedValueOnce(Object.defineProperty({}, "ok", { get: execute }));
    expect((await f.reader.search({ query: "launch" }, f.context)).status).toBe("unavailable");
    expect(execute).toHaveBeenCalledTimes(1); expect(d.records().at(-1)).toMatchObject({ reason: "check_failed" });
    expect(JSON.stringify(d.spy.mock.calls)).not.toContain(token);
  });
  it("observes missing prerequisites and authorization failures before API", async () => {
    const d = diagnostics(), f = fixture(); f.auth.mockResolvedValueOnce({ ok: true, bot_id: "B1", team_id: "T1" });
    expect((await f.reader.search({ query: "launch" }, f.context)).message).toBe(localUnavailable());
    expect(d.records().at(-1)).toMatchObject({ reason: "prerequisites_missing", stage: "prerequisites" });
    f.members.mockResolvedValueOnce({ ok: true, members: [] });
    expect((await f.reader.search({ query: "launch" }, f.context)).status).toBe("access_denied");
    expect(d.records().at(-1)).toMatchObject({ reason: "authorization_failed" }); expect(f.apiCall).not.toHaveBeenCalled();
  });
  it("identifies the defensive header budget path without changing its failure", async () => {
    const d = diagnostics(), f = fixture(); const byteLength = Buffer.byteLength;
    vi.spyOn(Buffer, "byteLength").mockImplementation((value, encoding) =>
      typeof value === "string" && value.includes('"text":""') ? 24_001 : byteLength(value, encoding));
    expect(await f.reader.search({ query: "launch" }, f.context)).toMatchObject({ status: "unavailable", message: localUnavailable() });
    expect(d.records().at(-1)).toMatchObject({ reason: "budget_exceeded" }); expect(f.apiCall).toHaveBeenCalledTimes(1);
  });
  it("logger exceptions cannot alter success, local rejection or cursor unlock/retry", async () => {
    const d = diagnostics(), f = fixture(); d.spy.mockImplementation(() => { throw new Error(token); });
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [message()] }, next_cursor: token });
    const first = await f.reader.search({ query: "launch" }, f.context);
    expect(first.status).toBe("ok");
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [] }, next_cursor: token });
    expect(await f.reader.search({ query: "launch", cursor: first.nextCursor }, f.context)).toMatchObject({ status: "unavailable", message: localUnavailable() });
    d.spy.mockImplementation(() => {});
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [] }, next_cursor: token });
    expect((await f.reader.search({ query: "launch", cursor: first.nextCursor }, f.context)).status).toBe("unavailable");
    expect(d.records().at(-1)).toMatchObject({ reason: "cursor_replay" });
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [message(3)] } });
    expect(await f.reader.search({ query: "launch", cursor: first.nextCursor }, f.context)).toMatchObject({ status: "ok", page: 2 });
    expect(f.apiCall).toHaveBeenCalledTimes(4);
  });
  it("success logs only response/check states, never result bodies or metadata", async () => {
    const d = diagnostics(), f = fixture(); const secret = "SECRET_SUCCESS_CONTENT";
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(), content: secret }] }, secret: token });
    expect((await f.reader.search({ query: "launch" }, f.context)).status).toBe("ok");
    expect(d.records()).toEqual([
      { stage: "transport", reason: "response_received", correlationAvailable: true, requestId: "event:1" },
      { stage: "api_check", reason: "check_passed", correlationAvailable: true, requestId: "event:1" },
    ]);
    for (const value of [secret, token, "synthetic.slack.com", "U2", "C1", "T1", "launch", ts(2)]) expect(JSON.stringify(d.spy.mock.calls)).not.toContain(value);
  });
});

describe("bot + trusted event action_token Real-time Search", () => {
  it("calls the official endpoint with fixed public/messages/current-channel filters and safe literal terms", async () => {
    const f = fixture(); const result = await f.reader.search({ query: "출시 plan" }, f.context);
    expect(result).toMatchObject({ status: "ok", api: "assistant.search.context", source: { channel: "C1" }, complete: true, truncated: false });
    expect(readOutput.safeParse(result).success).toBe(true);
    expect(f.apiCall).toHaveBeenCalledExactlyOnceWith("assistant.search.context", {
      action_token: token, query: 'in:<#C1> "출시" "plan"', channel_types: ["public_channel"], content_types: ["messages"],
      context_channel_id: "C1", include_bots: true, include_context_messages: true, include_message_blocks: false,
      disable_semantic_search: true, highlight: false, sort: "timestamp", sort_dir: "asc", limit: 20,
    });
    expect(result.messages[0]).toMatchObject({ channel: "C1", ts: ts(2), searchMatch: true, text: "match 2", permalink: message().permalink });
    expect(JSON.stringify(result)).not.toContain(token); expect(JSON.stringify(getSlackReadIdentity(f.context))).not.toContain(token);
    expect(f.context.get("action_token")).toBeUndefined(); expect(f.context.get("actionToken")).toBeUndefined();
    expect(f.history).not.toHaveBeenCalled(); expect(f.replies).not.toHaveBeenCalled();
  });
  it("uses the official contextual object schema, inherits verified parent scope, includes bots and sorts originals", async () => {
    const f = fixture(); f.apiCall.mockResolvedValue({ ok: true, results: { messages: [{ ...message(2), is_author_bot: true,
      context_messages: { before: [{ ts: ts(1), text: "original before", user_id: "U3" }], after: [{ ts: ts(3), text: "other bot", bot_id: "BOTHER", is_author_bot: true, channel_id: "C1", team_id: "T1" }] },
    }] }, action_token: token, blocks: [{ text: token }] });
    const result = await f.reader.search({ query: "launch" }, f.context);
    expect(result.messages.map(m => m.ts)).toEqual([ts(1), ts(2), ts(3)]);
    expect(result.messages[0]).toMatchObject({ searchMatch: false, contextForTs: ts(2), contextPosition: "before", text: "original before" });
    expect(result.messages[1].author.kind).toBe("bot"); expect(result.messages[2].author).toMatchObject({ botId: "BOTHER", kind: "bot" });
    expect(JSON.stringify(result)).not.toContain(token); expect(JSON.stringify(result)).not.toContain("blocks");
  });
  it("never returns the live action token even if the API echoes it inside message text", async () => {
    const f = fixture(); f.apiCall.mockResolvedValue({ ok: true, results: { messages: [{ ...message(), content: `credential ${token}` }] } });
    const result = await f.reader.search({ query: "launch" }, f.context);
    expect(result).toMatchObject({ status: "ok", complete: false, truncated: true });
    expect(result.messages[0].textTruncated).toBe(true); expect(JSON.stringify(result)).not.toContain(token);
    expect(result.messages[0].text).toContain("REDACTED");
  });
  it("normalizes official response timestamps with shorter fractions while preserving strict provenance", async () => {
    const f = fixture(); f.apiCall.mockResolvedValue({ ok: true, results: { messages: [{ ...message(100000), message_ts: "1700000000.1" }] } });
    expect((await f.reader.search({ query: "launch" }, f.context)).messages[0].ts).toBe("1700000000.100000");
  });
  it.each([undefined, "", 123, "has spaces"])("reports absent/invalid trusted event action token as unsupported: %s", async action => {
    const f = fixture(); const context = new RequestContext();
    bindSlackReadContext(context, { userId: "U1", teamId: "T1", channel: "C1", requestId: "event:1" }, action);
    context.set("action_token", token);
    const result = await f.reader.search({ query: "launch" }, context);
    expect(result.status).toBe("unsupported"); expect(result.message).toContain("action_token"); expect(result.message).toContain("search:read.public");
    expect(f.apiCall).not.toHaveBeenCalled(); expect(f.history).not.toHaveBeenCalled();
  });
  it("cannot synthesize identity or action token through text, plain context or tool arguments", async () => {
    const f = fixture(); const fake = new RequestContext(); for (const [k, v] of Object.entries({ userId: "U1", teamId: "T1", channel: "C1", action_token: token })) fake.set(k, v);
    expect((await f.reader.search({ query: "launch" }, fake)).status).toBe("access_denied");
    expect((await f.reader.search({ query: "launch", action_token: token }, f.context)).status).toBe("invalid_target");
    expect((await f.reader.search({ query: "launch", userId: "ADMIN" }, f.context)).status).toBe("invalid_target");
    expect(f.apiCall).not.toHaveBeenCalled();
  });
  it.each(["in:C1 plan", "-in:GSECRET plan", "channel:GSECRET", "plan OR secret", "plan or secret", "plan AND secret", "plan NOT secret", "<@USER>", "launch|secret", "(plan)", '"plan"', "from:BOT", "*", "plan\nsecret"])("rejects query operators rather than allowing in: filter injection: %s", async query => {
    const f = fixture(); expect((await f.reader.search({ query }, f.context)).status).toBe("access_denied"); expect(f.auth).not.toHaveBeenCalled(); expect(f.apiCall).not.toHaveBeenCalled();
  });
  it.each(["COTHER", "GSECRET", "DOTHER"])("blocks arbitrary channel %s before API calls", async channel => {
    const f = fixture(); expect((await f.reader.search({ query: "launch", channel }, f.context)).status).toBe("access_denied"); expect(f.auth).not.toHaveBeenCalled();
  });
  it.each([
    { channel: "G1", metadata: { id: "G1", is_group: true, is_private: true } },
    { channel: "D1", metadata: { id: "D1", is_im: true, user: "U1" } },
    { channel: "C1", metadata: { id: "C1", is_channel: true, is_private: true } },
  ])("does not search private/DM even when bot+requester can read them: %j", async item => {
    const f = fixture(); f.info.mockResolvedValue({ ok: true, channel: item.metadata });
    const result = await f.reader.search({ query: "launch" }, ctx({ channel: item.channel }));
    expect(result.status).toBe("unsupported"); expect(f.apiCall).not.toHaveBeenCalled(); expect(f.history).not.toHaveBeenCalled();
  });
  it("requires live membership and bot/team checks for search, not merely possession of action_token", async () => {
    const f = fixture(); f.members.mockResolvedValueOnce({ ok: true, members: ["UBOT"] });
    expect((await f.reader.search({ query: "launch" }, f.context)).status).toBe("access_denied");
    f.auth.mockResolvedValueOnce({ ok: true, team_id: "T1" });
    expect((await f.reader.search({ query: "launch" }, f.context)).status).toBe("access_denied");
    f.auth.mockResolvedValueOnce({ ok: true, bot_id: "B1", team_id: "TOTHER" });
    expect((await f.reader.search({ query: "launch" }, f.context)).status).toBe("access_denied"); expect(f.apiCall).not.toHaveBeenCalled();
  });
  it.each([
    ["feature_not_enabled", "unsupported"], ["missing_scope", "access_denied"], ["invalid_action_token", "unsupported"],
    ["not_allowed_token_type", "unsupported"], ["rate_limited", "rate_limited"], ["assistant_search_context_disabled", "unavailable"],
  ])("provides explicit sanitized failure/config guidance for %s", async (error, status) => {
    const f = fixture(); f.apiCall.mockResolvedValue({ ok: false, error, action_token: token, debug: token });
    const result = await f.reader.search({ query: "launch" }, f.context);
    expect(result.status).toBe(status); expect(result.complete).toBe(false); expect(result.messages).toEqual([]); expect(JSON.stringify(result)).not.toContain(token);
    expect(f.apiCall).toHaveBeenCalledTimes(1); expect(f.history).not.toHaveBeenCalled();
  });
  it("distinguishes empty successful results from thrown 429 and never retries", async () => {
    const f = fixture(); f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [] } });
    expect(await f.reader.search({ query: "launch" }, f.context)).toMatchObject({ status: "ok", messages: [], complete: true });
    f.apiCall.mockRejectedValueOnce({ code: "slack_webapi_rate_limited_error", retryAfter: 42, message: token });
    expect(await f.reader.search({ query: "launch" }, f.context)).toMatchObject({ status: "rate_limited", retryAfterSeconds: 42, messages: [] });
    expect(f.apiCall).toHaveBeenCalledTimes(2);
  });
  it.each([
    { ...message(), channel_id: "GSECRET" }, { ...message(), team_id: "TOTHER" }, { ...message(), channel: "GSECRET" },
    { ...message(), message_ts: "invalid" }, { ...message(), team_id: undefined },
    { ...message(), permalink: message().permalink.replace("synthetic", "evil") }, { ...message(), permalink: message().permalink.replace("C1", "GSECRET") },
    { ...message(), permalink: message().permalink + "?action_token=" + token },
    { ...message(), context_messages: { after: [{ ts: ts(3), text: "secret", channel_id: "GSECRET" }] } },
    { ...message(), context_messages: { before: [{ ts: ts(1), text: "secret", team_id: "TOTHER" }] } },
    { ...message(), context_messages: { before: [{ ts: ts(1), text: "secret", channel: "GSECRET" }] } },
    { ...message(), context_messages: { after: [{ ts: ts(3), text: "secret", team: "TOTHER" }] } },
  ])("fails closed for result/context scope or provenance violation %j", async item => {
    const f = fixture(); f.apiCall.mockResolvedValue({ ok: true, results: { messages: [item] } });
    const result = await f.reader.search({ query: "launch" }, f.context);
    expect(result.status).toBe("unavailable"); expect(result.messages).toEqual([]); expect(JSON.stringify(result)).not.toContain("secret"); expect(JSON.stringify(result)).not.toContain(token);
  });
  it("enforces maximum 20 primary results/request and refuses unexpected files or user results", async () => {
    const f = fixture();
    for (const limit of [0, 21, 1.5]) expect((await f.reader.search({ query: "launch", limit }, f.context)).status).toBe("invalid_target");
    expect(f.apiCall).not.toHaveBeenCalled();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: Array.from({ length: 21 }, (_, n) => message(n + 1)) } });
    expect((await f.reader.search({ query: "launch" }, f.context)).status).toBe("unavailable");
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [], files: [{ file_id: "FSECRET" }] } });
    expect((await f.reader.search({ query: "launch" }, f.context)).status).toBe("unavailable");
  });
  it("bounds source text and context without losing or misrepresenting scope checks", async () => {
    const f = fixture(); f.apiCall.mockResolvedValue({ ok: true, results: { messages: Array.from({ length: 20 }, (_, n) => ({ ...message(100 + n), content: "😀\n\"".repeat(10_000),
      context_messages: { before: Array.from({ length: 20 }, (_, j) => ({ ts: ts(1 + n * 20 + j), text: "context" })) },
    })) } });
    // Keep before timestamps actually before their parent.
    const raw = await f.apiCall(); raw.results.messages.forEach((m: { context_messages: { before: { ts: string }[] }; message_ts: string }, n: number) => { m.message_ts = ts(1000 + n); m.context_messages.before.forEach((c, j) => { c.ts = ts(1 + n * 20 + j); }); });
    raw.results.messages.forEach((m: { permalink: string; message_ts: string }) => { m.permalink = `https://synthetic.slack.com/archives/C1/p${m.message_ts.replace(".", "")}`; });
    f.apiCall.mockClear(); f.apiCall.mockResolvedValue(raw);
    const result = await f.reader.search({ query: "launch" }, f.context);
    expect(result).toMatchObject({ status: "ok", complete: false, truncated: true });
    expect(result.messages.filter(m => m.searchMatch)).toHaveLength(20); expect(result.messages.length).toBeLessThanOrEqual(40);
    expect(Buffer.byteLength(JSON.stringify(result.messages))).toBeLessThan(24_100); expect(result.messages.some(m => m.textTruncated)).toBe(true);
  });
  it("promotes a prior context-only message to the terminal page's actual match with full primary provenance", async () => {
    const f = fixture();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(2), context_messages: { after: [
      { ts: ts(3), text: "match 3", user_id: "UCONTEXT" },
    ] } }] }, response_metadata: { next_cursor: "next-page" } });
    const first = await f.reader.search({ query: "launch" }, f.context);
    expect(first.messages.find(m => m.ts === ts(3))).toMatchObject({ searchMatch: false, contextForTs: ts(2), author: { userId: "UCONTEXT" } });
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(3), author_user_id: "UBOT", is_author_bot: true, thread_ts: ts(1) }] } });
    const last = await f.reader.search({ query: "launch", cursor: first.nextCursor }, f.context);
    expect(last).toMatchObject({ status: "ok", page: 2, complete: true, truncated: false });
    expect(last.messages).toEqual([{ channel: "C1", ts: ts(3), text: "match 3", textTruncated: false,
      searchMatch: true, threadTs: ts(1), permalink: message(3).permalink, author: { userId: "UBOT", botId: null, kind: "bot" } }]);
    expect(last.messages[0].contextForTs).toBeUndefined(); expect(last.messages[0].contextPosition).toBeUndefined();
  });
  it("dedupes true primary repeats across pages without suppressing context-to-primary promotion", async () => {
    const f = fixture();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(2), context_messages: { after: [{ ts: ts(3), text: "match 3" }] } }] }, next_cursor: "page-2" });
    const first = await f.reader.search({ query: "launch" }, f.context);
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [message(2), message(3), message(3)] }, next_cursor: "page-3" });
    const second = await f.reader.search({ query: "launch", cursor: first.nextCursor }, f.context);
    expect(second.messages.map(m => [m.ts, m.searchMatch])).toEqual([[ts(3), true]]);
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [message(2), message(3), message(4)] } });
    const last = await f.reader.search({ query: "launch", cursor: second.nextCursor }, f.context);
    expect(last).toMatchObject({ status: "ok", complete: true, truncated: false });
    expect(last.messages.map(m => [m.ts, m.searchMatch])).toEqual([[ts(4), true]]);
  });
  it("returns one primary-preferred object per ts and dedupes same/later-page context with a representative relation", async () => {
    const f = fixture();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [
      { ...message(2), context_messages: { after: [{ ts: ts(3), text: "match 3" }, { ts: ts(4), text: "match 4" }] } },
      { ...message(4), context_messages: { before: [{ ts: ts(3), text: "match 3", user_id: "UOTHER" }] } },
    ] }, next_cursor: "next" });
    const first = await f.reader.search({ query: "launch" }, f.context);
    expect(first.messages.map(m => [m.ts, m.searchMatch])).toEqual([[ts(2), true], [ts(3), false], [ts(4), true]]);
    expect(first.messages.find(m => m.ts === ts(3))).toMatchObject({ contextForTs: ts(2), contextPosition: "after" });
    expect(first.messages.find(m => m.ts === ts(4))).toMatchObject({ permalink: message(4).permalink });
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(5), context_messages: { before: [
      { ts: ts(3), text: "match 3" }, { ts: ts(4), text: "match 4" },
    ] } }] } });
    const last = await f.reader.search({ query: "launch", cursor: first.nextCursor }, f.context);
    expect(last.messages.map(m => [m.ts, m.searchMatch])).toEqual([[ts(5), true]]); expect(last.complete).toBe(true);
  });
  it.each(["primary", "context"])("preserves cross-page text conflict rejection for prior %s delivery", async role => {
    const f = fixture();
    const messages = role === "primary" ? [message(3)] : [{ ...message(2), context_messages: { after: [{ ts: ts(3), text: "match 3" }] } }];
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages }, next_cursor: "next" });
    const first = await f.reader.search({ query: "launch" }, f.context);
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(3), content: "conflicting original" }] } });
    expect(await f.reader.search({ query: "launch", cursor: first.nextCursor }, f.context)).toMatchObject({ status: "unavailable", messages: [], complete: false });
  });
  it("does not mark capped-out context delivered; later primary is returned but traversal stays truncated", async () => {
    const f = fixture();
    const contexts = Array.from({ length: 20 }, (_, n) => ({ ts: ts(10 + n), text: `match ${10 + n}` }));
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [
      { ...message(2), context_messages: { after: contexts } },
      { ...message(3), context_messages: { after: contexts.map((c, n) => n === 19 ? { ts: ts(30), text: "match 30" } : c) } },
      ...Array.from({ length: 18 }, (_, n) => message(100 + n)),
    ] }, next_cursor: "next" });
    const first = await f.reader.search({ query: "launch" }, f.context);
    expect(first).toMatchObject({ status: "ok", complete: false, truncated: true });
    expect(first.messages).toHaveLength(40); expect(first.messages.some(m => m.ts === ts(30))).toBe(false);
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [message(30)] } });
    const last = await f.reader.search({ query: "launch", cursor: first.nextCursor }, f.context);
    expect(last.messages).toEqual([expect.objectContaining({ ts: ts(30), searchMatch: true, permalink: message(30).permalink })]);
    expect(last).toMatchObject({ status: "ok", complete: false, truncated: true });
  });
  it("binds opaque search cursors to query/limit/requester/team/current channel/request and rechecks membership", async () => {
    const f = fixture(); f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [message()] }, response_metadata: { next_cursor: "RAW_SEARCH_CURSOR" } });
    const first = await f.reader.search({ query: "launch", limit: 2 }, f.context); const cursor = first.nextCursor!;
    expect(first.complete).toBe(false); expect(cursor).not.toContain("RAW_SEARCH_CURSOR");
    for (const changes of [{ userId: "UOTHER" }, { teamId: "TOTHER" }, { channel: "COTHER" }, { requestId: "event:other" }]) {
      expect((await f.reader.search({ query: "launch", limit: 2, cursor }, ctx(changes))).status).toBe("invalid_target");
    }
    expect((await f.reader.search({ query: "different", limit: 2, cursor }, f.context)).status).toBe("invalid_target");
    expect((await f.reader.search({ query: "launch", limit: 1, cursor }, f.context)).status).toBe("invalid_target");
    expect((await f.reader.read("channel", { cursor }, f.context)).status).toBe("invalid_target");
    f.members.mockResolvedValueOnce({ ok: true, members: [] });
    expect((await f.reader.search({ query: "launch", limit: 2, cursor }, f.context)).status).toBe("access_denied");
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [message(3)] } });
    expect(await f.reader.search({ query: "launch", limit: 2, cursor }, f.context)).toMatchObject({ status: "ok", complete: true, page: 2 });
    expect(f.apiCall.mock.calls.at(-1)![1]).toMatchObject({ cursor: "RAW_SEARCH_CURSOR", action_token: token, limit: 2 });
    expect((await f.reader.search({ query: "launch", limit: 2, cursor }, f.context)).status).toBe("invalid_target");
  });
  it("stops after 4 explicit pages and expires cursors without broad scanning", async () => {
    const f = fixture(); f.apiCall.mockImplementation(async () => ({ ok: true, results: { messages: [message(f.apiCall.mock.calls.length)] }, next_cursor: `raw-${f.apiCall.mock.calls.length}` }));
    let cursor: string | undefined;
    for (let page = 1; page <= 4; page++) {
      const result = await f.reader.search({ query: "launch", ...(cursor ? { cursor } : {}) }, f.context);
      expect(result).toMatchObject({ status: "ok", page, complete: false, truncated: true });
      cursor = result.nextCursor ?? undefined;
      if (page === 4) expect(result.nextCursor).toBeNull(); else expect(cursor).toBeTruthy();
    }
    expect(f.apiCall).toHaveBeenCalledTimes(4); expect(f.history).not.toHaveBeenCalled();
    const first = await f.reader.search({ query: "launch" }, f.context);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000);
    try { expect((await f.reader.search({ query: "launch", cursor: first.nextCursor }, f.context)).status).toBe("invalid_target"); } finally { clock.mockRestore(); }
  });
  it("rejects replay loops and concurrent opaque cursor consumption", async () => {
    const f = fixture(); f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [message()] }, response_metadata: { next_cursor: "cursor-1" } });
    const first = await f.reader.search({ query: "launch" }, f.context);
    let release!: () => void, entered!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.apiCall.mockImplementationOnce(async () => { entered(); await hold; return { ok: true, results: { messages: [message(3)] }, response_metadata: { next_cursor: "cursor-1" } }; });
    const next = f.reader.search({ query: "launch", cursor: first.nextCursor }, f.context);
    await started;
    expect((await f.reader.search({ query: "launch", cursor: first.nextCursor }, f.context)).status).toBe("invalid_target");
    release(); expect((await next).status).toBe("unavailable");
    expect(f.apiCall).toHaveBeenCalledTimes(2);
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [message(3)] } });
    expect((await f.reader.search({ query: "launch", cursor: first.nextCursor }, f.context)).status).toBe("ok");
  });
  it("does not trust public channel type without explicit is_private=false", async () => {
    const f = fixture(); f.info.mockResolvedValue({ ok: true, channel: { id: "C1", is_channel: true } });
    expect((await f.reader.search({ query: "launch" }, f.context)).status).toBe("unsupported"); expect(f.apiCall).not.toHaveBeenCalled();
  });
  it("silences SDK logs at all levels even for request bodies bearing action_token", () => {
    const log = vi.spyOn(console, "log"), error = vi.spyOn(console, "error"), warn = vi.spyOn(console, "warn");
    try {
      silentSlackLogger.setLevel("debug" as never);
      for (const method of ["debug", "info", "warn", "error"] as const) silentSlackLogger[method]({ action_token: token });
      expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled();
    } finally { log.mockRestore(); error.mockRestore(); warn.mockRestore(); }
  });
});
