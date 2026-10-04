import type { App } from "@slack/bolt";
import { WebClient } from "@slack/web-api";

/** Transport timeout; not a new conversation/call/cost budget. */
export const SLACK_TRANSPORT_TIMEOUT_MS = 15_000;

/**
 * A dedicated client, not a patch to the shared Bolt client. Uses Slack's public
 * requestInterceptor to set Axios' transport signal (NOT Slack API body data).
 * The caller owns signal lifetime and must await actual API settlement.
 *
 * Inherit auth/header, agent/proxy, TLS, logger and endpoint configuration through
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
  return new WebClient(source.client.token, {
    ...inherited,
    headers: { ...inherited.headers },
    // Generic apiCall must not interpret a dynamic method name as an external URL.
    allowAbsoluteUrls: false,
    // Never sleep/retry after abort or 429; the caller chooses a friendly error.
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    timeout: SLACK_TRANSPORT_TIMEOUT_MS,
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
      request.timeout = SLACK_TRANSPORT_TIMEOUT_MS;
      return request;
    },
  });
}
