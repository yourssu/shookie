import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { logger } from "../../logger.js";
import { bindSlackReadContext } from "./context.js";
import { compareSlackSearchConflict, logSlackSearchConflictDiagnostic, logSlackSearchDiagnostic, logSlackSearchPermalinkDiagnostic, summarizeSearchSchemaIssues } from "./search-diagnostics.js";

describe("bounded conflict comparison and primitive diagnostic", () => {
  it.each([
    [" value ", "value", true, false, "neither"],
    ["a\r\nb\rc", "a\nb\nc", false, true, "neither"],
    ["prefix", "prefix tail", false, false, "previous_prefix"],
    ["prefix tail", "prefix", false, false, "current_prefix"],
    ["a", "b", false, false, "neither"],
    ["", "b", false, false, "previous_prefix"],
  ])("returns only derived flags for bounded strings", (previous, current, trimEqual, lineEndingEqual, prefixRelation) => {
    expect(compareSlackSearchConflict(previous, current)).toEqual({ comparisonAvailable: true, trimEqual, lineEndingEqual, prefixRelation });
  });
  it("caps both strings by existing 24KB threshold; unavailable is not evidence of inequality", () => {
    const unknown = { comparisonAvailable: false, trimEqual: false, lineEndingEqual: false, prefixRelation: "unknown" };
    const boundary = "a".repeat(24_000);
    expect(compareSlackSearchConflict(boundary, "b".repeat(24_000)).comparisonAvailable).toBe(true);
    expect(compareSlackSearchConflict("😀".repeat(6_000), "a").comparisonAvailable).toBe(true);
    for (const oversized of [boundary + "a", "😀".repeat(6_001)]) {
      expect(compareSlackSearchConflict(oversized, "a")).toEqual(unknown);
      expect(compareSlackSearchConflict("a", oversized)).toEqual(unknown);
    }
    expect(compareSlackSearchConflict(undefined, "a")).toEqual(unknown);
    vi.spyOn(Buffer, "byteLength").mockImplementation(() => { throw new Error("private"); });
    expect(compareSlackSearchConflict("a", "b")).toEqual(unknown);
  });
  it.each(["same_role_text", "cross_role_user", "cross_role_kind", "cross_role_thread",
    "cross_role_text_relation", "cross_role_seed_unverified", "unknown"] as const)("preserves fixed failure %s independently of comparison availability", failure => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => {});
    logSlackSearchConflictDiagnostic(undefined, "primary", "context", "page", true, false, false, false, false, "unknown",
      failure, "bot", "mixed", "explicit_bot", "mixed");
    expect(spy.mock.calls.at(-1)?.[1]).toMatchObject({ failure, comparisonAvailable: false,
      primaryKnownKinds: "bot", contextKnownKinds: "mixed", primaryKindSource: "explicit_bot", contextKindSource: "mixed" });
  });
  it("never executes object casts/getters/proxies/toJSON, logs only allowlisted primitives and WeakMap correlation", () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => {});
    const execute = vi.fn(() => { throw new Error(secret); });
    const proxy = new Proxy({}, { get: execute, ownKeys: execute, getOwnPropertyDescriptor: execute, getPrototypeOf: execute });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    const object = Object.defineProperty({ toJSON: execute, toString: execute }, "length", { get: execute });
    const context = { requestId: secret, toJSON: execute };
    for (const forged of [object, proxy, revoked.proxy, secret, undefined, 1]) {
      if (typeof forged !== "string") expect(compareSlackSearchConflict(forged, "a").comparisonAvailable).toBe(false);
      logSlackSearchConflictDiagnostic(context, forged as never, forged as never, forged as never,
        forged as never, forged as never, forged as never, forged as never, forged as never, forged as never,
        forged as never, forged as never, forged as never, forged as never, forged as never);
      expect(spy.mock.calls.at(-1)?.[1]).toEqual({ stage: "fingerprint", reason: "fingerprint_conflict", correlationAvailable: false,
        priorRole: "unknown", currentRole: "unknown", priorOrigin: "unknown", firstPage: false, cursorPresent: false,
        comparisonAvailable: false, trimEqual: false, lineEndingEqual: false, prefixRelation: "unknown",
        failure: "unknown", primaryKnownKinds: "none", contextKnownKinds: "none", primaryKindSource: "unknown", contextKindSource: "unknown" });
    }
    bindSlackReadContext(context, { requestId: "trusted-request", teamId: "TSECRET", userId: "USECRET", channel: "CSECRET" }, secret);
    logSlackSearchConflictDiagnostic(context, "context", "primary", "cursor", false, true, false, true, true, "previous_prefix");
    expect(spy.mock.calls.at(-1)?.[1]).toMatchObject({ requestId: "trusted-request", priorRole: "context", currentRole: "primary", priorOrigin: "cursor",
      comparisonAvailable: false, trimEqual: false, lineEndingEqual: false, prefixRelation: "unknown" });
    expect(execute).not.toHaveBeenCalled();
    for (const value of [secret, "TSECRET", "USECRET", "CSECRET"]) expect(JSON.stringify(spy.mock.calls)).not.toContain(value);
    spy.mockImplementation(() => { throw new Error(secret); });
    expect(() => logSlackSearchConflictDiagnostic(proxy, "unknown", "unknown", "unknown", false, false, false, false, false, "unknown")).not.toThrow();
  });
});

const secret = "ARBITRARY_SECRET_TOKEN_METADATA";
afterEach(() => vi.restoreAllMocks());

describe("primitive-only permalink diagnostic runtime allowlist", () => {
  it("drops all forged values without getters, proxy traps, coercion or toJSON; correlates only via WeakMap", () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => {});
    const execute = vi.fn(() => { throw new Error(secret); });
    const proxy = new Proxy({}, { get: execute, ownKeys: execute, getOwnPropertyDescriptor: execute, getPrototypeOf: execute });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    const object = Object.defineProperties({ toJSON: execute, toString: execute }, { value: { get: execute } });
    const context = { requestId: secret, get: execute, toJSON: execute };
    const args: Parameters<typeof logSlackSearchPermalinkDiagnostic> = [context,
      true, true, true, true, true, true, true, true, true, "workspace", "archives_message", true, true,
      "known", true, true, true, true, true, true];
    for (const forged of [secret, proxy, revoked.proxy, object, 1, undefined]) {
      // Includes every primitive argument and an untrusted context: no object input reaches logger.
      logSlackSearchPermalinkDiagnostic(...args.map(() => forged) as unknown as typeof args);
      const record = spy.mock.calls.at(-1)?.[1] as Record<string, unknown>;
      expect(record).toMatchObject({ stage: "permalink", reason: "permalink_invalid", correlationAvailable: false,
        hostClass: "other", pathShape: "other", queryClass: "unknown" });
      expect(Object.entries(record).filter(([, v]) => typeof v === "boolean").every(([, v]) => v === false)).toBe(true);
    }
    logSlackSearchPermalinkDiagnostic(...args);
    expect(spy.mock.calls.at(-1)?.[1]).not.toHaveProperty("requestId");
    bindSlackReadContext(context, { requestId: "trusted-request", teamId: "TSECRET", userId: "USECRET", channel: "CSECRET" }, secret);
    logSlackSearchPermalinkDiagnostic(...args);
    expect(spy.mock.calls.at(-1)?.[1]).toMatchObject({ requestId: "trusted-request", correlationAvailable: true });
    expect(execute).not.toHaveBeenCalled();
    for (const value of [secret, "TSECRET", "USECRET", "CSECRET"]) expect(JSON.stringify(spy.mock.calls)).not.toContain(value);
    spy.mockImplementation(() => { throw new Error(secret); });
    expect(() => logSlackSearchPermalinkDiagnostic(...args)).not.toThrow();
  });
});

describe("bounded fixed-schema issue projection", () => {
  it.each([
    [[], "response"], [["results"], "results"], [["results", "messages"], "messages"],
    [["results", "messages", 987654], "message_item"],
    ...["channel_id", "team_id", "channel", "team", "message_ts", "content", "author_user_id", "is_author_bot", "permalink", "thread_ts", "context_messages"].map(field =>
      [["results", "messages", 987654, field], `message_${field}`]),
    [["results", "messages", 0, "context_messages", "before"], "context_before"],
    [["results", "messages", 0, "context_messages", "after", 9], "context_item"],
    ...["channel_id", "team_id", "channel", "team", "ts", "text", "user_id", "user", "is_author_bot", "bot_id", "thread_ts"].map(field =>
      [["results", "messages", 0, "context_messages", "after", 9, field], `context_${field}`]),
    ...["files", "channels", "users"].map(field => [["results", field], field]),
    ...["response_metadata", "next_cursor", "has_more", "warning"].map(field => [[field], field]),
    [["response_metadata", "warnings"], "metadata_warnings"],
    [["response_metadata", "warnings", 0], "metadata_warning_item"],
    [["response_metadata", "next_cursor"], "metadata_next_cursor"],
    [[secret, "team_id"], "unknown"], [["results", "messages", secret, "team_id"], "unknown"],
    [["results", "messages", 0, "metadata", "team_id"], "unknown"],
    [["results", "messages", 0, "team_id", secret], "unknown"],
  ])("maps only full expected path to fixed field: %s", (path, field) => {
    const summary = summarizeSearchSchemaIssues([{ path, code: "invalid_type", received: "undefined", message: secret, input: secret }]);
    expect(summary).toEqual({ field, code: "invalid_type", missing: true });
    expect(JSON.stringify(summary)).not.toContain(secret); expect(JSON.stringify(summary)).not.toContain("987654");
  });
  it("uses actual Zod missing/type/regex/array-limit codes, bounded to first issue", () => {
    const schema = z.object({ results: z.object({ messages: z.array(z.object({ team_id: z.string(), is_author_bot: z.boolean(), message_ts: z.string().regex(/^valid$/) })).max(0) }) });
    const missing = schema.safeParse({ results: { messages: [{ is_author_bot: secret, message_ts: secret }] } });
    if (missing.success) throw new Error("expected failure");
    expect(summarizeSearchSchemaIssues(missing.error.issues)).toEqual({ field: "messages", code: "too_big", missing: false });
    const single = z.object({ results: z.object({ messages: z.array(z.object({ team_id: z.string() })) }) });
    for (const [value, expected] of [[undefined, true], [false, false]] as const) {
      const parsed = single.safeParse({ results: { messages: [{ team_id: value }] } });
      if (parsed.success) throw new Error("expected failure");
      expect(summarizeSearchSchemaIssues(parsed.error.issues)).toEqual({ field: "message_team_id", code: "invalid_type", missing: expected });
    }
    expect(summarizeSearchSchemaIssues([{ path: ["results", "messages", 0, "message_ts"], code: "invalid_string", message: secret }])).toEqual({ field: "message_message_ts", code: "invalid_string", missing: false });
  });
  it("never reads getters/proxy traps/toJSON or arbitrary keys, even on issues/path/code", () => {
    const execute = vi.fn(() => { throw new Error(secret); });
    const proxy = new Proxy({}, { get: execute, ownKeys: execute, getOwnPropertyDescriptor: execute, getPrototypeOf: execute });
    const revoked = Proxy.revocable([], {}); revoked.revoke();
    const path = ["results", "messages", 0, "content"];
    Object.defineProperty(path, "3", { get: execute });
    const inputs = [proxy, revoked.proxy, Object.defineProperty({}, "0", { get: execute }),
      [proxy], [Object.defineProperty({}, "path", { get: execute })],
      [{ path: proxy, code: secret }], [{ path: revoked.proxy, code: proxy }], [{ path, code: "invalid_type" }],
      [{ path: [], code: { toJSON: execute }, message: { toJSON: execute } }]];
    for (const input of inputs) expect(JSON.stringify(summarizeSearchSchemaIssues(input))).not.toContain(secret);
    const issue = Object.defineProperties({ path: ["results"], code: "invalid_type", received: "undefined", toJSON: execute }, {
      message: { get: execute }, input: { get: execute }, unknown: { get: execute },
    });
    const issues = Object.defineProperty([issue], "1", { get: execute });
    expect(summarizeSearchSchemaIssues(issues)).toEqual({ field: "results", code: "invalid_type", missing: true });
    expect(execute).not.toHaveBeenCalled();
  });
  it("logs fixed enums/booleans and trusted identity requestId only, with runtime allowlists", () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => {});
    const context = { requestId: secret, get: () => secret };
    logSlackSearchDiagnostic(context, "schema_invalid", secret as never, secret as never, false);
    expect(spy.mock.calls[0][1]).toEqual({ stage: "schema", reason: "schema_invalid", correlationAvailable: false,
      schemaField: "unknown", schemaCode: "unknown", schemaMissing: false });
    bindSlackReadContext(context, { requestId: "trusted-request", teamId: "TSECRET", userId: "USECRET", channel: "CSECRET" }, secret);
    logSlackSearchDiagnostic(context, "schema_invalid", "message_content", "invalid_type", true);
    expect(spy.mock.calls[1][1]).toMatchObject({ requestId: "trusted-request", schemaField: "message_content", schemaMissing: true });
    logSlackSearchDiagnostic(context, secret as never);
    const execute = vi.fn(() => { throw new Error(secret); });
    const proxy = new Proxy({}, { get: execute, ownKeys: execute, getOwnPropertyDescriptor: execute, getPrototypeOf: execute });
    logSlackSearchDiagnostic(proxy, proxy as never);
    logSlackSearchDiagnostic(proxy, "schema_invalid", proxy as never, { toJSON: execute } as never);
    expect(spy).toHaveBeenCalledTimes(3); expect(execute).not.toHaveBeenCalled();
    for (const value of [secret, "TSECRET", "USECRET", "CSECRET"]) expect(JSON.stringify(spy.mock.calls)).not.toContain(value);
    spy.mockImplementation(() => { throw new Error(secret); });
    expect(() => logSlackSearchDiagnostic(context, "schema_invalid", "message_content", "invalid_type", true)).not.toThrow();
  });
});
