import type { RelayIdentity } from "./event.js";

export interface IdentityClient {
  auth: { test(args?: Record<string, unknown>): Promise<{ ok?: boolean; team_id?: string; bot_id?: string }> };
  bots?: { info(args: { bot: string }): Promise<{ ok?: boolean; bot?: { app_id?: string } }> };
}

export type RelayIdentityVerification = { teamVerified: true; appVerified: true };

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
 * One-time startup check (never per message) against the already-configured bot token. An enabled relay must verify
 * BOTH the trusted workspace and the Slack app before the Socket starts, otherwise startup FAILS:
 *  - auth.test must report the configured workspace and a bot_id;
 *  - bots.info for that bot must report the configured app id.
 * A missing/failed/timed-out bots.info (e.g. missing users:read), a missing app_id or any mismatch fails startup; there is
 * no "unverified, continue" path. The runtime envelope guard (no outbox => no ACK) remains as defense in depth.
 * Nothing here logs tokens, ids or response bodies.
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
  if (typeof auth.bot_id !== "string" || !client.bots) {
    throw new Error("auth.test did not return a bot_id; cannot verify RADAR_SLACK_RELAY_APP_ID");
  }

  let appId: string | undefined;
  try {
    const info = await bounded(client.bots.info({ bot: auth.bot_id }), timeoutMs, "bots.info");
    if (info.ok !== false && typeof info.bot?.app_id === "string") appId = info.bot.app_id;
  } catch (error) {
    // Metadata only: never include the Slack response/message, which may echo identifiers.
    throw new Error(`bots.info failed (${error instanceof Error ? error.name : typeof error}); cannot verify RADAR_SLACK_RELAY_APP_ID, refusing to start the Slack message relay`);
  }
  if (appId === undefined) {
    throw new Error("bots.info returned no app_id; cannot verify RADAR_SLACK_RELAY_APP_ID, refusing to start the Slack message relay");
  }
  if (appId !== identity.appId) {
    throw new Error(
      "RADAR_SLACK_RELAY_APP_ID does not match the Slack app of SLACK_BOT_TOKEN; refusing to start the Slack message relay",
    );
  }
  return { teamVerified: true, appVerified: true };
}
