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
// Object identity only: do not retain bodies, events, token values or IDs in these markers.
type SocketMarker = { receiverSeen: boolean };
const socketBodies = new WeakMap<object, SocketMarker>();
const socketEvents = new WeakMap<object, SocketMarker>();
function safeObject(value: unknown): value is object {
  return value !== null && typeof value === "object" && !types.isProxy(value);
}

/** Own data properties only. Never invoke getters, proxy traps, toJSON or walk arbitrary keys. */
function ownData(object: unknown, key: "event" | "action_token" | "body" | "type" | "event_id" | "bot_id" | "subtype" | "user" | "channel" | "channel_type" | "ts"): { observation: Observation; value?: unknown } {
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
  const alias = safeObject(body) ? socketBodies.get(body) : undefined;
  logger.info(MESSAGE, { stage: "receive", eventKind, requestId, requestIdTrust: "authenticated_handler",
    sdkBodyAlias: !!alias, sdkEventAlias: !!alias && safeObject(event) && socketEvents.get(event) === alias,
    receiverBodyAlias: !!alias?.receiverSeen, ...projectSlackTokenSlots(event, body, context) });
}

/** Reusable primitive-only projection; callers never log the input objects. */
function projectSlackTokenSlots(event: unknown, body: unknown, context?: unknown) {
  const eventSlot = tokenSlot(event);
  const nested = ownData(body, "event");
  const bodyEventSlot = nested.observation === "data" ? tokenSlot(nested.value)
    : { observation: nested.observation === "absent" ? "absent" as const : "blocked" as const, present: false, usable: false };
  const bodySlot = tokenSlot(body);
  const contextSlot = tokenSlot(context);
  // Explicit primitive allowlist: never pass the inputs, descriptors or token values to the logger.
  return {
    eventTokenObservation: eventSlot.observation, eventTokenPresent: eventSlot.present, eventTokenUsable: eventSlot.usable,
    bodyEventTokenObservation: bodyEventSlot.observation, bodyEventTokenPresent: bodyEventSlot.present, bodyEventTokenUsable: bodyEventSlot.usable,
    bodyTokenObservation: bodySlot.observation, bodyTokenPresent: bodySlot.present, bodyTokenUsable: bodySlot.usable,
    contextTokenObservation: contextSlot.observation, contextTokenPresent: contextSlot.present, contextTokenUsable: contextSlot.usable,
  };
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

/** Public SDK event / receiver extractor observation. No ack, dispatch, mutation or exception escape. */
export function logSlackSocketTokenBoundary(stage: "socket_sdk" | "socket_receiver", args: unknown): void {
  try {
    const body = ownData(args, "body").value;
    if (!safeObject(body) || ownData(body, "type").value !== "event_callback") return;
    const bodyEvent = ownData(body, "event").value;
    if (!safeObject(bodyEvent)) return;
    const eventKind = ownData(bodyEvent, "type").value;
    if (eventKind !== "app_mention" && eventKind !== "message") return;
    // Narrow human/DM categories; do not read any message/file content.
    for (const key of ["bot_id", "subtype"] as const) {
      if (ownData(bodyEvent, key).observation !== "absent") return;
    }
    for (const key of ["user", "channel", "ts"] as const) {
      const value = ownData(bodyEvent, key).value;
      if (typeof value !== "string" || !value || value.length > 64) return;
    }
    if (eventKind === "message" && ownData(bodyEvent, "channel_type").value !== "im") return;
    const event = stage === "socket_sdk" ? ownData(args, "event").value : bodyEvent;
    let marker = socketBodies.get(body);
    if (stage === "socket_sdk") {
      marker = { receiverSeen: false };
      socketBodies.set(body, marker);
      if (safeObject(event)) socketEvents.set(event, marker);
    } else if (marker) {
      marker.receiverSeen = true;
    }
    const eventId = ownData(body, "event_id").value;
    // This is NOT an authenticated requestId or authority. Invalid IDs are omitted, not hashed.
    const eventCorrelationId = typeof eventId === "string" && eventId.length <= 64 && /^Ev[A-Z0-9]{8,62}$/.test(eventId)
      ? `slack-event:${eventId}` : undefined;
    logger.info(MESSAGE, {
      stage, eventKind, correlationTrust: "untrusted_event_id", correlationAvailable: !!eventCorrelationId,
      ...(eventCorrelationId ? { eventCorrelationId } : {}),
      sdkBodyAlias: !!marker,
      sdkEventAlias: !!marker && safeObject(bodyEvent) && socketEvents.get(bodyEvent) === marker,
      receiverBodyAlias: !!marker?.receiverSeen,
      ...projectSlackTokenSlots(event, body),
    });
  } catch { /* Diagnostic failures must never interrupt receiver ack or listener delivery. */ }
}

export function logSlackTokenSearch(context: object | undefined, stage: "search" | "search_api" = "search"): void {
  const correlation = context ? correlations.get(context) : undefined;
  const identity = getSlackReadIdentity(context);
  const requestId = correlation?.requestId ?? identity?.requestId;
  logger.info(MESSAGE, { stage, eventKind: correlation?.eventKind ?? "unknown",
    ...(requestId ? { requestId } : {}), correlationAvailable: !!requestId,
    identityBound: !!identity, tokenBound: !!getSlackSearchActionToken(context) });
}
