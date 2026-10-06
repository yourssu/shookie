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
  return { spy, records: () => spy.mock.calls.filter(([name]) => ["slack_action_token_diagnostic", "slack_search_response_diagnostic", "slack_read_response_diagnostic"].includes(name as string)) };
}
function localUnavailable() {
  try { unavailable(); } catch (error) { return (error as { result: { message: string } }).result.message; }
}

describe("role-aware fingerprint guards without temporary emits (synthetic)", () => {
  it.each([
    ["primary", "primary", [message(), { ...message(), content: "other" }]],
    ["primary", "context", [message(), { ...message(3), context_messages: { before: [{ ts: ts(2), text: "other" }] } }]],
    ["context", "context", [{ ...message(3), context_messages: { before: [{ ts: ts(2), text: "first" }, { ts: ts(2), text: "other" }] } }]],
    // Last equal observation is context, even though the projected representative remains primary.
    ["context", "context", [message(), { ...message(3), context_messages: { before: [
      { ts: ts(2), text: "match 2" }, { ts: ts(2), text: "other" },
    ] } }]],
  ])("rejects conflicting page roles %s -> %s, including nonwinning observations", async (priorRole, currentRole, messages) => {
    const d = diagnostics(), f = fixture(); f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages } });
    expect(await f.reader.search({ query: "launch" }, f.context)).toMatchObject({ status: "unavailable", message: localUnavailable(), messages: [], nextCursor: null });
    expect(d.records()).toEqual([]);
    for (const value of ["other", "first", "match 2", ts(2), "C1", "T1", token, "launch"]) expect(JSON.stringify(d.spy.mock.calls)).not.toContain(JSON.stringify(value));
  });
  it.each(["primary", "context"] as const)("uses cursor delivered %s role, never persists or recovers prior text", async priorRole => {
    const d = diagnostics(), f = fixture();
    const messages = priorRole === "primary" ? [message()] : [{ ...message(3), context_messages: { before: [{ ts: ts(2), text: "match 2" }] } }];
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages }, next_cursor: token });
    const first = await f.reader.search({ query: "launch" }, f.context);
    for (const currentRole of ["primary", "context"] as const) {
      d.spy.mockClear();
      const current = currentRole === "primary" ? [{ ...message(), content: "other" }] : [{ ...message(4), context_messages: { before: [{ ts: ts(2), text: "other" }] } }];
      f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: current } });
      expect(await f.reader.search({ query: "launch", cursor: first.nextCursor }, f.context)).toMatchObject({ status: "unavailable", message: localUnavailable() });
      expect(d.records()).toEqual([]);
    }
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [message()] } });
    expect(await f.reader.search({ query: "launch", cursor: first.nextCursor }, f.context)).toMatchObject({ status: "ok", page: 2 });
  });
  it("after an equal cursor-to-primary promotion observes the latest page context, not seed role", async () => {
    const d = diagnostics(), f = fixture();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(3), context_messages: { before: [{ ts: ts(2), text: "match 2" }] } }] }, next_cursor: token });
    const first = await f.reader.search({ query: "launch" }, f.context);
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [message(), { ...message(4), context_messages: { before: [
      { ts: ts(2), text: "match 2" }, { ts: ts(2), text: "match 2 tail" },
    ] } }] } });
    expect((await f.reader.search({ query: "launch", cursor: first.nextCursor }, f.context)).status).toBe("unavailable");
    expect(d.records()).toEqual([]);
  });
  it.each([
    [" value ", "value", true, true, false, "neither"],
    ["a\r\nb", "a\nb", true, false, true, "neither"],
    ["a tail", "a", true, false, false, "current_prefix"],
    ["a".repeat(24_001), "a", false, false, false, "unknown"],
    ["a", "😀".repeat(6_001), false, false, false, "unknown"],
  ])("fails closed for unequal same-role text regardless of normalization, prefix or size", async (previous, current) => {
    const d = diagnostics(), f = fixture();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(), content: previous }, { ...message(), content: current }] } });
    expect(await f.reader.search({ query: "launch" }, f.context)).toMatchObject({ status: "unavailable", message: localUnavailable(), messages: [] });
    expect(d.records()).toEqual([]);
    expect(JSON.stringify(d.spy.mock.calls)).not.toContain(JSON.stringify(previous)); expect(JSON.stringify(d.spy.mock.calls)).not.toContain(JSON.stringify(current));
  });
  it("uses only parsed/projected copies; raw content getter/proxy accesses and toJSON are not increased", async () => {
    const d = diagnostics(), f = fixture(); const toJSON = vi.fn(() => { throw new Error(token); });
    const getter = vi.fn(() => "other");
    const raw = Object.defineProperty({ ...message(), toJSON }, "content", { get: getter });
    const gets: string[] = [];
    const proxied = new Proxy(raw, { get(target, key, receiver) { if (key === "content") gets.push("content"); return Reflect.get(target, key, receiver); } });
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [message(), proxied] } });
    expect((await f.reader.search({ query: "launch" }, f.context)).status).toBe("unavailable");
    expect(getter).toHaveBeenCalledTimes(1); expect(gets).toEqual(["content"]); expect(toJSON).not.toHaveBeenCalled();
    expect(d.records()).toEqual([]);
  });
  it("reads explicit kind evidence only from parsed copies, without extra raw getter/proxy/toJSON access", async () => {
    const d = diagnostics(), f = fixture(), toJSON = vi.fn(() => { throw new Error(token); });
    const primaryFlag = vi.fn(() => true), contextFlag = vi.fn(() => undefined), botId = vi.fn(() => undefined), user = vi.fn(() => "U2");
    const contextual = Object.defineProperties({ ts: ts(2), text: "short longer", toJSON }, {
      is_author_bot: { get: contextFlag, enumerable: true }, bot_id: { get: botId, enumerable: true }, user_id: { get: user, enumerable: true },
    });
    const raw = Object.defineProperty({ ...message(), content: "short", toJSON }, "is_author_bot", { get: primaryFlag, enumerable: true });
    const gets: string[] = [];
    const proxied = new Proxy(contextual, { get(target, key, receiver) {
      if (["is_author_bot", "bot_id", "user_id"].includes(String(key))) gets.push(String(key));
      return Reflect.get(target, key, receiver);
    } });
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [raw, { ...message(4), context_messages: { before: [proxied] } }] } });
    expect(await f.reader.search({ query: "launch" }, f.context)).toMatchObject({ status: "ok", complete: false,
      messages: [{ author: { kind: "bot", userId: "U2" }, textTruncated: true }, {}] });
    for (const getter of [primaryFlag, contextFlag, botId, user]) expect(getter).toHaveBeenCalledTimes(1);
    expect(gets.sort()).toEqual(["bot_id", "is_author_bot", "user_id"]);
    expect(toJSON).not.toHaveBeenCalled();
    expect(d.records()).toEqual([]);
  });
  it("tracks conflicts for budget-omitted candidates and keeps cursor state role-hash-only", async () => {
    const d = diagnostics(), f = fixture();
    const before = Array.from({ length: 20 }, (_, n) => ({ ts: ts(n + 1), text: `PRIVATE_CONTEXT_${n}` }));
    const messages = Array.from({ length: 20 }, (_, n) => message(100 + n));
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [
      { ...messages[0], context_messages: { before } },
      { ...messages[1], context_messages: { before: [{ ts: ts(21), text: "PRIVATE_OMITTED" }] } },
      ...messages.slice(2),
    ] }, next_cursor: "safe-cursor" });
    const first = await f.reader.search({ query: "launch" }, f.context);
    expect(first).toMatchObject({ status: "ok", truncated: true }); expect(first.messages).toHaveLength(40);
    const searcher = (f.reader as unknown as { searcher: { cursors: Map<string, object> } }).searcher;
    const state = searcher.cursors.get(first.nextCursor!)!;
    expect(Object.keys(state).sort()).toEqual(["binding", "cursor", "deliveredRoles", "expires", "fingerprints", "lossy", "page", "used"]);
    for (const text of ["PRIVATE_CONTEXT_", "PRIVATE_OMITTED", "match 100"]) expect(JSON.stringify(state)).not.toContain(text);
    d.spy.mockClear();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [
      { ...messages[0], context_messages: { before } },
      { ...messages[1], context_messages: { before: [{ ts: ts(21), text: "PRIVATE_OMITTED" }, { ts: ts(21), text: "PRIVATE_CHANGED" }] } },
      ...messages.slice(2),
    ] } });
    expect((await f.reader.search({ query: "launch" }, f.context)).status).toBe("unavailable");
    expect(d.records()).toEqual([]);
    for (const text of ["PRIVATE_CONTEXT_", "PRIVATE_OMITTED", "PRIVATE_CHANGED"]) expect(JSON.stringify(d.spy.mock.calls)).not.toContain(text);
  });
  it("throwing logger preserves conflict failure, cursor finally unlock and retry promotion", async () => {
    const d = diagnostics(), f = fixture();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(3), context_messages: { before: [{ ts: ts(2), text: "match 2" }] } }] }, next_cursor: token });
    const first = await f.reader.search({ query: "launch" }, f.context);
    d.spy.mockImplementation(() => { throw new Error(token); });
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(), content: "other" }] } });
    expect(await f.reader.search({ query: "launch", cursor: first.nextCursor }, f.context)).toMatchObject({ status: "unavailable", message: localUnavailable(), messages: [] });
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [message()] } });
    expect(await f.reader.search({ query: "launch", cursor: first.nextCursor }, f.context)).toMatchObject({ status: "ok", page: 2, messages: [{ searchMatch: true }] });
    expect(f.apiCall).toHaveBeenCalledTimes(3);
  });
});

describe("permalink rejection guards without temporary emits", () => {
  const canonical = message().permalink;
  it.each([
    [token, { permalinkParsed: false, permalinkCanonicalHref: false, permalinkHttps: false, permalinkHost: false,
      permalinkNoUserinfo: false, permalinkNoPort: false, permalinkNoHash: false, permalinkNoQuery: false,
      permalinkPath: false, hostClass: "other", pathShape: "other", pathChannelMatch: false, pathMessageTsMatch: false, queryClass: "unknown" }],
    [canonical.replace("https:", "http:"), { permalinkHttps: false }],
    [canonical.replace("synthetic", "SYNTHETIC"), { permalinkCanonicalHref: false }],
    [` ${canonical}`, { permalinkCanonicalHref: false }],
    [canonical.replace(".com/", ".com:443/"), { permalinkCanonicalHref: false }],
    [canonical.replace(".com/", ".com:444/"), { permalinkNoPort: false }],
    [canonical.replace("https://", `https://${token}@`), { permalinkNoUserinfo: false }],
    [canonical.replace("https://", `https://:${token}@`), { permalinkNoUserinfo: false }],
    [`${canonical}#${token}`, { permalinkNoHash: false }],
    [canonical.replace("synthetic.slack.com", "private.invalid"), { permalinkHost: false, hostClass: "other" }],
    [canonical.replace("synthetic.slack.com", "app.slack.com"), { permalinkHost: false, hostClass: "app.slack.com" }],
    [canonical.replace("synthetic.slack.com", "slack.com"), { permalinkHost: false, hostClass: "slack.com" }],
    [canonical.replace("C1", "COTHER"), { permalinkPath: false, pathChannelMatch: false }],
    [canonical.replace(/000002$/, "000003"), { permalinkPath: false, pathMessageTsMatch: false }],
    [canonical.replace(/p[0-9]+$/, "p17000000002"), { permalinkPath: false, pathMessageTsMatch: false }],
    [canonical.replace("/archives/", "/else/"), { permalinkPath: false, pathShape: "other", pathChannelMatch: false, pathMessageTsMatch: false }],
    [`${canonical}?thread_ts=1700000000.1&cid=COTHER`, { permalinkNoQuery: false, queryClass: "known", queryThreadTsPresent: true, queryCidPresent: true }],
    [`${canonical}?thread_ts=${ts(1)}&thread_ts=${token}&cid=C1&cid=C1`, { permalinkNoQuery: false, queryClass: "known",
      queryThreadTsPresent: true, queryCidPresent: true, queryCidMatch: true, queryDuplicate: true }],
    [`${canonical}?${token}=${token}&thread_ts=${ts(1)}`, { permalinkNoQuery: false, queryClass: "unknown", queryThreadTsPresent: true, queryThreadTsMatch: true }],
    [`http://${token}:${token}@external.invalid:444/archives/COTHER/p123?${token}=${token}#${token}`, {
      permalinkHttps: false, permalinkHost: false, permalinkNoUserinfo: false, permalinkNoPort: false,
      permalinkNoHash: false, permalinkNoQuery: false, permalinkPath: false, hostClass: "other",
      pathChannelMatch: false, pathMessageTsMatch: false, queryClass: "unknown" }],
    [`${canonical}?${"a&".repeat(200)}`, { permalinkNoQuery: false, queryClass: "unknown" }],
    [`${canonical}?&&`, { permalinkNoQuery: false, queryClass: "unknown" }],
  ])("rejects each unsafe synthetic URL without logging it", async (permalink, _changes) => {
    const d = diagnostics(), f = fixture();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(), thread_ts: ts(1), permalink }] } });
    expect(await f.reader.search({ query: "launch" }, f.context)).toMatchObject({ status: "unavailable", message: localUnavailable(), messages: [], nextCursor: null });
    expect(d.records()).toEqual([]);
    expect(f.apiCall).toHaveBeenCalledTimes(1);
    for (const secret of [token, "synthetic.slack.com", "private.invalid", "external.invalid", "COTHER", "C1", "T1", ts(1), ts(2), "launch"]) {
      expect(JSON.stringify(d.spy.mock.calls)).not.toContain(secret);
    }
  });
  it("keeps the original 512-char schema bound before URL parsing", async () => {
    const d = diagnostics(), f = fixture();
    const prefix = `${canonical}?cid=`;
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(), permalink: prefix + "x".repeat(513 - prefix.length) }] } });
    expect((await f.reader.search({ query: "launch" }, f.context)).status).toBe("unavailable");
    expect(d.records()).toEqual([]);
  });
  it("query parser exceptions retain local rejection", async () => {
    const d = diagnostics(), f = fixture();
    vi.spyOn(URL.prototype, "searchParams", "get").mockImplementation(() => { throw new Error(token); });
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(), permalink: `${canonical}?cid=C1` }] } });
    expect(await f.reader.search({ query: "launch" }, f.context)).toMatchObject({ status: "unavailable", message: localUnavailable() });
    expect(d.records()).toEqual([]); expect(JSON.stringify(d.spy.mock.calls)).not.toContain(token);
  });
  it("does not emit a rejection vector for accepted canonical or missing permalinks", async () => {
    const d = diagnostics(), f = fixture();
    // Bare delimiters have empty URL.search/hash under the original predicate; keep that behavior too.
    for (const permalink of [canonical, `${canonical}?`, `${canonical}#`, undefined, ""]) {
      d.spy.mockClear(); f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(), permalink }] } });
      const result = await f.reader.search({ query: "launch" }, f.context);
      expect(result.status).toBe("ok");
      expect(result.messages[0].permalink).toBe(permalink || undefined);
      expect(d.records()).toEqual([]);
    }
  });
  it("rejects empty cid even when parent thread timestamp is absent", async () => {
    const d = diagnostics(), f = fixture();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(), permalink: `${canonical}?thread_ts=${ts(1)}&cid=` }] } });
    expect((await f.reader.search({ query: "launch" }, f.context)).status).toBe("unavailable");
    expect(d.records()).toEqual([]);
  });
  it("never adds accesses to raw response getters, metadata or toJSON", async () => {
    const d = diagnostics(), f = fixture();
    const getter = vi.fn(() => `${canonical}?${token}=${token}`), toJSON = vi.fn(() => { throw new Error(token); });
    const item = Object.defineProperty({ ...message(), toJSON }, "permalink", { get: getter });
    const raw = { ok: true, results: { messages: [item] }, metadata: { toJSON } };
    f.apiCall.mockResolvedValueOnce(raw);
    expect((await f.reader.search({ query: "launch" }, f.context)).status).toBe("unavailable");
    expect(getter).toHaveBeenCalledTimes(1); // Existing Zod access only; observation uses its parsed copy.
    expect(toJSON).not.toHaveBeenCalled(); expect(JSON.stringify(d.spy.mock.calls)).not.toContain(token);
  });
  it("throwing logger preserves permalink failure and continuation cursor unlock/retry", async () => {
    const d = diagnostics(), f = fixture();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [message()] }, next_cursor: token });
    const first = await f.reader.search({ query: "launch" }, f.context);
    d.spy.mockImplementation(() => { throw new Error(token); });
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(3), permalink: `${canonical}?cid=C1` }] } });
    expect(await f.reader.search({ query: "launch", cursor: first.nextCursor }, f.context)).toMatchObject({ status: "unavailable", message: localUnavailable() });
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [message(3)] } });
    expect(await f.reader.search({ query: "launch", cursor: first.nextCursor }, f.context)).toMatchObject({ status: "ok", page: 2 });
    expect(f.apiCall).toHaveBeenCalledTimes(3);
  });
});

describe("validated navigation query normalization (synthetic Slack API)", () => {
  it.each([
    `thread_ts=${ts(1)}&cid=C1`, `cid=C1&thread_ts=${ts(1)}`, "cid=C1", `thread_ts=${ts(1)}`,
    `%74hread_ts=${ts(1)}&%63id=C1`, `thread_ts=${ts(2)}`, "thread_ts=1700000000.0",
    "thread_ts=0000001700000000.0", "thread_ts=1.1", "thread_ts=1700000000%2E000001",
  ])("strips safe query %s without promoting a query root to metadata or context provenance", async query => {
    const d = diagnostics(), f = fixture();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(),
      permalink: `${message().permalink}?${query}`,
      context_messages: { before: [{ ts: ts(1), text: "context", user_id: "U3" }] },
    }] } });
    const result = await f.reader.search({ query: "launch" }, f.context);
    expect(result).toMatchObject({ status: "ok", complete: true, nextCursor: null });
    expect(readOutput.safeParse(result).success).toBe(true);
    expect(result.messages[1]).toMatchObject({ ts: ts(2), permalink: message().permalink, searchMatch: true });
    expect(result.messages.every(m => m.threadTs === undefined)).toBe(true);
    expect(result.messages[0]).toMatchObject({ searchMatch: false, contextForTs: ts(2), contextPosition: "before" });
    expect(d.records()).toEqual([]);
    expect(f.apiCall).toHaveBeenCalledTimes(1); expect(f.history).not.toHaveBeenCalled(); expect(f.replies).not.toHaveBeenCalled();
    for (const secret of [query, message().permalink, ts(1), ts(2), token, "context", "C1", "U3"]) {
      expect(JSON.stringify(d.spy.mock.calls)).not.toContain(secret);
    }
  });
  it.each(["1700000000.1", "1700000000.10", "1700000000.100", "1700000000.1000", "1700000000.10000", "1700000000.100000"])("normalizes query/root metadata fractions together: %s", async root => {
    const f = fixture();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(200000), message_ts: "1700000000.2", thread_ts: "1700000000.1",
      permalink: `${message(200000).permalink}?cid=C1&thread_ts=${root}` }] } });
    expect(await f.reader.search({ query: "launch" }, f.context)).toMatchObject({ status: "ok",
      messages: [{ ts: ts(200000), threadTs: ts(100000), permalink: message(200000).permalink }] });
  });
  it("compares bounded timestamps as integers without floating-point precision loss", async () => {
    const f = fixture(), whole = "9999999999999999";
    const permalink = `https://synthetic.slack.com/archives/C1/p${whole}000002`;
    for (const [root, status] of [[`${whole}.000001`, "ok"], [`${whole}.000002`, "ok"], [`${whole}.000003`, "unavailable"]]) {
      f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(), message_ts: `${whole}.000002`, permalink: `${permalink}?thread_ts=${root}` }] } });
      expect((await f.reader.search({ query: "launch" }, f.context)).status).toBe(status);
    }
  });
  it.each([
    "unknown=value", "=value", "cid", "cid=", "thread_ts", "thread_ts=", "cid=COTHER", "cid=c1",
    "cid=C1&cid=C1", "cid=C1&%63id=C1", "cid=&cid=C1", "thread_ts=&thread_ts=1700000000.000001",
    `thread_ts=${ts(1)}&thread_ts=${ts(1)}`, "thread_ts=1700000000.000001&%74hread_ts=1700000000.000002",
    "thread_ts=1700000000.000003", "thread_ts=1700000001.0", "thread_ts=1700000000", "thread_ts=.1",
    "thread_ts=1700000000.", "thread_ts=1700000000.0000001", "thread_ts=10000000000000000.1",
    "thread_ts=-1.1", "thread_ts=1e3.1", "thread_ts=1700000000%2E%FF", "thread_ts=%C0%AF",
    "thread_ts=1700000000.000001%", "thread_ts=1700000000.000001+", "threa%FFd_ts=1700000000.1",
    "cid=C1&unknown=value", "cid=C1&=value", "&&",
  ])("fails closed on %s, retains the cursor for retry and never looks up a fallback", async query => {
    const d = diagnostics(), f = fixture();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [message()] }, next_cursor: "page-2" });
    const first = await f.reader.search({ query: "launch" }, f.context);
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [message(1), { ...message(), permalink: `${message().permalink}?${query}` }] }, next_cursor: "page-3" });
    const result = await f.reader.search({ query: "launch", cursor: first.nextCursor }, f.context);
    expect(result).toMatchObject({ status: "unavailable", message: localUnavailable(), messages: [], nextCursor: null, complete: false });
    expect(d.records()).toEqual([]);
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [message(4)] } });
    expect(await f.reader.search({ query: "launch", cursor: first.nextCursor }, f.context)).toMatchObject({ status: "ok", page: 2, complete: true });
    expect(f.apiCall).toHaveBeenCalledTimes(3);
    expect(f.history).not.toHaveBeenCalled(); expect(f.replies).not.toHaveBeenCalled();
    expect(JSON.stringify(d.spy.mock.calls)).not.toContain(query);
  });
  it("does not give a query root any authority over context thread provenance or trusted identity", async () => {
    const f = fixture(), identity = getSlackReadIdentity(f.context);
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(),
      permalink: `${message().permalink}?thread_ts=${ts(1)}&cid=C1`,
      context_messages: { before: [{ ts: ts(1), thread_ts: ts(0), text: "independent context" }] },
    }] } });
    const result = await f.reader.search({ query: "launch" }, f.context);
    expect(result.status).toBe("ok");
    expect(result.messages[0]).toMatchObject({ threadTs: ts(0), searchMatch: false, contextForTs: ts(2) });
    expect(result.messages[1]).not.toHaveProperty("threadTs");
    expect(result.source).toEqual({ channel: "C1" });
    expect(getSlackReadIdentity(f.context)).toBe(identity);
  });
  it("rejects a safe-looking query root that conflicts with authoritative thread metadata", async () => {
    const f = fixture();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(), thread_ts: ts(1), permalink: `${message().permalink}?thread_ts=${ts(2)}&cid=C1` }] } });
    expect(await f.reader.search({ query: "launch" }, f.context)).toMatchObject({ status: "unavailable", messages: [], nextCursor: null });
  });
  it.each([
    (url: string) => url.replace("synthetic", "external"), (url: string) => url.replace("C1", "COTHER"),
    (url: string) => url.replace(/000002$/, "000003"), (url: string) => url.replace("synthetic", "SYNTHETIC"),
    (url: string) => url.replace(".com/", ".com:443/"), (url: string) => url.replace(".com/", ".com:444/"),
    (url: string) => url.replace("https://", "https://user@"), (url: string) => url.replace("https:", "http:"),
  ])("known query cannot relax the original authority/path guards", async mutate => {
    const f = fixture(); f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(), permalink: `${mutate(message().permalink)}?cid=C1&thread_ts=${ts(1)}` }] } });
    expect((await f.reader.search({ query: "launch" }, f.context)).status).toBe("unavailable");
  });
  it("known query cannot relax fragment guards, but bare hash stays accepted and is stripped", async () => {
    const f = fixture();
    for (const [hash, status] of [["#fragment", "unavailable"], ["#", "ok"]]) {
      f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(), permalink: `${message().permalink}?cid=C1${hash}` }] } });
      const result = await f.reader.search({ query: "launch" }, f.context);
      expect(result.status).toBe(status);
      if (status === "ok") expect(result.messages[0].permalink).toBe(message().permalink);
    }
  });
});

describe("search response guards and privacy without temporary emits", () => {
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
    expect(d.records()).toEqual([]);
    expect(JSON.stringify(d.spy.mock.calls)).not.toContain(token);
    expect(f.history).not.toHaveBeenCalled(); expect(f.replies).not.toHaveBeenCalled();
  });
  it("distinguishes API call rejection, check failure and schema failure without error codes", async () => {
    const d = diagnostics(), f = fixture();
    f.apiCall.mockRejectedValueOnce({ message: token });
    expect((await f.reader.search({ query: "launch" }, f.context)).status).toBe("unavailable");
    expect(d.records()).toEqual([]);
    d.spy.mockClear(); f.apiCall.mockResolvedValueOnce({ ok: false, error: token });
    expect((await f.reader.search({ query: "launch" }, f.context)).status).toBe("unavailable");
    expect(d.records()).toEqual([]);
    d.spy.mockClear(); f.apiCall.mockResolvedValueOnce({ ok: true });
    expect((await f.reader.search({ query: "launch" }, f.context)).message).toBe(localUnavailable());
    expect(d.records()).toEqual([]);
    expect(f.apiCall).toHaveBeenCalledTimes(3); expect(JSON.stringify(d.spy.mock.calls)).not.toContain(token);
  });
  it.each(["message_ts", "content", "team_id", "channel_id", "is_author_bot"] as const)("distinguishes missing/invalid required %s in the unchanged response schema", async field => {
    const d = diagnostics(), f = fixture();
    for (const value of [undefined, null]) {
      f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(), [field]: value }] } });
      expect(await f.reader.search({ query: "launch" }, f.context)).toMatchObject({ status: "unavailable", message: localUnavailable() });
      expect(d.records()).toEqual([]);
    }
    expect(f.apiCall).toHaveBeenCalledTimes(2);
  });
  it("maps nonempty metadata warnings to the existing schema rejection", async () => {
    const d = diagnostics(), f = fixture();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [] }, response_metadata: { warnings: [token] } });
    expect((await f.reader.search({ query: "launch" }, f.context)).message).toBe(localUnavailable());
    expect(d.records()).toEqual([]);
    expect(JSON.stringify(d.spy.mock.calls)).not.toContain(token);
  });
  it("rejects parser/check exceptions without additional response reads", async () => {
    const d = diagnostics(), f = fixture(), execute = vi.fn(() => { throw new Error(token); });
    const raw = Object.defineProperty({ ok: true }, "results", { get: execute });
    f.apiCall.mockResolvedValueOnce(raw);
    expect((await f.reader.search({ query: "launch" }, f.context)).status).toBe("unavailable");
    expect(execute).toHaveBeenCalledTimes(1); // Existing Zod parser read only.
    expect(d.records()).toEqual([]);
    execute.mockClear(); f.apiCall.mockResolvedValueOnce(Object.defineProperty({}, "ok", { get: execute }));
    expect((await f.reader.search({ query: "launch" }, f.context)).status).toBe("unavailable");
    expect(execute).toHaveBeenCalledTimes(1); expect(d.records()).toEqual([]);
    expect(JSON.stringify(d.spy.mock.calls)).not.toContain(token);
  });
  it("observes missing prerequisites and authorization failures before API", async () => {
    const d = diagnostics(), f = fixture(); f.auth.mockResolvedValueOnce({ ok: true, bot_id: "B1", team_id: "T1" });
    expect((await f.reader.search({ query: "launch" }, f.context)).message).toBe(localUnavailable());
    expect(d.records()).toEqual([]);
    f.members.mockResolvedValueOnce({ ok: true, members: [] });
    expect((await f.reader.search({ query: "launch" }, f.context)).status).toBe("access_denied");
    expect(d.records()).toEqual([]); expect(f.apiCall).not.toHaveBeenCalled();
  });
  it("identifies the defensive header budget path without changing its failure", async () => {
    const d = diagnostics(), f = fixture(); const byteLength = Buffer.byteLength;
    vi.spyOn(Buffer, "byteLength").mockImplementation((value, encoding) =>
      typeof value === "string" && value.includes('"text":""') ? 24_001 : byteLength(value, encoding));
    expect(await f.reader.search({ query: "launch" }, f.context)).toMatchObject({ status: "unavailable", message: localUnavailable() });
    expect(d.records()).toEqual([]); expect(f.apiCall).toHaveBeenCalledTimes(1);
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
    expect(d.records()).toEqual([]);
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [message(3)] } });
    expect(await f.reader.search({ query: "launch", cursor: first.nextCursor }, f.context)).toMatchObject({ status: "ok", page: 2 });
    expect(f.apiCall).toHaveBeenCalledTimes(4);
  });
  it("success emits no temporary diagnostics or result bodies/metadata", async () => {
    const d = diagnostics(), f = fixture(); const secret = "SECRET_SUCCESS_CONTENT";
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(), content: secret }] }, secret: token });
    expect((await f.reader.search({ query: "launch" }, f.context)).status).toBe("ok");
    expect(d.records()).toEqual([]);
    for (const value of [secret, token, "synthetic.slack.com", "U2", "C1", "T1", "launch", ts(2)]) expect(JSON.stringify(d.spy.mock.calls)).not.toContain(value);
  });
});

describe("narrow primary-short/context-long representations (synthetic, not live E2E)", () => {
  const short = "synthetic short", long = `${short} longer context 😀`;
  const pair = (content = short, text = long, contextMeta = {}) => [
    { ...message(2), content },
    { ...message(4), context_messages: { before: [{ ts: ts(2), text, ...contextMeta }] } },
  ];
  it("keeps short primary metadata, honest partial and first context relation without extra logs", async () => {
    const d = diagnostics(), f = fixture();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: pair(short, long, { user_id: "U2", thread_ts: ts(1) }) } });
    const result = await f.reader.search({ query: "launch" }, f.context);
    expect(result).toMatchObject({ status: "ok", complete: false, truncated: true });
    expect(result.messages[0]).toEqual({ channel: "C1", ts: ts(2), text: short, textTruncated: true,
      author: { userId: "U2", botId: null, kind: "participant" }, searchMatch: true, permalink: message(2).permalink });
    expect(result.messages).toHaveLength(2); expect(readOutput.safeParse(result).success).toBe(true);
    expect(d.records()).toEqual([]);
    for (const value of [short, long, token, message(2).permalink, ts(2)]) expect(JSON.stringify(d.spy.mock.calls)).not.toContain(value);
    expect(f.history).not.toHaveBeenCalled(); expect(f.replies).not.toHaveBeenCalled();
  });
  it.each([
    [short, "nonprefix"], [long, short], [" value ", "value"], ["a\r\nb", "a\nb"],
  ])("rejects unverified alternate representations %s / %s", async (primary, contextual) => {
    const d = diagnostics(), f = fixture(); f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: pair(primary, contextual) } });
    expect(await f.reader.search({ query: "launch" }, f.context)).toMatchObject({ status: "unavailable", messages: [] });
    expect(d.records()).toEqual([]);
  });
  it.each([
    [{ user_id: "UOTHER" }, "cross_role_user"],
    [{ is_author_bot: true, bot_id: "BOTHER" }, "cross_role_kind"],
    [{ thread_ts: ts(3) }, "cross_role_thread"],
    [{ user_id: "UOTHER", is_author_bot: true, thread_ts: ts(3) }, "cross_role_user"],
    [{ is_author_bot: true, thread_ts: ts(3) }, "cross_role_kind"],
  ])("rejects incompatible user/kind/thread metadata: %j", async (meta, _failure) => {
    const d = diagnostics(), f = fixture(); const messages = pair(short, long, meta).map((m, index) => index === 0 ? { ...m, thread_ts: ts(1) } : m);
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages } });
    expect(await f.reader.search({ query: "launch" }, f.context)).toMatchObject({ status: "unavailable", message: localUnavailable(), messages: [], nextCursor: null });
    expect(d.records()).toEqual([]);
    // Metadata failure precedes even a text-relation failure, matching the old OR guard.
    d.spy.mockClear();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: pair(short, "not a prefix", meta).map((m, i) => i === 0 ? { ...m, thread_ts: ts(1) } : m) } });
    expect((await f.reader.search({ query: "launch" }, f.context)).status).toBe("unavailable");
    expect(d.records()).toEqual([]);
  });
  it.each([
    [{ is_author_bot: false }, "participant", "explicit_participant", "cross_role_thread"],
    [{ user_id: "U2", is_author_bot: false }, "participant", "explicit_participant", "cross_role_thread"],
    [{ user_id: "U2" }, "none", "inferred_participant", "cross_role_thread"],
    [{ is_author_bot: true }, "bot", "explicit_bot", "cross_role_kind"],
    [{ bot_id: "BOTHER" }, "bot", "explicit_bot", "cross_role_kind"],
    [{ is_author_bot: false, bot_id: "BOTHER" }, "mixed", "mixed", "cross_role_kind"],
    [{}, "none", "unknown", "cross_role_thread"],
  ])("rejects explicit kind or thread contradictions with false / absent / bot presence: %j", async (meta, _contextKnownKinds, _contextKindSource, _failure) => {
    const d = diagnostics(), f = fixture();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: pair(short, long, { ...meta as object, thread_ts: ts(3) }).map((m, i) => i === 0 ? { ...m, thread_ts: ts(1) } : m) } });
    expect((await f.reader.search({ query: "launch" }, f.context)).status).toBe("unavailable");
    expect(d.records()).toEqual([]);
  });
  it("preserves successful prefix output/partial and unknown wildcard without explicit false", async () => {
    const d = diagnostics(), f = fixture();
    const response = () => ({ ok: true, results: { messages: pair().map((m, i) => i === 0 ? { ...m, is_author_bot: true } : m) } });
    f.apiCall.mockResolvedValueOnce(response());
    const result = await f.reader.search({ query: "launch" }, f.context);
    expect(result).toMatchObject({ status: "ok", complete: false, truncated: true,
      messages: [{ text: short, textTruncated: true, author: { kind: "bot" } }, {}] });
    expect(d.records()).toEqual([]);
    for (const field of ["kindSources", "primaryKindSource", "contextKindSource", "failure"]) expect(JSON.stringify(result)).not.toContain(field);
    d.spy.mockImplementation(() => { throw new Error(token); });
    f.apiCall.mockResolvedValueOnce(response());
    expect(await f.reader.search({ query: "launch" }, f.context)).toEqual(result);
  });
  it("metadata guard failure preserves cursor unlock, seed and successful retry even with a throwing logger", async () => {
    const d = diagnostics(), f = fixture();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [message(6)] }, next_cursor: "next" });
    const first = await f.reader.search({ query: "launch" }, f.context);
    d.spy.mockClear(); d.spy.mockImplementation(() => { throw new Error(token); });
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: pair(short, long, { is_author_bot: true }) } });
    expect(await f.reader.search({ query: "launch", cursor: first.nextCursor }, f.context)).toMatchObject({ status: "unavailable", message: localUnavailable(), messages: [], nextCursor: null });
    expect(d.records()).toEqual([]);
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: pair() } });
    expect(await f.reader.search({ query: "launch", cursor: first.nextCursor }, f.context)).toMatchObject({ status: "ok", page: 2, complete: false, messages: [{ text: short, textTruncated: true }, {}] });
    expect(f.apiCall).toHaveBeenCalledTimes(3);
  });
  it.each([{}, { is_author_bot: undefined }, { user_id: "U2" }, { user: "U2" }])("accepts explicit primary bot with context unknown kind, not inferred human proof: %j", async meta => {
    const d = diagnostics(), f = fixture();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: pair(short, long, meta).map((m, i) => i === 0 ? { ...m, is_author_bot: true } : m) } });
    const result = await f.reader.search({ query: "launch" }, f.context);
    expect(result).toMatchObject({ status: "ok", source: { channel: "C1" }, complete: false, truncated: true,
      messages: [{ text: short, textTruncated: true, author: { kind: "bot", userId: "U2" }, searchMatch: true }, {}] });
    expect(result.messages[0]).not.toHaveProperty("threadTs");
    expect(d.records()).toEqual([]);
  });
  it.each([{ is_author_bot: false }, { is_author_bot: false, user_id: "U2" }, { is_author_bot: false, bot_id: "BOTHER" }])("rejects explicit false vs primary bot even when projected system/bot: %j", async meta => {
    const d = diagnostics(), f = fixture();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: pair(short, long, meta).map((m, i) => i === 0 ? { ...m, is_author_bot: true } : m) } });
    expect(await f.reader.search({ query: "launch" }, f.context)).toMatchObject({ status: "unavailable", message: localUnavailable(), messages: [], nextCursor: null });
    expect(d.records()).toEqual([]);
  });
  it.each([{ is_author_bot: true }, { bot_id: "BOTHER" }, { is_author_bot: true, bot_id: "BOTHER", user_id: "U2" }])("accepts explicit bot context vs primary bot: %j", async meta => {
    const d = diagnostics(), f = fixture();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: pair(short, long, meta).map((m, i) => i === 0 ? { ...m, is_author_bot: true } : m) } });
    expect(await f.reader.search({ query: "launch" }, f.context)).toMatchObject({ status: "ok", complete: false,
      messages: [{ author: { kind: "bot", botId: null }, text: short, textTruncated: true }, {}] });
    expect(d.records()).toEqual([]);
  });
  it.each([{ is_author_bot: true }, { bot_id: "BOTHER" }])("primary explicit false is known participant even with system projection: %j", async meta => {
    const d = diagnostics(), f = fixture();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: pair(short, long, meta).map((m, i) => i === 0 ? { ...m, author_user_id: undefined } : m) } });
    expect((await f.reader.search({ query: "launch" }, f.context)).status).toBe("unavailable");
    expect(d.records()).toEqual([]);
  });
  it.each([
    [true, false, false], [true, false, true], [true, true, false], [true, true, true],
    [false, false, false], [false, false, true], [false, true, false], [false, true, true],
  ])("mixed sources retain compatible explicit knowledge (%s, inferred=%s, knownLast=%s)", async (bot, inferred, knownLast) => {
    const d = diagnostics(), f = fixture();
    const contextual = { ts: ts(2), text: long, ...(inferred ? { user_id: "U2" } : {}) };
    const observations = [{ ...contextual, is_author_bot: bot }, contextual];
    if (knownLast) observations.reverse();
    const response = (conflictingThread = false) => ({ ok: true, results: { messages: [
      { ...message(2), content: short, is_author_bot: bot, thread_ts: ts(1) },
      { ...message(4), context_messages: { before: observations.map(c => ({ ...c, thread_ts: conflictingThread ? ts(3) : ts(1) })) } },
    ] } });
    f.apiCall.mockResolvedValueOnce(response(true));
    expect((await f.reader.search({ query: "launch" }, f.context)).status).toBe("unavailable");
    expect(d.records()).toEqual([]);
    d.spy.mockClear(); f.apiCall.mockResolvedValueOnce(response());
    expect(await f.reader.search({ query: "launch" }, f.context)).toMatchObject({ status: "ok", complete: false,
      messages: [{ text: short, textTruncated: true, author: { kind: bot ? "bot" : "participant" } }, {}] });
    expect(d.records()).toEqual([]);
  });
  it("preserves unknown context wildcard even when all primary observations contain a known contradiction", async () => {
    const d = diagnostics(), f = fixture();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [
      { ...message(2), content: short, is_author_bot: false, author_user_id: undefined },
      { ...message(2), content: short, is_author_bot: true, author_user_id: undefined },
      { ...message(4), context_messages: { before: [{ ts: ts(2), text: long, user_id: "U2" }] } },
    ] } });
    expect(await f.reader.search({ query: "launch" }, f.context)).toMatchObject({ status: "ok", complete: false,
      messages: [{ text: short, textTruncated: true, searchMatch: true, author: { kind: "system", userId: null, botId: null } }, {}] });
    expect(d.records()).toEqual([]);
  });
  it.each([true, false])("earlier context true/false contradiction survives latest omission against primary %s", async bot => {
    const d = diagnostics(), f = fixture();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [
      { ...message(2), content: short, is_author_bot: bot },
      { ...message(4), context_messages: { before: [
        { ts: ts(2), text: long, is_author_bot: true }, { ts: ts(2), text: long, is_author_bot: false }, { ts: ts(2), text: long },
      ] } },
    ] } });
    expect((await f.reader.search({ query: "launch" }, f.context)).status).toBe("unavailable");
    expect(d.records()).toEqual([]);
  });
  it.each([
    [{ user_id: "U2" }, "participant"], [{ is_author_bot: false }, "system"],
    [{ is_author_bot: false, bot_id: "BOTHER" }, "bot"],
  ])("does not alter context-only output kind or promote it to primary metadata: %j", async (meta, kind) => {
    const f = fixture(); f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: pair(short, long, meta as object).slice(1) } });
    const result = await f.reader.search({ query: "launch" }, f.context);
    expect(result).toMatchObject({ status: "ok", complete: true, messages: [
      { ts: ts(2), text: long, textTruncated: false, author: { kind }, searchMatch: false, contextForTs: ts(4), contextPosition: "before" },
      { ts: ts(4), searchMatch: true },
    ] });
    expect(result.messages[0]).not.toHaveProperty("permalink");
    for (const field of ["kindEvidence", "knownKinds", "kindSources"]) expect(JSON.stringify(result)).not.toContain(field);
  });
  it.each([false, true])("aggregates all source observations even with later omitted metadata (%s)", async richLast => {
    const d = diagnostics(), f = fixture();
    const contextual = { ts: ts(2), text: long };
    const observations = [{ ...contextual, is_author_bot: true }, { ...contextual, is_author_bot: false, user_id: "U2" }, { ...contextual, user_id: "U2" }, contextual];
    if (richLast) observations.reverse();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [
      { ...message(2), content: short, author_user_id: undefined, is_author_bot: true },
      { ...message(2), content: short, author_user_id: undefined, is_author_bot: false },
      { ...message(4), context_messages: { before: observations } },
    ] } });
    expect((await f.reader.search({ query: "launch" }, f.context)).status).toBe("unavailable");
    expect(d.records()).toEqual([]);
    for (const value of [short, long, ts(2), "U2", token]) expect(JSON.stringify(d.records())).not.toContain(value);
  });
  it.each(["primary", "context"])("does not hide same-%s prefix conflicts behind the alternate role", async role => {
    const d = diagnostics(), f = fixture();
    const messages = role === "primary" ? [...pair(), { ...message(2), content: long }] : [
      ...pair(), { ...message(5), context_messages: { before: [{ ts: ts(2), text: `${long} changed` }] } },
    ];
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages } });
    expect((await f.reader.search({ query: "launch" }, f.context)).status).toBe("unavailable");
    expect(d.records()).toEqual([]);
  });
  it("reads role hashes back independently, never overwrites primary with context, and retries failures", async () => {
    const f = fixture(); f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: pair() }, next_cursor: "next1" });
    const first = await f.reader.search({ query: "launch" }, f.context);
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(2), content: long }] } });
    expect((await f.reader.search({ query: "launch", cursor: first.nextCursor }, f.context)).status).toBe("unavailable");
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(2), content: short }] }, next_cursor: "next2" });
    const second = await f.reader.search({ query: "launch", cursor: first.nextCursor }, f.context);
    expect(second).toMatchObject({ status: "ok", messages: [], complete: false });
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(5), context_messages: { before: [{ ts: ts(2), text: `${long} changed` }] } }] } });
    expect((await f.reader.search({ query: "launch", cursor: second.nextCursor }, f.context)).status).toBe("unavailable");
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(5), context_messages: { before: [{ ts: ts(2), text: long }] } }] } });
    expect(await f.reader.search({ query: "launch", cursor: second.nextCursor }, f.context)).toMatchObject({ status: "ok", complete: false, truncated: true, messages: [{ ts: ts(5) }] });
  });
  it("requires same-page prefix evidence for cross-role-only seed promotion; no raw cursor text", async () => {
    const d = diagnostics(), f = fixture();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: pair().slice(1) }, next_cursor: "next" });
    const first = await f.reader.search({ query: "launch" }, f.context);
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(2), content: short }] } });
    expect((await f.reader.search({ query: "launch", cursor: first.nextCursor }, f.context)).status).toBe("unavailable");
    expect(d.records()).toEqual([]);
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: pair() } });
    expect(await f.reader.search({ query: "launch", cursor: first.nextCursor }, f.context)).toMatchObject({ status: "ok", complete: false,
      messages: [{ ts: ts(2), text: short, textTruncated: true, searchMatch: true, permalink: message(2).permalink }] });
    for (const value of [short, long, token]) expect(JSON.stringify(d.spy.mock.calls)).not.toContain(value);
  });
  it("does not persist alternate-role hashes for context omitted by the projection bound", async () => {
    const f = fixture(); const contexts = Array.from({ length: 20 }, (_, n) => ({ ts: ts(10 + n), text: `synthetic ${n}` }));
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [
      { ...message(2), context_messages: { after: contexts } },
      { ...message(3), context_messages: { after: [{ ts: ts(30), text: long }] } },
      ...Array.from({ length: 18 }, (_, n) => message(100 + n)),
    ] }, next_cursor: "next" });
    const first = await f.reader.search({ query: "launch" }, f.context);
    expect(first.messages).toHaveLength(40); expect(first.messages.some(m => m.ts === ts(30))).toBe(false);
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(30), content: short }] } });
    expect(await f.reader.search({ query: "launch", cursor: first.nextCursor }, f.context)).toMatchObject({ status: "ok", messages: [{ ts: ts(30), text: short, textTruncated: false }], complete: false });
  });
  it("cannot hide earlier conflicting prefix metadata with a later equal same-role observation", async () => {
    const f = fixture();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [
      ...pair(short, long, { user_id: "UOTHER" }),
      { ...message(5), context_messages: { before: [{ ts: ts(2), text: long, user_id: "U2" }] } },
    ] } });
    expect((await f.reader.search({ query: "launch" }, f.context)).status).toBe("unavailable");
  });
  it.each([
    ["thread", false, false], ["thread", false, true], ["thread", true, false], ["thread", true, true],
    ["author", false, false], ["author", false, true], ["author", true, false], ["author", true, true],
    ["kind", false, false], ["kind", false, true], ["kind", true, false], ["kind", true, true],
  ])("rejects all-observation prefix metadata contradiction despite omitted latest %s (%s/%s)", async (field, primaryExplicitLast, contextExplicitLast) => {
    const d = diagnostics(), f = fixture();
    const primary = { ...message(2), content: short, author_user_id: undefined };
    const primaryMeta = field === "thread" ? { thread_ts: ts(1) } : field === "kind" ? { is_author_bot: true } : { author_user_id: "U2" };
    const contextual = { ts: ts(2), text: long };
    // User presence alone is inferred, not known participant: kind negatives need explicit false.
    const contextMeta = field === "thread" ? { thread_ts: ts(3) } : field === "kind" ? { is_author_bot: false, user_id: "U3" } : { user_id: "U3" };
    const primaries = [primary, { ...primary, ...primaryMeta }];
    const contextObjects = [contextual, { ...contextual, ...contextMeta }];
    if (!primaryExplicitLast) primaries.reverse();
    if (!contextExplicitLast) contextObjects.reverse();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [
      ...primaries,
      { ...message(4), context_messages: { before: [contextObjects[0]] } },
      { ...message(5), context_messages: { before: [contextObjects[1]] } },
    ] } });
    expect(await f.reader.search({ query: "launch" }, f.context)).toMatchObject({ status: "unavailable", messages: [] });
    expect(d.records()).toEqual([]);
  });
  it.each([[false, false], [false, true], [true, false], [true, true]])("keeps unknown metadata a wildcard without synthesizing primary provenance (%s/%s)", async (primaryKnown, contextKnown) => {
    const f = fixture();
    const primary = { ...message(2), content: short, author_user_id: undefined };
    const contextual = { ts: ts(2), text: long };
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [
      { ...primary, ...(primaryKnown ? { thread_ts: ts(1), author_user_id: "U2" } : {}) }, primary,
      { ...message(4), context_messages: { before: [{ ...contextual, ...(contextKnown ? { thread_ts: ts(1), user_id: "U2" } : {}) }] } },
      { ...message(5), context_messages: { before: [contextual] } },
    ] } });
    const result = await f.reader.search({ query: "launch" }, f.context);
    expect(result).toMatchObject({ status: "ok", complete: false, truncated: true });
    expect(result.messages[0]).toMatchObject({ ts: ts(2), text: short, textTruncated: true, searchMatch: true,
      author: { userId: primaryKnown ? "U2" : null, kind: primaryKnown ? "participant" : "system" } });
    if (primaryKnown) expect(result.messages[0].threadTs).toBe(ts(1)); else expect(result.messages[0]).not.toHaveProperty("threadTs");
  });
  it("preserves exact-equal cross-role metadata behavior despite contradictory explicit observations", async () => {
    const f = fixture();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [
      { ...message(2), content: short, thread_ts: ts(1) },
      { ...message(2), content: short, author_user_id: undefined },
      { ...message(4), context_messages: { before: [{ ts: ts(2), text: short, thread_ts: ts(3), user_id: "U3" }] } },
      { ...message(5), context_messages: { before: [{ ts: ts(2), text: short }] } },
    ] } });
    expect(await f.reader.search({ query: "launch" }, f.context)).toMatchObject({ status: "ok", complete: true, truncated: false,
      messages: [{ ts: ts(2), text: short, textTruncated: false, threadTs: ts(1), author: { userId: "U2" } }, {}, {}] });
  });
  it("keeps exact-equal cross-role legacy acceptance even for explicit kind contradiction", async () => {
    const f = fixture(); f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages:
      pair(short, short, { is_author_bot: false, bot_id: "BOTHER" }).map((m, i) => i === 0 ? { ...m, is_author_bot: true } : m),
    } });
    expect(await f.reader.search({ query: "launch" }, f.context)).toMatchObject({ status: "ok", complete: true,
      messages: [{ text: short, textTruncated: false, searchMatch: true, author: { kind: "bot", botId: null } }, {}] });
  });
  it.each([
    [{ user_id: "UOTHER" }, long, "cross_role_user"],
    [{ user_id: "U2", thread_ts: ts(3) }, long, "cross_role_thread"],
    [{ user_id: "U2" }, "nonprefix", "cross_role_text_relation"],
  ])("unknown context kind cannot bypass bot-primary user/thread/text guard: %j", async (meta, text, _failure) => {
    const d = diagnostics(), f = fixture();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: pair(short, text, meta).map((m, i) =>
      i === 0 ? { ...m, is_author_bot: true, thread_ts: ts(1) } : m) } });
    expect(await f.reader.search({ query: "launch" }, f.context)).toMatchObject({ status: "unavailable", messages: [], nextCursor: null });
    expect(d.records()).toEqual([]);
  });
  it("rejects primary-only cursor seed versus a longer context without current-page primary evidence", async () => {
    const d = diagnostics(), f = fixture(); f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: pair().slice(0, 1) }, next_cursor: "next" });
    const first = await f.reader.search({ query: "launch" }, f.context);
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: pair().slice(1) } });
    expect((await f.reader.search({ query: "launch", cursor: first.nextCursor }, f.context)).status).toBe("unavailable");
    expect(d.records()).toEqual([]);
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: pair() } });
    expect(await f.reader.search({ query: "launch", cursor: first.nextCursor }, f.context)).toMatchObject({ status: "ok", complete: false, messages: [{ ts: ts(4) }] });
  });
  it("keeps cursor state role-hash-only for delivered timestamps and preserves 40/page cumulative dedup", async () => {
    const f = fixture();
    // Inspect private synthetic state only to assert the no-raw-text/bounded-memory contract.
    const cursors = (f.reader as unknown as { searcher: { cursors: Map<string, { fingerprints: Record<string, Record<string, string>>; deliveredRoles: Record<string, string> }> } }).searcher.cursors;
    let cursor: string | undefined;
    const all = [];
    for (let page = 1; page <= 4; page++) {
      const base = page * 100;
      const messages = Array.from({ length: 20 }, (_, n) => ({ ...message(base + n), content: `synthetic raw primary ${base + n}` }));
      const withContext = messages.map((m, index) => index === 0 ? { ...m, context_messages: { after: [
        ...messages.slice(1).map(p => ({ ts: p.message_ts, text: `${p.content} longer` })),
        ...Array.from({ length: 20 }, (_, n) => ({ ts: ts(base + 40 + n), text: `synthetic raw context ${base + n}` })),
      ].slice(0, 20), before: Array.from({ length: 19 }, (_, n) => ({ ts: ts(base - 20 + n), text: `synthetic raw before ${base + n}` })) } } : m);
      f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: withContext }, next_cursor: `page-${page}` });
      const result = await f.reader.search({ query: "launch", ...(cursor ? { cursor } : {}) }, f.context);
      expect(result).toMatchObject({ status: "ok", page, complete: false });
      expect(result.messages).toHaveLength(40); all.push(...result.messages);
      cursor = result.nextCursor ?? undefined;
      if (cursor) {
        const state = cursors.get(cursor)!;
        expect(Object.keys(state.fingerprints)).toHaveLength(page * 40);
        expect(Object.keys(state.fingerprints).sort()).toEqual(Object.keys(state.deliveredRoles).sort());
        expect(Object.values(state.fingerprints).every(hashes => Object.keys(hashes).length <= 2 && Object.values(hashes).every(hash => /^[a-f0-9]{64}$/.test(hash)))).toBe(true);
        expect(JSON.stringify(state)).not.toContain("synthetic raw");
      }
    }
    expect(all).toHaveLength(160); expect(new Set(all.map(m => m.ts)).size).toBe(160); expect(cursor).toBeUndefined();
  });
  it("validates omitted context authority before prefix/projection and bounds UTF-8 short text", async () => {
    const f = fixture();
    const messages = pair("😀\n\"".repeat(10_000), "😀\n\"".repeat(10_000) + " end");
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages } });
    const result = await f.reader.search({ query: "launch" }, f.context);
    expect(result).toMatchObject({ status: "ok", complete: false });
    expect(Buffer.byteLength(JSON.stringify(result.messages))).toBeLessThan(24_100);
    expect(Buffer.byteLength(JSON.stringify(result.messages[0].text)) - 2).toBeLessThanOrEqual(8_000);
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [...pair(), { ...message(6), context_messages: { before: [{ ts: ts(2), text: long, channel_id: "GSECRET" }] } }] } });
    expect((await f.reader.search({ query: "launch" }, f.context)).status).toBe("unavailable");
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
