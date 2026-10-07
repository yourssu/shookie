import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestContext } from "@mastra/core/request-context";
import { logger } from "../../logger.js";
import { SlackSearcher } from "./search.js";
import type { SlackReadClient } from "./client.js";
import { bindSlackReadContext } from "./context.js";
import { readOutput } from "./schemas.js";
import { createSlackReadTools } from "./tools.js";
import { ExecutionScope, executionStorage, executionTools } from "../../cancellation/execution-context.js";
import { compareCrossSearchText, logCrossChannelSearchDiagnostic, summarizeCrossSearchSchema } from "./cross-channel-search-diagnostics.js";

const token = "SYNTHETIC_DIAGNOSTIC_SECRET";
const ts = (n: number) => `1700000000.${String(n).padStart(6, "0")}`;
const message = (n = 2) => ({ channel_id: "CTARGET", team_id: "TTEAM", message_ts: ts(n), content: "PRIVATE_PRIMARY",
  author_user_id: "UACTOR", is_author_bot: false, permalink: `https://synthetic.slack.com/archives/CTARGET/p${ts(n).replace(".", "")}` });
function fixture() {
  const context = new RequestContext(); context.set("requestId", "FORGED_REQUEST_ID");
  bindSlackReadContext(context, { userId: "UREQUESTER", teamId: "TTEAM", channel: "CORIGIN", requestId: "trusted-event" }, token);
  const auth = vi.fn().mockResolvedValue({ ok: true, bot_id: "B1", team_id: "TTEAM", url: "https://synthetic.slack.com/" });
  const info = vi.fn(async ({ channel }: { channel: string }) => ({ ok: true, channel: { id: channel, context_team_id: "TTEAM", is_channel: true, is_private: false, is_group: false } }));
  const members = vi.fn().mockResolvedValue({ ok: true, members: ["UREQUESTER"] });
  const apiCall = vi.fn().mockResolvedValue({ ok: true, results: { messages: [message()] } });
  const history = vi.fn(), replies = vi.fn();
  const client = { auth: { test: auth }, conversations: { info, members, history, replies }, apiCall } as unknown as SlackReadClient;
  const spy = vi.spyOn(logger, "info").mockImplementation(() => {});
  return { context, auth, info, members, apiCall, history, replies, client, searcher: new SlackSearcher(client), spy,
    records: () => spy.mock.calls.filter(([name]) => name === "slack_cross_channel_search_diagnostic").map(([, data]) => data as Record<string, unknown>) };
}
afterEach(() => vi.restoreAllMocks());
const booleanKeys = ["correlationAvailable", "finalSuccess", "cursorPresent", "pagePrimaryPresent", "pageContextPresent", "seedPrimaryPresent", "seedContextPresent",
  "usersCompatible", "kindsCompatible", "threadsCompatible", "channelIdAgrees", "channelAliasAgrees", "teamIdAgrees", "teamAliasAgrees", "permalinkParsed", "canonicalHttps", "canonicalHref", "verifiedWorkspace", "noUserinfo", "noPort", "noHash", "pathAgrees", "pathChannelAgrees", "pathMessageTsAgrees", "queryKnown", "queryDuplicate", "queryCidAgrees", "queryRootValid", "threadMetadataAvailable", "queryRootAgrees", "queryEmpty", "schemaMissing", "comparisonAvailable", "equal", "primaryPrefix", "contextPrefix", "primarySubstring", "contextSubstring", "trimEquals", "lineEndingEquals"];
const stagePairs = {
  preflight_failed: "preflight", authorization_failed: "authorization", prerequisites_missing: "prerequisites", current_public_required: "authorization", scoped_target_failed: "scopedtargetverification", result_channel_failed: "resultchannelverification", verification_budget: "budget", transport_failed: "transport", response_received: "transport", check_failed: "check", check_passed: "check", schema_failed: "schema", schema_passed: "schema", warning_present: "schema", result_limit_exceeded: "budget", primary_scope_mismatch: "primaryscope", scoped_result_mismatch: "primaryscope", context_scope_mismatch: "contextscope", permalink_parse_failed: "permalink", permalink_invalid: "permalink", context_time_invalid: "contexttime", thread_scope_mismatch: "threadscope", same_role_hash_conflict: "samerolehash", cross_role_user_conflict: "crossroleuser", cross_role_kind_conflict: "explicitkind", cross_role_thread_conflict: "thread", cross_role_text_relation: "relation", cross_role_seed_unverified: "seed", budget_exceeded: "budget", cursor_conflict: "cursorreplay_conflict", cursor_replay: "cursorreplay_conflict", cursor_invalid: "cursorreplay_conflict", validation_exception: "preflight", success: "final",
};
function assertSafe(records: Record<string, unknown>[]) {
  expect(records.length).toBeLessThanOrEqual(4);
  for (const record of records) for (const [key, value] of Object.entries(record)) {
    if (booleanKeys.includes(key)) expect(typeof value).toBe("boolean");
    else if (key === "requestId") expect(value).toBe("trusted-event");
    else if (key === "reason") expect(Object.keys(stagePairs)).toContain(value);
    else if (key === "stage") expect(value).toBe(stagePairs[record.reason as keyof typeof stagePairs]);
    else if (["role", "origin"].includes(key)) expect(["primary", "context", "page", "cursor", "unknown"]).toContain(value);
    else if (["primaryKnownKinds", "contextKnownKinds"].includes(key)) expect(["none", "bot", "participant", "mixed", "unknown"]).toContain(value);
    else if (key === "schemaField") expect(["message_is_author_bot", "message_channel_id", "message_content", "context_text", "unknown"]).toContain(value);
    else if (key === "schemaCode") expect(["invalid_type", "invalid_string", "unknown"]).toContain(value);
    else throw new Error(`Unexpected diagnostic key: ${key}`);
  }
  const serialized = JSON.stringify(records);
  for (const secret of [token, "PRIVATE_PRIMARY", "PRIVATE_CONTEXT", "UREQUESTER", "UACTOR", "TTEAM", "CORIGIN", "CTARGET", ts(1), ts(2), "synthetic.slack.com", "FORGED_REQUEST_ID", "keyword", "PRIVATE_CURSOR"]) expect(serialized).not.toContain(secret);
}

describe("bounded runtime projection", () => {
  it("accepts every fixed reason/stage pair and rejects every runtime non-allowlisted reason", () => {
    const f = fixture();
    for (const reason of Object.keys(stagePairs)) logCrossChannelSearchDiagnostic(f.context, reason as never, { raw: token });
    expect(f.records()).toHaveLength(Object.keys(stagePairs).length);
    for (const [index, reason] of Object.keys(stagePairs).entries()) expect(f.records()[index]).toEqual({ stage: stagePairs[reason as keyof typeof stagePairs], reason, requestId: "trusted-event", correlationAvailable: true });
    f.spy.mockClear();
    const getter = vi.fn(() => { throw new Error(token); });
    const hostile = { toString: getter, toJSON: getter, [Symbol.toPrimitive]: getter };
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    for (const value of [token, "__proto__", "constructor", "toString", undefined, null, 7, true, Symbol(token), hostile, new Proxy({}, { get: getter }), revoked.proxy]) logCrossChannelSearchDiagnostic(f.context, value as never);
    expect(f.spy).not.toHaveBeenCalled(); expect(getter).not.toHaveBeenCalled();
  });
  it("own data only: no getters, proxies, inherited values, toJSON or coercion", () => {
    const f = fixture(); const trap = vi.fn(() => { throw new Error(token); });
    const proxy = new Proxy({}, { get: trap, getOwnPropertyDescriptor: trap, ownKeys: trap });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    const getters = Object.defineProperties({ toJSON: trap }, { schemaField: { get: trap }, equal: { get: trap } });
    for (const value of [proxy, revoked.proxy, getters, Object.create({ schemaField: token, equal: true }), null, 7]) {
      logCrossChannelSearchDiagnostic(f.context, "schema_failed", value);
      expect(f.records().at(-1)).toEqual({ stage: "schema", reason: "schema_failed", correlationAvailable: true, requestId: "trusted-event" });
    }
    logCrossChannelSearchDiagnostic(f.context, "schema_failed", { schemaField: token, schemaCode: proxy, schemaMissing: proxy, raw: token, requestId: token, toJSON: trap, comparisonAvailable: false, equal: true });
    expect(f.records().at(-1)).toEqual({ stage: "schema", reason: "schema_failed", correlationAvailable: true, requestId: "trusted-event", schemaField: "unknown", comparisonAvailable: false });
    expect(trap).not.toHaveBeenCalled();
  });
  it("every additional enum and boolean is independently runtime-whitelisted, never logger raw input", () => {
    const f = fixture();
    const enumValues = {
      role: ["primary", "context", "unknown"], origin: ["page", "cursor", "unknown"],
      primaryKnownKinds: ["none", "bot", "participant", "mixed", "unknown"], contextKnownKinds: ["none", "bot", "participant", "mixed", "unknown"],
      schemaCode: ["invalid_type", "invalid_literal", "custom", "invalid_union", "invalid_union_discriminator", "invalid_enum_value", "unrecognized_keys", "invalid_arguments", "invalid_return_type", "invalid_date", "invalid_string", "too_small", "too_big", "invalid_intersection_types", "not_multiple_of", "not_finite", "unknown"],
      schemaField: ["response", "results", "messages", "message_item", "files", "channels", "users", "response_metadata", "metadata_next_cursor", "metadata_warnings", "metadata_warning_item", "next_cursor", "has_more", "warning", "context_before", "context_after", "context_item", "unknown",
        ...["channel_id", "team_id", "channel", "team", "message_ts", "content", "author_user_id", "is_author_bot", "permalink", "thread_ts", "context_messages"].map(field => `message_${field}`),
        ...["channel_id", "team_id", "channel", "team", "ts", "text", "user_id", "user", "is_author_bot", "bot_id", "thread_ts"].map(field => `context_${field}`)],
    };
    for (const [key, values] of Object.entries(enumValues)) {
      for (const value of values) { logCrossChannelSearchDiagnostic(f.context, "schema_failed", { [key]: value }); expect(f.records().at(-1)?.[key]).toBe(value); }
      logCrossChannelSearchDiagnostic(f.context, "schema_failed", { [key]: token }); expect(f.records().at(-1)?.[key]).toBe("unknown");
      for (const value of [7, true, {}, new String(token)]) { logCrossChannelSearchDiagnostic(f.context, "schema_failed", { [key]: value }); expect(f.records().at(-1)).not.toHaveProperty(key); }
    }
    for (const key of booleanKeys.filter(key => key !== "correlationAvailable")) {
      for (const value of [true, false]) {
        const input = { comparisonAvailable: true, [key]: value, extra: token };
        logCrossChannelSearchDiagnostic(f.context, "schema_failed", input);
        expect(f.records().at(-1)?.[key]).toBe(value); expect(f.spy.mock.calls.at(-1)?.[1]).not.toBe(input);
      }
      for (const value of ["true", 1, {}, token]) { logCrossChannelSearchDiagnostic(f.context, "schema_failed", { [key]: value }); expect(f.records().at(-1)).not.toHaveProperty(key); }
    }
    expect(JSON.stringify(f.records())).not.toContain(token);
  });
  it("does not trust a plain/model requestId or context getter, and swallows logger faults", () => {
    const f = fixture(), trap = vi.fn(() => { throw new Error(token); });
    const plain = Object.defineProperty({}, "requestId", { get: trap });
    logCrossChannelSearchDiagnostic(plain, "preflight_failed", { requestId: token });
    expect(f.records().at(-1)).toEqual({ stage: "preflight", reason: "preflight_failed", correlationAvailable: false });
    f.spy.mockImplementation(() => { throw new Error(token); });
    expect(() => logCrossChannelSearchDiagnostic(f.context, "success", { finalSuccess: true })).not.toThrow();
    expect(trap).not.toHaveBeenCalled();
  });
  it.each([["a".repeat(24_001), "a"], ["😀".repeat(6_001), "a"], [null, "a"], [{ toString: () => { throw new Error(token); } }, "a"]])("unavailable comparisons are unknown, not inequality", (a, b) => {
    expect(compareCrossSearchText(a, b)).toEqual({ comparisonAvailable: false });
  });
  it("observes substring and normalization without allowing them to authorize", () => {
    expect(compareCrossSearchText("needle", "prefix needle suffix")).toMatchObject({ comparisonAvailable: true, equal: false, primaryPrefix: false, primarySubstring: true });
    expect(compareCrossSearchText(" a ", "a")).toMatchObject({ trimEquals: true });
    expect(compareCrossSearchText("a\r\nb", "a\nb")).toMatchObject({ lineEndingEquals: true });
    expect(compareCrossSearchText("a".repeat(24_000), "a")).toHaveProperty("comparisonAvailable", true);
  });
  it("first issue only, exact static path; hostile issue/path fields remain unknown", () => {
    const trap = vi.fn(() => { throw new Error(token); });
    const valid = { path: ["results", "messages", 4, "is_author_bot"], code: "invalid_type", received: "undefined", message: token };
    expect(summarizeCrossSearchSchema([valid, { path: [token], code: token }])).toEqual({ schemaField: "message_is_author_bot", schemaCode: "invalid_type", schemaMissing: true });
    expect(summarizeCrossSearchSchema([{ ...valid, path: [token, "results", "messages", 0, "content"] }]).schemaField).toBe("unknown");
    expect(summarizeCrossSearchSchema([{ ...valid, path: ["results", "messages", token, "content"] }]).schemaField).toBe("unknown");
    expect(summarizeCrossSearchSchema([{ ...valid, path: ["results", "messages", 0, "context_messages", "after", 0, "text"] }]).schemaField).toBe("context_text");
    const revoked = Proxy.revocable([], {}); revoked.revoke();
    for (const value of [new Proxy([], { get: trap, getOwnPropertyDescriptor: trap }), revoked.proxy, Object.defineProperty([], "0", { get: trap }), [Object.defineProperty({}, "path", { get: trap })], [Object.create(valid)], null]) {
      expect(summarizeCrossSearchSchema(value)).toEqual({ schemaField: "unknown", schemaCode: "unknown", schemaMissing: false });
    }
    for (const path of [new Proxy([], { get: trap }), revoked.proxy, Object.defineProperty([], "0", { get: trap })]) expect(summarizeCrossSearchSchema([{ ...valid, path }]).schemaField).toBe("unknown");
    expect(trap).not.toHaveBeenCalled();
  });
});

describe("search rejection observations preserve guards and privacy (synthetic, NOT actual E2E)", () => {
  it.each([
    ["cross_role_user_conflict", { user_id: "UOTHER", is_author_bot: true, thread_ts: ts(0) }, { thread_ts: ts(1) }],
    ["cross_role_kind_conflict", { user_id: "UACTOR", is_author_bot: true, thread_ts: ts(0) }, { thread_ts: ts(1) }],
    ["cross_role_thread_conflict", { user_id: "UACTOR", is_author_bot: false, thread_ts: ts(0) }, { thread_ts: ts(1) }],
    ["cross_role_text_relation", { user_id: "UACTOR", is_author_bot: false }, {}],
  ])("identifies first existing guard %s; diagnostic substring is not prefix permission", async (reason, contextMeta, primaryMeta) => {
    const f = fixture();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(), ...primaryMeta }, { ...message(4), context_messages: { before: [{ ts: ts(2), text: "PRIVATE_CONTEXT PRIVATE_PRIMARY suffix", ...contextMeta }] } }] } });
    const result = await f.searcher.search({ query: "keyword" }, f.context);
    expect(result).toMatchObject({ status: "unavailable", messages: [], nextCursor: null }); expect(readOutput.safeParse(result).success).toBe(true);
    expect(result.message).toBe("Slack 결과를 안전하게 확인하지 못했습니다. 잠시 후 다시 시도해주세요.");
    expect(f.records().map(r => r.reason)).toEqual(["response_received", "check_passed", "schema_passed", reason]);
    expect(f.records().at(-1)).toMatchObject({ comparisonAvailable: true, primarySubstring: true, primaryPrefix: false, pagePrimaryPresent: true, pageContextPresent: true });
    assertSafe(f.records()); expect(f.apiCall).toHaveBeenCalledTimes(1); expect(f.members).toHaveBeenCalledTimes(1); expect(f.info).toHaveBeenCalledTimes(2); expect(f.history).not.toHaveBeenCalled(); expect(f.replies).not.toHaveBeenCalled();
  });
  it.each([
    ["primary_scope_mismatch", { team: "TOTHER" }], ["permalink_parse_failed", { permalink: "not a URL" }],
    ["permalink_invalid", { permalink: `${message().permalink}?cid=CORIGIN` }],
    ["context_scope_mismatch", { context_messages: { before: [{ ts: ts(1), text: "PRIVATE_CONTEXT", channel: "CORIGIN" }] } }],
    ["context_time_invalid", { context_messages: { before: [{ ts: ts(2), text: "PRIVATE_CONTEXT" }] } }],
    ["thread_scope_mismatch", { thread_ts: ts(1), context_messages: { before: [{ ts: ts(1), text: "PRIVATE_CONTEXT", thread_ts: ts(0) }] } }],
  ])("observes %s with unchanged local refusal and no source disclosure", async (reason, changes) => {
    const f = fixture(); f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(), ...changes }] } });
    expect(await f.searcher.search({ query: "keyword" }, f.context)).toMatchObject({ status: "unavailable", messages: [] });
    expect(f.records().at(-1)).toHaveProperty("reason", reason); assertSafe(f.records());
  });
  it.each([
    [`http://synthetic.slack.com/archives/CTARGET/p${ts(2).replace(".", "")}`, { canonicalHttps: false }],
    [`https://evil.slack.com/archives/CTARGET/p${ts(2).replace(".", "")}`, { verifiedWorkspace: false }],
    [`${message().permalink}#private`, { noHash: false }],
    [`https://synthetic.slack.com/archives/COTHER/p${ts(2).replace(".", "")}`, { pathChannelAgrees: false, pathMessageTsAgrees: true }],
    [`https://synthetic.slack.com/archives/CTARGET/p${ts(1).replace(".", "")}`, { pathChannelAgrees: true, pathMessageTsAgrees: false }],
    [`${message().permalink}?cid=CTARGET&cid=CTARGET`, { queryDuplicate: true, queryKnown: true }],
    [`${message().permalink}?private_key=${token}`, { queryKnown: false }],
    [`${message().permalink}?cid=CORIGIN`, { queryCidAgrees: false }],
    [`${message().permalink}?thread_ts=${ts(3)}`, { queryRootValid: false, threadMetadataAvailable: false }],
    [`${message().permalink}?thread_ts=${ts(0)}`, { queryRootValid: true, threadMetadataAvailable: true, queryRootAgrees: false }],
  ])("permalink refusal predicates never disclose the URL or query hints", async (permalink, predicates) => {
    const f = fixture(); f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(), permalink, ...("threadMetadataAvailable" in predicates && predicates.threadMetadataAvailable ? { thread_ts: ts(1) } : {}) }] } });
    expect((await f.searcher.search({ query: "keyword" }, f.context)).status).toBe("unavailable");
    expect(f.records().at(-1)).toMatchObject({ reason: "permalink_invalid", permalinkParsed: true, ...predicates }); assertSafe(f.records());
    expect(JSON.stringify(f.records())).not.toContain(permalink);
  });
  it("large page-local conflicts still reject with comparison unknown, not false inequality", async () => {
    const f = fixture(); f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(), content: "😀".repeat(6_001) }, { ...message(), content: "different" }] } });
    expect((await f.searcher.search({ query: "keyword" }, f.context)).status).toBe("unavailable");
    expect(f.records().at(-1)).toMatchObject({ reason: "same_role_hash_conflict", comparisonAvailable: false });
    expect(f.records().at(-1)).not.toHaveProperty("equal"); expect(f.records().at(-1)).not.toHaveProperty("primarySubstring"); assertSafe(f.records());
  });
  it("cursor conflicts and replay retain the seed; live result metadata refusal keeps its permission status", async () => {
    const f = fixture(); f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [message()] }, next_cursor: "PRIVATE_CURSOR" });
    const first = await f.searcher.search({ query: "keyword" }, f.context); f.spy.mockClear();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [message()] }, next_cursor: "PRIVATE_CURSOR" });
    expect((await f.searcher.search({ query: "keyword", cursor: first.nextCursor }, f.context)).status).toBe("unavailable");
    expect(f.records().at(-1)).toHaveProperty("reason", "cursor_replay"); assertSafe(f.records()); f.spy.mockClear();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [message()] }, next_cursor: "a", response_metadata: { next_cursor: "b" } });
    expect((await f.searcher.search({ query: "keyword", cursor: first.nextCursor }, f.context)).status).toBe("unavailable");
    expect(f.records().at(-1)).toHaveProperty("reason", "cursor_conflict"); assertSafe(f.records()); f.spy.mockClear();
    f.info.mockResolvedValueOnce({ ok: true, channel: { id: "CORIGIN", context_team_id: "TTEAM", is_channel: true, is_private: false, is_group: false } });
    f.info.mockRejectedValueOnce({ data: { error: "not_in_channel" }, message: token });
    expect((await f.searcher.search({ query: "keyword", cursor: first.nextCursor }, f.context)).status).toBe("access_denied");
    expect(f.records().at(-1)).toHaveProperty("reason", "result_channel_failed"); assertSafe(f.records()); f.spy.mockClear();
    expect(await f.searcher.search({ query: "keyword", cursor: first.nextCursor }, f.context)).toMatchObject({ status: "ok", page: 2 }); assertSafe(f.records());
  });
  it("logs only a static first schema issue including current publicChannelId rejection", async () => {
    const f = fixture(); const m = message();
    delete (m as Partial<typeof m>).is_author_bot;
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [m] } });
    expect((await f.searcher.search({ query: "keyword" }, f.context)).status).toBe("unavailable");
    expect(f.records().at(-1)).toMatchObject({ stage: "schema", reason: "schema_failed", schemaField: "message_is_author_bot", schemaCode: "invalid_type", schemaMissing: true });
    assertSafe(f.records()); f.spy.mockClear();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(), channel_id: "GPRIVATE" }] } });
    expect((await f.searcher.search({ query: "keyword" }, f.context)).status).toBe("unavailable");
    expect(f.records().at(-1)).toMatchObject({ schemaField: "message_channel_id", schemaCode: "invalid_string", schemaMissing: false }); assertSafe(f.records());
  });
  it("uses pending fixed transport/check/verification stages, not raw error codes", async () => {
    const f = fixture();
    f.apiCall.mockRejectedValueOnce({ message: token, data: { error: "missing_scope" } });
    expect((await f.searcher.search({ query: "keyword" }, f.context)).status).toBe("access_denied");
    expect(f.records().map(r => r.reason)).toEqual(["transport_failed"]); assertSafe(f.records()); f.spy.mockClear();
    f.apiCall.mockResolvedValueOnce({ ok: false, error: "missing_scope" });
    expect((await f.searcher.search({ query: "keyword" }, f.context)).status).toBe("access_denied");
    expect(f.records().map(r => r.reason)).toEqual(["response_received", "check_failed"]); assertSafe(f.records()); f.spy.mockClear();
    f.info.mockResolvedValueOnce({ ok: true, channel: { id: "CORIGIN", context_team_id: "TTEAM", is_channel: true, is_private: false, is_group: false } });
    f.info.mockRejectedValueOnce({ statusCode: 429, retryAfter: 37, message: token });
    expect(await f.searcher.search({ query: "keyword", channel: "CTARGET" }, f.context)).toMatchObject({ status: "rate_limited", retryAfterSeconds: 37 });
    expect(f.records().map(r => r.reason)).toEqual(["scoped_target_failed"]); assertSafe(f.records());
    expect(f.apiCall).toHaveBeenCalledTimes(2);
  });
  it("does not reread raw getter/proxy/toJSON while observing a same-role rejection", async () => {
    const f = fixture(), getter = vi.fn(() => "PRIVATE_CONTEXT"), toJSON = vi.fn(() => { throw new Error(token); });
    const raw = Object.defineProperty({ ...message(), toJSON }, "content", { get: getter, enumerable: true });
    const gets: string[] = [];
    const proxy = new Proxy(raw, { get(target, key, receiver) { if (key === "content") gets.push("content"); return Reflect.get(target, key, receiver); } });
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [message(), proxy] } });
    expect((await f.searcher.search({ query: "keyword" }, f.context)).status).toBe("unavailable");
    expect(f.records().at(-1)).toMatchObject({ reason: "same_role_hash_conflict", origin: "page", role: "primary", comparisonAvailable: true });
    expect(getter).toHaveBeenCalledTimes(1); expect(gets).toEqual(["content"]); expect(toJSON).not.toHaveBeenCalled(); assertSafe(f.records());
  });
  it("cancelled continuation drains and unlocks the same seed even when diagnostic logger throws", async () => {
    const f = fixture(), tool = executionTools(createSlackReadTools(f.client)).slack_search;
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [message()] }, next_cursor: "PRIVATE_CURSOR" });
    const first = await tool.execute!({ query: "keyword", limit: 20 }, { requestContext: f.context });
    if ("error" in first) throw new Error("Synthetic seed failed");
    let entered!: () => void, reject!: (error: unknown) => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    f.apiCall.mockImplementationOnce(() => { entered(); return new Promise((_resolve, no) => { reject = no; }); });
    f.spy.mockClear(); f.spy.mockImplementation(() => { throw new Error(token); });
    const scope = new ExecutionScope();
    const work = executionStorage.run(scope, () => tool.execute!({ query: "keyword", limit: 20, cursor: first.nextCursor! }, { requestContext: f.context }));
    const assertion = expect(work).rejects.toMatchObject({ reason: "cancelled" });
    await ready; scope.control.cancel(); reject(new Error(token)); await assertion; await scope.drain(); scope.control.finish();
    expect(f.records().at(-1)).toHaveProperty("reason", "transport_failed"); assertSafe(f.records()); f.spy.mockClear();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [message()] } });
    expect(await tool.execute!({ query: "keyword", limit: 20, cursor: first.nextCursor! }, { requestContext: f.context })).toMatchObject({ status: "ok", page: 2 });
    expect(f.apiCall).toHaveBeenCalledTimes(3); assertSafe(f.records());
  });
  it("keeps seed immutable, no diagnostic retention, logger-throw failure unlock and retry", async () => {
    const f = fixture(); f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [message()] }, next_cursor: "PRIVATE_CURSOR" });
    const first = await f.searcher.search({ query: "keyword" }, f.context);
    expect(first).toMatchObject({ status: "ok" }); expect(f.records().at(-1)).toMatchObject({ reason: "success", finalSuccess: true }); assertSafe(f.records());
    const cursors = (f.searcher as unknown as { cursors: Map<string, object> }).cursors;
    const seed = JSON.stringify(cursors.get(first.nextCursor!));
    expect(Object.keys(cursors.get(first.nextCursor!)!).sort()).toEqual(["binding", "cursor", "deliveredRoles", "expires", "fingerprints", "lossy", "page", "used"]);
    f.spy.mockClear(); f.spy.mockImplementation(() => { throw new Error(token); });
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(), content: "PRIVATE_CONTEXT" }] } });
    expect((await f.searcher.search({ query: "keyword", cursor: first.nextCursor }, f.context)).status).toBe("unavailable");
    expect(JSON.stringify(cursors.get(first.nextCursor!))).toBe(seed);
    expect(f.records().at(-1)).toMatchObject({ reason: "same_role_hash_conflict", origin: "cursor", comparisonAvailable: false, seedPrimaryPresent: true });
    expect(f.records().at(-1)).not.toHaveProperty("equal"); assertSafe(f.records()); f.spy.mockClear();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [message()] } });
    expect(await f.searcher.search({ query: "keyword", cursor: first.nextCursor }, f.context)).toMatchObject({ status: "ok", page: 2 });
    expect(f.apiCall).toHaveBeenCalledTimes(3); expect(cursors.has(first.nextCursor!)).toBe(false); assertSafe(f.records());
  });
});
