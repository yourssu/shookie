import type { SlackMessageRelayMetadata } from "database";

/** Fixed, trusted identity of the authenticated Socket Mode app (configuration, never a per-event lookup). */
export interface RelayIdentity {
  appId: string;
  teamId: string;
}

/** Subtypes that represent a NEW public-channel message. Edits/deletes/replies wrappers etc. are excluded. */
const CAPTURED_SUBTYPES: ReadonlySet<string> = new Set([
  "bot_message",
  "thread_broadcast",
  "file_share",
  "me_message",
]);

const TEAM_ID = /^T[A-Z0-9]{2,31}$/u;
const APP_ID = /^A[A-Z0-9]{2,31}$/u;
const EVENT_ID = /^Ev[A-Za-z0-9]{2,63}$/u;
const CHANNEL_ID = /^C[A-Z0-9]{2,31}$/u;
const USER_ID = /^[UW][A-Z0-9]{2,31}$/u;
const BOT_ID = /^B[A-Z0-9]{2,31}$/u;
const SLACK_TS = /^\d{10}\.\d{6}$/u;

export type RelayExtraction =
  | { kind: "ignore" }
  | { kind: "mismatch"; reason: "team" | "app" }
  | { kind: "invalid"; reason: string; eventId: string | null }
  | { kind: "capture"; metadata: SlackMessageRelayMetadata };

const IGNORE: RelayExtraction = { kind: "ignore" };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Pure, read-only metadata extraction from a raw Events API envelope. Deliberately independent of
 * extractMentionMessageEvent (which requires text and excludes bots/subtypes): relay capture needs neither.
 * Only version-1 metadata is returned; message text, files, blocks and tokens are never read.
 */
export function extractRelayMessage(body: unknown, identity: RelayIdentity): RelayExtraction {
  const envelope = record(body);
  if (!envelope || envelope.type !== "event_callback") return IGNORE;
  const event = record(envelope.event);
  if (!event || event.type !== "message") return IGNORE;

  // Public channels only: DMs (im), group DMs (mpim) and private channels (group) are never captured.
  if (event.channel_type !== "channel") return IGNORE;
  const subtype = event.subtype === undefined || event.subtype === null ? null : text(event.subtype);
  if (event.subtype !== undefined && event.subtype !== null && subtype === null) return IGNORE;
  if (subtype !== null && !CAPTURED_SUBTYPES.has(subtype)) return IGNORE;

  const eventId = text(envelope.event_id);
  if (envelope.team_id !== identity.teamId) {
    return text(envelope.team_id) === null ? { kind: "invalid", reason: "team", eventId } : { kind: "mismatch", reason: "team" };
  }
  if (envelope.api_app_id !== identity.appId) {
    return text(envelope.api_app_id) === null ? { kind: "invalid", reason: "app", eventId } : { kind: "mismatch", reason: "app" };
  }

  const invalid = (reason: string): RelayExtraction => ({ kind: "invalid", reason, eventId });
  if (eventId === null || !EVENT_ID.test(eventId)) return invalid("event_id");
  const channelId = text(event.channel);
  if (channelId === null || !CHANNEL_ID.test(channelId)) return invalid("channel");
  const ts = text(event.ts);
  if (ts === null || !SLACK_TS.test(ts)) return invalid("ts");

  let threadTs: string | null = null;
  if (event.thread_ts !== undefined && event.thread_ts !== null) {
    const raw = text(event.thread_ts);
    if (raw === null || !SLACK_TS.test(raw) || raw > ts) return invalid("thread_ts");
    // A parent message announces itself as its own thread; normalize so parents are not "replies".
    threadTs = raw === ts ? null : raw;
  }

  let userId: string | null = null;
  if (event.user !== undefined && event.user !== null) {
    userId = text(event.user);
    if (userId === null || !USER_ID.test(userId)) return invalid("user");
  } else {
    // Only legacy bot_message events may omit a user, and then a valid bot id must identify the sender.
    // The bot id itself is validated here and intentionally NOT forwarded.
    const botId = text(event.bot_id);
    if (subtype !== "bot_message" || botId === null || !BOT_ID.test(botId)) return invalid("user");
  }

  return {
    kind: "capture",
    metadata: { teamId: identity.teamId, appId: identity.appId, eventId, channelId, ts, threadTs, userId, subtype },
  };
}
