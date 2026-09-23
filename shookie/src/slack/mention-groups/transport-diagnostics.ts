import * as diagnosticsChannel from "node:diagnostics_channel";

export type RadarTransportStage =
  | "dispatch"
  | "request_created"
  | "request_sent"
  | "response_headers"
  | "request_error";

export interface RadarTransportEvent {
  requestId: string;
  stage: RadarTransportStage;
  elapsedMs: number;
  httpStatus?: number;
  errorClass?: string;
  errorCode?: string;
}

export interface RadarTransportDiagnostics {
  recordError(error: unknown): void;
  stop(): void;
}

interface RequestContext {
  requestId: string;
  startedAt: number;
  now: () => number;
  onEvent: (event: RadarTransportEvent) => void;
  active: boolean;
  errorObserved: boolean;
}

interface CorrelatedRequest {
  context: RequestContext;
  emittedStages: Set<RadarTransportStage>;
}

const activeContexts = new Map<string, RequestContext>();
const correlatedRequests = new WeakMap<object, CorrelatedRequest>();

const requestCreateChannel = diagnosticsChannel.channel("undici:request:create");
const requestBodySentChannel = diagnosticsChannel.channel(
  "undici:request:bodySent",
);
const requestHeadersChannel = diagnosticsChannel.channel("undici:request:headers");
const requestErrorChannel = diagnosticsChannel.channel("undici:request:error");
const clientSendHeadersChannel = diagnosticsChannel.channel(
  "undici:client:sendHeaders",
);

const subscriptions = [
  [requestCreateChannel, safeListener(onRequestCreate)],
  [requestBodySentChannel, safeListener(onRequestSent)],
  [requestHeadersChannel, safeListener(onResponseHeaders)],
  [requestErrorChannel, safeListener(onRequestError)],
  [clientSendHeadersChannel, safeListener(onRequestSent)],
] as const;

let subscribed = false;

/**
 * Undici's diagnostics channels are process-global and experimental. Subscribe
 * only while a Radar request is active, then correlate request events by the
 * exact X-Request-Id carried by the request object. Connection channels are
 * intentionally not used because they cannot be tied safely to one request.
 */
export function startRadarTransportDiagnostics(
  requestId: string,
  onEvent: (event: RadarTransportEvent) => void,
  now: () => number = () => performance.now(),
): RadarTransportDiagnostics {
  const context: RequestContext = {
    requestId,
    startedAt: now(),
    now,
    onEvent,
    active: true,
    errorObserved: false,
  };
  activeContexts.set(requestId, context);
  subscribe();
  emit(context, { stage: "dispatch" });

  return {
    recordError(error: unknown) {
      try {
        emitError(context, error);
      } catch {
        // Diagnostics must never change the Radar request's behavior.
      }
    },
    stop() {
      if (!context.active) return;
      context.active = false;
      if (activeContexts.get(requestId) === context) {
        activeContexts.delete(requestId);
      }
      if (activeContexts.size === 0) unsubscribe();
    },
  };
}

function subscribe() {
  if (subscribed) return;
  for (const [channel, listener] of subscriptions) channel.subscribe(listener);
  subscribed = true;
}

function unsubscribe() {
  if (!subscribed) return;
  for (const [channel, listener] of subscriptions) channel.unsubscribe(listener);
  subscribed = false;
}

function safeListener(listener: (message: unknown) => void) {
  return (message: unknown) => {
    try {
      listener(message);
    } catch {
      // Diagnostics must never change the underlying fetch's behavior.
    }
  };
}

function onRequestCreate(message: unknown) {
  const request = readRequest(message);
  if (!request) return;
  const requestId = readRequestId(request);
  if (!requestId) return;
  const context = activeContexts.get(requestId);
  if (!context) return;

  const correlated: CorrelatedRequest = {
    context,
    emittedStages: new Set(),
  };
  correlatedRequests.set(request, correlated);
  emitOnce(correlated, { stage: "request_created" });
}

function onRequestSent(message: unknown) {
  const correlated = readCorrelatedRequest(message);
  if (!correlated) return;
  emitOnce(correlated, { stage: "request_sent" });
}

function onResponseHeaders(message: unknown) {
  const correlated = readCorrelatedRequest(message);
  if (!correlated) return;
  const status = readHttpStatus(
    readProperty(readProperty(message, "response"), "statusCode"),
  );
  emitOnce(correlated, {
    stage: "response_headers",
    ...(status !== undefined ? { httpStatus: status } : {}),
  });
}

function onRequestError(message: unknown) {
  const correlated = readCorrelatedRequest(message);
  if (!correlated) return;
  emitError(correlated.context, readProperty(message, "error"));
}

function readCorrelatedRequest(message: unknown): CorrelatedRequest | undefined {
  const request = readRequest(message);
  return request ? correlatedRequests.get(request) : undefined;
}

function readRequest(message: unknown): object | undefined {
  const request = readProperty(message, "request");
  return request !== null && typeof request === "object" ? request : undefined;
}

function readRequestId(request: object): string | undefined {
  return readHeaderValue(readProperty(request, "headers"), "x-request-id");
}

function readHeaderValue(headers: unknown, wantedName: string): string | undefined {
  if (Array.isArray(headers)) {
    for (let index = 0; index + 1 < headers.length; index += 2) {
      const name = headers[index];
      const value = headers[index + 1];
      if (
        typeof name === "string" &&
        typeof value === "string" &&
        name.toLowerCase() === wantedName
      ) {
        return value;
      }
    }
    return undefined;
  }

  if (typeof headers === "string") {
    for (const line of headers.split(/\r?\n/u)) {
      const separator = line.indexOf(":");
      if (separator < 0) continue;
      if (line.slice(0, separator).trim().toLowerCase() !== wantedName) continue;
      return line.slice(separator + 1).trim();
    }
    return undefined;
  }

  const value = readProperty(headers, wantedName);
  return typeof value === "string" ? value : undefined;
}

function emitOnce(
  correlated: CorrelatedRequest,
  event: Omit<RadarTransportEvent, "requestId" | "elapsedMs">,
) {
  if (correlated.emittedStages.has(event.stage)) return;
  correlated.emittedStages.add(event.stage);
  emit(correlated.context, event);
}

function emitError(context: RequestContext, error: unknown) {
  if (!context.active || context.errorObserved) return;
  context.errorObserved = true;
  const errorCode = safeErrorCode(error);
  emit(context, {
    stage: "request_error",
    errorClass: safeErrorClass(error),
    ...(errorCode ? { errorCode } : {}),
  });
}

function emit(
  context: RequestContext,
  event: Omit<RadarTransportEvent, "requestId" | "elapsedMs">,
) {
  if (!context.active) return;
  const elapsedMs = Math.max(0, context.now() - context.startedAt);
  try {
    context.onEvent({ requestId: context.requestId, elapsedMs, ...event });
  } catch {
    // Diagnostics must never change the Radar request's behavior.
  }
}

function readHttpStatus(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : undefined;
}

function safeErrorClass(error: unknown): string {
  const candidate =
    error !== null && typeof error === "object"
      ? readProperty(readProperty(error, "constructor"), "name")
      : undefined;
  if (
    typeof candidate === "string" &&
    /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(candidate)
  ) {
    return candidate;
  }
  return "unknown_error";
}

function safeErrorCode(error: unknown): string | undefined {
  const candidate = readProperty(error, "code");
  return typeof candidate === "string" &&
    /^[A-Z][A-Z0-9_]{0,31}$/u.test(candidate)
    ? candidate
    : undefined;
}

function readProperty(value: unknown, key: string): unknown {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}
