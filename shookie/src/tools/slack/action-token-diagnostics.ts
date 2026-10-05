import { types } from "node:util";
import { logger } from "../../logger.js";
import { isUsableSlackActionToken } from "./action-token-validation.js";
import { getSlackReadIdentity, getSlackSearchActionToken } from "./context.js";

type EventKind = "app_mention" | "message";
type Observation = "absent" | "data" | "accessor" | "blocked";
type Slot = { observation: Observation; present: boolean; usable: boolean };
const MESSAGE = "slack_action_token_diagnostic";
// Ephemeral correlation only, never RequestContext entries, model messages or persistence.
const correlations = new WeakMap<object, { requestId: string; eventKind: EventKind }>();

/** Own data properties only. Never invoke getters, proxy traps, toJSON or walk arbitrary keys. */
function ownData(object: unknown, key: "event" | "action_token"): { observation: Observation; value?: unknown } {
  if (object === null || typeof object !== "object") return { observation: "absent" };
  if (types.isProxy(object)) return { observation: "blocked" };
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor) return { observation: "absent" };
    if (!("value" in descriptor)) return { observation: "accessor" };
    return { observation: "data", value: descriptor.value };
  } catch { return { observation: "blocked" }; }
}
function tokenSlot(object: unknown): Slot {
  const slot = ownData(object, "action_token");
  return { observation: slot.observation, present: slot.observation === "data" || slot.observation === "accessor",
    usable: slot.observation === "data" && isUsableSlackActionToken(slot.value) };
}

/** These four fixed paths are observations, NOT alternate authorities or fallback sources. */
export function logSlackTokenReceive(requestId: string, eventKind: EventKind, event: unknown, body: unknown, context: unknown): void {
  const eventSlot = tokenSlot(event);
  const nested = ownData(body, "event");
  const bodyEventSlot = nested.observation === "data" ? tokenSlot(nested.value)
    : { observation: nested.observation === "absent" ? "absent" as const : "blocked" as const, present: false, usable: false };
  const bodySlot = tokenSlot(body);
  const contextSlot = tokenSlot(context);
  // Explicit primitive allowlist: never pass the inputs, descriptors or token values to the logger.
  logger.info(MESSAGE, {
    stage: "receive", eventKind, requestId,
    eventTokenObservation: eventSlot.observation, eventTokenPresent: eventSlot.present, eventTokenUsable: eventSlot.usable,
    bodyEventTokenObservation: bodyEventSlot.observation, bodyEventTokenPresent: bodyEventSlot.present, bodyEventTokenUsable: bodyEventSlot.usable,
    bodyTokenObservation: bodySlot.observation, bodyTokenPresent: bodySlot.present, bodyTokenUsable: bodySlot.usable,
    contextTokenObservation: contextSlot.observation, contextTokenPresent: contextSlot.present, contextTokenUsable: contextSlot.usable,
  });
}

/** Observe the actual already-selected value; do not read event.action_token again. */
export function logSlackTokenSelection(requestId: string, eventKind: EventKind, selected: unknown): void {
  logger.info(MESSAGE, { stage: "selection", eventKind, requestId, selectedSource: "event.action_token",
    selectedUsable: isUsableSlackActionToken(selected) });
}

/** Called after the existing optional binding, including when missing team prevented binding. */
export function logSlackTokenBinding(context: object, requestId: string, eventKind: EventKind, selected: unknown, bindingAttempted: boolean): void {
  correlations.set(context, { requestId, eventKind });
  logger.info(MESSAGE, { stage: "binding", eventKind, requestId, bindingAttempted,
    selectedUsable: isUsableSlackActionToken(selected), identityBound: !!getSlackReadIdentity(context),
    tokenBound: !!getSlackSearchActionToken(context) });
}

export function logSlackTokenSearch(context: object | undefined, stage: "search" | "search_api" = "search"): void {
  const correlation = context ? correlations.get(context) : undefined;
  const identity = getSlackReadIdentity(context);
  const requestId = correlation?.requestId ?? identity?.requestId;
  logger.info(MESSAGE, { stage, eventKind: correlation?.eventKind ?? "unknown",
    ...(requestId ? { requestId } : {}), correlationAvailable: !!requestId,
    identityBound: !!identity, tokenBound: !!getSlackSearchActionToken(context) });
}
