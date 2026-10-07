import type { RelayIdentity } from "./event.js";

export interface IdentityClient {
  auth: { test(args?: Record<string, unknown>): Promise<{ ok?: boolean; team_id?: string; bot_id?: string }> };
  bots?: { info(args: { bot: string }): Promise<{ ok?: boolean; bot?: { app_id?: string } }> };
}

export type RelayIdentityVerification = { teamVerified: true; appVerified: boolean };

const DEFAULT_TIMEOUT_MS = 10_000;

async function bounded<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * One-time startup check (never per message) against the already-configured bot token:
 *  - auth.test must report the configured workspace, else startup FAILS;
 *  - bots.info for the token's own bot must report the configured app id, else startup FAILS.
 *    bots.info normally needs users:read; scopes are not ours to change, so when it is unavailable the app id stays
 *    "unverified" (reported to the caller, never logged with ids) and is enforced fail-closed at runtime by the
 *    capture path: an eligible event with another api_app_id is neither outboxed nor ACKed.
 * Nothing here logs tokens or response bodies.
 */
export async function verifyRelayIdentity(
  client: IdentityClient,
  identity: RelayIdentity,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<RelayIdentityVerification> {
  const auth = await bounded(client.auth.test(), timeoutMs, "auth.test");
  if (auth.ok === false || typeof auth.team_id !== "string") {
    throw new Error("auth.test did not return a team_id");
  }
  if (auth.team_id !== identity.teamId) {
    throw new Error(
      "RADAR_SLACK_RELAY_TEAM_ID does not match the workspace of SLACK_BOT_TOKEN; refusing to start the Slack message relay",
    );
  }

  let appId: string | undefined;
  if (client.bots && typeof auth.bot_id === "string") {
    try {
      const info = await bounded(client.bots.info({ bot: auth.bot_id }), timeoutMs, "bots.info");
      if (info.ok !== false && typeof info.bot?.app_id === "string") appId = info.bot.app_id;
    } catch {
      // missing_scope / transient error: fall back to runtime enforcement below.
    }
  }
  if (appId === undefined) return { teamVerified: true, appVerified: false };
  if (appId !== identity.appId) {
    throw new Error(
      "RADAR_SLACK_RELAY_APP_ID does not match the Slack app of SLACK_BOT_TOKEN; refusing to start the Slack message relay",
    );
  }
  return { teamVerified: true, appVerified: true };
}
