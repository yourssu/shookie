import { logger } from "../../logger.js";
import { getSlackReadIdentity } from "./context.js";

// Fixed local branch labels only; never accept API codes, errors or response-derived paths.
const stages = {
  identity_failed: "identity", input_failed: "input", target_failed: "target", cursor_invalid: "cursor",
  authorization_failed: "authorization", api_call_failed: "transport", check_failed: "api_check",
  response_exception: "response", response_warning: "response", metadata_warning: "response",
  messages_shape_invalid: "response", result_limit_exceeded: "response",
  message_exception: "message", message_ts_invalid: "message", message_text_invalid: "message",
  message_channel_mismatch: "message", message_team_mismatch: "message", message_thread_ts_invalid: "message",
  message_user_invalid: "message", message_bot_id_invalid: "message",
  thread_exception: "thread", thread_parent_mismatch: "thread", thread_relation_mismatch: "thread", thread_time_invalid: "thread",
  root_reply_count_exception: "root", root_reply_count_invalid: "root", root_missing: "root",
  fingerprint_exception: "fingerprint", fingerprint_conflict: "fingerprint",
  projection_exception: "projection", budget_exceeded: "budget", continuation_exception: "cursor", cursor_replay: "cursor",
} as const;
export type ReadDiagnosticReason = keyof typeof stages;

/** Failure-only observer: primitive runtime allowlists and the trusted identity WeakMap, no fallback. */
export function logSlackReadDiagnostic(context: object | undefined, kind: "thread" | "channel", reason: ReadDiagnosticReason): void {
  try {
    if ((kind !== "thread" && kind !== "channel") || typeof reason !== "string" || !Object.hasOwn(stages, reason)) return;
    const identity = getSlackReadIdentity(context);
    logger.info("slack_read_response_diagnostic", {
      kind, stage: stages[reason], reason, correlationAvailable: !!identity?.requestId,
      ...(identity?.requestId ? { requestId: identity.requestId } : {}),
    });
  } catch { /* Observation cannot affect the public result, cancellation, provenance or cursor unlock. */ }
}
