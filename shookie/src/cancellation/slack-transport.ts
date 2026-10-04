import type { App } from "@slack/bolt";
import { WebClient, LogLevel, type Logger } from "@slack/web-api";

// Same mandatory no-op policy as the Slack read/search client: action_token is
// NOT protected by the SDK's token-key redaction, and response diagnostics leak too.
// Keep independent until the shared Slack modules are integrated; then reuse their logger.
const silentCancellationSlackLogger: Logger = Object.freeze({
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  setLevel: () => {}, setName: () => {}, getLevel: () => LogLevel.ERROR,
});

/** Transport timeout; not a new conversation/call/cost budget. */
export const SLACK_TRANSPORT_TIMEOUT_MS = 15_000;

/**
 * A dedicated client, not a patch to the shared Bolt client. Uses Slack's public
 * requestInterceptor to set Axios' transport signal (NOT Slack API body data).
 * The caller owns signal lifetime and must await actual API settlement.
 *
 * Inherit auth/header, agent/proxy, TLS and trusted endpoint configuration through
 * Bolt's public webClientOptions. Keep the SDK's standard Axios adapter: an unknown
 * custom adapter might ignore abort, so reject it rather than claiming termination.
 */
export function createCancellationSlackClient(
  source: Pick<App, "client" | "webClientOptions">,
  signal: AbortSignal,
): WebClient {
  const inherited = source.webClientOptions;
  if (inherited.adapter) throw new Error("Cancellation requires the standard Slack transport adapter");
  const upstream = inherited.requestInterceptor;
  // A pre-existing tighter read/search timeout must not be relaxed to 15 seconds.
  const timeoutMs = inherited.timeout && Number.isFinite(inherited.timeout) && inherited.timeout > 0
    ? Math.min(inherited.timeout, SLACK_TRANSPORT_TIMEOUT_MS) : SLACK_TRANSPORT_TIMEOUT_MS;
  return new WebClient(source.client.token, {
    ...inherited,
    headers: { ...inherited.headers },
    // Generic apiCall must not interpret a dynamic method name as an external URL.
    allowAbsoluteUrls: false,
    // Never sleep/retry after abort or 429; the caller chooses a friendly error.
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    timeout: timeoutMs,
    // Never inherit a DEBUG logger: assistant.search.context request/response data
    // contains a WeakMap-held event action_token that must not enter any SDK log.
    logger: silentCancellationSlackLogger,
    logLevel: LogLevel.ERROR,
    attachOriginalToWebAPIRequestError: false,
    requestInterceptor: async config => {
      signal.throwIfAborted();
      const request = upstream ? await upstream(config) : config;
      signal.throwIfAborted();
      // Preserve an inherited interceptor's native cancellation boundary too.
      const previous = request.signal;
      if (previous && !(previous instanceof AbortSignal)) {
        throw new Error("Unsupported inherited Slack cancellation signal");
      }
      request.signal = previous && previous !== signal ? AbortSignal.any([signal, previous]) : signal;
      // An inherited interceptor cannot accidentally restore an unbounded timeout.
      request.timeout = request.timeout && Number.isFinite(request.timeout) && request.timeout > 0
        ? Math.min(request.timeout, timeoutMs) : timeoutMs;
      return request;
    },
  });
}
