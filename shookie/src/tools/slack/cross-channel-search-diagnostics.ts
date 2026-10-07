import { types } from "node:util";
import { logger } from "../../logger.js";
import { getSlackReadIdentity } from "./context.js";

// Fixed pairs. Exceptions are classified ONLY by the pending operation, never by error data.
const stages = {
  preflight_failed: "preflight", authorization_failed: "authorization", prerequisites_missing: "prerequisites",
  current_public_required: "authorization", scoped_target_failed: "scopedtargetverification",
  result_channel_failed: "resultchannelverification", verification_budget: "budget",
  transport_failed: "transport", response_received: "transport", check_failed: "check", check_passed: "check",
  schema_failed: "schema", schema_passed: "schema", warning_present: "schema", result_limit_exceeded: "budget",
  primary_scope_mismatch: "primaryscope", scoped_result_mismatch: "primaryscope", context_scope_mismatch: "contextscope",
  permalink_parse_failed: "permalink", permalink_invalid: "permalink", context_time_invalid: "contexttime", thread_scope_mismatch: "threadscope",
  same_role_hash_conflict: "samerolehash", cross_role_user_conflict: "crossroleuser", cross_role_kind_conflict: "explicitkind",
  cross_role_thread_conflict: "thread", cross_role_text_relation: "relation", cross_role_seed_unverified: "seed",
  budget_exceeded: "budget", cursor_conflict: "cursorreplay_conflict", cursor_replay: "cursorreplay_conflict",
  cursor_invalid: "cursorreplay_conflict", validation_exception: "preflight", success: "final",
} as const;
export type CrossSearchReason = keyof typeof stages;

/** Own data properties only. A proxy (including revoked) is never interrogated. */
function data(object: unknown, key: string): unknown {
  if (object === null || typeof object !== "object" || types.isProxy(object)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
const item = Symbol("item");
// Whole fixed schema paths, not suffix matching arbitrary response keys.
const paths: Record<string, readonly (string | symbol)[]> = {
  response: [], results: ["results"], messages: ["results", "messages"], message_item: ["results", "messages", item],
  files: ["results", "files"], channels: ["results", "channels"], users: ["results", "users"],
  response_metadata: ["response_metadata"], metadata_next_cursor: ["response_metadata", "next_cursor"],
  metadata_warnings: ["response_metadata", "warnings"], metadata_warning_item: ["response_metadata", "warnings", item],
  next_cursor: ["next_cursor"], has_more: ["has_more"], warning: ["warning"],
};
const primaryFields = ["channel_id", "team_id", "channel", "team", "message_ts", "content", "author_user_id", "is_author_bot", "permalink", "thread_ts", "context_messages"] as const;
const contextFields = ["channel_id", "team_id", "channel", "team", "ts", "text", "user_id", "user", "is_author_bot", "bot_id", "thread_ts"] as const;
for (const field of primaryFields) paths[`message_${field}`] = ["results", "messages", item, field];
for (const position of ["before", "after"] as const) paths[`context_${position}`] = ["results", "messages", item, "context_messages", position];
const schemaFields = [...Object.keys(paths), "context_item", ...contextFields.map(field => `context_${field}`), "unknown"];
const schemaCodes = ["invalid_type", "invalid_literal", "custom", "invalid_union", "invalid_union_discriminator", "invalid_enum_value", "unrecognized_keys", "invalid_arguments", "invalid_return_type", "invalid_date", "invalid_string", "too_small", "too_big", "invalid_intersection_types", "not_multiple_of", "not_finite", "unknown"];
function schemaField(path: unknown): string {
  if (path === null || typeof path !== "object" || types.isProxy(path) || !Array.isArray(path)) return "unknown";
  const length = data(path, "length");
  if (typeof length !== "number" || length > 7) return "unknown";
  const matches = (pattern: readonly (string | symbol)[]) => length === pattern.length && pattern.every((part, index) => {
    const value = data(path, String(index));
    return part === item ? typeof value === "number" && Number.isSafeInteger(value) && value >= 0 : value === part;
  });
  for (const field of Object.keys(paths)) if (matches(paths[field])) return field;
  for (const position of ["before", "after"] as const) {
    const prefix = ["results", "messages", item, "context_messages", position, item];
    if (matches(prefix)) return "context_item";
    for (const field of contextFields) if (matches([...prefix, field])) return `context_${field}`;
  }
  return "unknown";
}
/** Inspect only the first own issue's fixed path/code and missing predicate. Never emit received/message/path. */
export function summarizeCrossSearchSchema(issues: unknown): { schemaField: string; schemaCode: string; schemaMissing: boolean } {
  try {
    const issue = data(issues, "0"), code = data(issue, "code");
    return { schemaField: schemaField(data(issue, "path")), schemaCode: schemaCodes.find(known => known === code) ?? "unknown",
      schemaMissing: code === "invalid_type" && data(issue, "received") === "undefined" };
  } catch { return { schemaField: "unknown", schemaCode: "unknown", schemaMissing: false }; }
}
const enums = {
  role: ["primary", "context", "unknown"], origin: ["page", "cursor", "unknown"],
  primaryKnownKinds: ["none", "bot", "participant", "mixed", "unknown"], contextKnownKinds: ["none", "bot", "participant", "mixed", "unknown"],
  schemaField: schemaFields, schemaCode: schemaCodes,
} as const;
const booleans = ["finalSuccess", "cursorPresent", "pagePrimaryPresent", "pageContextPresent", "seedPrimaryPresent", "seedContextPresent",
  "usersCompatible", "kindsCompatible", "threadsCompatible", "channelIdAgrees", "channelAliasAgrees", "teamIdAgrees", "teamAliasAgrees",
  "permalinkParsed", "canonicalHttps", "canonicalHref", "verifiedWorkspace", "noUserinfo", "noPort", "noHash", "pathAgrees", "pathChannelAgrees", "pathMessageTsAgrees",
  "queryKnown", "queryDuplicate", "queryCidAgrees", "queryRootValid", "threadMetadataAvailable", "queryRootAgrees", "queryEmpty",
  "schemaMissing", "comparisonAvailable", "equal", "primaryPrefix", "contextPrefix", "primarySubstring", "contextSubstring", "trimEquals", "lineEndingEquals"] as const;

/** No raw objects reach the logger; descriptors are re-projected through primitive allowlists. */
export function logCrossChannelSearchDiagnostic(context: object | undefined, reason: CrossSearchReason, observations?: unknown): void {
  try {
    if (typeof reason !== "string" || !Object.hasOwn(stages, reason)) return;
    const record: Record<string, string | boolean> = { stage: stages[reason], reason };
    const identity = getSlackReadIdentity(context);
    // Only the private WeakMap identity; never context.get(), event text or supplied observations.
    const requestId = data(identity, "requestId");
    record.correlationAvailable = typeof requestId === "string" && requestId !== "";
    if (record.correlationAvailable) record.requestId = requestId as string;
    for (const key of booleans) {
      const value = data(observations, key);
      if (typeof value === "boolean") record[key] = value;
    }
    for (const key of Object.keys(enums) as (keyof typeof enums)[]) {
      const value = data(observations, key);
      if (typeof value === "string") record[key] = enums[key].find(known => known === value) ?? "unknown";
    }
    // Unavailable comparisons mean unknown, not evidence of inequality.
    if (record.comparisonAvailable !== true) for (const key of comparisonKeys) delete record[key];
    logger.info("slack_cross_channel_search_diagnostic", record);
  } catch { /* Logging cannot change rejection, cancellation, seed state or finally cleanup. */ }
}
const comparisonKeys = ["equal", "primaryPrefix", "contextPrefix", "primarySubstring", "contextSubstring", "trimEquals", "lineEndingEquals"] as const;

/** Validated page-local strings only. Never authorize, retain, hash or log either text here. */
export function compareCrossSearchText(primary: unknown, contextual: unknown): Record<string, boolean> {
  try {
    if (typeof primary !== "string" || typeof contextual !== "string" || primary.length > 24_000 || contextual.length > 24_000 ||
        Buffer.byteLength(primary) > 24_000 || Buffer.byteLength(contextual) > 24_000) return { comparisonAvailable: false };
    return { comparisonAvailable: true, equal: primary === contextual,
      primaryPrefix: contextual.startsWith(primary), contextPrefix: primary.startsWith(contextual),
      primarySubstring: contextual.includes(primary), contextSubstring: primary.includes(contextual),
      trimEquals: primary.trim() === contextual.trim(), lineEndingEquals: primary.replace(/\r\n?/g, "\n") === contextual.replace(/\r\n?/g, "\n") };
  } catch { return { comparisonAvailable: false }; }
}
