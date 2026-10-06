import { types } from "node:util";
import { logger } from "../../logger.js";
import { getSlackReadIdentity } from "./context.js";

// Static stage/reason pairs only. No API error code or response-derived string is accepted.
const stages = {
  preflight_failed: "preflight", authorization_failed: "authorization", prerequisites_missing: "prerequisites",
  api_call_failed: "transport", response_received: "transport", check_failed: "api_check", check_passed: "api_check",
  schema_exception: "schema", schema_invalid: "schema", warning_present: "warnings", result_limit_exceeded: "result_limit",
  scope_mismatch: "scope", permalink_invalid: "permalink", context_time_invalid: "context_time",
  thread_scope_mismatch: "thread_scope", fingerprint_conflict: "fingerprint", budget_exceeded: "budget",
  cursor_conflict: "cursor", cursor_replay: "cursor", validation_exception: "validation",
} as const;
export type SearchDiagnosticReason = keyof typeof stages;
const permalinkHosts = ["workspace", "app.slack.com", "slack.com", "other"] as const;
const permalinkPaths = ["archives_message", "other"] as const;
const permalinkQueries = ["none", "known", "unknown"] as const;
type PermalinkHost = typeof permalinkHosts[number];
type PermalinkPath = typeof permalinkPaths[number];
type PermalinkQuery = typeof permalinkQueries[number];

/** Primitive-only predicate vector; never accept/spread URL objects or response metadata. */
export function logSlackSearchPermalinkDiagnostic(context: object | undefined,
  parsed: boolean, canonicalHref: boolean, https: boolean, host: boolean, noUserinfo: boolean,
  noPort: boolean, noHash: boolean, noQuery: boolean, path: boolean,
  hostClass: PermalinkHost, pathShape: PermalinkPath, pathChannelMatch: boolean, pathMessageTsMatch: boolean,
  queryClass: PermalinkQuery, queryThreadTsPresent: boolean, queryCidPresent: boolean,
  queryThreadTsAvailable: boolean, queryThreadTsMatch: boolean, queryCidMatch: boolean, queryDuplicate: boolean): void {
  try {
    const identity = getSlackReadIdentity(context);
    logger.info("slack_search_response_diagnostic", {
      stage: "permalink", reason: "permalink_invalid", correlationAvailable: !!identity?.requestId,
      ...(identity?.requestId ? { requestId: identity.requestId } : {}),
      permalinkParsed: parsed === true, permalinkCanonicalHref: canonicalHref === true,
      permalinkHttps: https === true, permalinkHost: host === true, permalinkNoUserinfo: noUserinfo === true,
      permalinkNoPort: noPort === true, permalinkNoHash: noHash === true, permalinkNoQuery: noQuery === true,
      permalinkPath: path === true,
      hostClass: permalinkHosts.find(known => known === hostClass) ?? "other",
      pathShape: permalinkPaths.find(known => known === pathShape) ?? "other",
      pathChannelMatch: pathChannelMatch === true, pathMessageTsMatch: pathMessageTsMatch === true,
      queryClass: permalinkQueries.find(known => known === queryClass) ?? "unknown",
      queryThreadTsPresent: queryThreadTsPresent === true, queryCidPresent: queryCidPresent === true,
      queryThreadTsAvailable: queryThreadTsAvailable === true, queryThreadTsMatch: queryThreadTsMatch === true,
      queryCidMatch: queryCidMatch === true, queryDuplicate: queryDuplicate === true,
    });
  } catch { /* Observation cannot affect local unavailable or cursor finally cleanup. */ }
}

const conflictRoles = ["primary", "context", "unknown"] as const;
const conflictOrigins = ["page", "cursor", "unknown"] as const;
const prefixRelations = ["previous_prefix", "current_prefix", "neither", "unknown"] as const;
type ConflictRole = typeof conflictRoles[number];
type ConflictOrigin = typeof conflictOrigins[number];
type PrefixRelation = typeof prefixRelations[number];
const conflictFailures = ["same_role_text", "cross_role_user", "cross_role_kind", "cross_role_thread",
  "cross_role_text_relation", "cross_role_seed_unverified", "unknown"] as const;
// Explicit schema-validated knowledge only (PR104's older logs summarized projected kind).
// A mixed source summary need not be mixed knowledge; the caller aggregates flags per object.
const knownKinds = ["none", "bot", "participant", "mixed"] as const;
const kindSources = ["explicit_bot", "explicit_participant", "inferred_participant", "unknown", "mixed"] as const;
export type SearchConflictFailure = typeof conflictFailures[number];
export type SearchKnownKinds = typeof knownKinds[number];
export type SearchKindSource = typeof kindSources[number];

/** The existing failure record only. All arguments after context are re-projected primitives. */
export function logSlackSearchConflictDiagnostic(context: object | undefined,
  priorRole: ConflictRole, currentRole: ConflictRole, priorOrigin: ConflictOrigin,
  firstPage: boolean, cursorPresent: boolean, comparisonAvailable: boolean,
  trimEqual: boolean, lineEndingEqual: boolean, prefixRelation: PrefixRelation,
  failure: SearchConflictFailure = "unknown", primaryKnownKinds: SearchKnownKinds = "none",
  contextKnownKinds: SearchKnownKinds = "none", primaryKindSource: SearchKindSource = "unknown",
  contextKindSource: SearchKindSource = "unknown"): void {
  try {
    const identity = getSlackReadIdentity(context);
    logger.info("slack_search_response_diagnostic", {
      stage: "fingerprint", reason: "fingerprint_conflict", correlationAvailable: !!identity?.requestId,
      ...(identity?.requestId ? { requestId: identity.requestId } : {}),
      priorRole: conflictRoles.find(known => known === priorRole) ?? "unknown",
      currentRole: conflictRoles.find(known => known === currentRole) ?? "unknown",
      priorOrigin: conflictOrigins.find(known => known === priorOrigin) ?? "unknown",
      firstPage: firstPage === true, cursorPresent: cursorPresent === true,
      comparisonAvailable: comparisonAvailable === true,
      trimEqual: comparisonAvailable === true && trimEqual === true,
      lineEndingEqual: comparisonAvailable === true && lineEndingEqual === true,
      prefixRelation: comparisonAvailable === true ? prefixRelations.find(known => known === prefixRelation) ?? "unknown" : "unknown",
      failure: conflictFailures.find(known => known === failure) ?? "unknown",
      primaryKnownKinds: knownKinds.find(known => known === primaryKnownKinds) ?? "none",
      contextKnownKinds: knownKinds.find(known => known === contextKnownKinds) ?? "none",
      primaryKindSource: kindSources.find(known => known === primaryKindSource) ?? "unknown",
      contextKindSource: kindSources.find(known => known === contextKindSource) ?? "unknown",
    });
  } catch { /* Observation cannot affect rejection, cancellation or cursor unlock. */ }
}

/** Page-local validated primitive text only; never persisted or passed to the logger. */
export function compareSlackSearchConflict(previous: unknown, current: unknown): Readonly<{
  comparisonAvailable: boolean; trimEqual: boolean; lineEndingEqual: boolean; prefixRelation: PrefixRelation;
}> {
  const unknown = { comparisonAvailable: false, trimEqual: false, lineEndingEqual: false, prefixRelation: "unknown" } as const;
  try {
    // The cheap code-unit bound prevents scanning an arbitrarily large API string just for diagnosis.
    if (typeof previous !== "string" || typeof current !== "string" || previous.length > 24_000 || current.length > 24_000 ||
        Buffer.byteLength(previous) > 24_000 || Buffer.byteLength(current) > 24_000) return unknown;
    return { comparisonAvailable: true, trimEqual: previous.trim() === current.trim(),
      lineEndingEqual: previous.replace(/\r\n?/g, "\n") === current.replace(/\r\n?/g, "\n"),
      prefixRelation: current.startsWith(previous) ? "previous_prefix" : previous.startsWith(current) ? "current_prefix" : "neither" };
  } catch { return unknown; }
}

const index = Symbol("item");
// Complete paths for this fixed responseSchema, not suffix matches on arbitrary metadata keys.
const paths = {
  response: [], results: ["results"], messages: ["results", "messages"], message_item: ["results", "messages", index],
  files: ["results", "files"], channels: ["results", "channels"], users: ["results", "users"],
  response_metadata: ["response_metadata"], metadata_next_cursor: ["response_metadata", "next_cursor"],
  metadata_warnings: ["response_metadata", "warnings"], metadata_warning_item: ["response_metadata", "warnings", index], next_cursor: ["next_cursor"], has_more: ["has_more"], warning: ["warning"],
  message_channel_id: ["results", "messages", index, "channel_id"], message_team_id: ["results", "messages", index, "team_id"],
  message_channel: ["results", "messages", index, "channel"], message_team: ["results", "messages", index, "team"],
  message_message_ts: ["results", "messages", index, "message_ts"], message_content: ["results", "messages", index, "content"],
  message_author_user_id: ["results", "messages", index, "author_user_id"], message_is_author_bot: ["results", "messages", index, "is_author_bot"],
  message_permalink: ["results", "messages", index, "permalink"], message_thread_ts: ["results", "messages", index, "thread_ts"],
  message_context_messages: ["results", "messages", index, "context_messages"],
  context_before: ["results", "messages", index, "context_messages", "before"],
  context_after: ["results", "messages", index, "context_messages", "after"],
} as const;
const contextFields = ["channel_id", "team_id", "channel", "team", "ts", "text", "user_id", "user", "is_author_bot", "bot_id", "thread_ts"] as const;
type SchemaField = keyof typeof paths | "context_item" | `context_${typeof contextFields[number]}` | "unknown";
const codes = ["invalid_type", "invalid_literal", "custom", "invalid_union", "invalid_union_discriminator", "invalid_enum_value",
  "unrecognized_keys", "invalid_arguments", "invalid_return_type", "invalid_date", "invalid_string", "too_small", "too_big",
  "invalid_intersection_types", "not_multiple_of", "not_finite"] as const;
type SchemaCode = typeof codes[number] | "unknown";
export type SearchSchemaSummary = Readonly<{ field: SchemaField; code: SchemaCode; missing: boolean }>;

/** Own data descriptors only, including for Zod issues. No getters/proxies/toJSON/key enumeration. */
function data(object: unknown, key: string): unknown {
  if (object === null || typeof object !== "object" || types.isProxy(object)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
function fieldFor(path: unknown): SchemaField {
  if (path === null || typeof path !== "object" || types.isProxy(path) || !Array.isArray(path)) return "unknown";
  const length = data(path, "length");
  if (typeof length !== "number" || length > 7) return "unknown";
  const matches = (pattern: readonly (string | symbol)[]) => length === pattern.length && pattern.every((part, i) => {
    const value = data(path, String(i));
    return part === index ? typeof value === "number" && Number.isSafeInteger(value) && value >= 0 : value === part;
  });
  // Enumerating our static table, never response/issue keys.
  for (const field of Object.keys(paths) as (keyof typeof paths)[]) if (matches(paths[field])) return field;
  for (const position of ["before", "after"] as const) {
    const prefix = ["results", "messages", index, "context_messages", position, index];
    if (matches(prefix)) return "context_item";
    for (const field of contextFields) if (matches([...prefix, field])) return `context_${field}`;
  }
  return "unknown";
}

/** Bounded first issue only. Do not log/pass issues, paths, messages, inputs or received values. */
export function summarizeSearchSchemaIssues(issues: unknown): SearchSchemaSummary {
  const unknown: SearchSchemaSummary = { field: "unknown", code: "unknown", missing: false };
  try {
    const issue = data(issues, "0");
    const code = data(issue, "code");
    return { field: fieldFor(data(issue, "path")),
      code: codes.find(known => known === code) ?? "unknown",
      missing: code === "invalid_type" && data(issue, "received") === "undefined" };
  } catch { return unknown; }
}

/** Primitive-only logging API. Raw responses/errors/issues are never logger arguments. */
export function logSlackSearchDiagnostic(context: object | undefined, reason: SearchDiagnosticReason,
  field?: SchemaField, code?: SchemaCode, missing?: boolean): void {
  try {
    // Runtime allowlists also protect accidental cast/unknown input; never spread a caller object.
    if (typeof reason !== "string" || !Object.hasOwn(stages, reason)) return;
    const identity = getSlackReadIdentity(context);
    const knownField = typeof field === "string" && (Object.hasOwn(paths, field) || field === "context_item" ||
      contextFields.some(known => field === `context_${known}`)) ? field : "unknown";
    logger.info("slack_search_response_diagnostic", {
      stage: stages[reason], reason, correlationAvailable: !!identity?.requestId,
      ...(identity?.requestId ? { requestId: identity.requestId } : {}),
      ...(reason === "schema_invalid" ? { schemaField: knownField,
        schemaCode: codes.find(known => known === code) ?? "unknown", schemaMissing: missing === true } : {}),
    });
  } catch { /* Observation must not change the failure classification, cancellation or cursor cleanup. */ }
}
