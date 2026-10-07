import type { RelayIdentity } from "./event.js";

export interface AuthTestClient {
  auth: { test(args?: Record<string, unknown>): Promise<{ ok?: boolean; team_id?: string }> };
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * One-time startup check (never per message): the already-configured bot token must belong to the configured
 * workspace. Uses the same auth.test Bolt itself performs; no new scope or connection. The app ID cannot be read from
 * auth.test without an extra scope (bots.info needs users:read), so it is enforced fail-closed at runtime instead:
 * the first relayed-looking event with a different api_app_id is NOT ACKed and is logged loudly.
 */
export async function verifyRelayIdentity(
  client: AuthTestClient,
  identity: RelayIdentity,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      client.auth.test(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("auth.test timed out")), timeoutMs);
      }),
    ]);
    if (result.ok === false || typeof result.team_id !== "string") {
      throw new Error("auth.test did not return a team_id");
    }
    if (result.team_id !== identity.teamId) {
      throw new Error(
        "RADAR_SLACK_RELAY_TEAM_ID does not match the workspace of SLACK_BOT_TOKEN; refusing to start the Slack message relay",
      );
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}
